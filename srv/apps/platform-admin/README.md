# Platform Admin

Minimal Next.js control panel for independently managed VPS services.

Current version: `0.5.0`

## Authentication

Platform Admin uses one local administrator account, a scrypt password hash and an HMAC-signed 12-hour session cookie.

Local secrets live only on the VPS under:

```text
/srv/apps/platform-admin/secrets/
```

With HTTPS enabled, set `AUTH_COOKIE_SECURE=true` in `.env`.

## Encrypted credential vault

Platform Admin can persist application credentials so connection URLs can be revealed later without keeping plaintext passwords in the database.

The vault uses AES-256-GCM. Its master key is stored only on the VPS:

```text
/srv/apps/platform-admin/secrets/credential_vault_key
```

Encrypted credential rows are stored in the `platform_admin` PostgreSQL database through the unprivileged `platform_app` role.

## PostgreSQL

Available at `/postgres` after login:

- list databases and roles;
- create DB + new dedicated user;
- create DB using an existing user;
- rotate passwords;
- delete a database only, or explicitly delete its user too;
- reveal/hide a full remote PostgreSQL URL from each database row when a stored credential is available.

Newly generated managed databases revoke public CONNECT/TEMPORARY privileges and keep the selected owner role as the intended application identity.

Remote URL format:

```text
postgresql://USER:PASSWORD@db.openmusk.store:5432/DATABASE?sslmode=verify-full
```

Public PostgreSQL uses PostgreSQL's own TLS endpoint with a CA-trusted certificate for `db.openmusk.store`, SCRAM authentication, hardened `pg_hba.conf`, the Contabo network firewall and a Docker-aware host firewall policy in `DOCKER-USER`.

## Redis

Available at `/redis` after the shared Redis service is started:

- Redis health/status;
- list ACL users;
- create application ACL users;
- generate and rotate passwords;
- delete application ACL users;
- reveal/hide private Redis connection URLs from the user list.

Application Redis URLs use the private Docker network:

```text
redis://USER:PASSWORD@redis:6379/0
```

Do not expose Redis port 6379 publicly by default. Same-VPS application containers should join `redis_net`.

## Docker Services

Available at `/docker`.

Platform Admin does not mount `/var/run/docker.sock`. A separate `platform-docker-agent` container owns the socket on the private `management_net`. The agent requires a bearer token and only lists/controls exact container names in `DOCKER_AGENT_ALLOWLIST`.

Current actions are:

- list status;
- start;
- restart;
- stop.

Shared Docker agent runtime path:

```text
/srv/infrastructure/management/docker-agent
```

## Required secret mounts

Platform Admin expects:

```text
/srv/infrastructure/databases/postgres/secrets/platform_controller_password
/srv/infrastructure/databases/postgres/secrets/platform_app_password
/srv/infrastructure/cache/redis/secrets/platform_controller_password
/srv/infrastructure/management/docker-agent/secrets/control_token
/srv/apps/platform-admin/secrets/admin_password_hash
/srv/apps/platform-admin/secrets/auth_session_secret
/srv/apps/platform-admin/secrets/credential_vault_key
```

## Required Docker networks

```bash
docker network inspect proxy_net >/dev/null 2>&1 || docker network create proxy_net
docker network inspect postgres_net >/dev/null 2>&1 || docker network create postgres_net
docker network inspect redis_net >/dev/null 2>&1 || docker network create redis_net
docker network inspect management_net >/dev/null 2>&1 || docker network create management_net
```

## Update on VPS

```bash
cd /tmp/vps_server_management_VSM
git pull
cp -a srv/apps/platform-admin/. /srv/apps/platform-admin/
cd /srv/apps/platform-admin
docker compose up -d --build
```

## Security

- Port 3000 stays bound to `127.0.0.1` only.
- Admin authentication is required for management APIs.
- Credential secrets are encrypted at rest with a VPS-only master key.
- PostgreSQL controller and Redis controller credentials are never exposed to the browser.
- Connection passwords are decrypted server-side only after an authenticated explicit reveal request.
- Docker lifecycle control is isolated behind a private, token-authenticated, allowlisted agent instead of exposing the Docker socket directly to the web app.
