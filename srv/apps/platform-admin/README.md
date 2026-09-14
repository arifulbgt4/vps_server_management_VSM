# Platform Admin

Minimal Next.js control panel for independently managed VPS services.

Current version: `0.4.0`

## Authentication

Platform Admin uses one local administrator account, a scrypt password hash and an HMAC-signed 12-hour session cookie.

Secrets are stored only on the VPS:

```text
/srv/apps/platform-admin/secrets/admin_password_hash
/srv/apps/platform-admin/secrets/auth_session_secret
```

The default username is `admin`. Override it with `ADMIN_USERNAME` in a local `.env` file if needed.

Create authentication secrets before starting the container:

```bash
cd /srv/apps/platform-admin
mkdir -p secrets
chmod 700 secrets

read -s -p "Admin password: " ADMIN_PASSWORD; echo
printf '%s' "$ADMIN_PASSWORD" | docker run --rm -i \
  -v "$PWD/scripts/hash-password.mjs:/tmp/hash-password.mjs:ro" \
  node:22-alpine node /tmp/hash-password.mjs \
  > secrets/admin_password_hash
unset ADMIN_PASSWORD

openssl rand -hex 32 > secrets/auth_session_secret
chmod 600 secrets/admin_password_hash secrets/auth_session_secret
```

With HTTPS enabled, set `AUTH_COOKIE_SECURE=true` in the local `.env` file.

## Current modules

### PostgreSQL

Available at `/postgres` after login:

- list databases and roles;
- create a database with a new dedicated login user;
- create a database using an existing login user;
- set the selected application role as database owner;
- generate strong passwords server-side;
- rotate a role password;
- delete a database only, or explicitly delete the database and role together;
- generate a remote PostgreSQL URL after password creation/rotation;
- hide the password and remote URL by default and reveal them only on request.

The application connects to PostgreSQL over the private `postgres_net` Docker network. The privileged `platform_controller` password is read from:

```text
/srv/infrastructure/databases/postgres/secrets/platform_controller_password
```

All PostgreSQL management APIs require an authenticated Platform Admin session.

### Remote PostgreSQL URL

Compose exposes these configuration values to Platform Admin:

```text
PG_PUBLIC_HOST=db.openmusk.store
PG_PUBLIC_PORT=5432
PG_PUBLIC_SSLMODE=require
```

The generated URL format is:

```text
postgresql://USER:PASSWORD@db.openmusk.store:5432/DATABASE?sslmode=require
```

Platform Admin never attempts to recover an existing PostgreSQL password because PostgreSQL does not store reversible plaintext passwords. When creating a database for an existing user, its password is preserved. Rotate that user's password from the UI if a fresh one-time URL is needed.

Generating the URL does not itself open PostgreSQL to the Internet. DNS, the Contabo firewall, Docker-compatible host firewall policy, PostgreSQL TLS and `pg_hba.conf` must also allow the intended remote source.

## VPS path

```text
/srv/apps/platform-admin
```

## Deploy / update on the VPS

```bash
cd /tmp
rm -rf vps_server_management_VSM
git clone https://github.com/arifulbgt4/vps_server_management_VSM.git
mkdir -p /srv/apps/platform-admin
cp -a /tmp/vps_server_management_VSM/srv/apps/platform-admin/. /srv/apps/platform-admin/
cd /srv/apps/platform-admin
```

Create the authentication secrets as described above, then:

```bash
docker compose up -d --build
```

For later updates:

```bash
cd /tmp/vps_server_management_VSM
git pull
cp -a srv/apps/platform-admin/. /srv/apps/platform-admin/
cd /srv/apps/platform-admin
docker compose up -d --build
```

The local `secrets/` directory is ignored by Git and is not deleted by the copy command above.

## Check

```bash
docker compose ps
docker logs platform-admin --tail 50
curl http://127.0.0.1:3000/api/health
curl -i http://127.0.0.1:3000/api/postgres
```

Without a session, `/api/postgres` should return HTTP `401 Unauthorized`.

## Required external Docker networks

```bash
docker network inspect proxy_net >/dev/null 2>&1 || docker network create proxy_net
docker network inspect postgres_net >/dev/null 2>&1 || docker network create postgres_net
```

## Security

- Port 3000 remains bound to `127.0.0.1` only.
- Password hashes and session signing keys are not committed to Git.
- The session cookie is HttpOnly and SameSite=Strict.
- PostgreSQL management operations run server-side only.
- The PostgreSQL controller password is never sent to the browser.
- Generated database passwords are shown only as one-time UI state and are not stored by Platform Admin.
- Public PostgreSQL access should be source-restricted whenever possible.
