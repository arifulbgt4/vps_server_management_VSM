# Platform Admin

Authenticated Next.js control panel for independently managed VPS services.

Current version: `0.9.0`

For the complete VPS build, networking, TLS, queue mode, Media Storage, firewall, deployment and troubleshooting guide, see:

```text
docs/PRODUCTION_SETUP.md
```

> Documentation uses `example.com` as a placeholder domain. Replace it with real production domains only in VPS runtime configuration.

## Authentication

Platform Admin uses one local administrator account, a scrypt password hash and an HMAC-signed session cookie.

Local secrets live only on the VPS under:

```text
/srv/apps/platform-admin/secrets/
```

With HTTPS enabled:

```env
AUTH_COOKIE_SECURE=true
```

## Encrypted credential vault

Platform Admin persists recoverable application credentials only in encrypted form.

The vault uses AES-256-GCM. Its master key is stored only on the VPS:

```text
/srv/apps/platform-admin/secrets/credential_vault_key
```

Encrypted rows are stored in the `platform_admin` PostgreSQL database through the unprivileged `platform_app` role.

The vault is used for PostgreSQL/Redis credential reveal and for Media user API keys that need authenticated Show/Hide behavior in the UI.

## PostgreSQL manager

Available at `/postgres` after login.

Features:

```text
list databases and roles
create DB + new dedicated user
create DB using an existing user
rotate role passwords
delete database only
optionally delete database + role
reveal/hide stored remote connection URLs
copy connection URL
```

Managed application databases use unprivileged application owners.

Public connection format:

```text
postgresql://USER:PASSWORD@db.example.com:5432/DATABASE?sslmode=verify-full
```

Same-VPS applications should prefer the private `postgres_net` endpoint `postgres:5432`.

## Redis manager

Available at `/redis`.

Features:

```text
health/status
list ACL users
create application ACL users
generate strong passwords
rotate passwords
delete application ACL users
reveal/hide private and public connection URLs
```

Private same-VPS Docker URL:

```text
redis://USER:PASSWORD@redis:6379/0
```

Public TLS URL:

```text
rediss://USER:PASSWORD@redis.example.com:6380/0
```

Redis port `6379` is private.

n8n queue mode uses a dedicated Redis ACL user such as:

```text
n8n_queue
```

Do not use `platform_controller` for n8n workflow queue traffic.

## Docker Services manager

Available at `/docker`.

Platform Admin never mounts `/var/run/docker.sock`. A separate `platform-docker-agent` owns the socket on private `management_net`, requires a bearer token, and manages only exact allowlisted containers.

Current UI features:

```text
host total/used/available CPU
host total/used/available RAM
host total/used/available disk for the filesystem backing /srv
container state and health
container CPU usage %
container RAM usage and %
uptime
restart count
PID count
network names and container IPs
internal/published ports
recent log viewer
start / stop / restart
CPU limit %
RAM limit %
persistent resource-limit policy
```

Current default allowlist includes:

```text
platform-admin
platform-postgres
platform-redis
n8n
n8n-worker
platform-media
```

Metrics refresh approximately every 10 seconds.

### Resource limits

CPU and RAM limits are percentages of the entire VPS.

For a 4-vCPU host:

```text
10% CPU = 0.40 CPU
25% CPU = 1.00 CPU
50% CPU = 2.00 CPU
100% CPU = 4.00 CPU
```

Persistent policies are stored at:

```text
/srv/infrastructure/management/docker-agent/data/resource-limits.json
```

The agent periodically reconciles stored policies after container recreation.

## Media Storage manager

Available at `/media`.

Platform Admin connects to Media Storage through private `media_net` and never sends the media admin token to browser code.

Current UI features:

```text
overall media user count
overall file count and stored bytes
host filesystem capacity and safe upload capacity
create media users
individual user storage quota in GiB
used / quota / available per user
enable or disable users
rotate API keys
masked API keys by default
Show key / Hide key / Copy key for vault-backed keys
list a user's files
show public file URL when available
permanent file deletion
permanent user + all-files deletion
Next.js App Router API examples
```

### Media user API-key storage

The Media Service stores only a cryptographic hash of each user API key. Platform Admin stores a separate AES-256-GCM encrypted copy in its own credential vault when a user is created or a key is rotated.

This allows the authenticated UI to keep the key hidden by default and reveal it only after `Show key` is clicked.

For an older user created before this vault behavior existed, the plaintext key cannot be reconstructed from the Media Service hash. Rotate that user's key once to store the new value in the encrypted Platform Admin vault.

### Media API examples

The top of `/media` includes a copyable Next.js App Router example. The example keeps the media bearer key server-side in `.env.local` and proxies storage usage, upload, list, binary download and delete operations through a Next.js Route Handler.

This is preferred over putting the media bearer key in browser JavaScript.

The private same-VPS Media endpoint for n8n is:

```text
http://media-service:8080
```

## Media admin token

Source token:

```text
/srv/apps/media-service/secrets/admin_token
```

Platform Admin runs as UID/GID 1001, so install a private readable copy:

```bash
sudo install \
  -o 1001 -g 1001 -m 0600 \
  /srv/apps/media-service/secrets/admin_token \
  /srv/apps/platform-admin/secrets/media_admin_token
```

## Required secret mounts

Infrastructure secrets:

```text
/srv/infrastructure/databases/postgres/secrets/platform_controller_password
/srv/infrastructure/databases/postgres/secrets/platform_app_password
/srv/infrastructure/cache/redis/secrets/platform_controller_password
```

App-local secrets:

```text
/srv/apps/platform-admin/secrets/admin_password_hash
/srv/apps/platform-admin/secrets/auth_session_secret
/srv/apps/platform-admin/secrets/credential_vault_key
/srv/apps/platform-admin/secrets/docker_agent_token
/srv/apps/platform-admin/secrets/media_admin_token
```

Docker agent root-only source token:

```text
/srv/infrastructure/management/docker-agent/secrets/control_token
```

Install the Platform Admin copy:

```bash
sudo install \
  -o 1001 -g 1001 -m 0600 \
  /srv/infrastructure/management/docker-agent/secrets/control_token \
  /srv/apps/platform-admin/secrets/docker_agent_token
```

## Required Docker networks

```bash
docker network inspect proxy_net >/dev/null 2>&1 || docker network create proxy_net
docker network inspect postgres_net >/dev/null 2>&1 || docker network create postgres_net
docker network inspect redis_net >/dev/null 2>&1 || docker network create redis_net
docker network inspect management_net >/dev/null 2>&1 || docker network create management_net
docker network inspect media_net >/dev/null 2>&1 || docker network create media_net
```

## Update on VPS

```bash
cd /tmp/vps_server_management_VSM
git pull
cp -a srv/apps/platform-admin/. /srv/apps/platform-admin/
cd /srv/apps/platform-admin
docker compose up -d --build
docker compose ps
docker logs platform-admin --tail 100
```

## Security invariants

```text
Port 3000 remains bound to 127.0.0.1 only.
Management APIs require admin authentication.
Recoverable credentials are encrypted at rest.
PostgreSQL and Redis controller credentials are never exposed to the browser.
Media user API keys are masked by default and revealed only through authenticated server-side vault access.
The web application never mounts docker.sock.
Docker lifecycle/resource control stays behind the private token-authenticated allowlisted agent.
Host /proc and /srv are mounted read-only into the private Docker agent only for metrics.
Media admin access stays on media_net and its token is never exposed to the browser.
Redis plaintext 6379 remains private.
Secrets are never committed to Git.
```
