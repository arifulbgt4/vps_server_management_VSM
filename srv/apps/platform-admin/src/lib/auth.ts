import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { cookies } from "next/headers";

export const SESSION_COOKIE_NAME = "vsm_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

function readSecretFile(envName: string) {
  const path = process.env[envName];
  if (!path) throw new Error(`${envName} is not configured`);
  return readFileSync(path, "utf8").trim();
}

function safeEqualText(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sessionSecret() {
  return readSecretFile("AUTH_SESSION_SECRET_FILE");
}

function passwordHash() {
  return readSecretFile("ADMIN_PASSWORD_HASH_FILE");
}

function sign(payload: string) {
  return createHmac("sha256", sessionSecret())
    .update(payload)
    .digest("base64url");
}

export function createSessionToken() {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const nonce = randomBytes(24).toString("base64url");
  const payload = `v1.${expiresAt}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined) {
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;

  const [, expiresAtRaw, nonce, signature] = parts;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    return false;
  }

  if (!/^[A-Za-z0-9_-]{20,}$/.test(nonce)) return false;

  const payload = `v1.${expiresAt}.${nonce}`;
  return safeEqualText(signature, sign(payload));
}

export async function isAuthenticated() {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);
}

export function verifyAdminCredentials(username: unknown, password: unknown) {
  if (typeof username !== "string" || typeof password !== "string") return false;

  const configuredUsername = process.env.ADMIN_USERNAME || "admin";
  if (!safeEqualText(username, configuredUsername)) return false;

  const encoded = passwordHash();
  const [scheme, saltEncoded, hashEncoded] = encoded.split("$");
  if (scheme !== "scrypt" || !saltEncoded || !hashEncoded) {
    throw new Error("Admin password hash has an invalid format");
  }

  const salt = Buffer.from(saltEncoded, "base64url");
  const expected = Buffer.from(hashEncoded, "base64url");
  const actual = scryptSync(password, salt, expected.length);

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function secureCookieEnabled() {
  return process.env.AUTH_COOKIE_SECURE === "true";
}
