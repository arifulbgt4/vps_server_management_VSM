# Platform Admin

Minimal Next.js control panel for independently managed VPS services.

Current version: `0.3.0`

## Authentication

Platform Admin uses one local administrator account, a scrypt password hash and an HMAC-signed 12-hour session cookie.

Secrets are stored only on the VPS:

```text
/srv/apps/platform-admin/secrets/admin_password_hash
/srv/apps/platform-admin/secrets/auth_session_secret
```

The default username is `admin`. Override it with `ADMIN_USERNAME` in a local `.env` file if needed.

Create authentication secrets before starting the v0.3 container:

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

While the app is available only through local HTTP/SSH tunneling, leave `AUTH_COOKIE_SECURE=false` (the Compose default). After HTTPS is enabled, set `AUTH_COOKIE_SECURE=true`.

## Current modules

### PostgreSQL

Available at `/postgres` after login:

- list databases;
- list roles;
- create a database and login role;
- set the application role as database owner;
- generate a strong password server-side;
- rotate a role password;
- delete a database and its role;
- show the generated password once in the UI.

The application connects to PostgreSQL over the private `postgres_net` Docker network. The privileged `platform_controller` password is read from:

```text
/srv/infrastructure/databases/postgres/secrets/platform_controller_password
```

All PostgreSQL management APIs require an authenticated Platform Admin session.

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

For browser testing without public exposure, create an SSH tunnel from your local machine:

```bash
ssh -L 3300:127.0.0.1:3000 contabo
```

Then open `http://127.0.0.1:3300/login` locally.

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
- Enable the cookie `Secure` flag when HTTPS is added.
