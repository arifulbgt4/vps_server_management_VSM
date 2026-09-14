import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  credentialUsers,
  deleteCredential,
  getCredential,
  setCredential,
} from "@/lib/credential-vault";

const { Pool } = require("pg");

let pool: any;

const RESERVED_DATABASES = new Set(["postgres", "platform_admin"]);
const RESERVED_ROLES = new Set(["postgres", "platform_controller", "platform_app"]);

function getPassword() {
  const path = process.env.PG_PASSWORD_FILE;
  if (!path) throw new Error("PG_PASSWORD_FILE is not configured");
  return readFileSync(path, "utf8").trim();
}

function controllerRole() {
  return process.env.PGUSER || "platform_controller";
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.PGHOST || "postgres",
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE || "postgres",
      user: controllerRole(),
      password: getPassword(),
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

function assertIdentifierFormat(name: unknown, kind: string) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9_]{2,62}$/.test(name)) {
    throw new Error(`${kind} name must match ^[a-z][a-z0-9_]{2,62}$`);
  }
  return name;
}

function assertName(name: unknown, kind: "database" | "role") {
  const validName = assertIdentifierFormat(name, kind);
  if (kind === "database" && RESERVED_DATABASES.has(validName)) {
    throw new Error(`Database ${validName} is reserved`);
  }
  if (kind === "role" && RESERVED_ROLES.has(validName)) {
    throw new Error(`Role ${validName} is reserved`);
  }
  return validName;
}

function ident(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function literal(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function generatedPassword() {
  return randomBytes(24).toString("base64url");
}

function publicConnection(database: string, role: string, password: string) {
  const host = process.env.PG_PUBLIC_HOST?.trim();
  if (!host) return null;

  const port = Number(process.env.PG_PUBLIC_PORT || 5432);
  const sslmode = process.env.PG_PUBLIC_SSLMODE || "verify-full";

  return {
    host,
    port,
    sslmode,
    database,
    role,
    url: `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}?sslmode=${encodeURIComponent(sslmode)}`,
  };
}

async function ensureControllerCanSetRole(client: any, role: string) {
  const controller = assertIdentifierFormat(controllerRole(), "controller role");
  const result = await client.query(
    "SELECT pg_has_role($1, $2, 'SET') AS can_set",
    [controller, role],
  );

  if (result.rows[0]?.can_set) return;

  try {
    await client.query(
      `GRANT ${ident(role)} TO ${ident(controller)} WITH SET TRUE`,
    );
  } catch {
    throw new Error(
      `Platform controller cannot SET ROLE ${role}. Grant ${role} to ${controller} with SET permission as postgres first.`,
    );
  }
}

async function restrictDatabaseToOwner(client: any, database: string, role: string) {
  await client.query(`SET ROLE ${ident(role)}`);
  try {
    await client.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${ident(database)} FROM PUBLIC`);
  } finally {
    await client.query("RESET ROLE").catch(() => undefined);
  }
}

export async function listPostgresResources() {
  const db = getPool();
  const [databases, roles, storedUsers] = await Promise.all([
    db.query(`
      SELECT
        datname AS name,
        pg_get_userbyid(datdba) AS owner,
        pg_database_size(datname)::bigint AS size_bytes
      FROM pg_database
      WHERE datistemplate = false
      ORDER BY datname
    `),
    db.query(`
      SELECT
        rolname AS name,
        rolcanlogin AS can_login,
        rolcreatedb AS create_db,
        rolcreaterole AS create_role,
        rolsuper AS superuser
      FROM pg_roles
      WHERE rolname !~ '^pg_'
      ORDER BY rolname
    `),
    credentialUsers("postgres"),
  ]);

  return {
    databases: databases.rows.map((row: any) => ({
      ...row,
      credential_available:
        !RESERVED_DATABASES.has(row.name) && storedUsers.has(row.owner),
    })),
    roles: roles.rows,
  };
}

export async function createDatabaseWithRole(databaseInput: unknown, roleInput: unknown) {
  const database = assertName(databaseInput, "database");
  const role = assertName(roleInput, "role");
  const password = generatedPassword();
  const client = await getPool().connect();
  let roleCreated = false;

  try {
    const existingDb = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [database],
    );
    if (existingDb.rowCount) throw new Error(`Database ${database} already exists`);

    const existingRole = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1",
      [role],
    );
    if (existingRole.rowCount) throw new Error(`Role ${role} already exists`);

    await client.query(
      `CREATE ROLE ${ident(role)} LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
    roleCreated = true;

    await setCredential("postgres", role, password);
    await ensureControllerCanSetRole(client, role);
    await client.query(`CREATE DATABASE ${ident(database)} OWNER ${ident(role)}`);
    await restrictDatabaseToOwner(client, database, role);
  } catch (error) {
    await deleteCredential("postgres", role).catch(() => undefined);
    if (roleCreated) {
      await client.query(`DROP DATABASE IF EXISTS ${ident(database)} WITH (FORCE)`).catch(() => undefined);
      await client.query(`DROP ROLE IF EXISTS ${ident(role)}`).catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }

  return {
    database,
    role,
    password,
    connection: publicConnection(database, role, password),
  };
}

export async function createDatabaseForExistingRole(
  databaseInput: unknown,
  roleInput: unknown,
) {
  const database = assertName(databaseInput, "database");
  const role = assertName(roleInput, "role");
  const client = await getPool().connect();

  try {
    const existingDb = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [database],
    );
    if (existingDb.rowCount) throw new Error(`Database ${database} already exists`);

    const roleResult = await client.query(
      "SELECT rolcanlogin, rolsuper FROM pg_roles WHERE rolname = $1",
      [role],
    );
    if (!roleResult.rowCount) throw new Error(`Role ${role} does not exist`);
    if (!roleResult.rows[0].rolcanlogin) throw new Error(`Role ${role} cannot login`);
    if (roleResult.rows[0].rolsuper) {
      throw new Error("Superuser roles cannot be assigned through this UI");
    }

    await ensureControllerCanSetRole(client, role);
    await client.query(`CREATE DATABASE ${ident(database)} OWNER ${ident(role)}`);
    await restrictDatabaseToOwner(client, database, role);
  } finally {
    client.release();
  }

  return {
    database,
    role,
    credential_available: Boolean(await getCredential("postgres", role)),
  };
}

export async function getDatabaseConnection(databaseInput: unknown) {
  const database = assertName(databaseInput, "database");
  const db = getPool();

  const result = await db.query(
    `
      SELECT pg_get_userbyid(datdba) AS owner
      FROM pg_database
      WHERE datname = $1 AND datistemplate = false
    `,
    [database],
  );

  if (!result.rowCount) throw new Error(`Database ${database} does not exist`);
  const role = result.rows[0].owner as string;
  if (RESERVED_ROLES.has(role)) {
    throw new Error("System database credentials are not exposed");
  }

  const password = await getCredential("postgres", role);
  if (!password) {
    throw new Error(
      `Password for ${role} is not stored in the encrypted vault. Rotate that user's password once to enable URL reveal.`,
    );
  }

  return {
    database,
    role,
    password,
    connection: publicConnection(database, role, password),
  };
}

export async function rotateRolePassword(
  roleInput: unknown,
  databaseInput?: unknown,
) {
  const role = assertName(roleInput, "role");
  const database = databaseInput ? assertName(databaseInput, "database") : undefined;
  const password = generatedPassword();
  const db = getPool();

  const exists = await db.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  if (!exists.rowCount) throw new Error(`Role ${role} does not exist`);

  if (database) {
    const dbExists = await db.query(
      "SELECT 1 FROM pg_database WHERE datname = $1 AND pg_get_userbyid(datdba) = $2",
      [database, role],
    );
    if (!dbExists.rowCount) {
      throw new Error(`Database ${database} is not owned by ${role}`);
    }
  }

  await db.query(`ALTER ROLE ${ident(role)} PASSWORD ${literal(password)}`);

  let credentialStored = true;
  try {
    await setCredential("postgres", role, password);
  } catch {
    credentialStored = false;
  }

  return {
    role,
    database,
    password,
    credential_stored: credentialStored,
    connection: database ? publicConnection(database, role, password) : null,
  };
}

export async function deleteDatabaseOnly(databaseInput: unknown) {
  const database = assertName(databaseInput, "database");
  const db = getPool();
  await db.query(`DROP DATABASE IF EXISTS ${ident(database)} WITH (FORCE)`);
  return { database };
}

export async function deleteDatabaseAndRole(databaseInput: unknown, roleInput: unknown) {
  const database = assertName(databaseInput, "database");
  const role = assertName(roleInput, "role");
  const db = getPool();

  await db.query(`DROP DATABASE IF EXISTS ${ident(database)} WITH (FORCE)`);
  await db.query(`DROP ROLE IF EXISTS ${ident(role)}`);
  await deleteCredential("postgres", role);

  return { database, role };
}
