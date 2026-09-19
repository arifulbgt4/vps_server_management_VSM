# n8n Automation SaaS deployment on VSM

This guide runs PostgreSQL, Redis, `automation-api`, `automation-worker`, n8n, `n8n-worker`, and Media Storage on the VPS while Customer Panel and Super Admin are developed locally.

## Architecture

```text
Local Mac
  Customer Panel :3000
  Super Admin    :3001
        |
        | HTTPS
        v
api.openmusk.store -> platform-proxy -> automation-api:4000
                                      |
                                      +-> PostgreSQL app_db
                                      +-> Redis DB 0
                                      +-> Media Storage
                                      +-> n8n

automation-worker -> SaaS BullMQ queues
n8n-worker        -> n8n execution queue
```

`automation-worker` and `n8n-worker` are separate services and must both remain enabled.

## 1. DNS

Create this A record before deployment:

```text
api.openmusk.store -> YOUR_VPS_IPV4
```

If another hostname is used, set `API_DOMAIN` in the VPS `.env`.

## 2. Pull the VSM update

```bash
cd /path/to/vps_server_management_VSM
git checkout master
git pull origin master
```

For a first install:

```bash
cp -n .env.example .env
chmod 600 .env
nano .env
```

Verify at least:

```dotenv
API_DOMAIN=api.openmusk.store
AUTOMATION_REPOSITORY=https://github.com/arifulbgt4/n8n-automation.git
AUTOMATION_REF=master
AUTOMATION_QUEUE_PREFIX=n8nauto:production
AUTOMATION_CUSTOMER_APP_ORIGIN=http://localhost:3000
AUTOMATION_ADMIN_APP_ORIGIN=http://localhost:3001
```

Do not commit the VPS `.env`.

## 3. Back up PostgreSQL before the first pgvector build

The PostgreSQL image remains based on the same `postgres:17-alpine` runtime. VSM compiles pgvector into that image, preserving the existing Alpine UID/data layout. Still take a backup first:

```bash
sudo mkdir -p /srv/vsm/backups
sudo sh -c 'docker exec -u postgres platform-postgres pg_dumpall -U postgres > /srv/vsm/backups/pre-automation-$(date +%Y%m%d-%H%M%S).sql'
ls -lh /srv/vsm/backups/
```

## 4. Validate and deploy

```bash
docker compose config >/dev/null
sudo ./bootstrap.sh
```

For an already bootstrapped VPS, this is enough:

```bash
docker compose up -d --build
```

The automatic dependency chain is:

```text
vsm-init
  -> postgres with pgvector capability
  -> automation-db-init
  -> automation-migrate
  -> automation-api
  -> automation-worker
```

`automation-db-init` and `automation-migrate` are one-shot services. `Exited (0)` is the expected healthy state for them.

## 5. Inspect runtime status

```bash
docker compose ps -a
docker compose logs --tail=100 automation-db-init
docker compose logs --tail=100 automation-migrate
docker compose logs --tail=100 automation-api
docker compose logs --tail=100 automation-worker
docker compose logs --tail=100 n8n
docker compose logs --tail=100 n8n-worker
```

## 6. Verify PostgreSQL

```bash
docker exec -u postgres platform-postgres psql -U postgres -d app_db -c '\dx'
```

`app_db` should contain `pgcrypto` and `vector`. Other databases remain normal PostgreSQL databases; pgvector is database-scoped and is not enabled elsewhere automatically.

## 7. Verify API

Internal health:

```bash
docker exec automation-api node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>r.text()).then(console.log)"
docker exec automation-api node -e "fetch('http://127.0.0.1:4000/readyz').then(r=>r.text()).then(console.log)"
```

External health:

```bash
curl -fsS https://api.openmusk.store/healthz
curl -fsS https://api.openmusk.store/readyz
```

Expected readiness response: `{"status":"ready"}`.

## 8. Redis separation

n8n remains unchanged: Redis DB 1, user `n8n_queue`, prefix `n8n`.

The SaaS backend uses Redis DB 0, user `automation_app`, prefix `n8nauto:production`. The queues do not overlap.

## 9. n8n and n8n-worker

Do not replace the existing `n8n-worker`. VSM injects these values into both n8n main and n8n worker:

```text
SAAS_API_INTERNAL_URL=http://automation-api:4000
INTERNAL_SERVICE_AUTH_SECRET=<shared generated secret>
N8N_WORKFLOW_BUNDLE_VERSION=1.0.0
```

After changing this integration, recreate both n8n services:

```bash
docker compose up -d --force-recreate n8n n8n-worker
```

## 10. Deploy the n8n-automation workflow bundle

Create an n8n API key from the n8n UI, then on the VPS:

```bash
export N8N_API_KEY='PASTE_YOUR_N8N_API_KEY'
```

Dry run:

```bash
docker compose run --rm --no-deps \
  -e N8N_API_URL=http://n8n:5678 \
  -e N8N_API_KEY="$N8N_API_KEY" \
  -e SAAS_API_INTERNAL_URL=http://automation-api:4000 \
  automation-api npm run n8n:plan
```

Deploy inactive:

```bash
docker compose run --rm --no-deps \
  -e N8N_API_URL=http://n8n:5678 \
  -e N8N_API_KEY="$N8N_API_KEY" \
  -e SAAS_API_INTERNAL_URL=http://automation-api:4000 \
  automation-api npm run n8n:deploy
```

Activate after reviewing trigger conflicts:

```bash
docker compose run --rm --no-deps \
  -e N8N_API_URL=http://n8n:5678 \
  -e N8N_API_KEY="$N8N_API_KEY" \
  -e SAAS_API_INTERNAL_URL=http://automation-api:4000 \
  automation-api npm run n8n:deploy:activate
unset N8N_API_KEY
```

## 11. Create a SaaS Super Admin

```bash
docker compose run --rm --no-deps \
  -e ADMIN_EMAIL='admin@example.com' \
  -e ADMIN_PASSWORD='Use-A-Strong-Password-123' \
  -e ADMIN_NAME='Platform Super Admin' \
  automation-api npm run admin:create
```

## 12. Update the n8n-automation backend later

`AUTOMATION_REF=master` is a moving Git ref, so use a no-cache build to guarantee the newest code is cloned:

```bash
cd /path/to/vps_server_management_VSM
git pull origin master
docker compose build --pull --no-cache automation-api
docker compose up -d --force-recreate automation-migrate automation-api automation-worker
docker compose ps -a automation-migrate automation-api automation-worker
curl -fsS https://api.openmusk.store/readyz
```

The migrate/API/worker services share the same built image tag.

## 13. Update VSM infrastructure later

```bash
cd /path/to/vps_server_management_VSM
git pull origin master
docker compose config >/dev/null
docker compose up -d --build
docker compose ps -a
docker compose logs --tail=100 vsm-smoke
```

## 14. Restart individual services

```bash
docker compose restart automation-api
docker compose restart automation-worker
docker compose restart n8n
docker compose restart n8n-worker
```

## 15. Local frontend configuration

On the development Mac, Customer Panel and Super Admin should proxy local `/api` requests to `https://api.openmusk.store`. This keeps browser authentication same-origin from the local UI perspective and avoids problems with production Secure/SameSite cookies.

Run locally:

```bash
npm run dev:customer
npm run dev:admin
```

Customer: `http://localhost:3000`

Admin: `http://localhost:3001`

Do not publish container port 4000 directly. Public API traffic should enter only through Nginx HTTPS on port 443.
