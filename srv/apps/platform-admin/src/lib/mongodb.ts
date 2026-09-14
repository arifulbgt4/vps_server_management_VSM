import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  credentialUsers,
  deleteCredential,
  getCredential,
  setCredential,
} from "@/lib/credential-vault";

const { MongoClient } = require("mongodb");

let client: any;
let connecting: Promise<any> | null = null;

const RESERVED_DATABASES = new Set(["admin", "config", "local"]);
const RESERVED_USERS = new Set(["root", "platform_controller"]);

function controllerPassword() {
  const path = process.env.MONGO_CONTROLLER_PASSWORD_FILE;
  if (!path) throw new Error("MONGO_CONTROLLER_PASSWORD_FILE is not configured");
  return readFileSync(path, "utf8").trim();
}

function controllerUser() {
  return process.env.MONGO_CONTROLLER_USER || "platform_controller";
}

function replicaSet() {
  return process.env.MONGO_REPLICA_SET || "rs0";
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

function generatedPassword() {
  return randomBytes(24).toString("base64url");
}

function credentialKey(database: string, user: string) {
  return `${database}:${user}`;
}

function controllerUri() {
  const host = process.env.MONGO_HOST || "mongodb";
  const port = Number(process.env.MONGO_PORT || 27017);
  return `mongodb://${encodeURIComponent(controllerUser())}:${encodeURIComponent(controllerPassword())}@${host}:${port}/admin?authSource=admin&replicaSet=${encodeURIComponent(replicaSet())}`;
}

async function getClient() {
  if (client) return client;
  if (!connecting) {
    connecting = (async () => {
      const next = new MongoClient(controllerUri(), {
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 5000,
      });
      await next.connect();
      await next.db("admin").command({ ping: 1 });
      client = next;
      return next;
    })().finally(() => {
      connecting = null;
    });
  }
  return connecting;
}

function privateConnection(database: string, user: string, password: string) {
  const host = process.env.MONGO_APP_HOST || "mongodb";
  const port = Number(process.env.MONGO_APP_PORT || 27017);
  const rs = replicaSet();
  return {
    host,
    port,
    database,
    user,
    replica_set: rs,
    url: `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}?authSource=${encodeURIComponent(database)}&replicaSet=${encodeURIComponent(rs)}`,
  };
}

function publicConnection(database: string, user: string, password: string) {
  const host = process.env.MONGO_PUBLIC_HOST?.trim();
  if (!host) return null;
  const port = Number(process.env.MONGO_PUBLIC_PORT || 27017);
  const rs = replicaSet();
  return {
    host,
    port,
    database,
    user,
    replica_set: rs,
    url: `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}?authSource=${encodeURIComponent(database)}&replicaSet=${encodeURIComponent(rs)}&tls=true`,
  };
}

export async function listMongoResources() {
  const mongo = await getClient();
  const [databaseInfo, userInfo, storedKeys, ping] = await Promise.all([
    mongo.db("admin").admin().listDatabases({ nameOnly: false }),
    mongo.db("admin").command({ usersInfo: { forAllDBs: true }, showPrivileges: true }),
    credentialUsers("mongodb"),
    mongo.db("admin").command({ ping: 1 }),
  ]);

  const users = (userInfo.users || [])
    .filter((item: any) => !RESERVED_DATABASES.has(item.db) && !RESERVED_USERS.has(item.user))
    .map((item: any) => ({
      name: item.user,
      database: item.db,
      roles: (item.roles || []).map((role: any) => `${role.role}@${role.db}`),
      credential_available: storedKeys.has(credentialKey(item.db, item.user)),
    }));

  const usersByDatabase = new Map<string, string[]>();
  for (const item of users) {
    if (!usersByDatabase.has(item.database)) usersByDatabase.set(item.database, []);
    usersByDatabase.get(item.database)!.push(item.name);
  }

  return {
    status: ping.ok === 1 ? "online" : "unknown",
    replica_set: replicaSet(),
    databases: (databaseInfo.databases || [])
      .filter((item: any) => !RESERVED_DATABASES.has(item.name))
      .map((item: any) => ({
        name: item.name,
        size_bytes: String(item.sizeOnDisk || 0),
        empty: Boolean(item.empty),
        users: usersByDatabase.get(item.name) || [],
      })),
    users,
  };
}

export async function createMongoDatabaseWithUser(databaseInput: unknown, userInput: unknown) {
  const database = assertDatabase(databaseInput);
  const user = assertUser(userInput);
  const password = generatedPassword();
  const mongo = await getClient();
  const db = mongo.db(database);
  let userCreated = false;

  const existingDatabases = await mongo.db("admin").admin().listDatabases({ nameOnly: true });
  if ((existingDatabases.databases || []).some((item: any) => item.name === database)) {
    throw new Error(`Database ${database} already exists`);
  }

  try {
    const userInfo = await db.command({ usersInfo: user });
    if ((userInfo.users || []).length) throw new Error(`User ${user} already exists in ${database}`);

    await db.command({
      createUser: user,
      pwd: password,
      roles: [{ role: "readWrite", db: database }],
    });
    userCreated = true;

    await db.collection("_vsm_meta").insertOne({
      managedBy: "platform-admin",
      createdAt: new Date(),
    });

    await setCredential("mongodb", credentialKey(database, user), password);
  } catch (error) {
    await deleteCredential("mongodb", credentialKey(database, user)).catch(() => undefined);
    if (userCreated) await db.command({ dropUser: user }).catch(() => undefined);
    await db.dropDatabase().catch(() => undefined);
    throw error;
  }

  return {
    database,
    user,
    password,
    connection: privateConnection(database, user, password),
    public_connection: publicConnection(database, user, password),
  };
}

export async function getMongoConnection(databaseInput: unknown, userInput: unknown) {
  const database = assertDatabase(databaseInput);
  const user = assertUser(userInput);
  const mongo = await getClient();
  const info = await mongo.db(database).command({ usersInfo: user });
  if (!(info.users || []).length) throw new Error(`User ${user} does not exist in ${database}`);

  const password = await getCredential("mongodb", credentialKey(database, user));
  if (!password) throw new Error(`Password for ${user}@${database} is not stored in the encrypted vault. Rotate it once.`);

  return {
    database,
    user,
    password,
    connection: privateConnection(database, user, password),
    public_connection: publicConnection(database, user, password),
  };
}

export async function rotateMongoPassword(databaseInput: unknown, userInput: unknown) {
  const database = assertDatabase(databaseInput);
  const user = assertUser(userInput);
  const password = generatedPassword();
  const mongo = await getClient();
  const db = mongo.db(database);
  const info = await db.command({ usersInfo: user });
  if (!(info.users || []).length) throw new Error(`User ${user} does not exist in ${database}`);

  await db.command({ updateUser: user, pwd: password });

  let credentialStored = true;
  try {
    await setCredential("mongodb", credentialKey(database, user), password);
  } catch {
    credentialStored = false;
  }

  return {
    database,
    user,
    password,
    credential_stored: credentialStored,
    connection: privateConnection(database, user, password),
    public_connection: publicConnection(database, user, password),
  };
}

export async function deleteMongoDatabase(databaseInput: unknown) {
  const database = assertDatabase(databaseInput);
  const mongo = await getClient();
  await mongo.db(database).dropDatabase();
  return { database };
}

export async function deleteMongoDatabaseAndUser(databaseInput: unknown, userInput: unknown) {
  const database = assertDatabase(databaseInput);
  const user = assertUser(userInput);
  const mongo = await getClient();
  const db = mongo.db(database);

  await db.command({ dropUser: user }).catch((error: any) => {
    if (!String(error?.message || "").includes("not found")) throw error;
  });
  await db.dropDatabase();
  await deleteCredential("mongodb", credentialKey(database, user));
  return { database, user };
}
