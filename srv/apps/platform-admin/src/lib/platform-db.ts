import { readFileSync } from "node:fs";

const { Pool } = require("pg");

let pool: any;

function readPassword() {
  const path = process.env.PLATFORM_DB_PASSWORD_FILE;
  if (!path) throw new Error("PLATFORM_DB_PASSWORD_FILE is not configured");
  return readFileSync(path, "utf8").trim();
}

export function getPlatformDbPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.PGHOST || "postgres",
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PLATFORM_DB_NAME || "platform_admin",
      user: process.env.PLATFORM_DB_USER || "platform_app",
      password: readPassword(),
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }

  return pool;
}
