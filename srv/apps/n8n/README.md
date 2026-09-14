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
       ├── mysql_net    -> mysql:3306
       ├── mongo_net    -> mongodb:27017 / rs0
       └── media_net    -> media-service:8080

Redis queue
  -> n8n-worker
       ├── postgres_net -> postgres:5432
       ├── redis_net    -> redis:6379
       ├── mysql_net    -> mysql:3306
       ├── mongo_net    -> mongodb:27017 / rs0
       └── media_net    -> media-service:8080
```

Only the main n8n process publishes a host port, and it is bound to loopback. `n8n-worker` publishes no host port.

Queue mode is always enabled. Production and manual executions are offloaded to workers with `OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS=true`.

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

The Redis password is read from `secrets/redis_password`. Initial worker concurrency is `5`.

Queue mode uses:

```text
N8N_DEFAULT_BINARY_DATA_MODE=database
```

For application-owned images, videos, PDFs and documents, use the dedicated Media Service rather than n8n execution storage as permanent storage.

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

## PostgreSQL runtime database

n8n itself continues to use dedicated PostgreSQL credentials on `postgres_net`. Do not replace n8n's runtime database with MySQL or MongoDB just because workflow access to those services exists.

## Redis ACL user

Use Platform Admin `/redis` to create a dedicated Redis user such as:

```text
n8n_queue
```

Do not use `platform_controller` for queue traffic.

## MySQL workflow access

After the MySQL infrastructure stack is deployed, both n8n containers resolve:

```text
Host: mysql
Port: 3306
```

Create an application database/user in Platform Admin `/mysql`, then place that generated application credential into an n8n MySQL credential. Never use MySQL `root` or `platform_controller` from workflows.

## MongoDB workflow access

After the MongoDB infrastructure stack is deployed, both n8n containers resolve:

```text
Host:        mongodb
Port:        27017
Replica set: rs0
```

Use an application credential generated from Platform Admin `/mongodb`.

Connection format:

```text
mongodb://USER:PASSWORD@mongodb:27017/DATABASE?authSource=DATABASE&replicaSet=rs0
```

Never use MongoDB `root` or `platform_controller` from workflows.

## Copy/update the app

Do not overwrite runtime `.env`, `data/` or `secrets/`:

```bash
cd /tmp/vps_server_management_VSM
git pull
sudo rsync -a \
  --exclude='.env' \
  --exclude='data/' \
  --exclude='secrets/' \
  srv/apps/n8n/ \
  /srv/apps/n8n/
```

Never regenerate the n8n encryption key after credentials exist.

## Required Docker networks

```bash
docker network inspect postgres_net >/dev/null 2>&1 || docker network create postgres_net
docker network inspect redis_net >/dev/null 2>&1 || docker network create redis_net
docker network inspect mysql_net >/dev/null 2>&1 || docker network create mysql_net
docker network inspect mongo_net >/dev/null 2>&1 || docker network create mongo_net
docker network inspect media_net >/dev/null 2>&1 || docker network create media_net
```

Expected aliases after the corresponding service is deployed:

```text
postgres      -> PostgreSQL
redis         -> Redis
mysql         -> MySQL
mongodb       -> MongoDB
media-service -> Media Storage
```

## Start / recreate queue mode

```bash
cd /srv/apps/n8n
docker compose config
docker compose pull
docker compose up -d --force-recreate
docker compose ps
docker logs n8n --tail 100
docker logs n8n-worker --tail 100
```

Expected:

```text
n8n          healthy
n8n-worker   healthy
```

Worker log should report concurrency `5`.

## Health checks

Main:

```bash
curl -fsS http://127.0.0.1:5678/healthz/readiness
```

Worker:

```bash
docker exec n8n-worker \
  node -e "fetch('http://127.0.0.1:5678/healthz/readiness').then(async r=>console.log(r.status,await r.text()))"
```

## Private database connectivity tests

After MySQL is deployed:

```bash
docker exec n8n node -e "require('net').connect(3306,'mysql').on('connect',function(){console.log('mysql tcp ok');this.end()}).on('error',e=>{console.error(e);process.exit(1)})"
```

After MongoDB is deployed:

```bash
docker exec n8n node -e "require('net').connect(27017,'mongodb').on('connect',function(){console.log('mongodb tcp ok');this.end()}).on('error',e=>{console.error(e);process.exit(1)})"
```

## Scaling later

Start with one worker at concurrency `5`. If queue wait time grows while CPU/RAM/PostgreSQL remain safe, increase concurrency carefully or add workers. All additional workers that need MySQL/MongoDB workflow nodes must also join `mysql_net` and `mongo_net`.

## Security invariants

```text
n8n main 5678 remains loopback-only.
n8n-worker publishes no host port.
Redis 6379 remains Docker-private.
MySQL 3306 remains Docker-private.
MongoDB 27017 remains Docker-private.
Workflows use application database users, never controller/root accounts.
Main and worker share the exact same persistent N8N_ENCRYPTION_KEY.
Queue binary mode is database.
Media Service remains the durable application file store.
Secrets are never committed to Git.
```
