import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  credentialUsers,
  deleteCredential,
  getCredential,
  setCredential,
} from "@/lib/credential-vault";

const { createClient } = require("redis");

let client: any;

const RESERVED_USERS = new Set(["default", "platform_controller"]);

function assertUser(name: unknown) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9_]{2,62}$/.test(name)) {
    throw new Error("Redis username must match ^[a-z][a-z0-9_]{2,62}$");
  }
  if (RESERVED_USERS.has(name)) throw new Error(`Redis user ${name} is reserved`);
  return name;
}

function controllerPassword() {
  const path = process.env.REDIS_PASSWORD_FILE;
  if (!path) throw new Error("REDIS_PASSWORD_FILE is not configured");
  return readFileSync(path, "utf8").trim();
}

function generatedPassword() {
  return randomBytes(24).toString("base64url");
}

async function getClient() {
  if (!client) {
    client = createClient({
      socket: {
        host: process.env.REDIS_HOST || "redis",
        port: Number(process.env.REDIS_PORT || 6379),
        connectTimeout: 5000,
      },
      username: process.env.REDIS_USER || "platform_controller",
      password: controllerPassword(),
    });
    client.on("error", (error: Error) => {
      console.error("Redis client error:", error.message);
    });
  }

  if (!client.isOpen) await client.connect();
  return client;
}

function privateConnection(username: string, password: string) {
  const host = process.env.REDIS_APP_HOST || "redis";
  const port = Number(process.env.REDIS_APP_PORT || 6379);
  const database = Number(process.env.REDIS_APP_DATABASE || 0);

  return {
    host,
    port,
    database,
    url: `redis://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${database}`,
  };
}

function parseAclLine(line: string) {
  const parts = line.split(/\s+/);
  const username = parts[1] || "unknown";
  return {
    name: username,
    enabled: parts.includes("on"),
    system: RESERVED_USERS.has(username),
  };
}

async function saveAcl(redis: any) {
  await redis.sendCommand(["ACL", "SAVE"]);
}

export async function listRedisResources() {
  const redis = await getClient();
  const [pong, aclLines, storedUsers] = await Promise.all([
    redis.ping(),
    redis.sendCommand(["ACL", "LIST"]) as Promise<string[]>,
    credentialUsers("redis"),
  ]);

  return {
    status: pong === "PONG" ? "online" : "unknown",
    users: aclLines.map(parseAclLine).map((user) => ({
      ...user,
      credential_available: !user.system && storedUsers.has(user.name),
    })),
    app_host: process.env.REDIS_APP_HOST || "redis",
    app_port: Number(process.env.REDIS_APP_PORT || 6379),
  };
}

export async function createRedisUser(usernameInput: unknown) {
  const username = assertUser(usernameInput);
  const redis = await getClient();
  const users = (await redis.sendCommand(["ACL", "USERS"])) as string[];
  if (users.includes(username)) throw new Error(`Redis user ${username} already exists`);

  const password = generatedPassword();
  await redis.sendCommand([
    "ACL",
    "SETUSER",
    username,
    "reset",
    "on",
    `>${password}`,
    "~*",
    "&*",
    "+@all",
    "-@admin",
    "-@dangerous",
  ]);

  try {
    await setCredential("redis", username, password);
    await saveAcl(redis);
  } catch (error) {
    await redis.sendCommand(["ACL", "DELUSER", username]).catch(() => undefined);
    throw error;
  }

  return {
    username,
    password,
    connection: privateConnection(username, password),
  };
}

export async function rotateRedisPassword(usernameInput: unknown) {
  const username = assertUser(usernameInput);
  const redis = await getClient();
  const users = (await redis.sendCommand(["ACL", "USERS"])) as string[];
  if (!users.includes(username)) throw new Error(`Redis user ${username} does not exist`);

  const password = generatedPassword();
  await redis.sendCommand(["ACL", "SETUSER", username, "resetpass", `>${password}`]);

  let credentialStored = true;
  try {
    await setCredential("redis", username, password);
    await saveAcl(redis);
  } catch {
    credentialStored = false;
  }

  return {
    username,
    password,
    credential_stored: credentialStored,
    connection: privateConnection(username, password),
  };
}

export async function getRedisConnection(usernameInput: unknown) {
  const username = assertUser(usernameInput);
  const password = await getCredential("redis", username);
  if (!password) {
    throw new Error(
      `Password for ${username} is not stored in the encrypted vault. Rotate it once to enable URL reveal.`,
    );
  }

  return {
    username,
    password,
    connection: privateConnection(username, password),
  };
}

export async function deleteRedisUser(usernameInput: unknown) {
  const username = assertUser(usernameInput);
  const redis = await getClient();
  const deleted = Number(await redis.sendCommand(["ACL", "DELUSER", username]));
  if (!deleted) throw new Error(`Redis user ${username} does not exist`);

  await deleteCredential("redis", username);
  await saveAcl(redis);
  return { username };
}
