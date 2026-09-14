import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

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

function assertName(name: unknown, kind: "database" | "role") {
  if (typeof name !== "string" || !/^[a-z][a-z0-9_]{2,62}$/.test(name)) {
    throw new Error(`${kind} name must match ^[a-z][a-z0-9_]{2,62}$`);
  }
  if (kind === "database" && RESERVED_DATABASES.has(name)) {
    throw new Error(`Database ${name} is reserved`);
  }
  if (kind === "role" && RESERVED_ROLES.has(name)) {
    throw new Error(`Role ${name} is reserved`);
  }
  return name;
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

export async function listPostgresResources() {
  const db = getPool();
  const [databases, roles] = await Promise.all([
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
  ]);

  return {
    databases: databases.rows,
    roles: roles.rows,
  };
}

export async function createDatabaseWithRole(databaseInput: unknown, roleInput: unknown) {
  const database = assertName(databaseInput, "database");
  const role = assertName(roleInput, "role");
  const controller = assertName(controllerRole(), "role");
  const password = generatedPassword();
  const client = await getPool().connect();

  try {
    const existingDb = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (existingDb.rowCount) throw new Error(`Database ${database} already exists`);

    const existingRole = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
    if (existingRole.rowCount) throw new Error(`Role ${role} already exists`);

    await client.query(
      `CREATE ROLE ${ident(role)} LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );

    try {
      // PostgreSQL 17 gives a CREATEROLE user ADMIN membership on roles it creates,
      // but creating a database owned by another role specifically requires SET ROLE.
      // Enable SET only for the controller's membership before assigning ownership.
      await client.query(
        `GRANT ${ident(role)} TO ${ident(controller)} WITH SET TRUE`,
      );

      await client.query(`CREATE DATABASE ${ident(database)} OWNER ${ident(role)}`);
    } catch (error) {
      await client.query(`DROP ROLE IF EXISTS ${ident(role)}`);
      throw error;
    }
  } finally {
    client.release();
  }

  return { database, role, password };
}

export async function rotateRolePassword(roleInput: unknown) {
  const role = assertName(roleInput, "role");
  const password = generatedPassword();
  const db = getPool();

  const exists = await db.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  if (!exists.rowCount) throw new Error(`Role ${role} does not exist`);

  await db.query(`ALTER ROLE ${ident(role)} PASSWORD ${literal(password)}`);
  return { role, password };
}

export async function deleteDatabaseAndRole(databaseInput: unknown, roleInput: unknown) {
  const database = assertName(databaseInput, "database");
  const role = assertName(roleInput, "role");
  const db = getPool();

  await db.query(`DROP DATABASE IF EXISTS ${ident(database)} WITH (FORCE)`);
  await db.query(`DROP ROLE IF EXISTS ${ident(role)}`);

  return { database, role };
}
