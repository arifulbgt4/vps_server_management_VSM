import http from "node:http";
import {
  createReadStream,
  createWriteStream,
  openSync,
  readSync,
  closeSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import pg from "pg";
import Busboy from "busboy";

const { Pool } = pg;

const PORT = Number(process.env.PORT || 8080);
const STORAGE_ROOT = path.resolve(process.env.MEDIA_STORAGE_ROOT || "/storage");
const DB_PASSWORD_FILE = process.env.MEDIA_DB_PASSWORD_FILE || "/run/secrets/db_password";
const ADMIN_TOKEN_FILE = process.env.MEDIA_ADMIN_TOKEN_FILE || "/run/secrets/admin_token";
const PUBLIC_BASE_URL = String(process.env.MEDIA_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const PUBLIC_FILES_ENABLED = String(process.env.MEDIA_PUBLIC_FILES_ENABLED || "true") === "true";
const MAX_UPLOAD_BYTES = Number(process.env.MEDIA_MAX_UPLOAD_BYTES || 512 * 1024 * 1024);
const MIN_FREE_BYTES = Number(process.env.MEDIA_MIN_FREE_BYTES || 5 * 1024 * 1024 * 1024);
const ALLOW_OTHER_FILES = String(process.env.MEDIA_ALLOW_OTHER_FILES || "false") === "true";

const ADMIN_TOKEN = readFileSync(ADMIN_TOKEN_FILE, "utf8").trim();
const DB_PASSWORD = readFileSync(DB_PASSWORD_FILE, "utf8").trim();

for (const directory of [STORAGE_ROOT, path.join(STORAGE_ROOT, ".tmp"), path.join(STORAGE_ROOT, ".trash")]) {
  mkdirSync(directory, { recursive: true });
}

const pool = new Pool({
  host: process.env.MEDIA_DB_HOST || "postgres",
  port: Number(process.env.MEDIA_DB_PORT || 5432),
  database: process.env.MEDIA_DB_NAME || "media_service",
  user: process.env.MEDIA_DB_USER || "media_app",
  password: DB_PASSWORD,
  max: Number(process.env.MEDIA_DB_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (error) => console.error("PostgreSQL pool error:", error));

const EXACT_ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/json",
  "application/xml",
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/rtf",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "text/plain",
  "text/csv",
  "text/markdown",
]);
const ALLOWED_MIME_PREFIXES = ["image/", "video/", "audio/"];
const BLOCKED_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".sh", ".bash", ".bat", ".cmd", ".com", ".scr", ".msi",
  ".apk", ".jar", ".php", ".phtml", ".html", ".htm", ".svg", ".js", ".mjs", ".cjs",
]);

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function errorJson(res, status, code, message, extra = {}) {
  json(res, status, { error: code, message, ...extra });
}

function readBearer(req) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function safeTokenEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function requireAdmin(req) {
  return safeTokenEqual(readBearer(req), ADMIN_TOKEN);
}

function apiKeyHash(apiKey) {
  return createHash("sha256").update(apiKey).digest("hex");
}

function generateApiKey() {
  const secret = randomBytes(32).toString("base64url");
  return `ms_live_${secret}`;
}

function apiKeyPrefix(apiKey) {
  return apiKey.slice(0, 16);
}

async function authenticateUser(req) {
  const apiKey = readBearer(req);
  if (!apiKey.startsWith("ms_live_")) return null;
  const result = await pool.query(
    `SELECT id, name, quota_bytes, used_bytes, is_active, api_key_prefix, created_at, updated_at
       FROM media_users
      WHERE api_key_hash = $1
      LIMIT 1`,
    [apiKeyHash(apiKey)],
  );
  const user = result.rows[0];
  return user?.is_active ? user : null;
}

function parseJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function normalizeBigInt(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function serializeUser(row) {
  const quota = normalizeBigInt(row.quota_bytes);
  const used = normalizeBigInt(row.used_bytes) || 0;
  return {
    id: row.id,
    name: row.name,
    api_key_prefix: row.api_key_prefix,
    quota_bytes: quota,
    used_bytes: used,
    available_bytes: quota === null ? null : Math.max(0, quota - used),
    usage_percent: quota && quota > 0 ? Math.min(100, (used / quota) * 100) : 0,
    file_count: Number(row.file_count || 0),
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function serializeFile(row) {
  const publicUrl = row.visibility === "public" && PUBLIC_FILES_ENABLED && PUBLIC_BASE_URL
    ? `${PUBLIC_BASE_URL}/f/${row.id}`
    : null;
  return {
    id: row.id,
    user_id: row.user_id,
    original_name: row.original_name,
    mime_type: row.mime_type,
    extension: row.extension,
    size_bytes: normalizeBigInt(row.size_bytes) || 0,
    kind: row.kind,
    visibility: row.visibility,
    checksum_sha256: row.checksum_sha256,
    public_url: publicUrl,
    content_url: `/api/v1/files/${row.id}/content`,
    created_at: row.created_at,
  };
}

function fileKind(mime) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (
    mime.includes("word") || mime.includes("excel") || mime.includes("spreadsheet")
    || mime.includes("powerpoint") || mime.includes("presentation") || mime.includes("opendocument")
    || mime === "application/rtf" || mime.startsWith("text/")
  ) return "document";
  if (mime.includes("zip") || mime.includes("gzip")) return "archive";
  return "other";
}

function isAllowedMime(mime) {
  if (EXACT_ALLOWED_MIME_TYPES.has(mime)) return true;
  if (ALLOWED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) return true;
  return ALLOW_OTHER_FILES;
}

function safeExtension(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  if (!ext || ext.length > 12 || !/^\.[a-z0-9]+$/.test(ext)) return "";
  return ext;
}

function signatureLooksValid(filepath, mime) {
  const descriptor = openSync(filepath, "r");
  const head = Buffer.alloc(32);
  let bytesRead = 0;
  try {
    bytesRead = readSync(descriptor, head, 0, head.length, 0);
  } finally {
    closeSync(descriptor);
  }
  const sample = head.subarray(0, bytesRead);
  if (mime === "application/pdf") return sample.subarray(0, 5).toString() === "%PDF-";
  if (mime === "image/png") return sample.length >= 8 && sample.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if (mime === "image/jpeg") return sample.length >= 3 && sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff;
  if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(sample.subarray(0, 6).toString());
  if (mime === "image/webp") return sample.subarray(0, 4).toString() === "RIFF" && sample.subarray(8, 12).toString() === "WEBP";
  if (mime === "audio/wav" || mime === "audio/x-wav") return sample.subarray(0, 4).toString() === "RIFF" && sample.subarray(8, 12).toString() === "WAVE";
  if (mime === "audio/ogg" || mime === "video/ogg") return sample.subarray(0, 4).toString() === "OggS";
  if (mime === "video/webm" || mime === "audio/webm") return sample.length >= 4 && sample[0] === 0x1a && sample[1] === 0x45 && sample[2] === 0xdf && sample[3] === 0xa3;
  if (mime === "video/mp4" || mime === "audio/mp4" || mime === "video/quicktime") {
    return sample.length >= 12 && sample.subarray(4, 8).toString() === "ftyp";
  }
  if (mime === "application/zip" || mime === "application/x-zip-compressed" || mime.includes("openxmlformats")) {
    return sample.length >= 4 && sample[0] === 0x50 && sample[1] === 0x4b && [0x03, 0x05, 0x07].includes(sample[2]);
  }
  return true;
}

function validateUploadedFile(upload) {
  if (!upload.original_name || !upload.size_bytes) throw new Error("Uploaded file is empty");
  if (upload.size_bytes > MAX_UPLOAD_BYTES) throw new Error("File exceeds the server upload limit");

  const extension = safeExtension(upload.original_name);
  if (BLOCKED_EXTENSIONS.has(extension)) throw new Error(`Files with ${extension} extension are not allowed`);

  const mime = String(upload.mime_type || "application/octet-stream").toLowerCase().split(";")[0].trim();
  if (!isAllowedMime(mime)) throw new Error(`MIME type ${mime} is not allowed`);
  if (!signatureLooksValid(upload.temp_path, mime)) throw new Error("File signature does not match the declared MIME type");

  return { extension, mime, kind: fileKind(mime) };
}

function parseMultipartUpload(req) {
  return new Promise((resolve, reject) => {
    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: MAX_UPLOAD_BYTES, fields: 10, fieldSize: 64 * 1024 },
      });
    } catch (error) {
      reject(error);
      return;
    }

    let filePromise = null;
    let fileInfo = null;
    let visibility = "private";
    let tooLarge = false;
    let settled = false;

    const cleanup = () => {
      if (fileInfo?.temp_path && existsSync(fileInfo.temp_path)) {
        try { unlinkSync(fileInfo.temp_path); } catch {}
      }
    };

    busboy.on("field", (name, value) => {
      if (name === "visibility" && ["private", "public"].includes(value)) visibility = value;
    });

    busboy.on("file", (fieldname, file, info) => {
      if (fieldname !== "file" || filePromise) {
        file.resume();
        return;
      }

      const tempPath = path.join(STORAGE_ROOT, ".tmp", `${randomUUID()}.upload`);
      const hash = createHash("sha256");
      let size = 0;
      fileInfo = {
        temp_path: tempPath,
        original_name: info.filename || "upload.bin",
        mime_type: info.mimeType || "application/octet-stream",
      };

      file.on("data", (chunk) => {
        size += chunk.length;
        hash.update(chunk);
      });
      file.on("limit", () => { tooLarge = true; });

      const output = createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
      filePromise = pipeline(file, output).then(() => ({
        ...fileInfo,
        size_bytes: size,
        checksum_sha256: hash.digest("hex"),
      }));
    });

    busboy.on("error", (error) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    busboy.on("finish", async () => {
      if (settled) return;
      try {
        if (!filePromise) throw new Error("multipart field 'file' is required");
        const result = await filePromise;
        if (tooLarge) throw new Error("File exceeds the server upload limit");
        settled = true;
        resolve({ ...result, visibility });
      } catch (error) {
        cleanup();
        settled = true;
        reject(error);
      }
    });

    req.on("aborted", () => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(new Error("Upload aborted"));
      }
    });

    req.pipe(busboy);
  });
}

function storageMetrics() {
  const stats = statfsSync(STORAGE_ROOT);
  const blockSize = Number(stats.bsize || 0);
  const total = blockSize * Number(stats.blocks || 0);
  const free = blockSize * Number(stats.bfree || 0);
  const available = blockSize * Number(stats.bavail || 0);
  return {
    total_bytes: total,
    used_bytes: Math.max(0, total - free),
    available_bytes: Math.max(0, available),
    reserved_bytes: MIN_FREE_BYTES,
    upload_available_bytes: Math.max(0, available - MIN_FREE_BYTES),
  };
}

function ensureServerHasSpace(sizeBytes) {
  const metrics = storageMetrics();
  if (sizeBytes > metrics.upload_available_bytes) {
    const error = new Error("Server storage reserve would be exceeded");
    error.code = "server_storage_full";
    error.metrics = metrics;
    throw error;
  }
}

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_users (
      id uuid PRIMARY KEY,
      name text UNIQUE NOT NULL,
      api_key_prefix text NOT NULL,
      api_key_hash char(64) UNIQUE NOT NULL,
      quota_bytes bigint NULL CHECK (quota_bytes IS NULL OR quota_bytes >= 0),
      used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS media_files (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES media_users(id) ON DELETE CASCADE,
      original_name text NOT NULL,
      storage_path text NOT NULL UNIQUE,
      storage_name text NOT NULL,
      mime_type text NOT NULL,
      extension text NOT NULL DEFAULT '',
      size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
      kind text NOT NULL,
      visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
      checksum_sha256 char(64) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS media_files_user_created_idx
      ON media_files(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS media_files_checksum_idx
      ON media_files(user_id, checksum_sha256);
  `);
}

async function createMediaUser(input) {
  const name = String(input.name || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{1,79}$/.test(name)) {
    throw new Error("User name must be 2-80 characters using letters, numbers, spaces, dot, dash or underscore");
  }
  const quota = input.quota_bytes === null || input.quota_bytes === "" || input.quota_bytes === undefined
    ? null
    : Number(input.quota_bytes);
  if (quota !== null && (!Number.isFinite(quota) || quota < 0 || quota > Number.MAX_SAFE_INTEGER)) {
    throw new Error("quota_bytes must be a positive integer or null for unlimited");
  }

  const id = randomUUID();
  const apiKey = generateApiKey();
  const result = await pool.query(
    `INSERT INTO media_users (id, name, api_key_prefix, api_key_hash, quota_bytes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [id, name, apiKeyPrefix(apiKey), apiKeyHash(apiKey), quota === null ? null : Math.floor(quota)],
  );
  return { user: serializeUser(result.rows[0]), api_key: apiKey };
}

async function listMediaUsers() {
  const result = await pool.query(`
    SELECT u.*, count(f.id)::bigint AS file_count
      FROM media_users u
      LEFT JOIN media_files f ON f.user_id = u.id
     GROUP BY u.id
     ORDER BY u.created_at DESC
  `);
  return result.rows.map(serializeUser);
}

async function updateMediaUser(id, input) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query("SELECT * FROM media_users WHERE id = $1 FOR UPDATE", [id]);
    if (!current.rows[0]) throw new Error("Media user not found");

    let name = current.rows[0].name;
    let quota = normalizeBigInt(current.rows[0].quota_bytes);
    let active = Boolean(current.rows[0].is_active);

    if (input.name !== undefined) {
      name = String(input.name || "").trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{1,79}$/.test(name)) throw new Error("Invalid user name");
    }
    if (Object.prototype.hasOwnProperty.call(input, "quota_bytes")) {
      quota = input.quota_bytes === null || input.quota_bytes === "" ? null : Number(input.quota_bytes);
      if (quota !== null && (!Number.isFinite(quota) || quota < 0 || quota > Number.MAX_SAFE_INTEGER)) {
        throw new Error("Invalid quota_bytes");
      }
      if (quota !== null && quota < Number(current.rows[0].used_bytes || 0)) {
        throw new Error("Quota cannot be lower than the user's current storage usage");
      }
    }
    if (input.is_active !== undefined) active = Boolean(input.is_active);

    const result = await client.query(
      `UPDATE media_users
          SET name = $2, quota_bytes = $3, is_active = $4, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, name, quota === null ? null : Math.floor(quota), active],
    );
    await client.query("COMMIT");
    return serializeUser(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function rotateMediaUserKey(id) {
  const apiKey = generateApiKey();
  const result = await pool.query(
    `UPDATE media_users
        SET api_key_prefix = $2, api_key_hash = $3, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, apiKeyPrefix(apiKey), apiKeyHash(apiKey)],
  );
  if (!result.rows[0]) throw new Error("Media user not found");
  return { user: serializeUser(result.rows[0]), api_key: apiKey };
}

async function uploadForUser(userId, req) {
  const upload = await parseMultipartUpload(req);
  let finalPath = null;

  try {
    const validated = validateUploadedFile(upload);
    ensureServerHasSpace(upload.size_bytes);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        "SELECT * FROM media_users WHERE id = $1 FOR UPDATE",
        [userId],
      );
      const user = locked.rows[0];
      if (!user || !user.is_active) throw new Error("Media user is inactive or does not exist");

      const quota = normalizeBigInt(user.quota_bytes);
      const used = Number(user.used_bytes || 0);
      if (quota !== null && used + upload.size_bytes > quota) {
        const error = new Error("Storage quota exceeded");
        error.code = "storage_quota_exceeded";
        error.quota_bytes = quota;
        error.used_bytes = used;
        error.available_bytes = Math.max(0, quota - used);
        throw error;
      }

      const now = new Date();
      const id = randomUUID();
      const relativeDir = path.join(userId, String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, "0"));
      const absoluteDir = path.join(STORAGE_ROOT, relativeDir);
      mkdirSync(absoluteDir, { recursive: true });

      const storageName = `${id}${validated.extension}`;
      const relativePath = path.join(relativeDir, storageName);
      finalPath = path.join(STORAGE_ROOT, relativePath);
      renameSync(upload.temp_path, finalPath);

      const inserted = await client.query(
        `INSERT INTO media_files (
          id, user_id, original_name, storage_path, storage_name, mime_type,
          extension, size_bytes, kind, visibility, checksum_sha256
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *`,
        [
          id, userId, upload.original_name, relativePath, storageName, validated.mime,
          validated.extension, upload.size_bytes, validated.kind, upload.visibility, upload.checksum_sha256,
        ],
      );

      await client.query(
        "UPDATE media_users SET used_bytes = used_bytes + $2, updated_at = now() WHERE id = $1",
        [userId, upload.size_bytes],
      );
      await client.query("COMMIT");
      finalPath = null;
      return serializeFile(inserted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      if (finalPath && existsSync(finalPath)) {
        try { unlinkSync(finalPath); } catch {}
      }
      throw error;
    } finally {
      client.release();
    }
  } finally {
    if (existsSync(upload.temp_path)) {
      try { unlinkSync(upload.temp_path); } catch {}
    }
  }
}

async function listFilesForUser(userId, query) {
  const limit = Math.min(200, Math.max(1, Number(query.get("limit") || 50)));
  const offset = Math.max(0, Number(query.get("offset") || 0));
  const result = await pool.query(
    `SELECT * FROM media_files
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  const count = await pool.query("SELECT count(*)::bigint AS total FROM media_files WHERE user_id = $1", [userId]);
  return { files: result.rows.map(serializeFile), total: Number(count.rows[0]?.total || 0), limit, offset };
}

async function getFileForUser(userId, fileId) {
  const result = await pool.query("SELECT * FROM media_files WHERE id = $1 AND user_id = $2", [fileId, userId]);
  return result.rows[0] || null;
}

async function markFileVisibility(userId, fileId, visibility) {
  if (!["private", "public"].includes(visibility)) throw new Error("visibility must be private or public");
  const result = await pool.query(
    `UPDATE media_files SET visibility = $3 WHERE id = $1 AND user_id = $2 RETURNING *`,
    [fileId, userId, visibility],
  );
  if (!result.rows[0]) throw new Error("File not found");
  return serializeFile(result.rows[0]);
}

async function hardDeleteFile(fileId, expectedUserId = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT * FROM media_files
        WHERE id = $1 ${expectedUserId ? "AND user_id = $2" : ""}
        FOR UPDATE`,
      expectedUserId ? [fileId, expectedUserId] : [fileId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("File not found");

    const original = path.join(STORAGE_ROOT, row.storage_path);
    const trash = path.join(STORAGE_ROOT, ".trash", `${row.id}-${randomUUID()}`);
    if (existsSync(original)) renameSync(original, trash);

    try {
      await client.query("DELETE FROM media_files WHERE id = $1", [row.id]);
      await client.query(
        `UPDATE media_users
            SET used_bytes = GREATEST(0, used_bytes - $2), updated_at = now()
          WHERE id = $1`,
        [row.user_id, row.size_bytes],
      );
      await client.query("COMMIT");
      if (existsSync(trash)) rmSync(trash, { force: true });
      return { deleted: true, id: row.id, freed_bytes: Number(row.size_bytes || 0) };
    } catch (error) {
      await client.query("ROLLBACK");
      if (existsSync(trash) && !existsSync(original)) {
        mkdirSync(path.dirname(original), { recursive: true });
        renameSync(trash, original);
      }
      throw error;
    }
  } finally {
    client.release();
  }
}

async function hardDeleteUser(userId) {
  const client = await pool.connect();
  const originalDir = path.join(STORAGE_ROOT, userId);
  let trashDir = null;
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT * FROM media_users WHERE id = $1 FOR UPDATE", [userId]);
    if (!locked.rows[0]) throw new Error("Media user not found");
    await client.query("UPDATE media_users SET is_active = false, updated_at = now() WHERE id = $1", [userId]);
    await client.query("COMMIT");

    if (existsSync(originalDir)) {
      trashDir = path.join(STORAGE_ROOT, ".trash", `user-${userId}-${randomUUID()}`);
      renameSync(originalDir, trashDir);
    }

    await client.query("BEGIN");
    const summary = await client.query(
      "SELECT count(*)::bigint AS files, COALESCE(sum(size_bytes),0)::bigint AS bytes FROM media_files WHERE user_id = $1",
      [userId],
    );
    const deleted = await client.query("DELETE FROM media_users WHERE id = $1 RETURNING id", [userId]);
    if (!deleted.rows[0]) throw new Error("Media user not found");
    await client.query("COMMIT");

    if (trashDir && existsSync(trashDir)) rmSync(trashDir, { recursive: true, force: true });
    return {
      deleted: true,
      id: userId,
      files_deleted: Number(summary.rows[0]?.files || 0),
      bytes_freed: Number(summary.rows[0]?.bytes || 0),
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    if (trashDir && existsSync(trashDir) && !existsSync(originalDir)) {
      renameSync(trashDir, originalDir);
    }
    try {
      await pool.query("UPDATE media_users SET is_active = true, updated_at = now() WHERE id = $1", [userId]);
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}

function sendFile(req, res, row, forceAttachment = false) {
  const absolute = path.join(STORAGE_ROOT, row.storage_path);
  if (!existsSync(absolute)) {
    errorJson(res, 404, "file_missing", "File content is missing from storage");
    return;
  }
  const stats = statSync(absolute);
  const inline = !forceAttachment && (
    row.kind === "image" || row.kind === "video" || row.kind === "audio" || row.kind === "pdf"
  );
  const safeName = String(row.original_name || "file").replace(/["\r\n]/g, "_");
  res.writeHead(200, {
    "content-type": row.mime_type || "application/octet-stream",
    "content-length": stats.size,
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"`,
    "x-content-type-options": "nosniff",
    "cache-control": row.visibility === "public" ? "public, max-age=3600" : "private, no-store",
  });
  createReadStream(absolute).pipe(res);
}

async function adminOverview() {
  const [users, files] = await Promise.all([
    pool.query("SELECT count(*)::bigint AS count, COALESCE(sum(used_bytes),0)::bigint AS bytes FROM media_users"),
    pool.query("SELECT count(*)::bigint AS count, COALESCE(sum(size_bytes),0)::bigint AS bytes FROM media_files"),
  ]);
  return {
    users: Number(users.rows[0]?.count || 0),
    files: Number(files.rows[0]?.count || 0),
    stored_bytes: Number(files.rows[0]?.bytes || 0),
    filesystem: storageMetrics(),
    max_upload_bytes: MAX_UPLOAD_BYTES,
    public_files_enabled: PUBLIC_FILES_ENABLED,
    public_base_url: PUBLIC_BASE_URL || null,
  };
}

async function route(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/healthz") {
    try {
      await pool.query("SELECT 1");
      json(res, 200, { status: "ok" });
    } catch {
      errorJson(res, 503, "database_unavailable", "PostgreSQL is unavailable");
    }
    return;
  }

  const publicMatch = pathname.match(/^\/f\/([0-9a-f-]{36})$/i);
  if (req.method === "GET" && publicMatch) {
    if (!PUBLIC_FILES_ENABLED) return errorJson(res, 404, "not_found", "Public files are disabled");
    const result = await pool.query(
      "SELECT * FROM media_files WHERE id = $1 AND visibility = 'public'",
      [publicMatch[1]],
    );
    if (!result.rows[0]) return errorJson(res, 404, "not_found", "File not found");
    return sendFile(req, res, result.rows[0]);
  }

  if (pathname.startsWith("/api/v1/admin/")) {
    if (!requireAdmin(req)) return errorJson(res, 401, "unauthorized", "Invalid admin token");

    if (req.method === "GET" && pathname === "/api/v1/admin/overview") {
      return json(res, 200, await adminOverview());
    }
    if (req.method === "GET" && pathname === "/api/v1/admin/users") {
      return json(res, 200, { users: await listMediaUsers() });
    }
    if (req.method === "POST" && pathname === "/api/v1/admin/users") {
      const body = await parseJsonBody(req);
      return json(res, 201, await createMediaUser(body));
    }

    const userMatch = pathname.match(/^\/api\/v1\/admin\/users\/([0-9a-f-]{36})$/i);
    if (userMatch && req.method === "PATCH") {
      return json(res, 200, { user: await updateMediaUser(userMatch[1], await parseJsonBody(req)) });
    }
    if (userMatch && req.method === "DELETE") {
      if (url.searchParams.get("confirm") !== "true") {
        return errorJson(res, 400, "confirmation_required", "Add ?confirm=true to permanently delete this user and all files");
      }
      return json(res, 200, await hardDeleteUser(userMatch[1]));
    }

    const rotateMatch = pathname.match(/^\/api\/v1\/admin\/users\/([0-9a-f-]{36})\/rotate-key$/i);
    if (rotateMatch && req.method === "POST") {
      return json(res, 200, await rotateMediaUserKey(rotateMatch[1]));
    }

    const filesMatch = pathname.match(/^\/api\/v1\/admin\/users\/([0-9a-f-]{36})\/files$/i);
    if (filesMatch && req.method === "GET") {
      return json(res, 200, await listFilesForUser(filesMatch[1], url.searchParams));
    }

    const adminFileMatch = pathname.match(/^\/api\/v1\/admin\/files\/([0-9a-f-]{36})$/i);
    if (adminFileMatch && req.method === "DELETE") {
      return json(res, 200, await hardDeleteFile(adminFileMatch[1]));
    }

    return errorJson(res, 404, "not_found", "Admin endpoint not found");
  }

  if (pathname.startsWith("/api/v1/")) {
    const user = await authenticateUser(req);
    if (!user) return errorJson(res, 401, "unauthorized", "Invalid or inactive media API key");

    if (req.method === "GET" && pathname === "/api/v1/storage") {
      const refreshed = await pool.query(
        `SELECT u.*, count(f.id)::bigint AS file_count
           FROM media_users u
           LEFT JOIN media_files f ON f.user_id = u.id
          WHERE u.id = $1
          GROUP BY u.id`,
        [user.id],
      );
      return json(res, 200, { storage: serializeUser(refreshed.rows[0]), server: storageMetrics() });
    }

    if (req.method === "POST" && pathname === "/api/v1/files") {
      const file = await uploadForUser(user.id, req);
      return json(res, 201, { file });
    }

    if (req.method === "GET" && pathname === "/api/v1/files") {
      return json(res, 200, await listFilesForUser(user.id, url.searchParams));
    }

    const contentMatch = pathname.match(/^\/api\/v1\/files\/([0-9a-f-]{36})\/content$/i);
    if (contentMatch && req.method === "GET") {
      const row = await getFileForUser(user.id, contentMatch[1]);
      if (!row) return errorJson(res, 404, "not_found", "File not found");
      return sendFile(req, res, row);
    }

    const fileMatch = pathname.match(/^\/api\/v1\/files\/([0-9a-f-]{36})$/i);
    if (fileMatch && req.method === "GET") {
      const row = await getFileForUser(user.id, fileMatch[1]);
      if (!row) return errorJson(res, 404, "not_found", "File not found");
      return json(res, 200, { file: serializeFile(row) });
    }
    if (fileMatch && req.method === "PATCH") {
      const body = await parseJsonBody(req);
      return json(res, 200, { file: await markFileVisibility(user.id, fileMatch[1], body.visibility) });
    }
    if (fileMatch && req.method === "DELETE") {
      return json(res, 200, await hardDeleteFile(fileMatch[1], user.id));
    }

    return errorJson(res, 404, "not_found", "API endpoint not found");
  }

  errorJson(res, 404, "not_found", "Not found");
}

await runMigrations();

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    console.error(`${req.method || "REQUEST"} ${req.url || "/"}:`, error);
    const code = error?.code || "request_failed";
    const status =
      code === "storage_quota_exceeded" ? 413
      : code === "server_storage_full" ? 507
      : /not found/i.test(error?.message || "") ? 404
      : /invalid|must|quota|allowed|signature|required|exceeds/i.test(error?.message || "") ? 400
      : 500;
    errorJson(res, status, code, error instanceof Error ? error.message : "Media service request failed", {
      ...(error?.quota_bytes !== undefined ? { quota_bytes: error.quota_bytes } : {}),
      ...(error?.used_bytes !== undefined ? { used_bytes: error.used_bytes } : {}),
      ...(error?.available_bytes !== undefined ? { available_bytes: error.available_bytes } : {}),
      ...(error?.metrics ? { filesystem: error.metrics } : {}),
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Media service listening on ${PORT}`);
  console.log(`Storage root: ${STORAGE_ROOT}`);
  console.log(`Public files: ${PUBLIC_FILES_ENABLED ? "enabled" : "disabled"}`);
});
