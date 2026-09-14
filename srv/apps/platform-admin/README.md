# Platform Admin

Minimal Next.js control panel for independently managed VPS services.

Current version: `0.2.0`

## Current modules

### PostgreSQL

Available at `/postgres`:

- list databases;
- list roles;
- create a database and login role;
- generate a strong password server-side;
- rotate a role password;
- delete a database and its role;
- show the generated password once in the UI.

The application connects to PostgreSQL over the private `postgres_net` Docker network. The privileged `platform_controller` password is read from the VPS file:

```text
/srv/infrastructure/databases/postgres/secrets/platform_controller_password
```

The password is mounted read-only into the container and is not stored in this repository.

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

## Check

```bash
docker compose ps
docker logs platform-admin --tail 50
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/postgres
```

The container publishes port 3000 only on `127.0.0.1`. Do not expose Platform Admin publicly until authentication and the reverse-proxy/HTTPS layer are implemented.

## Required external Docker networks

```bash
docker network inspect proxy_net >/dev/null 2>&1 || docker network create proxy_net
docker network inspect postgres_net >/dev/null 2>&1 || docker network create postgres_net
```

## Security

Do not commit production passwords, PostgreSQL controller credentials, TLS private keys, or `.env` files. PostgreSQL management operations run server-side only; the controller password is never sent to the browser.
