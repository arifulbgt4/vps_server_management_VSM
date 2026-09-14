# Platform Admin

Authenticated Next.js control panel for independently managed VPS services.

Current version: `1.0.0`

For the complete VPS build, networking, TLS, queue mode, database services, Media Storage, firewall, deployment and troubleshooting guide, see:

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

Platform Admin persists recoverable application credentials only in encrypted form using AES-256-GCM. The master key is stored only on the VPS:

```text
/srv/apps/platform-admin/secrets/credential_vault_key
```

Encrypted rows live in the `platform_admin` PostgreSQL database through the unprivileged `platform_app` role.

Vault namespaces now include:

```text
postgres
mysql
mongodb
redis
media-user-api-key
```

Database root/bootstrap credentials are not stored in the vault and are not exposed to the browser.

## PostgreSQL manager

Available at `/postgres`.

Features:

```text
list databases and roles
create DB + new dedicated user
create DB using an existing user
rotate role passwords
delete database only
optionally delete database + role
reveal/hide stored remote connection URLs
```

Public PostgreSQL URL:

```text
postgresql://USER:PASSWORD@db.example.com:5432/DATABASE?sslmode=verify-full
```

Same-VPS applications should prefer `postgres:5432` on `postgres_net`.

## MySQL manager

Available at `/mysql` after the MySQL infrastructure stack is deployed.

Features:

```text
list application databases and sizes
list application users
create utf8mb4 DB + dedicated user
create DB using an existing application user
rotate application-user passwords
delete database only
optionally delete database + user
reveal/hide private connection URLs from the encrypted vault
```

Same-VPS connection format:

```text
mysql://USER:PASSWORD@mysql:3306/DATABASE
```

MySQL is private-first. The tracked stack does not publish port `3306`.

Platform Admin authenticates with `platform_controller`, using only:

```text
/srv/infrastructure/databases/mysql/secrets/controller_password
```

The MySQL root password is not mounted into Platform Admin.

## MongoDB manager

Available at `/mongodb` after the MongoDB infrastructure stack is deployed.

Features:

```text
MongoDB health and replica-set status
list managed databases and sizes
list database-scoped application users
create DB + readWrite user
rotate user passwords
hard delete database
optionally delete database + scoped user
reveal/hide private replica-set connection URLs
```

Same-VPS connection format:

```text
mongodb://USER:PASSWORD@mongodb:27017/DATABASE?authSource=DATABASE&replicaSet=rs0
```

MongoDB is private-first. The tracked stack does not publish port `27017`.

Platform Admin authenticates with `platform_controller`, using only:

```text
/srv/infrastructure/databases/mongodb/secrets/controller_password
```

MongoDB root and replica-keyfile secrets are never mounted into Platform Admin.

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

Private URL:

```text
redis://USER:PASSWORD@redis:6379/0
```

Public TLS URL:

```text
rediss://USER:PASSWORD@redis.example.com:6380/0
```

n8n queue mode uses a dedicated ACL user such as `n8n_queue`, not `platform_controller`.

## Docker Services manager

Available at `/docker`.

Platform Admin never mounts `/var/run/docker.sock`. A separate `platform-docker-agent` owns the socket on private `management_net`, requires a bearer token, and manages only exact allowlisted containers.

Current default allowlist includes:

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

The one-shot `platform-mysql-init` and `platform-mongodb-init` bootstrap containers are intentionally not managed from the Docker UI.

Current UI features include host/container CPU/RAM/disk metrics, lifecycle controls, logs, networks/ports, and persistent CPU/RAM limits.

## Media Storage manager

Available at `/media`.

Platform Admin connects through private `media_net` and never sends the media admin token to browser code. Media user API keys remain masked by default; the Media Service stores only hashes while Platform Admin may keep an AES-256-GCM encrypted reveal copy.

The `/media` page also provides server-side Next.js App Router examples for media usage without exposing the bearer key to client JavaScript.

## Required secret mounts

Infrastructure secrets consumed by Platform Admin:

```text
/srv/infrastructure/databases/postgres/secrets/platform_controller_password
/srv/infrastructure/databases/postgres/secrets/platform_app_password
/srv/infrastructure/cache/redis/secrets/platform_controller_password
/srv/infrastructure/databases/mysql/secrets/controller_password
/srv/infrastructure/databases/mongodb/secrets/controller_password
```

MySQL and MongoDB controller-password files must be readable by Platform Admin UID/GID `1001` and should remain mode `0600`.

App-local secrets:

```text
/srv/apps/platform-admin/secrets/admin_password_hash
/srv/apps/platform-admin/secrets/auth_session_secret
/srv/apps/platform-admin/secrets/credential_vault_key
/srv/apps/platform-admin/secrets/docker_agent_token
/srv/apps/platform-admin/secrets/media_admin_token
```

## Required Docker networks

```bash
docker network inspect proxy_net >/dev/null 2>&1 || docker network create proxy_net
docker network inspect postgres_net >/dev/null 2>&1 || docker network create postgres_net
docker network inspect redis_net >/dev/null 2>&1 || docker network create redis_net
docker network inspect mysql_net >/dev/null 2>&1 || docker network create mysql_net
docker network inspect mongo_net >/dev/null 2>&1 || docker network create mongo_net
docker network inspect management_net >/dev/null 2>&1 || docker network create management_net
docker network inspect media_net >/dev/null 2>&1 || docker network create media_net
```

## Update on VPS

Do not overwrite runtime secrets while copying repository code:

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
docker compose up -d --build
docker compose ps
docker logs platform-admin --tail 100
```

## Security invariants

```text
Port 3000 remains bound to 127.0.0.1 only.
Management APIs require admin authentication.
Recoverable credentials are encrypted at rest.
Database root/bootstrap credentials are not mounted into Platform Admin.
MySQL 3306 and MongoDB 27017 remain Docker-private in the initial design.
The web application never mounts docker.sock.
Docker lifecycle/resource control stays behind the private token-authenticated allowlisted agent.
Media admin access stays on media_net and its token is never exposed to the browser.
Redis plaintext 6379 remains private.
Secrets are never committed to Git.
```
