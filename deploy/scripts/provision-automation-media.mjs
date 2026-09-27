import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const accountName = "n8n-automation-shared";
const baseUrl = process.env.MEDIA_BASE_URL || "http://media-service:8080";
const keyFile = process.env.MEDIA_API_KEY_FILE || "/run/media-credentials/media_api_key";
const adminTokenFile = process.env.MEDIA_ADMIN_TOKEN_FILE || "/run/secrets/media_admin_token";
const recoverExisting = process.env.MEDIA_RECOVER_EXISTING === "1";

async function request(path, token, options = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!response.ok) throw new Error(`Media Service rejected ${path} (HTTP ${response.status})`);
  return response.json();
}

function readExistingKey() {
  let metadata;
  try {
    metadata = lstatSync(keyFile);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Shared media key file must be a private regular file (mode 0600)");
  }
  const key = readFileSync(keyFile, "utf8").trim();
  if (!/^ms_live_[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error("Shared media key file is empty or invalid");
  }
  return key;
}

function verifyWritableDirectory() {
  const directory = dirname(keyFile);
  accessSync(directory, constants.R_OK | constants.W_OK);
  const probe = `${keyFile}.${randomUUID()}.probe`;
  const descriptor = openSync(probe, "wx", 0o600);
  closeSync(descriptor);
  unlinkSync(probe);
}

async function validateExistingKey(key) {
  const response = await request("/api/v1/storage", key);
  if (response.storage?.name !== accountName || !response.storage?.is_active) {
    throw new Error("Existing shared media key does not belong to the active automation account");
  }
  console.log("Shared automation media credential is valid; no changes made.");
}

async function provisionMissingKey() {
  verifyWritableDirectory();
  // Compose holds an OS flock while this entire operation runs. Recheck after
  // acquiring it because another run may have created the key while waiting.
  const racedKey = readExistingKey();
  if (racedKey) return validateExistingKey(racedKey);

  const adminToken = readFileSync(adminTokenFile, "utf8").trim();
  if (!adminToken) throw new Error("Media admin token file is empty");
  const listed = await request("/api/v1/admin/users", adminToken);
  if (!Array.isArray(listed.users)) throw new Error("Media user listing is invalid");
  const existingAccount = listed.users.find((user) => user.name === accountName);
  if (existingAccount && !recoverExisting) {
    throw new Error("Automation media account exists without its local key; use explicit recovery before retrying");
  }
  if (existingAccount && !existingAccount.is_active) {
    throw new Error("Existing automation media account is inactive; resolve it before recovery");
  }

  const created = existingAccount
    ? await request(`/api/v1/admin/users/${existingAccount.id}/rotate-key`, adminToken, { method: "POST" })
    : await request("/api/v1/admin/users", adminToken, {
      method: "POST",
      body: JSON.stringify({ name: accountName, quota_bytes: null }),
    });
  if (created.user?.name !== accountName || !/^ms_live_[A-Za-z0-9_-]+$/.test(created.api_key || "")) {
    throw new Error("Media Service returned an invalid automation account or key");
  }
  writeFileSync(keyFile, `${created.api_key}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(keyFile, 0o600);
  console.log(existingAccount
    ? "Shared automation media key was explicitly rotated and saved privately."
    : "Shared automation media account and private key file are ready.");
}

async function main() {
  const existingKey = readExistingKey();
  if (existingKey) return validateExistingKey(existingKey);
  await provisionMissingKey();
}

main().catch((error) => {
  console.error(`Automation media provisioning failed: ${error.message}`);
  process.exitCode = 1;
});
