import { randomBytes, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";

const password = readFileSync(0, "utf8").trimEnd();

if (password.length < 12) {
  console.error("Password must be at least 12 characters.");
  process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(password, salt, 64);

process.stdout.write(
  `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}\n`,
);
