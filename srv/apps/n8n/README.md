# n8n Production App

Production n8n deployment for the VSM host. This stack is intentionally independent from the PostgreSQL infrastructure lifecycle and uses the shared PostgreSQL service over `postgres_net`.

The image is pinned to n8n `2.38.7`, the current stable release when this app scaffold was created. Review n8n release notes before upgrading the pinned version.

> Documentation uses `example.com` as a placeholder domain. Replace it with your real domain in VPS runtime configuration.

## Architecture

```text
Internet
  -> HTTPS / Nginx on the host
  -> 127.0.0.1:5678
  -> n8n container
  -> postgres_net
  -> shared platform-postgres
```

The n8n container does not publish port `5678` publicly. It is bound only to host loopback and must be reached through Nginx/HTTPS.

This first production stack runs one n8n instance. Redis/queue workers are deliberately not enabled yet; add queue mode as a separate scaling step when execution volume requires it.

## Files

```text
/srv/apps/n8n/
├── compose.yml
├── entrypoint.sh
├── .env
├── data/
├── secrets/
│   ├── db_password
│   └── encryption_key
└── nginx.conf.example
```

`.env`, `data/`, and `secrets/` are ignored by Git.

## 1. Create the PostgreSQL database and role

Use Platform Admin `/postgres` to create:

```text
Database: n8n
User:     n8n_app
```

Use a dedicated role. Do not use `postgres`, `platform_controller`, or `platform_app` for n8n.

Save the generated n8n database password securely. The same password must be written to the n8n runtime secret file in step 4.

## 2. Copy the app to the VPS

```bash
cd /tmp/vps_server_management_VSM
git pull

sudo mkdir -p /srv/apps/n8n
sudo chown -R ariful:ariful /srv/apps/n8n

cp -a srv/apps/n8n/. /srv/apps/n8n/
```

## 3. Create runtime directories and environment file

```bash
cd /srv/apps/n8n

mkdir -p data secrets
cp .env.example .env
chmod 600 .env
chmod 755 entrypoint.sh
```

Edit `.env`:

```bash
nano .env
```

Example:

```env
N8N_VERSION=2.38.7
N8N_HOST=n8n.example.com
N8N_BIND_PORT=5678
N8N_DB_NAME=n8n
N8N_DB_USER=n8n_app
GENERIC_TIMEZONE=Asia/Dhaka
TZ=Asia/Dhaka
N8N_LOG_LEVEL=info
N8N_EXECUTIONS_DATA_MAX_AGE=336
N8N_EXECUTIONS_DATA_PRUNE_MAX_COUNT=10000
```

Do not put database passwords or the n8n encryption key in `.env`.

## 4. Create secrets

Write the PostgreSQL password created for `n8n_app` into:

```text
/srv/apps/n8n/secrets/db_password
```

For example, without placing the password in shell history:

```bash
read -s N8N_DB_PASSWORD
echo
printf '%s' "$N8N_DB_PASSWORD" > /srv/apps/n8n/secrets/db_password
unset N8N_DB_PASSWORD
```

Generate a persistent n8n encryption key once:

```bash
openssl rand -hex 32 > /srv/apps/n8n/secrets/encryption_key
```

n8n stores encrypted credentials using this key. Never regenerate or replace it after credentials are in use unless you are intentionally performing an encryption-key migration.

The official image runs as UID/GID `1000`, so prepare ownership and permissions:

```bash
sudo chown -R 1000:1000 /srv/apps/n8n/data
sudo chown 1000:1000 /srv/apps/n8n/secrets/db_password
sudo chown 1000:1000 /srv/apps/n8n/secrets/encryption_key
sudo chmod 700 /srv/apps/n8n/data /srv/apps/n8n/secrets
sudo chmod 600 /srv/apps/n8n/secrets/db_password
sudo chmod 600 /srv/apps/n8n/secrets/encryption_key
sudo chmod 755 /srv/apps/n8n/entrypoint.sh
```

The custom entrypoint reads the two secret files, exports `DB_POSTGRESDB_PASSWORD` and `N8N_ENCRYPTION_KEY` only inside the container process, then starts n8n.

## 5. Confirm the shared Docker network

```bash
docker network inspect postgres_net >/dev/null 2>&1 || docker network create postgres_net
```

The PostgreSQL container must already be attached to this network with the `postgres` alias.

## 6. Start n8n

```bash
cd /srv/apps/n8n

docker compose config
docker compose pull
docker compose up -d
```

Verify:

```bash
docker compose ps
docker logs n8n --tail 100
```

The expected host binding is:

```text
127.0.0.1:5678 -> 5678/tcp
```

Test the local health endpoint:

```bash
curl -fsS http://127.0.0.1:5678/healthz
```

## 7. Nginx reverse proxy

Copy the example and replace the placeholder domain:

```bash
sudo cp /srv/apps/n8n/nginx.conf.example /etc/nginx/sites-available/n8n
sudo nano /etc/nginx/sites-available/n8n
sudo ln -sf /etc/nginx/sites-available/n8n /etc/nginx/sites-enabled/n8n
sudo nginx -t
sudo systemctl reload nginx
```

Create DNS first:

```text
n8n.example.com -> YOUR_VPS_PUBLIC_IP
```

Then issue HTTPS:

```bash
sudo certbot --nginx -d n8n.example.com
```

The compose stack sets `N8N_PROXY_HOPS=1`, `WEBHOOK_URL`, and `N8N_EDITOR_BASE_URL` for the single host-Nginx reverse-proxy hop.

## 8. Verify externally

Open:

```text
https://n8n.example.com
```

Then verify HTTPS and health:

```bash
curl -I https://n8n.example.com
curl -fsS https://n8n.example.com/healthz
```

On first launch, create the n8n owner account in the web UI.

## 9. Docker Services integration

The VSM Docker agent default allowlist includes the `n8n` container. After updating/recreating the agent, `/docker` can display n8n metrics, logs, lifecycle controls, and CPU/RAM limits alongside the existing platform services.

## 10. Update n8n

Do not blindly use `latest` in production. Check the n8n release notes, update `N8N_VERSION` in `/srv/apps/n8n/.env`, then:

```bash
cd /srv/apps/n8n
docker compose pull
docker compose up -d

docker compose ps
docker logs n8n --tail 100
```

Keep the database, `/srv/apps/n8n/data`, and `/srv/apps/n8n/secrets/encryption_key` backed up before major upgrades.

## Security invariants

```text
n8n port 5678 remains bound to 127.0.0.1 only.
Public access goes through host Nginx + HTTPS.
n8n uses a dedicated PostgreSQL database and role.
The database password is not committed to Git.
The n8n encryption key is not committed to Git.
The encryption key is persistent and must not be casually rotated.
The app connects only to postgres_net unless another network is explicitly required.
Execution history pruning is enabled by default.
Diagnostics and personalization telemetry are disabled in this stack.
```
