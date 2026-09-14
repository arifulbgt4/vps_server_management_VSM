import { readFileSync } from "node:fs";
import {
  credentialUsers,
  deleteCredential,
  getCredential,
  setCredential,
} from "@/lib/credential-vault";

const MEDIA_URL = process.env.MEDIA_SERVICE_URL || "http://media-service:8080";
const MEDIA_API_KEY_SERVICE = "media-user-api-key";

function adminToken() {
  const path = process.env.MEDIA_ADMIN_TOKEN_FILE;
  if (!path) throw new Error("MEDIA_ADMIN_TOKEN_FILE is not configured");
  return readFileSync(path, "utf8").trim();
}

async function mediaRequest(path: string, init?: RequestInit) {
  const response = await fetch(`${MEDIA_URL}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${adminToken()}`,
    },
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || data.error || `Media service returned ${response.status}`);
  }
  return data;
}

function assertId(value: unknown, label = "id") {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

export async function getMediaOverview() {
  return mediaRequest("/api/v1/admin/overview");
}

export async function listMediaUsers() {
  const data = await mediaRequest("/api/v1/admin/users");
  const storedKeys = await credentialUsers(MEDIA_API_KEY_SERVICE);
  return {
    ...data,
    users: (data.users || []).map((user: { id: string }) => ({
      ...user,
      api_key_stored: storedKeys.has(user.id),
    })),
  };
}

export async function listMediaFiles(userIdInput: unknown, limit = 100) {
  const userId = assertId(userIdInput, "user id");
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
  return mediaRequest(`/api/v1/admin/users/${encodeURIComponent(userId)}/files?limit=${safeLimit}`);
}

export async function createMediaUser(name: unknown, quotaBytes: unknown) {
  const data = await mediaRequest("/api/v1/admin/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      quota_bytes: quotaBytes === "" || quotaBytes === undefined ? null : quotaBytes,
    }),
  });

  if (data?.user?.id && typeof data.api_key === "string" && data.api_key) {
    await setCredential(MEDIA_API_KEY_SERVICE, data.user.id, data.api_key);
  }
  return data;
}

export async function updateMediaUser(
  userIdInput: unknown,
  input: { name?: unknown; quota_bytes?: unknown; is_active?: unknown },
) {
  const userId = assertId(userIdInput, "user id");
  return mediaRequest(`/api/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function rotateMediaUserKey(userIdInput: unknown) {
  const userId = assertId(userIdInput, "user id");
  const data = await mediaRequest(`/api/v1/admin/users/${encodeURIComponent(userId)}/rotate-key`, {
    method: "POST",
  });

  if (typeof data.api_key === "string" && data.api_key) {
    await setCredential(MEDIA_API_KEY_SERVICE, userId, data.api_key);
  }
  return data;
}

export async function revealMediaUserKey(userIdInput: unknown) {
  const userId = assertId(userIdInput, "user id");
  const apiKey = await getCredential(MEDIA_API_KEY_SERVICE, userId);
  if (!apiKey) {
    throw new Error("This API key is not stored in the encrypted vault. Rotate the key once to enable reveal.");
  }
  return { api_key: apiKey };
}

export async function deleteMediaUser(userIdInput: unknown) {
  const userId = assertId(userIdInput, "user id");
  const data = await mediaRequest(`/api/v1/admin/users/${encodeURIComponent(userId)}?confirm=true`, {
    method: "DELETE",
  });
  await deleteCredential(MEDIA_API_KEY_SERVICE, userId);
  return data;
}

export async function deleteMediaFile(fileIdInput: unknown) {
  const fileId = assertId(fileIdInput, "file id");
  return mediaRequest(`/api/v1/admin/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
  });
}
