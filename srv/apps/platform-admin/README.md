# Platform Admin

Minimal Next.js control panel for independently managed VPS services.

Current version: `0.4.0`

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

Create it once with:

```bash
openssl rand -hex 32 > /srv/apps/platform-admin/secrets/credential_vault_key
chmod 600 /srv/apps/platform-admin/secrets/credential_vault_key
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

Newly generated or rotated PostgreSQL passwords are stored encrypted in the credential vault. Passwords that existed before the vault was introduced cannot be recovered; rotate those users once to enable URL reveal.

Remote URL format:

```text
postgresql://USER:PASSWORD@db.openmusk.store:5432/DATABASE?sslmode=require
```

Generating a URL does not itself open PostgreSQL to the Internet. DNS, Contabo firewall policy, Docker-compatible host firewall policy, TLS and `pg_hba.conf` still need to allow the intended remote connection.

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

Shared Redis runtime path:

```text
/srv/infrastructure/cache/redis
```

## Required secret mounts

Platform Admin expects:

```text
/srv/infrastructure/databases/postgres/secrets/platform_controller_password
/srv/infrastructure/databases/postgres/secrets/platform_app_password
/srv/infrastructure/cache/redis/secrets/platform_controller_password
/srv/apps/platform-admin/secrets/admin_password_hash
/srv/apps/platform-admin/secrets/auth_session_secret
/srv/apps/platform-admin/secrets/credential_vault_key
```

## Required Docker networks

```bash
docker network inspect proxy_net >/dev/null 2>&1 || docker network create proxy_net
docker network inspect postgres_net >/dev/null 2>&1 || docker network create postgres_net
docker network inspect redis_net >/dev/null 2>&1 || docker network create redis_net
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
