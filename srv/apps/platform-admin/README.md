# Platform Admin

Authenticated Next.js control panel for independently managed VPS services.

Current tracked version: `1.0.0`.

## Modules

```text
/postgres   PostgreSQL databases/roles/credentials
/mysql      MySQL databases/users/credentials
/mongodb    MongoDB databases/users/credentials
/redis      Redis ACL users/credentials
/docker     Docker metrics/logs/lifecycle/resource limits
/media      Media users/quotas/API keys/files
```

All management routes require the Platform Admin session.

## Login credentials

Production login URL:

```text
https://admin.openmusk.store
```

The username is configured by `ADMIN_USERNAME` in the root VSM `.env` and defaults to `admin`.

Show the effective configured value:

```bash
cd ~/srv
ADMIN_USER="$(grep -E '^ADMIN_USERNAME=' .env | tail -n1 | cut -d= -f2-)"
printf '%s\n' "${ADMIN_USER:-admin}"
```

Show the generated initial or most recently reset password:

```bash
sudo cat /srv/vsm/bootstrap/admin_initial_password
```

If that plaintext recovery file has been deleted, the password cannot be recovered from its scrypt hash and must be reset.

To change only the username, edit `ADMIN_USERNAME` in the root `.env`, then recreate the service:

```bash
docker compose up -d --force-recreate platform-admin
```

To change/reset the password, do not merely change `VSM_ADMIN_PASSWORD` in `.env`; the existing persisted hash is intentionally reused. Follow the reset procedure in:

**[../../../docs/PLATFORM_ADMIN_ACCESS.md](../../../docs/PLATFORM_ADMIN_ACCESS.md)**

The reset procedure rotates the Platform Admin auth-session secret so existing authenticated sessions are invalidated, while unrelated database, Redis, n8n, media, and automation credentials remain unchanged.

## Credential vault

Recoverable application credentials are encrypted with AES-256-GCM. The master key stays only on the VPS:

```text
/srv/apps/platform-admin/secrets/credential_vault_key
```

Vault namespaces include:

```text
postgres
mysql
mongodb
redis
media-user-api-key
```

Database root/bootstrap credentials are never exposed to browser code and are not mounted into Platform Admin.

## PostgreSQL

`/postgres` manages unprivileged application databases/roles and encrypted connection reveal.

Public production format:

```text
postgresql://USER:PASSWORD@db.example.com:5432/DATABASE?sslmode=verify-full
```

Same-VPS applications should use `postgres:5432` over `postgres_net`.

## MySQL

`/mysql` becomes operational after the private MySQL stack is deployed.

Features:

```text
list databases/sizes and application users
create utf8mb4 database + dedicated user
create database using an existing application user
rotate application-user password
delete database only
delete database + user with shared-user protection
Show/Hide/Copy private connection URL
```

Private connection format:

```text
mysql://USER:PASSWORD@mysql:3306/DATABASE
```

Platform Admin reads an app-local copy of the controller password:

```text
/srv/apps/platform-admin/secrets/mysql_controller_password
```

Create/update that copy from the service-owned secret:

```bash
sudo install \
  -o 1001 -g 1001 -m 0600 \
  /srv/infrastructure/databases/mysql/secrets/controller_password \
  /srv/apps/platform-admin/secrets/mysql_controller_password
```

MySQL root credentials are never mounted into Platform Admin.

## MongoDB

`/mongodb` becomes operational after the private MongoDB stack is deployed.

Features:

```text
health and replica-set status
list managed databases/sizes/users
create database + readWrite user
rotate password
hard-delete database
optionally delete database + scoped user
Show/Hide/Copy private replica-set URL
```

Private connection format:

```text
mongodb://USER:PASSWORD@mongodb:27017/DATABASE?authSource=DATABASE&replicaSet=rs0
```

Platform Admin reads an app-local controller-password copy:

```text
/srv/apps/platform-admin/secrets/mongo_controller_password
```

Create/update it with:

```bash
sudo install \
  -o 1001 -g 1001 -m 0600 \
  /srv/infrastructure/databases/mongodb/secrets/controller_password \
  /srv/apps/platform-admin/secrets/mongo_controller_password
```

MongoDB root credentials and the replica-set keyfile are never mounted into Platform Admin.

## Redis

`/redis` manages application ACL identities. Same-VPS URL:

```text
redis://USER:PASSWORD@redis:6379/0
```

Public TLS URL:

```text
rediss://USER:PASSWORD@redis.example.com:6380/0
```

n8n queue traffic uses a dedicated ACL user such as `n8n_queue`, never `platform_controller`.

## Docker Services

`/docker` talks only to the private token-authenticated Docker agent; Platform Admin never mounts `docker.sock`.

Default managed long-running containers:

```text
platform-admin
platform-postgres
platform-redis
platform-mysql
platform-mongodb
n8n
n8n-worker
platform-media
```

The MongoDB bootstrap sidecar is intentionally excluded. MySQL controller setup runs only through the official image's first-initialization hook, so there is no MySQL bootstrap container to manage.

## Media Storage

`/media` uses private `media_net`. Media Service stores API-key hashes while Platform Admin can retain an encrypted reveal copy. API keys stay masked until an authenticated Show action.

## App-local secrets

```text
/srv/apps/platform-admin/secrets/admin_password_hash
/srv/apps/platform-admin/secrets/auth_session_secret
/srv/apps/platform-admin/secrets/credential_vault_key
/srv/apps/platform-admin/secrets/docker_agent_token
/srv/apps/platform-admin/secrets/media_admin_token
/srv/apps/platform-admin/secrets/mysql_controller_password
/srv/apps/platform-admin/secrets/mongo_controller_password
```

The PostgreSQL/Redis controller secrets continue to use their existing infrastructure mounts.

## Required networks

```bash
docker network inspect proxy_net >/dev/null 2>&1 || docker network create proxy_net
docker network inspect postgres_net >/dev/null 2>&1 || docker network create postgres_net
docker network inspect redis_net >/dev/null 2>&1 || docker network create redis_net
docker network inspect mysql_net >/dev/null 2>&1 || docker network create mysql_net
docker network inspect mongo_net >/dev/null 2>&1 || docker network create mongo_net
docker network inspect management_net >/dev/null 2>&1 || docker network create management_net
docker network inspect media_net >/dev/null 2>&1 || docker network create media_net
```

## Safe update

Do not overwrite runtime `.env`, secrets, or installed dependencies while syncing tracked code:

```bash
cd /tmp/vps_server_management_VSM
git pull
sudo rsync -a \
  --exclude='.env' \
  --exclude='secrets/' \
  --exclude='node_modules/' \
  srv/apps/platform-admin/ \
  /srv/apps/platform-admin/

cd /srv/apps/platform-admin
docker compose config
docker compose up -d --build
docker compose ps
docker logs platform-admin --tail 100
```

## Security invariants

```text
Platform Admin port 3000 stays loopback-only.
Management APIs require authentication.
Recoverable application credentials are encrypted at rest.
MySQL 3306 and MongoDB 27017 remain Docker-private.
Database root/bootstrap credentials are not mounted into Platform Admin.
Platform Admin never mounts docker.sock.
Secrets are never committed to Git.
```
