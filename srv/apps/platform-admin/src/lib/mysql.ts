import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  credentialUsers,
  deleteCredential,
  getCredential,
  setCredential,
} from "@/lib/credential-vault";

const mysql = require("mysql2/promise");

let pool: any;

const RESERVED_DATABASES = new Set([
  "information_schema",
  "mysql",
  "performance_schema",
  "sys",
]);
const RESERVED_USERS = new Set([
  "root",
  "platform_controller",
  "mysql.infoschema",
  "mysql.session",
  "mysql.sys",
]);

function controllerPassword() {
  const path = process.env.MYSQL_CONTROLLER_PASSWORD_FILE;
  if (!path) throw new Error("MYSQL_CONTROLLER_PASSWORD_FILE is not configured");
  return readFileSync(path, "utf8").trim();
}

function controllerUser() {
  return process.env.MYSQL_CONTROLLER_USER || "platform_controller";
}

function tlsEnabled() {
  return (process.env.MYSQL_TLS_ENABLED || "true").toLowerCase() !== "false";
}

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST || "mysql.openmusk.store",
      port: Number(process.env.MYSQL_PORT || 3306),
      user: controllerUser(),
      password: controllerPassword(),
      ssl: tlsEnabled() ? { rejectUnauthorized: true } : undefined,
      waitForConnections: true,
      connectionLimit: 5,
      maxIdle: 5,
      idleTimeout: 30000,
      enableKeepAlive: true,
    });
  }
  return pool;
}

function assertIdentifier(value: unknown, kind: string) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{2,62}$/.test(value)) {
    throw new Error(`${kind} name must match ^[a-z][a-z0-9_]{2,62}$`);
  }
  return value;
}

function assertDatabase(value: unknown) {
  const database = assertIdentifier(value, "database");
  if (RESERVED_DATABASES.has(database)) throw new Error(`Database ${database} is reserved`);
  return database;
}

function assertUser(value: unknown) {
  const user = assertIdentifier(value, "user");
  if (RESERVED_USERS.has(user)) throw new Error(`User ${user} is reserved`);
  return user;
}

function ident(value: string) {
  return `\`${value.replaceAll("`", "``")}\``;
}

function literal(value: string) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function generatedPassword() {
  return randomBytes(24).toString("base64url");
}

function grantee(user: string) {
  return `'${user}'@'%'`;
}

function mysqlUrl(database: string, user: string, password: string, host: string, port: number) {
  return `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}?ssl-mode=VERIFY_IDENTITY`;
}

function privateConnection(database: string, user: string, password: string) {
  const host = process.env.MYSQL_APP_HOST || "mysql.openmusk.store";
  const port = Number(process.env.MYSQL_APP_PORT || 3306);
  return {
    host,
    port,
    database,
    user,
    tls_required: true,
    url: mysqlUrl(database, user, password, host, port),
  };
}

function publicConnection(database: string, user: string, password: string) {
  const host = process.env.MYSQL_PUBLIC_HOST?.trim();
  if (!host) return null;
  const port = Number(process.env.MYSQL_PUBLIC_PORT || 3306);
  return {
    host,
    port,
    database,
    user,
    tls_required: true,
    ssl_mode: "VERIFY_IDENTITY",
    url: mysqlUrl(database, user, password, host, port),
  };
}

async function databaseUsers() {
  const [rows] = await getPool().query(`
    SELECT TABLE_SCHEMA AS database_name, GRANTEE
    FROM information_schema.SCHEMA_PRIVILEGES
    WHERE TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
    GROUP BY TABLE_SCHEMA, GRANTEE
  `);

  const map = new Map<string, Set<string>>();
  for (const row of rows as Array<{ database_name: string; GRANTEE: string }>) {
    const match = /^'([^']+)'@/.exec(row.GRANTEE);
    if (!match || RESERVED_USERS.has(match[1])) continue;
    if (!map.has(row.database_name)) map.set(row.database_name, new Set());
    map.get(row.database_name)!.add(match[1]);
  }
  return map;
}

async function assertUserHasDatabaseGrant(db: any, database: string, user: string) {
  const [rows] = await db.query(
    "SELECT 1 FROM information_schema.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA = ? AND GRANTEE = ? LIMIT 1",
    [database, grantee(user)],
  );
  if (!(rows as any[]).length) {
    throw new Error(`${user} is not assigned to database ${database}`);
  }
}

export async function listMysqlResources() {
  const db = getPool();
  const [[databases], [users], storedUsers, grants] = await Promise.all([
    db.query(`
      SELECT
        s.SCHEMA_NAME AS name,
        COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS size_bytes
      FROM information_schema.SCHEMATA s
      LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
      WHERE s.SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      GROUP BY s.SCHEMA_NAME
      ORDER BY s.SCHEMA_NAME
    `),
    db.query(`
      SELECT User AS name, Host AS host
      FROM mysql.user
      WHERE User NOT IN ('root', 'platform_controller', 'mysql.infoschema', 'mysql.session', 'mysql.sys')
      ORDER BY User, Host
    `),
    credentialUsers("mysql"),
    databaseUsers(),
  ]);

  return {
    databases: (databases as any[]).map((row) => {
      const assigned = Array.from(grants.get(row.name) || []);
      return {
        name: row.name,
        size_bytes: String(row.size_bytes || 0),
        users: assigned,
        credential_available: assigned.some((user) => storedUsers.has(user)),
      };
    }),
    users: (users as any[]).map((row) => ({
      name: row.name,
      host: row.host,
      credential_available: storedUsers.has(row.name),
    })),
  };
}

export async function createMysqlDatabaseWithUser(databaseInput: unknown, userInput: unknown) {
  const database = assertDatabase(databaseInput);
  const user = assertUser(userInput);
  const password = generatedPassword();
  const connection = await getPool().getConnection();
  let dbCreated = false;
  let userCreated = false;

  try {
    const [dbRows] = await connection.query(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
      [database],
    );
    if ((dbRows as any[]).length) throw new Error(`Database ${database} already exists`);

    const [userRows] = await connection.query(
      "SELECT User FROM mysql.user WHERE User = ? AND Host = '%'",
      [user],
    );
    if ((userRows as any[]).length) throw new Error(`User ${user} already exists`);

    await connection.query(`CREATE DATABASE ${ident(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    dbCreated = true;
    await connection.query(`CREATE USER ${literal(user)}@'%' IDENTIFIED BY ${literal(password)} REQUIRE SSL`);
    userCreated = true;
    await connection.query(`GRANT ALL PRIVILEGES ON ${ident(database)}.* TO ${literal(user)}@'%'`);
    await setCredential("mysql", user, password);
  } catch (error) {
    await deleteCredential("mysql", user).catch(() => undefined);
    if (userCreated) await connection.query(`DROP USER IF EXISTS ${literal(user)}@'%'`).catch(() => undefined);
    if (dbCreated) await connection.query(`DROP DATABASE IF EXISTS ${ident(database)}`).catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }

  return {
    database,
    user,
    password,
    connection: privateConnection(database, user, password),
    public_connection: publicConnection(database, user, password),
  };
}

export async function createMysqlDatabaseForExistingUser(databaseInput: unknown, userInput: unknown) {
  const database = assertDatabase(databaseInput);
  const user = assertUser(userInput);
  const db = getPool();

  const [dbRows] = await db.query(
    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
    [database],
  );
  if ((dbRows as any[]).length) throw new Error(`Database ${database} already exists`);

  const [userRows] = await db.query(
    "SELECT User FROM mysql.user WHERE User = ? AND Host = '%'",
    [user],
  );
  if (!(userRows as any[]).length) throw new Error(`User ${user} does not exist`);

  await db.query(`CREATE DATABASE ${ident(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  try {
    await db.query(`ALTER USER ${literal(user)}@'%' REQUIRE SSL`);
    await db.query(`GRANT ALL PRIVILEGES ON ${ident(database)}.* TO ${literal(user)}@'%'`);
  } catch (error) {
    await db.query(`DROP DATABASE IF EXISTS ${ident(database)}`).catch(() => undefined);
    throw error;
  }

  return {
    database,
    user,
    credential_available: Boolean(await getCredential("mysql", user)),
  };
}

export async function getMysqlConnection(databaseInput: unknown, userInput: unknown) {
  const database = assertDatabase(databaseInput);
  const user = assertUser(userInput);
  const db = getPool();
  await assertUserHasDatabaseGrant(db, database, user);

  const password = await getCredential("mysql", user);
  if (!password) throw new Error(`Password for ${user} is not stored in the encrypted vault. Rotate it once.`);

  return {
    database,
    user,
    password,
    connection: privateConnection(database, user, password),
    public_connection: publicConnection(database, user, password),
  };
}

export async function rotateMysqlPassword(userInput: unknown, databaseInput?: unknown) {
  const user = assertUser(userInput);
  const database = databaseInput ? assertDatabase(databaseInput) : undefined;
  const password = generatedPassword();
  const db = getPool();

  const [rows] = await db.query("SELECT User FROM mysql.user WHERE User = ? AND Host = '%'", [user]);
  if (!(rows as any[]).length) throw new Error(`User ${user} does not exist`);
  if (database) await assertUserHasDatabaseGrant(db, database, user);

  await db.query(`ALTER USER ${literal(user)}@'%' IDENTIFIED BY ${literal(password)} REQUIRE SSL`);
  let credentialStored = true;
  try {
    await setCredential("mysql", user, password);
  } catch {
    credentialStored = false;
  }

  return {
    database,
    user,
    password,
    credential_stored: credentialStored,
    connection: database ? privateConnection(database, user, password) : null,
    public_connection: database ? publicConnection(database, user, password) : null,
  };
}

export async function deleteMysqlDatabase(databaseInput: unknown) {
  const database = assertDatabase(databaseInput);
  await getPool().query(`DROP DATABASE IF EXISTS ${ident(database)}`);
  return { database };
}

export async function deleteMysqlDatabaseAndUser(databaseInput: unknown, userInput: unknown) {
  const database = assertDatabase(databaseInput);
  const user = assertUser(userInput);
  const db = getPool();

  await assertUserHasDatabaseGrant(db, database, user);

  const [otherGrants] = await db.query(
    `
      SELECT DISTINCT TABLE_SCHEMA AS database_name
      FROM information_schema.SCHEMA_PRIVILEGES
      WHERE GRANTEE = ?
        AND TABLE_SCHEMA <> ?
        AND TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      ORDER BY TABLE_SCHEMA
    `,
    [grantee(user), database],
  );

  if ((otherGrants as any[]).length) {
    const names = (otherGrants as any[]).map((row) => row.database_name).join(", ");
    throw new Error(
      `User ${user} is also assigned to: ${names}. Delete only database ${database}, or remove the other assignments before deleting the user.`,
    );
  }

  await db.query(`DROP DATABASE IF EXISTS ${ident(database)}`);
  await db.query(`DROP USER IF EXISTS ${literal(user)}@'%'`);
  await deleteCredential("mysql", user);
  return { database, user };
}
