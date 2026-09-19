import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, scryptSync } from "node:crypto";

const ROOT = process.env.VSM_RUNTIME_ROOT || "/srv/vsm";
const SECRETS = join(ROOT, "secrets");
const MASTER = join(SECRETS, "master");
const BOOTSTRAP = join(ROOT, "bootstrap");

const uid = {
  root: 0,
  postgres: 70,
  node: 1000,
  nextjs: 1001,
  db: 999,
};

function mkdir(path, mode = 0o700, owner = uid.root, group = uid.root) {
  mkdirSync(path, { recursive: true, mode });
  try { chmodSync(path, mode); } catch {}
  try { chownSync(path, owner, group); } catch {}
}

function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function readOrCreate(path, factory) {
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8").trim();
    if (current) return current;
  }
  const value = factory();
  mkdir(dirname(path));
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  return value;
}

function writeSecret(path, value, owner = uid.root, group = owner, mode = 0o600) {
  mkdir(dirname(path), 0o700, owner, group);
  writeFileSync(path, `${value}\n`, { mode });
  chmodSync(path, mode);
  chownSync(path, owner, group);
}

mkdir(ROOT, 0o755);
mkdir(SECRETS);
mkdir(MASTER);
mkdir(BOOTSTRAP);

for (const path of [
  join(ROOT, "postgres", "data"),
  join(ROOT, "redis", "data"),
  join(ROOT, "mysql", "data"),
  join(ROOT, "mongodb", "data"),
  join(ROOT, "n8n", "data"),
  join(ROOT, "media", "storage"),
  join(ROOT, "docker-agent"),
  join(ROOT, "letsencrypt"),
  join(ROOT, "acme"),
  join(ROOT, "tls", "postgres"),
  join(ROOT, "tls", "redis"),
  join(ROOT, "tls", "mysql"),
  join(ROOT, "tls", "mongodb"),
]) {
  mkdir(path, 0o755);
}

try { chownSync(join(ROOT, "postgres", "data"), uid.postgres, uid.postgres); } catch {}
try { chownSync(join(ROOT, "redis", "data"), uid.db, uid.db); } catch {}
try { chownSync(join(ROOT, "mysql", "data"), uid.db, uid.db); } catch {}
try { chownSync(join(ROOT, "mongodb", "data"), uid.db, uid.db); } catch {}
try { chownSync(join(ROOT, "n8n", "data"), uid.node, uid.node); } catch {}
try { chownSync(join(ROOT, "media", "storage"), uid.node, uid.node); } catch {}

const values = {
  postgresSuperuser: readOrCreate(join(MASTER, "postgres_superuser_password"), () => randomSecret(32)),
  postgresController: readOrCreate(join(MASTER, "postgres_controller_password"), () => randomSecret(32)),
  platformApp: readOrCreate(join(MASTER, "platform_app_password"), () => randomSecret(32)),
  n8nDb: readOrCreate(join(MASTER, "n8n_db_password"), () => randomSecret(32)),
  mediaDb: readOrCreate(join(MASTER, "media_db_password"), () => randomSecret(32)),
  redisController: readOrCreate(join(MASTER, "redis_controller_password"), () => randomSecret(32)),
  n8nRedis: readOrCreate(join(MASTER, "n8n_redis_password"), () => randomSecret(32)),
  automationDb: readOrCreate(join(MASTER, "automation_db_password"), () => randomSecret(32)),
  automationRedis: readOrCreate(join(MASTER, "automation_redis_password"), () => randomSecret(32)),
  automationEncryption: readOrCreate(join(MASTER, "automation_app_encryption_key"), () => randomBytes(32).toString("hex")),
  automationInternalAuth: readOrCreate(join(MASTER, "automation_internal_service_auth_secret"), () => randomSecret(48)),
  mysqlRoot: readOrCreate(join(MASTER, "mysql_root_password"), () => randomSecret(32)),
  mysqlController: readOrCreate(join(MASTER, "mysql_controller_password"), () => randomSecret(32)),
  mongoRoot: readOrCreate(join(MASTER, "mongo_root_password"), () => randomSecret(32)),
  mongoController: readOrCreate(join(MASTER, "mongo_controller_password"), () => randomSecret(32)),
  mongoKeyfile: readOrCreate(join(MASTER, "mongo_replica_keyfile"), () => randomBytes(48).toString("base64")),
  n8nEncryption: readOrCreate(join(MASTER, "n8n_encryption_key"), () => randomSecret(48)),
  mediaAdminToken: readOrCreate(join(MASTER, "media_admin_token"), () => randomSecret(48)),
  dockerAgentToken: readOrCreate(join(MASTER, "docker_agent_token"), () => randomSecret(48)),
  vaultKey: readOrCreate(join(MASTER, "credential_vault_key"), () => randomBytes(32).toString("base64url")),
  authSession: readOrCreate(join(MASTER, "auth_session_secret"), () => randomSecret(48)),
};

const adminHashPath = join(MASTER, "admin_password_hash");
let adminHash;
if (existsSync(adminHashPath) && readFileSync(adminHashPath, "utf8").trim()) {
  adminHash = readFileSync(adminHashPath, "utf8").trim();
} else {
  const supplied = (process.env.VSM_ADMIN_PASSWORD || "").trim();
  const adminPassword = supplied || randomSecret(24);
  const salt = randomBytes(16);
  const hash = scryptSync(adminPassword, salt, 32);
  adminHash = `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
  writeSecret(adminHashPath, adminHash);
  writeSecret(join(BOOTSTRAP, "admin_initial_password"), adminPassword, uid.root, uid.root, 0o600);
}

const copies = [
  ["postgres/postgres_superuser_password", values.postgresSuperuser, uid.postgres],
  ["postgres/platform_controller_password", values.postgresController, uid.postgres],
  ["postgres/platform_app_password", values.platformApp, uid.postgres],
  ["postgres/n8n_db_password", values.n8nDb, uid.postgres],
  ["postgres/media_db_password", values.mediaDb, uid.postgres],

  ["redis/platform_controller_password", values.redisController, uid.root],
  ["redis/n8n_queue_password", values.n8nRedis, uid.root],
  ["redis/automation_app_password", values.automationRedis, uid.root],

  ["mysql/root_password", values.mysqlRoot, uid.db],
  ["mysql/controller_password", values.mysqlController, uid.db],

  ["mongodb/root_password", values.mongoRoot, uid.db],
  ["mongodb/replica_keyfile", values.mongoKeyfile, uid.db],
  ["mongodb/controller_password", values.mongoController, uid.root],

  ["n8n/db_password", values.n8nDb, uid.node],
  ["n8n/redis_password", values.n8nRedis, uid.node],
  ["n8n/encryption_key", values.n8nEncryption, uid.node],

  ["automation/db_password", values.automationDb, uid.node],
  ["automation/redis_password", values.automationRedis, uid.node],
  ["automation/app_encryption_key", values.automationEncryption, uid.node],
  ["automation/internal_service_auth_secret", values.automationInternalAuth, uid.node],

  ["media/db_password", values.mediaDb, uid.node],
  ["media/admin_token", values.mediaAdminToken, uid.node],

  ["docker-agent/control_token", values.dockerAgentToken, uid.root],

  ["platform-admin/admin_password_hash", adminHash, uid.nextjs],
  ["platform-admin/auth_session_secret", values.authSession, uid.nextjs],
  ["platform-admin/credential_vault_key", values.vaultKey, uid.nextjs],
  ["platform-admin/postgres_controller_password", values.postgresController, uid.nextjs],
  ["platform-admin/platform_app_password", values.platformApp, uid.nextjs],
  ["platform-admin/redis_controller_password", values.redisController, uid.nextjs],
  ["platform-admin/mysql_controller_password", values.mysqlController, uid.nextjs],
  ["platform-admin/mongo_controller_password", values.mongoController, uid.nextjs],
  ["platform-admin/docker_agent_token", values.dockerAgentToken, uid.nextjs],
  ["platform-admin/media_admin_token", values.mediaAdminToken, uid.nextjs],
];

for (const [relative, value, owner] of copies) {
  writeSecret(join(SECRETS, relative), value, owner, owner);
}

chmodSync(join(SECRETS, "mongodb", "replica_keyfile"), 0o400);

writeFileSync(
  join(BOOTSTRAP, "README.txt"),
  [
    "VSM runtime secrets were generated idempotently.",
    "Initial Platform Admin password: /srv/vsm/bootstrap/admin_initial_password",
    "Do not copy /srv/vsm/secrets into Git.",
    "",
  ].join("\n"),
  { mode: 0o600 },
);

console.log("VSM runtime directories and secrets are ready.");
console.log(`Initial admin password file: ${join(BOOTSTRAP, "admin_initial_password")}`);
