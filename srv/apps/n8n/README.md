# n8n Production App

Production n8n deployment for the VSM host. The stack uses shared PostgreSQL for persistent n8n data, shared Redis as the Bull queue/message broker, one main n8n process for the editor/API/webhooks, and one worker process for workflow execution.

The image is pinned to n8n `2.38.7`. Review n8n release notes before upgrading the pinned version.

> Documentation uses `example.com` as a placeholder domain. Replace it with the real production domain in VPS runtime configuration.

## Architecture

```text
Internet
  -> HTTPS / Nginx on host
  -> 127.0.0.1:5678
  -> n8n main
       ├── postgres_net -> postgres:5432
       ├── redis_net    -> redis:6379 -> Bull queue
       └── media_net    -> media-service:8080

Redis queue
  -> n8n-worker
       ├── postgres_net -> postgres:5432
       ├── redis_net    -> redis:6379
       └── media_net    -> media-service:8080
```

Only the main n8n process publishes a host port, and it is bound to loopback. `n8n-worker` publishes no host port.

Queue mode is always enabled in this stack. Production executions are processed by workers. Manual executions are also offloaded to workers with `OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS=true`.

## Queue configuration

```text
EXECUTIONS_MODE=queue
QUEUE_BULL_REDIS_HOST=redis
QUEUE_BULL_REDIS_PORT=6379
QUEUE_BULL_REDIS_USERNAME=n8n_queue
QUEUE_BULL_REDIS_DB=1
QUEUE_BULL_PREFIX=n8n
OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS=true
```

The Redis password is not stored in `.env`; it is read from `secrets/redis_password` by the custom entrypoint and exported only inside the container process.

The initial worker concurrency is `5`. n8n recommends worker concurrency of at least 5. Increase it only after observing VPS CPU/RAM, PostgreSQL connections, Redis health, and workflow latency.

Queue mode must not use local filesystem binary storage. This stack explicitly sets:

```text
N8N_DEFAULT_BINARY_DATA_MODE=database
```

For application-owned images, videos, PDFs and documents, prefer the dedicated Media Service rather than treating n8n execution storage as permanent file storage.

## Runtime files

```text
/srv/apps/n8n/
├── compose.yml
├── entrypoint.sh
├── .env
├── data/
├── secrets/
│   ├── db_password
│   ├── encryption_key
│   └── redis_password
└── nginx.conf.example
```

`.env`, `data/`, and `secrets/` are ignored by Git.

## 1. PostgreSQL

Use Platform Admin `/postgres` to create or reuse the dedicated n8n database/role. The runtime values must match `.env`.

Example:

```text
Database: n8n
User:     n8n_app
```

Do not use `postgres`, `platform_controller`, or `platform_app` as the n8n runtime role.

## 2. Redis ACL user

Use Platform Admin `/redis` to create a dedicated Redis user:

```text
n8n_queue
```

Do not use `platform_controller` for n8n queue traffic.

The internal same-VPS Redis endpoint is:

```text
redis:6379
```

Queue DB index `1` is used to keep n8n queue keys logically separate from applications using Redis DB `0`.

## 3. Copy/update the app

```bash
cd /tmp/vps_server_management_VSM
git pull

sudo mkdir -p /srv/apps/n8n
sudo chown -R ariful:ariful /srv/apps/n8n

cp -a srv/apps/n8n/. /srv/apps/n8n/
```

Do not delete existing runtime secrets or regenerate the n8n encryption key.

## 4. Runtime directories and environment

```bash
cd /srv/apps/n8n
mkdir -p data secrets
chmod 755 entrypoint.sh
```

If `.env` does not already exist, start from `.env.example` and set the production domain/database values.

Queue settings:

```env
N8N_REDIS_USER=n8n_queue
N8N_REDIS_DB=1
N8N_QUEUE_PREFIX=n8n
N8N_WORKER_CONCURRENCY=5
```

## 5. Secrets

Existing database secret:

```text
/srv/apps/n8n/secrets/db_password
```

Existing persistent encryption key:

```text
/srv/apps/n8n/secrets/encryption_key
```

Never regenerate `encryption_key` after n8n credentials exist.

Write the password for Redis user `n8n_queue` without placing it in shell history:

```bash
read -s N8N_REDIS_PASSWORD
echo
printf '%s' "$N8N_REDIS_PASSWORD" > /srv/apps/n8n/secrets/redis_password
unset N8N_REDIS_PASSWORD
```

The official image runs as UID/GID `1000`:

```bash
sudo chown -R 1000:1000 /srv/apps/n8n/data
sudo chown 1000:1000 /srv/apps/n8n/secrets/db_password
sudo chown 1000:1000 /srv/apps/n8n/secrets/encryption_key
sudo chown 1000:1000 /srv/apps/n8n/secrets/redis_password

sudo chmod 700 /srv/apps/n8n/data /srv/apps/n8n/secrets
sudo chmod 600 /srv/apps/n8n/secrets/db_password
sudo chmod 600 /srv/apps/n8n/secrets/encryption_key
sudo chmod 600 /srv/apps/n8n/secrets/redis_password
sudo chmod 755 /srv/apps/n8n/entrypoint.sh
```

## 6. Docker networks

```bash
docker network inspect postgres_net >/dev/null 2>&1 || docker network create postgres_net
docker network inspect redis_net >/dev/null 2>&1 || docker network create redis_net
docker network inspect media_net >/dev/null 2>&1 || docker network create media_net
```

Expected service aliases:

```text
postgres -> shared PostgreSQL on postgres_net
redis -> shared Redis on redis_net
media-service -> Media Service on media_net
```

## 7. Start queue mode

```bash
cd /srv/apps/n8n

docker compose config
docker compose pull
docker compose up -d --force-recreate
```

Verify:

```bash
docker compose ps
docker logs n8n --tail 100
docker logs n8n-worker --tail 100
```

Expected containers:

```text
n8n          healthy
n8n-worker   healthy
```

The worker log should include a ready message and concurrency value `5`.

## 8. Health checks

Main:

```bash
curl -fsS http://127.0.0.1:5678/healthz/readiness
```

Worker from inside its container:

```bash
docker exec n8n-worker \
  node -e "fetch('http://127.0.0.1:5678/healthz/readiness').then(async r=>console.log(r.status,await r.text()))"
```

## 9. Redis verification

Confirm both containers joined `redis_net`:

```bash
docker network inspect redis_net \
  --format '{{range $id,$c := .Containers}}{{println $c.Name}}{{end}}'
```

Expected to include:

```text
platform-redis
n8n
n8n-worker
```

A production workflow execution should be received by the main instance and executed by `n8n-worker`.

## 10. Nginx / HTTPS

The main process stays on:

```text
127.0.0.1:5678
```

Public traffic goes through host Nginx and HTTPS. Worker port `5678` remains Docker-internal only and is used solely for worker health endpoints.

## 11. Docker Services integration

The Docker agent allowlist includes both:

```text
n8n
n8n-worker
```

After recreating the Docker agent, Platform Admin `/docker` can show and control both containers independently.

## Scaling later

Start with one worker at concurrency `5`. If queue wait time grows while the VPS still has safe CPU/RAM and PostgreSQL capacity, either increase `N8N_WORKER_CONCURRENCY` or add another worker. Avoid many low-concurrency workers because each worker adds database connections and process overhead.

Webhook processor containers are not required initially. Add them only when incoming webhook traffic itself becomes a bottleneck.

## Security invariants

```text
n8n main port 5678 remains bound to 127.0.0.1 only.
n8n-worker publishes no host port.
Redis plaintext 6379 remains Docker-private.
n8n uses a dedicated Redis ACL user, not platform_controller.
Redis queue password is stored only in secrets/redis_password.
PostgreSQL and Redis are shared infrastructure but use dedicated app identities.
Main and worker use the exact same persistent N8N_ENCRYPTION_KEY.
Queue binary mode is database, never local filesystem.
Media Service remains the durable application file store.
Secrets are never committed to Git.
```
