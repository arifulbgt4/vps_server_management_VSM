# Production VPS Setup and Operations Guide

This is the authoritative operations guide for the VSM repository. It distinguishes tracked code from services that have actually been deployed and verified on the VPS.

> Never commit passwords, private keys, bearer tokens, database controller credentials, MongoDB keyfiles, n8n encryption keys, or credential-vault keys.
>
> Documentation uses `example.com` placeholders. Real production domains belong only in runtime configuration.

## 1. Architecture

The host is a single Ubuntu 24.04 LTS VPS running Docker Engine, Docker Compose, host Nginx and Certbot.

```text
Internet
   |
Host Nginx
   |------------------------|------------------------|
   v                        v                        v
Platform Admin           n8n main              Media Service
127.0.0.1:3000           127.0.0.1:5678       127.0.0.1:8082
                             |
                             v
                        Redis queue
                             |
                             v
                        n8n-worker

Private Docker infrastructure:
  postgres_net  -> postgres:5432
  redis_net     -> redis:6379
  mysql_net     -> mysql:3306
  mongo_net     -> mongodb:27017
  media_net     -> media-service:8080
  management_net -> Platform Admin <-> Docker agent
```

Repository code for MySQL and MongoDB is implemented. They are not considered live production services until their VPS deployment and runtime acceptance checks pass.

## 2. Network exposure

Intentionally public ports:

```text
22/tcp    SSH
80/tcp    HTTP / ACME
443/tcp   HTTPS
5432/tcp  PostgreSQL TLS
6380/tcp  Redis TLS
```

Private/loopback-only ports:

```text
3000    Platform Admin loopback
5678    n8n main loopback
5678    n8n-worker health Docker-internal
6379    Redis Docker-private
3306    MySQL Docker-private
27017   MongoDB Docker-private
8080    Media Service Docker-private
8082    Media Service loopback
```

Do not add public firewall rules for MySQL `3306` or MongoDB `27017` in the private-first design.

## 3. Filesystem layout

```text
/srv/
├── infrastructure/
│   ├── databases/
│   │   ├── postgres/
│   │   ├── mysql/
│   │   └── mongodb/
│   ├── cache/redis/
│   ├── management/docker-agent/
│   └── networking/
└── apps/
    ├── platform-admin/
    ├── n8n/
    └── media-service/
```

Persistent data and secrets live outside disposable container layers.

## 4. Host security

SSH policy:

```text
PermitRootLogin no
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
```

Recommended packages:

```bash
sudo apt update
sudo apt install -y \
  curl wget git nano unzip ca-certificates gnupg \
  ufw fail2ban nginx certbot python3-certbot-nginx quota rsync
```

Host UFW exposes only SSH/HTTP/HTTPS. PostgreSQL/Redis public database ports are additionally controlled by provider firewall and the Docker-aware `DOCKER-USER` policy.

Expected provider rules before final DROP:

```text
22
80
443
5432
6380
```

Verify Docker-aware policy:

```bash
sudo iptables -nvL DOCKER-USER --line-numbers
```

Expected logical policy:

```text
ACCEPT RELATED,ESTABLISHED
ACCEPT original destination 5432
ACCEPT original destination 6380
DROP   other NEW public Docker-forwarded traffic
```

## 5. External Docker networks

Create once:

```bash
docker network inspect proxy_net >/dev/null 2>&1 || docker network create proxy_net
docker network inspect postgres_net >/dev/null 2>&1 || docker network create postgres_net
docker network inspect redis_net >/dev/null 2>&1 || docker network create redis_net
docker network inspect mysql_net >/dev/null 2>&1 || docker network create mysql_net
docker network inspect mongo_net >/dev/null 2>&1 || docker network create mongo_net
docker network inspect management_net >/dev/null 2>&1 || docker network create management_net
docker network inspect media_net >/dev/null 2>&1 || docker network create media_net
```

Same-VPS applications should use private Docker aliases instead of public database endpoints wherever possible.

## 6. Platform Admin 1.0.0

Tracked runtime path:

```text
/srv/apps/platform-admin
```

Modules:

```text
/postgres
/mysql
/mongodb
/redis
/docker
/media
```

The credential vault encrypts recoverable application credentials with AES-256-GCM. Database root/bootstrap credentials never go to browser code and are not mounted into Platform Admin.

Platform Admin does not mount `docker.sock`; Docker control remains isolated behind `platform-docker-agent`.

## 7. PostgreSQL

Existing service:

```text
container: platform-postgres
private:   postgres:5432
public:    db.example.com:5432 with TLS/SCRAM
```

Public URL:

```text
postgresql://USER:PASSWORD@db.example.com:5432/DATABASE?sslmode=verify-full
```

Applications use dedicated unprivileged roles.

## 8. Redis

Existing service:

```text
container: platform-redis
private:   redis:6379
public:    redis.example.com:6380 TLS
```

The default Redis user is disabled. Applications use dedicated ACL identities. n8n queue mode uses its own user such as `n8n_queue` and DB index `1`.

## 9. MySQL integration

Tracked files:

```text
srv/infrastructure/databases/mysql/compose.yml
srv/infrastructure/databases/mysql/.env.example
srv/infrastructure/databases/mysql/scripts/init-controller.sh
srv/infrastructure/databases/mysql/README.md
```

Target service:

```text
container: platform-mysql
alias:     mysql
port:      3306 private only
image:     mysql:8.4 by default
```

Identity model:

```text
root                 localhost/bootstrap/emergency only
platform_controller  Platform Admin management only
application users    database-scoped runtime identities
```

`MYSQL_ROOT_HOST=localhost` prevents a persistent remote root account. `platform_controller` is created during the official image's first `/var/lib/mysql` initialization through `/docker-entrypoint-initdb.d/20-platform-controller.sh`. There is no MySQL bootstrap sidecar.

### Deploy MySQL code

```bash
cd /tmp/vps_server_management_VSM
git pull
sudo mkdir -p /srv/infrastructure/databases/mysql
sudo rsync -a \
  --exclude='.env' \
  --exclude='data/' \
  --exclude='backups/' \
  --exclude='secrets/' \
  srv/infrastructure/databases/mysql/ \
  /srv/infrastructure/databases/mysql/
```

Prepare runtime:

```bash
cd /srv/infrastructure/databases/mysql
mkdir -p data backups secrets
[ -f .env ] || cp .env.example .env
chmod 600 .env

docker network inspect mysql_net >/dev/null 2>&1 || docker network create mysql_net

[ -f secrets/root_password ] || openssl rand -hex 32 > secrets/root_password
[ -f secrets/controller_password ] || openssl rand -hex 32 > secrets/controller_password

sudo chown 999:999 secrets/root_password secrets/controller_password
sudo chmod 600 secrets/root_password secrets/controller_password
sudo chown -R 999:999 data
```

UID/GID `999` is the expected database user for the tracked official image family; verify it when changing image families.

Start:

```bash
docker compose config
docker compose pull
docker compose up -d
docker compose ps
docker logs platform-mysql --tail 100
```

On a brand-new data directory, logs should include the controller initialization message. Ordinary restarts do not rerun `/docker-entrypoint-initdb.d` scripts.

### Install Platform Admin MySQL secret copy

```bash
sudo install \
  -o 1001 -g 1001 -m 0600 \
  /srv/infrastructure/databases/mysql/secrets/controller_password \
  /srv/apps/platform-admin/secrets/mysql_controller_password
```

`/mysql` then manages database/user creation, existing-user assignments, password rotation, encrypted URL reveal and deletion. Database+user deletion is blocked when that user still owns grants on another managed database.

Private app URL:

```text
mysql://USER:PASSWORD@mysql:3306/DATABASE
```

## 10. MongoDB integration

Tracked files:

```text
srv/infrastructure/databases/mongodb/compose.yml
srv/infrastructure/databases/mongodb/.env.example
srv/infrastructure/databases/mongodb/config/mongod.conf
srv/infrastructure/databases/mongodb/scripts/init-replica.sh
srv/infrastructure/databases/mongodb/README.md
```

Target service:

```text
container:   platform-mongodb
alias:       mongodb
port:        27017 private only
replica set: rs0
image:       mongo:8.0 by default
```

Identity model:

```text
root                 bootstrap/emergency only
platform_controller  Platform Admin management only
application users    readWrite on their own database
```

MongoDB starts with authorization, a persistent replica-set keyfile and `rs0`. A one-shot `platform-mongodb-init` sidecar initiates `rs0` if needed, waits for PRIMARY state, creates/rotates `platform_controller`, then exits.

### Deploy MongoDB code

```bash
cd /tmp/vps_server_management_VSM
git pull
sudo mkdir -p /srv/infrastructure/databases/mongodb
sudo rsync -a \
  --exclude='.env' \
  --exclude='data/' \
  --exclude='backups/' \
  --exclude='secrets/' \
  srv/infrastructure/databases/mongodb/ \
  /srv/infrastructure/databases/mongodb/
```

Prepare runtime:

```bash
cd /srv/infrastructure/databases/mongodb
mkdir -p data backups secrets
[ -f .env ] || cp .env.example .env
chmod 600 .env

docker network inspect mongo_net >/dev/null 2>&1 || docker network create mongo_net

[ -f secrets/root_password ] || openssl rand -hex 32 > secrets/root_password
[ -f secrets/controller_password ] || openssl rand -hex 32 > secrets/controller_password
[ -f secrets/replica_keyfile ] || openssl rand -hex 64 > secrets/replica_keyfile

sudo chown 999:999 secrets/root_password secrets/replica_keyfile
sudo chmod 600 secrets/root_password
sudo chmod 400 secrets/replica_keyfile
sudo chown root:root secrets/controller_password
sudo chmod 600 secrets/controller_password
sudo chown -R 999:999 data
```

Start:

```bash
docker compose config
docker compose pull
docker compose up -d
docker compose ps
docker logs platform-mongodb --tail 100
docker logs platform-mongodb-init --tail 100
```

Expected bootstrap sidecar result: exited successfully after `rs0` is PRIMARY and the controller exists.

### Install Platform Admin MongoDB secret copy

```bash
sudo install \
  -o 1001 -g 1001 -m 0600 \
  /srv/infrastructure/databases/mongodb/secrets/controller_password \
  /srv/apps/platform-admin/secrets/mongo_controller_password
```

Private application URL:

```text
mongodb://USER:PASSWORD@mongodb:27017/DATABASE?authSource=DATABASE&replicaSet=rs0
```

Never regenerate `replica_keyfile` on a live replica set without a reviewed key-rotation procedure.

## 11. Rebuild Platform Admin

Create both private controller-secret copies before rebuilding Platform Admin, because its compose file requires them.

```bash
cd /tmp/vps_server_management_VSM
git pull
sudo rsync -a \
  --exclude='.env' \
  --exclude='secrets/' \
  --exclude='node_modules/' \
  srv/apps/platform-admin/ \
  /srv/apps/platform-admin/

cd /srv/apps/platform-admin
docker compose config
docker compose up -d --build
docker compose ps
docker logs platform-admin --tail 100
```

Expected authenticated pages:

```text
/postgres
/mysql
/mongodb
/redis
/docker
/media
```

## 12. n8n queue and database-network integration

n8n itself continues to use PostgreSQL for persistent runtime data. MySQL and MongoDB are additional private workflow targets, not replacements for n8n's runtime database.

Tracked n8n networks:

```text
postgres_net
redis_net
mysql_net
mongo_net
media_net
```

Queue mode remains:

```text
EXECUTIONS_MODE=queue
OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS=true
QUEUE_BULL_REDIS_HOST=redis
QUEUE_BULL_REDIS_DB=1
N8N_DEFAULT_BINARY_DATA_MODE=database
```

Safe sync/recreate:

```bash
cd /tmp/vps_server_management_VSM
git pull
sudo rsync -a \
  --exclude='.env' \
  --exclude='data/' \
  --exclude='secrets/' \
  srv/apps/n8n/ \
  /srv/apps/n8n/

cd /srv/apps/n8n
docker compose config
docker compose up -d --force-recreate
docker compose ps
```

Private TCP checks:

```bash
docker exec n8n node -e "require('net').connect(3306,'mysql').on('connect',function(){console.log('mysql tcp ok');this.end()}).on('error',e=>{console.error(e);process.exit(1)})"

docker exec n8n node -e "require('net').connect(27017,'mongodb').on('connect',function(){console.log('mongodb tcp ok');this.end()}).on('error',e=>{console.error(e);process.exit(1)})"
```

Workflows must use application credentials generated in `/mysql` or `/mongodb`, never controller/root identities.

## 13. Media Storage

Existing service:

```text
container: platform-media
private:   media-service:8080
host:      127.0.0.1:8082
```

Physical files live under `/srv/apps/media-service/storage`; metadata/quota ownership lives in PostgreSQL. Media user API keys are hashed in Media Service, while Platform Admin can retain encrypted reveal copies.

## 14. Docker control agent

Default long-running allowlist:

```text
platform-admin
platform-postgres
platform-redis
platform-mysql
platform-mongodb
n8n
n8n-worker
platform-media
```

`platform-mongodb-init` is intentionally excluded. MySQL has no bootstrap sidecar.

If `/srv/infrastructure/management/docker-agent/.env` explicitly overrides `DOCKER_AGENT_ALLOWLIST`, update that runtime override as well.

Apply tracked compose changes:

```bash
cd /tmp/vps_server_management_VSM
git pull
cp srv/infrastructure/management/docker-agent/compose.yml \
  /srv/infrastructure/management/docker-agent/compose.yml

cd /srv/infrastructure/management/docker-agent
docker compose up -d --force-recreate
docker logs platform-docker-agent --tail 100
```

## 15. Verification

```bash
# database containers
docker compose -f /srv/infrastructure/databases/mysql/compose.yml ps
docker compose -f /srv/infrastructure/databases/mongodb/compose.yml ps

# application containers
docker compose -f /srv/apps/platform-admin/compose.yml ps
docker compose -f /srv/apps/n8n/compose.yml ps

# networks
docker network inspect mysql_net --format '{{range $id,$c := .Containers}}{{println $c.Name}}{{end}}'
docker network inspect mongo_net --format '{{range $id,$c := .Containers}}{{println $c.Name}}{{end}}'

# no public DB publication
docker port platform-mysql
docker port platform-mongodb
```

Expected long-running members after full integration:

```text
mysql_net:
  platform-mysql
  platform-admin
  n8n
  n8n-worker

mongo_net:
  platform-mongodb
  platform-admin
  n8n
  n8n-worker
```

`docker port platform-mysql` and `docker port platform-mongodb` should show no host-published database port.

## 16. Backup/recovery

Critical state includes:

```text
PostgreSQL databases
Redis /data
MySQL /var/lib/mysql + logical dumps + service secrets
MongoDB /data/db + logical dumps + root/controller/keyfile secrets
n8n data + persistent N8N_ENCRYPTION_KEY
Media Storage files + media database
Platform Admin credential_vault_key + app-local controller copies
```

A backup policy is not production-ready until an actual restore test succeeds.

MySQL: use a consistent `mysqldump`/restore procedure.
MongoDB: use `mongodump --archive --gzip` / `mongorestore` or a reviewed consistent snapshot procedure.

## 17. Storage-limit status

CPU/RAM resource limits are managed through `/docker`.

Hard per-service persistent-storage quotas are **not currently active**. The root ext4 filesystem does not have project quota enabled. Do not claim storage limits exist until a dedicated quota-capable filesystem or another reviewed storage-quota design is deployed.

## 18. Scaling/load balancing

n8n execution scales first through Redis workers. Redis distributes execution jobs; no HTTP load balancer is needed for worker distribution.

Introduce HTTP load balancing only after multiple HTTP-facing instances exist. A load balancer on the same single VPS does not remove the VPS as a single point of failure.

## 19. Security invariants

```text
No root/password SSH login.
Platform Admin 3000 stays loopback-only.
n8n main 5678 stays loopback-only.
n8n-worker publishes no host port.
Media 8082 stays loopback-only.
Redis 6379 stays Docker-private.
MySQL 3306 stays Docker-private.
MongoDB 27017 stays Docker-private.
MySQL remote root is not created.
Database root/bootstrap credentials are never used by applications.
Platform Admin receives only private controller-secret copies.
n8n workflows use application-scoped database credentials.
MongoDB replica keyfile remains persistent/private.
Platform Admin never mounts docker.sock.
Secrets are never committed to Git.
DOCKER-USER blocks unapproved public Docker-published ports.
```

## 20. Runtime acceptance checklist

Do not mark the new database integrations deployed until all relevant checks pass:

```text
platform-mysql healthy
/mysql loads and can create/rotate/delete a test application DB/user
platform-mongodb healthy
platform-mongodb-init exited 0
rs0 has one writable PRIMARY
/mongodb loads and can create/rotate/delete a test application DB/user
Platform Admin healthy after rebuild
n8n healthy
n8n-worker healthy
n8n -> mysql:3306 succeeds
n8n -> mongodb:27017 succeeds
platform-mysql appears in /docker
platform-mongodb appears in /docker
3306 has no host publication
27017 has no host publication
MySQL restore test succeeds
MongoDB restore test succeeds
```
