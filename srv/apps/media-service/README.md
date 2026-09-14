# Media Storage Service

Production-oriented multi-user media/file storage for the VSM host.

The service supports images, video, audio, PDF, Office/OpenDocument files, text/CSV/Markdown and common archives. Each media user receives an independent bearer API key and optional storage quota. Physical files live on the VPS filesystem while ownership, metadata and quota accounting live in PostgreSQL.

Documentation examples use `example.com`. Replace them only in VPS runtime configuration.

## Architecture

```text
Internet
  -> HTTPS / host Nginx
  -> 127.0.0.1:8082
  -> platform-media
      ├── /storage
      └── postgres_net -> postgres:5432

Platform Admin
  -> media_net
  -> media-service:8080 admin API

n8n main + workers
  -> media_net
  -> media-service:8080 user/binary API
```

The host binding is loopback-only. Public traffic reaches the service through Nginx. Trusted same-VPS applications use `media_net`.

## Core behavior

```text
per-user bearer API keys
per-user quota in bytes / GiB in Platform Admin
transactional quota checks
host free-space reserve
private/public files
authenticated binary download
optional public file URLs
hard file deletion
hard user + all-files deletion
MIME/extension validation
UUID storage names
SHA-256 checksum per file
```

Blank quota means unlimited for that user, but the host reserve and per-file maximum still apply.

## Runtime layout

```text
/srv/apps/media-service/
├── compose.yml
├── Dockerfile
├── package.json
├── src/
│   └── server.mjs
├── .env
├── storage/
│   ├── .tmp/
│   ├── .trash/
│   └── <user-id>/<year>/<month>/<uuid>.<ext>
└── secrets/
    ├── db_password
    └── admin_token
```

`.env`, `storage/` and `secrets/` are ignored by Git.

## 1. PostgreSQL database and role

Use Platform Admin `/postgres` to create a dedicated database/role, for example:

```text
Database: media_service
User:     media_app
```

Do not use `postgres`, `platform_controller` or `platform_app` as the runtime Media identity.

## 2. Copy/update the app

```bash
cd /tmp/vps_server_management_VSM
git pull

sudo mkdir -p /srv/apps/media-service
sudo chown -R ariful:ariful /srv/apps/media-service

cp -a srv/apps/media-service/. /srv/apps/media-service/
```

## 3. Runtime directories and networks

```bash
cd /srv/apps/media-service
mkdir -p storage/.tmp storage/.trash secrets

docker network inspect media_net >/dev/null 2>&1 || docker network create media_net
docker network inspect postgres_net >/dev/null 2>&1 || docker network create postgres_net
```

If `.env` does not already exist:

```bash
cp .env.example .env
chmod 600 .env
```

Example runtime settings:

```env
MEDIA_DB_NAME=media_service
MEDIA_DB_USER=media_app
MEDIA_BIND_PORT=8082
MEDIA_PUBLIC_BASE_URL=https://media.example.com
MEDIA_PUBLIC_FILES_ENABLED=true
MEDIA_MAX_UPLOAD_BYTES=536870912
MEDIA_MIN_FREE_BYTES=5368709120
MEDIA_ALLOW_OTHER_FILES=false
MEDIA_DB_POOL_MAX=10
```

Defaults represented above:

```text
per-file maximum   512 MiB
host reserve       5 GiB
```

Per-user quota is independent from the per-file maximum.

## 4. Secrets

Write the PostgreSQL password without placing it in shell history:

```bash
read -s MEDIA_DB_PASSWORD
echo
printf '%s' "$MEDIA_DB_PASSWORD" > /srv/apps/media-service/secrets/db_password
unset MEDIA_DB_PASSWORD
```

Generate the media admin token once:

```bash
openssl rand -hex 32 > /srv/apps/media-service/secrets/admin_token
```

Permissions for the service UID/GID 1000:

```bash
sudo chown -R 1000:1000 /srv/apps/media-service/storage
sudo chown 1000:1000 /srv/apps/media-service/secrets/db_password
sudo chown 1000:1000 /srv/apps/media-service/secrets/admin_token
sudo chmod 700 /srv/apps/media-service/storage /srv/apps/media-service/secrets
sudo chmod 600 /srv/apps/media-service/secrets/db_password
sudo chmod 600 /srv/apps/media-service/secrets/admin_token
```

## 5. Start and health

```bash
cd /srv/apps/media-service

docker compose config
docker compose up -d --build
docker compose ps
docker logs platform-media --tail 100
```

Local health:

```bash
curl -fsS http://127.0.0.1:8082/healthz
```

Expected:

```json
{"status":"ok"}
```

The service creates its required media tables automatically in the configured database.

## 6. Nginx and HTTPS

```bash
sudo cp /srv/apps/media-service/nginx.conf.example /etc/nginx/sites-available/media
sudo nano /etc/nginx/sites-available/media
sudo ln -sf /etc/nginx/sites-available/media /etc/nginx/sites-enabled/media
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d media.example.com
```

Verify:

```bash
curl -fsS https://media.example.com/healthz
```

The public Nginx configuration streams uploads and must keep `/api/v1/admin/*` inaccessible from the public internet.

## 7. Platform Admin integration

Platform Admin reaches the private admin API through `media_net`.

Install a UID/GID 1001 copy of the admin token:

```bash
sudo install \
  -o 1001 -g 1001 -m 0600 \
  /srv/apps/media-service/secrets/admin_token \
  /srv/apps/platform-admin/secrets/media_admin_token
```

Manager URL:

```text
/media
```

The panel can:

```text
create users
set individual GiB quotas
show used/available storage
enable/disable users
rotate user API keys
show/hide/copy vault-backed API keys
list files
hard-delete files
hard-delete user + all owned files
view media/host storage usage
copy Next.js API examples
```

### API-key storage model

The Media Service itself stores only the API-key hash required for authentication.

Platform Admin separately stores an AES-256-GCM encrypted copy in its credential vault when a user is created or when the key is rotated. This enables authenticated Show/Hide/Copy behavior without changing the Media Service's hash-only authentication model.

An older key created before vault storage cannot be reconstructed from the Media Service hash. Rotate it once to create a new vault-backed key.

## 8. User API

Every authenticated request uses:

```http
Authorization: Bearer ms_live_...
```

Endpoints:

```text
GET    /api/v1/storage
POST   /api/v1/files
GET    /api/v1/files?limit=50&offset=0
GET    /api/v1/files/:id
GET    /api/v1/files/:id/content
PATCH  /api/v1/files/:id
DELETE /api/v1/files/:id
```

Upload form fields:

```text
file        required
visibility  optional: private | public
```

For `visibility=public`, the response includes a public URL when public file serving is enabled.

## 9. Recommended Next.js server-side usage

Keep the Media API key server-side:

```env
# .env.local
MEDIA_BASE_URL=https://media.example.com
MEDIA_API_KEY=ms_live_...
```

Example App Router handler pattern:

```ts
// app/api/media/route.ts
const baseUrl = process.env.MEDIA_BASE_URL!;
const apiKey = process.env.MEDIA_API_KEY!;

const auth = {
  Authorization: `Bearer ${apiKey}`,
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const fileId = url.searchParams.get("fileId");
  const mode = url.searchParams.get("mode");

  const path = fileId
    ? `/api/v1/files/${fileId}${mode === "content" ? "/content" : ""}`
    : mode === "storage"
      ? "/api/v1/storage"
      : "/api/v1/files";

  const response = await fetch(`${baseUrl}${path}`, {
    headers: auth,
    cache: "no-store",
  });

  if (mode === "content" && fileId) {
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") || "application/octet-stream",
      },
    });
  }

  return Response.json(await response.json(), { status: response.status });
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const response = await fetch(`${baseUrl}/api/v1/files`, {
    method: "POST",
    headers: auth,
    body: formData,
  });

  return Response.json(await response.json(), { status: response.status });
}

export async function DELETE(request: Request) {
  const fileId = new URL(request.url).searchParams.get("fileId");
  if (!fileId) return Response.json({ error: "fileId is required" }, { status: 400 });

  const response = await fetch(`${baseUrl}/api/v1/files/${fileId}`, {
    method: "DELETE",
    headers: auth,
  });

  return Response.json(await response.json(), { status: response.status });
}
```

This keeps `MEDIA_API_KEY` out of browser JavaScript.

## 10. n8n usage

n8n main and workers are attached to `media_net`, so workflows can avoid the public internet hop:

```text
http://media-service:8080/api/v1/files/<FILE_ID>/content
```

Use an HTTP Request node with the media user's bearer key and response format `File` when the workflow needs the actual binary.

For Messenger/Meta delivery, the workflow can fetch this binary, upload it to Meta's attachment API, obtain the provider attachment identifier, then send the message.

## 11. Admin API

Private-token-protected endpoints:

```text
GET    /api/v1/admin/overview
GET    /api/v1/admin/users
POST   /api/v1/admin/users
PATCH  /api/v1/admin/users/:id
POST   /api/v1/admin/users/:id/rotate-key
GET    /api/v1/admin/users/:id/files
DELETE /api/v1/admin/files/:id
DELETE /api/v1/admin/users/:id?confirm=true
```

Do not expose the media admin token to browsers or workflow data.

## 12. Quota semantics

An upload is accepted only when both conditions pass:

```text
used + incoming_size <= user_quota
AND
host_available - incoming_size >= MEDIA_MIN_FREE_BYTES
```

The user row is locked during the final quota check and commit, preventing concurrent uploads from both consuming the same remaining quota.

Quota cannot be reduced below current stored usage.

## 13. Hard-delete semantics

Individual file deletion:

```text
active file -> service trash -> DB metadata/quota commit -> trash removal
```

If the database operation fails, the file can be restored from the temporary trash location.

User deletion disables the account, removes the active storage tree, deletes the user/metadata, then permanently removes the staged storage tree.

External copies previously uploaded to Meta, S3 or another provider are outside this service and are not removed automatically by a local hard delete.

## 14. Backup requirements

To recover Media Storage, back up both:

```text
media PostgreSQL database
/srv/apps/media-service/storage
```

A database-only backup is insufficient because the physical file bytes are stored on disk.

## 15. Security defaults

```text
Host 8082 is loopback-only.
Admin API uses a separate high-entropy token.
User API keys are hash-only inside the Media Service.
Recoverable UI copies are encrypted separately in Platform Admin.
Uploads use UUID storage names.
Executable/active-web extensions are blocked by default.
Common binary formats receive signature checks.
Public serving requires visibility=public.
Private binary responses use no-store.
X-Content-Type-Options: nosniff is set on file responses.
The final 5 GiB of host storage is protected by default.
Database access stays on postgres_net.
Same-VPS application access stays on media_net.
Secrets are never committed to Git.
```

If a broader file policy is required, enable `MEDIA_ALLOW_OTHER_FILES=true` only after evaluating the security implications.
