import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { getPlatformDbPool } from "@/lib/platform-db";

let initialized = false;

function vaultKey() {
  const path = process.env.CREDENTIAL_VAULT_KEY_FILE;
  if (!path) throw new Error("CREDENTIAL_VAULT_KEY_FILE is not configured");

  const raw = readFileSync(path, "utf8").trim();
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error("Credential vault key must be a 32-byte hex value");
  }
  return key;
}

async function ensureTable() {
  if (initialized) return;

  await getPlatformDbPool().query(`
    CREATE TABLE IF NOT EXISTS credential_vault (
      service TEXT NOT NULL,
      username TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (service, username)
    )
  `);

  initialized = true;
}

function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", vaultKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: authTag.toString("base64url"),
  };
}

function decrypt(ciphertext: string, iv: string, authTag: string) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    vaultKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(authTag, "base64url"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}

export async function setCredential(
  service: string,
  username: string,
  password: string,
) {
  await ensureTable();
  const encrypted = encrypt(password);

  await getPlatformDbPool().query(
    `
      INSERT INTO credential_vault (
        service,
        username,
        ciphertext,
        iv,
        auth_tag,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (service, username)
      DO UPDATE SET
        ciphertext = EXCLUDED.ciphertext,
        iv = EXCLUDED.iv,
        auth_tag = EXCLUDED.auth_tag,
        updated_at = NOW()
    `,
    [
      service,
      username,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.authTag,
    ],
  );
}

export async function getCredential(service: string, username: string) {
  await ensureTable();

  const result = await getPlatformDbPool().query(
    `
      SELECT ciphertext, iv, auth_tag
      FROM credential_vault
      WHERE service = $1 AND username = $2
    `,
    [service, username],
  );

  if (!result.rowCount) return null;
  const row = result.rows[0];
  return decrypt(row.ciphertext, row.iv, row.auth_tag);
}

export async function credentialUsers(service: string) {
  await ensureTable();
  const result = await getPlatformDbPool().query(
    `SELECT username FROM credential_vault WHERE service = $1`,
    [service],
  );
  return new Set<string>(result.rows.map((row: { username: string }) => row.username));
}

export async function deleteCredential(service: string, username: string) {
  await ensureTable();
  await getPlatformDbPool().query(
    `DELETE FROM credential_vault WHERE service = $1 AND username = $2`,
    [service, username],
  );
}
