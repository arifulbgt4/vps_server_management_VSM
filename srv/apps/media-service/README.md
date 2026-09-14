# Media Storage Service

Production-oriented multi-user media/file storage for the VSM host.

The service supports images, video, audio, PDF, Office/OpenDocument files, text/CSV/Markdown and common archives. Each media user receives an independent API key and storage quota. Files are stored on the VPS filesystem while metadata, ownership and quota accounting live in PostgreSQL.

Documentation examples use `example.com`. Replace them with the real production domain.

## Architecture

```text
Internet
  -> HTTPS / Nginx
  -> 127.0.0.1:8082
  -> platform-media
      ├── /storage on the VPS
      └── postgres_net -> postgres:5432 -> shared PostgreSQL

Platform Admin
  -> media_net
  -> media-service:8080 admin API

n8n
  -> media_net
  -> media-service:8080 user API
```

The public host port is bound to loopback only. `media_net` is the private Docker network used by trusted same-VPS applications.

## Core behavior

- Per-user bearer API keys.
- Per-user quota in bytes; Platform Admin presents quota in GiB.
- Blank quota means unlimited for that user, but host free-space protection still applies.
- User quota is checked transactionally with a PostgreSQL row lock.
- A configurable host reserve prevents uploads from consuming the final disk space.
- Public and private files.
- Authenticated binary download endpoint for n8n.
- Optional public URL for files explicitly uploaded as `visibility=public`.
- Hard file deletion removes both the PostgreSQL row and physical file.
- Hard user deletion removes the user, API key, metadata and all files.
- Dangerous executable/web-active extensions are rejected by default.
- Common binary formats receive basic signature validation.
- Original filenames never become storage paths; physical names are random UUIDs.
- SHA-256 checksum is stored for every upload.

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

## 1. Create PostgreSQL database and role

Use Platform Admin `/postgres` and create a dedicated application database/role, for example:

```text
Database: media_service
User:     media_app
```

Do not use `postgres`, `platform_controller` or `platform_app` as the runtime media identity.

## 2. Copy the app

```bash
cd /tmp/vps_server_management_VSM
git pull

sudo mkdir -p /srv/apps/media-service
sudo chown -R ariful:ariful /srv/apps/media-service

cp -a srv/apps/media-service/. /srv/apps/media-service/
```

## 3. Runtime directories and Docker network

```bash
cd /srv/apps/media-service

mkdir -p storage/.tmp storage/.trash secrets
cp .env.example .env
chmod 600 .env

docker network inspect media_net >/dev/null 2>&1 || docker network create media_net
docker network inspect postgres_net >/dev/null 2>&1 || docker network create postgres_net
```

Edit `.env`:

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

`MEDIA_MAX_UPLOAD_BYTES=536870912` is a 512 MiB per-file cap. This is independent from a user's total quota.

`MEDIA_MIN_FREE_BYTES=5368709120` reserves 5 GiB of filesystem capacity from uploads.

## 4. Create secrets

Write the PostgreSQL password without putting it in shell history:

```bash
read -s MEDIA_DB_PASSWORD
echo
printf '%s' "$MEDIA_DB_PASSWORD" > /srv/apps/media-service/secrets/db_password
unset MEDIA_DB_PASSWORD
```

Generate the service admin token once:

```bash
openssl rand -hex 32 > /srv/apps/media-service/secrets/admin_token
```

The service image runs as UID/GID 1000:

```bash
sudo chown -R 1000:1000 /srv/apps/media-service/storage
sudo chown 1000:1000 /srv/apps/media-service/secrets/db_password
sudo chown 1000:1000 /srv/apps/media-service/secrets/admin_token

sudo chmod 700 /srv/apps/media-service/storage
sudo chmod 700 /srv/apps/media-service/secrets
sudo chmod 600 /srv/apps/media-service/secrets/db_password
sudo chmod 600 /srv/apps/media-service/secrets/admin_token
```

## 5. Start

```bash
cd /srv/apps/media-service

docker compose config
docker compose up -d --build
docker compose ps
docker logs platform-media --tail 100
```

Health:

```bash
curl -fsS http://127.0.0.1:8082/healthz
```

Expected:

```json
{"status":"ok"}
```

The service creates its `media_users` and `media_files` tables automatically inside the selected media database.

## 6. Nginx and HTTPS

```bash
sudo cp /srv/apps/media-service/nginx.conf.example /etc/nginx/sites-available/media
sudo nano /etc/nginx/sites-available/media
sudo ln -sf /etc/nginx/sites-available/media /etc/nginx/sites-enabled/media
sudo nginx -t
sudo systemctl reload nginx
```

Create DNS:

```text
media.example.com -> VPS_PUBLIC_IP
```

Then:

```bash
sudo certbot --nginx -d media.example.com
```

Verify:

```bash
curl -fsS https://media.example.com/healthz
```

## 7. Platform Admin integration

Platform Admin connects to the private admin API through `media_net`.

Create the app-local readable token copy:

```bash
sudo install \
  -o 1001 -g 1001 -m 0600 \
  /srv/apps/media-service/secrets/admin_token \
  /srv/apps/platform-admin/secrets/media_admin_token
```

The repository Platform Admin compose mounts this file and exposes the Media Storage manager at:

```text
/media
```

The panel can create users, set individual GiB quotas, enable/disable users, rotate API keys, inspect file lists, hard-delete individual files, hard-delete a user and all files, and view media/host storage usage.

The API key is returned only during user creation/rotation. The service stores only its SHA-256 hash.

## User API

Every request below uses:

```http
Authorization: Bearer ms_live_...
```

### Storage usage

```http
GET /api/v1/storage
```

### Upload

```http
POST /api/v1/files
Content-Type: multipart/form-data
```

Fields:

```text
file        required
visibility  optional: private | public
```

Example:

```bash
curl \
  -H "Authorization: Bearer $MEDIA_API_KEY" \
  -F "visibility=private" \
  -F "file=@./product.mp4" \
  https://media.example.com/api/v1/files
```

For `visibility=public`, `public_url` is returned when public files are enabled.

### List and metadata

```http
GET /api/v1/files?limit=50&offset=0
GET /api/v1/files/:id
```

### Actual binary

```http
GET /api/v1/files/:id/content
```

This is the preferred endpoint for n8n when it needs to send the actual binary to Messenger/Meta rather than sending a URL.

### Change visibility

```http
PATCH /api/v1/files/:id
Content-Type: application/json

{"visibility":"public"}
```

### Hard delete

```http
DELETE /api/v1/files/:id
```

A successful delete removes the physical file and DB row and releases the user's used quota.

## n8n example

Once `n8n` is attached to `media_net`, it can avoid the public internet hop:

```text
http://media-service:8080/api/v1/files/<FILE_ID>/content
```

Use an HTTP Request node with the media user's bearer API key and response format `File`. The returned n8n binary can then be uploaded to the Meta Messenger attachment API.

## Admin API

Admin endpoints are private-token protected:

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

Do not expose the admin token to browsers or n8n workflow data.

## Quota semantics

If a user has 2 GiB quota and 1.4 GiB used, the service accepts an upload only when:

```text
used + incoming_size <= quota
AND
host_available - incoming_size >= MEDIA_MIN_FREE_BYTES
```

The user row is locked during the final quota check/commit, so concurrent uploads cannot both consume the same remaining quota. Quota cannot be reduced below current usage.

## Hard-delete semantics

For individual files, the physical file is first moved to the service trash area, then the DB row and quota accounting are committed. If the DB operation fails, the file is restored. After a successful commit, the temporary trash copy is removed.

For user deletion, the account is disabled first, the user's storage directory is moved out of the active tree, the user row is deleted with cascading metadata deletion, then the storage tree is removed.

External copies previously uploaded to Meta, S3 or another provider are outside this service and are not automatically removed by a local hard delete.

## Security defaults

```text
Host port 8082 is loopback-only.
Admin API requires a separate high-entropy token.
User API keys are stored only as SHA-256 hashes.
Uploads use UUID storage names.
Executable and active-web extensions are blocked by default.
Common binary formats receive signature checks.
Public serving requires visibility=public.
Private binary responses use no-store.
X-Content-Type-Options: nosniff is set on file responses.
The final 5 GiB of host storage is protected by default.
Database access stays on postgres_net.
Same-VPS application access stays on media_net.
```

If a broader file policy is required, set `MEDIA_ALLOW_OTHER_FILES=true` only after evaluating the security implications.
