# Platform Admin

Minimal Next.js control-panel shell for the VPS.

This first version intentionally contains only:

- a small Platform Admin dashboard;
- `/api/health`;
- production Docker build;
- Docker Compose deployment;
- connection to the existing `proxy_net` and `postgres_net` networks.

PostgreSQL database/user/role management will be added as the next module. MySQL, Redis, backups, monitoring and other infrastructure modules can be added independently later.

## VPS path

The runtime path is:

```text
/srv/apps/platform-admin
```

The repository mirrors the VPS structure, so this app is stored at `srv/apps/platform-admin` in GitHub.

## Copy from the repository to the VPS path

```bash
cd /tmp
rm -rf vps_server_management_VSM
git clone https://github.com/arifulbgt4/vps_server_management_VSM.git
mkdir -p /srv/apps/platform-admin
cp -a /tmp/vps_server_management_VSM/srv/apps/platform-admin/. /srv/apps/platform-admin/
cd /srv/apps/platform-admin
```

## Required Docker networks

```bash
docker network inspect proxy_net >/dev/null 2>&1 || docker network create proxy_net
docker network inspect postgres_net >/dev/null 2>&1 || docker network create postgres_net
```

## Run

```bash
cd /srv/apps/platform-admin
docker compose up -d --build
```

Check:

```bash
docker compose ps
docker logs platform-admin --tail 50
curl http://127.0.0.1:3000/api/health
```

The container publishes port 3000 only on `127.0.0.1`, so it is not directly exposed to the Internet. A future reverse proxy can reach `platform-admin:3000` through `proxy_net`.

## Update

Pull the repository copy, copy the app files again, then rebuild:

```bash
cd /tmp/vps_server_management_VSM
git pull
cp -a srv/apps/platform-admin/. /srv/apps/platform-admin/
cd /srv/apps/platform-admin
docker compose up -d --build
```

## Security

Do not commit production passwords, PostgreSQL controller credentials, TLS private keys, or `.env` files. Do not expose this admin UI publicly until authentication is implemented.
