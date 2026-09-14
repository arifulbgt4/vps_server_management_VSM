# Production VPS Setup and Operations Guide

This is the authoritative operations document for the VSM repository. It records the current single-VPS architecture, security boundaries, deployment procedures, database integrations, n8n queue mode, Media Storage, Docker management, verification and scaling policy.

> Never commit real passwords, private keys, bearer tokens, API keys, database controller credentials, MongoDB keyfiles or encryption keys.
>
> Documentation uses `example.com` placeholders. Runtime production configuration may use the real domains.

## 1. Deployment model

The host is an Ubuntu 24.04 LTS VPS running Docker Engine, Docker Compose, host Nginx and Certbot.

Already deployed/verified services should be distinguished from code that is merely present in Git. Repository code for MySQL and MongoDB is complete, but each service is considered deployed only after its runtime directories/secrets/networks are created on the VPS and health checks pass.

Core architecture:

```text
Internet
   |
Host Nginx
   |---------------------------|---------------------------|
   v                           v                           v
Platform Admin              n8n main                 Media Service
127.0.0.1:3000              127.0.0.1:5678          127.0.0.1:8082
                                |
                                v
                           Redis queue
                                |
                                v
                           n8n-worker

Private infrastructure networks:
  postgres_net -> PostgreSQL alias postgres:5432
  redis_net    -> Redis alias redis:6379
  mysql_net    -> MySQL alias mysql:3306
  mongo_net    -> MongoDB alias mongodb:27017
  media_net    -> Media alias media-service:8080
  management_net -> Platform Admin <-> Docker agent
```

A separate HTTP load balancer is not required while only one HTTP-facing instance of each application exists on this VPS.

## 2. Public ports

Intentionally exposed ports:

```text
22/tcp    SSH
80/tcp    HTTP / ACME
443/tcp   HTTPS
5432/tcp  PostgreSQL TLS
6380/tcp  Redis TLS
```

Private/loopback-only ports:

```text
3000    Platform Admin, loopback only
5678    n8n main, loopback only
5678    n8n worker health endpoint, Docker-internal only
6379    Redis plaintext, Docker-private
3306    MySQL, Docker-private
27017   MongoDB, Docker-private
8080    Media Service container port, Docker-private
8082    Media Service host binding, loopback only
```

Do not add public firewall rules for MySQL `3306` or MongoDB `27017` in the private-first deployment.

## 3. Runtime filesystem layout

```text
/srv/
├── infrastructure/
│   ├── databases/
│   │   ├── postgres/
│   │   ├── mysql/
│   │   └── mongodb/
│   ├── cache/
│   │   └── redis/
│   ├── management/
│   │   └── docker-agent/
│   ├── networking/
│   ├── proxy/
│   └── monitoring/
├── apps/
│   ├── platform-admin/
│   ├── n8n/
│   └── media-service/
├── mail/
└── backups/
```

Persistent data must remain outside disposable container layers.

## 4. Base hardening

Required SSH policy:

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

Enable Fail2ban and set timezone:

```bash
sudo systemctl enable --now fail2ban
sudo timedatectl set-timezone Asia/Dhaka
```

## 5. Firewall policy

Host UFW:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Provider/network firewall allows only the required public ports before the final DROP rule:

```text
22
80
443
5432
6380
```

Docker-published ports can bypass ordinary UFW INPUT handling. The deployment therefore also uses the tracked `DOCKER-USER` policy:

```text
srv/infrastructure/networking/postgres-public/docker-firewall.sh
```

Expected logic:

```text
ACCEPT RELATED,ESTABLISHED
ACCEPT original destination 5432
ACCEPT original destination 6380
DROP   other NEW traffic entering from the external interface
```

Verify:

```bash
sudo iptables -nvL DOCKER-USER --line-numbers
```

## 6. External Docker networks

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

Same-VPS applications should use these private aliases instead of public database domains whenever possible.

## 7. Nginx / HTTPS

Host Nginx terminates HTTPS for HTTP-facing applications:

```text
admin.example.com -> 127.0.0.1:3000
n8n.example.com   -> 127.0.0.1:5678
media.example.com -> 127.0.0.1:8082
```

PostgreSQL and public Redis TLS are not HTTP reverse-proxy workloads.

MySQL and MongoDB have no public Nginx endpoint in the initial integration.

## 8. Platform Admin 1.0.0

Runtime:

```text
/srv/apps/platform-admin
```

Modules:

```text
/postgres   PostgreSQL management
/mysql      MySQL management
/mongodb    MongoDB management
/redis      Redis ACL management
/docker     Docker metrics/lifecycle/resource limits
/media      Media users/quotas/keys/files
```

The credential vault uses AES-256-GCM and stores encrypted recoverable application credentials in the `platform_admin` PostgreSQL database.

Database root/bootstrap credentials are deliberately not exposed to the browser and are not mounted into Platform Admin.

Platform Admin itself never mounts `docker.sock`.

## 9. PostgreSQL

Container:

```text
platform-postgres
```

Private endpoint:

```text
postgres:5432
```

Public TLS format:

```text
postgresql://USER:PASSWORD@db.example.com:5432/DATABASE?sslmode=verify-full
```

Management identities:

```text
postgres             emergency/local superuser
platform_controller  management role, not superuser
platform_app         unprivileged Platform Admin database owner
```

Application roles remain unprivileged.

## 10. Redis

Container:

```text
platform-redis
```

Endpoints:

```text
redis:6379                     private Docker plaintext
redis.example.com:6380         public TLS
```

`default` is disabled. `platform_controller` is management-only. Applications use dedicated ACL identities.

n8n queue uses a dedicated user such as `n8n_queue` and Redis DB index `1`.

## 11. MySQL integration

Tracked stack:

```text
srv/infrastructure/databases/mysql/
```

Container and alias:

```text
platform-mysql
mysql:3306
```

Port `3306` is not host-published.

Identity model:

```text
root                 bootstrap/emergency only
platform_controller  Platform Admin management only
app users             database-scoped runtime identities
```

Platform Admin `/mysql` supports:

```text
list databases and sizes
list users
create database + new application user
create database using an existing application user
rotate passwords
delete database only
delete database + user
reveal private URL from encrypted credential vault
```

Private connection format:

```text
mysql://USER:PASSWORD@mysql:3306/DATABASE
```

### Deploy MySQL

Copy tracked code without overwriting runtime state:

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
```

Create secrets only if they do not already exist:

```bash
[ -f secrets/root_password ] || openssl rand -hex 32 > secrets/root_password
[ -f secrets/controller_password ] || openssl rand -hex 32 > secrets/controller_password

sudo chown root:root secrets/root_password
sudo chmod 600 secrets/root_password
sudo chown 1001:1001 secrets/controller_password
sudo chmod 600 secrets/controller_password
sudo chown -R 999:999 data
```

Start and verify:

```bash
docker compose config
docker compose pull
docker compose up -d
docker compose ps
docker logs platform-mysql --tail 100
docker logs platform-mysql-init --tail 100
```

The `platform-mysql-init` container is expected to finish successfully and exit after creating/rotating the controller account.

## 12. MongoDB integration

Tracked stack:

```text
srv/infrastructure/databases/mongodb/
```

Container/alias/replica:

```text
platform-mongodb
mongodb:27017
rs0
```

Port `27017` is not host-published.

MongoDB uses a single-node replica set from day one so transactions/change streams work and future replica expansion does not require converting from standalone mode.

Identity model:

```text
root                 bootstrap/emergency only
platform_controller  Platform Admin management only
app users             readWrite on their own database
```

Platform Admin `/mongodb` supports database/user creation, password rotation, encrypted connection reveal, database size listing and deletion.

Private connection format:

```text
mongodb://USER:PASSWORD@mongodb:27017/DATABASE?authSource=DATABASE&replicaSet=rs0
```

### Deploy MongoDB

Copy tracked code:

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
```

Create persistent secrets once:

```bash
[ -f secrets/root_password ] || openssl rand -hex 32 > secrets/root_password
[ -f secrets/controller_password ] || openssl rand -hex 32 > secrets/controller_password
[ -f secrets/replica_keyfile ] || openssl rand -hex 64 > secrets/replica_keyfile

sudo chown root:root secrets/root_password
sudo chmod 600 secrets/root_password
sudo chown 1001:1001 secrets/controller_password
sudo chmod 600 secrets/controller_password
sudo chown 999:999 secrets/replica_keyfile
sudo chmod 400 secrets/replica_keyfile
sudo chown -R 999:999 data
```

Start and verify:

```bash
docker compose config
docker compose pull
docker compose up -d
docker compose ps
docker logs platform-mongodb --tail 100
docker logs platform-mongodb-init --tail 100
```

The one-shot initializer should initiate `rs0`, wait for PRIMARY state and create/rotate the controller account.

Never regenerate the replica keyfile on a live replica set without a reviewed key rotation procedure.

## 13. n8n queue mode

Containers:

```text
n8n          editor/API/webhook process
n8n-worker   execution worker
```

Queue settings:

```text
EXECUTIONS_MODE=queue
OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS=true
QUEUE_BULL_REDIS_HOST=redis
QUEUE_BULL_REDIS_PORT=6379
QUEUE_BULL_REDIS_USERNAME=n8n_queue
QUEUE_BULL_REDIS_DB=1
QUEUE_BULL_PREFIX=n8n
N8N_DEFAULT_BINARY_DATA_MODE=database
```

Initial worker concurrency is `5`.

Both main and worker are tracked on:

```text
postgres_net
redis_net
mysql_net
mongo_net
media_net
```

This does not mean n8n runtime data moved to MySQL/MongoDB. n8n itself continues using PostgreSQL; the additional networks allow workflow nodes to reach application databases privately.

## 14. Media Storage

Container:

```text
platform-media
```

Bindings:

```text
127.0.0.1:8082 -> 8080
media-service:8080 on media_net
```

Physical files live under:

```text
/srv/apps/media-service/storage
```

Metadata/quota ownership lives in its PostgreSQL database. The Media Service stores API-key hashes; Platform Admin may keep encrypted copies for authenticated reveal.

## 15. Docker control agent

Container:

```text
platform-docker-agent
```

Default managed allowlist:

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

Bootstrap containers `platform-mysql-init` and `platform-mongodb-init` are intentionally excluded.

If `/srv/infrastructure/management/docker-agent/.env` explicitly overrides `DOCKER_AGENT_ALLOWLIST`, update that runtime override too; Compose defaults do not replace an explicit `.env` value.

## 16. Apply Platform Admin integration

After MySQL and MongoDB runtime secret files exist, update Platform Admin safely:

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

## 17. Apply n8n network integration

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

Expected Redis/network members can be inspected with:

```bash
docker network inspect mysql_net --format '{{range $id,$c := .Containers}}{{println $c.Name}}{{end}}'
docker network inspect mongo_net --format '{{range $id,$c := .Containers}}{{println $c.Name}}{{end}}'
```

After full integration, expected long-running members include:

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

## 18. Private connectivity verification

From n8n:

```bash
docker exec n8n node -e "require('net').connect(3306,'mysql').on('connect',function(){console.log('mysql tcp ok');this.end()}).on('error',e=>{console.error(e);process.exit(1)})"

docker exec n8n node -e "require('net').connect(27017,'mongodb').on('connect',function(){console.log('mongodb tcp ok');this.end()}).on('error',e=>{console.error(e);process.exit(1)})"
```

From Platform Admin the `/mysql` and `/mongodb` pages should load without connection errors.

## 19. Docker-agent update

```bash
cd /tmp/vps_server_management_VSM
git pull
cp srv/infrastructure/management/docker-agent/compose.yml \
  /srv/infrastructure/management/docker-agent/compose.yml
cp srv/infrastructure/management/docker-agent/agent.mjs \
  /srv/infrastructure/management/docker-agent/agent.mjs

cd /srv/infrastructure/management/docker-agent
docker compose up -d --force-recreate
docker logs platform-docker-agent --tail 100
```

Then `/docker` can manage `platform-mysql` and `platform-mongodb` after the containers exist.

## 20. Backup / recovery

Critical state includes:

```text
PostgreSQL databases
Redis /data
MySQL /var/lib/mysql data + logical dumps
MongoDB /data/db + logical dumps + replica_keyfile
/srv/apps/n8n/data
/srv/apps/n8n/secrets/encryption_key
/srv/apps/media-service/storage
Platform Admin credential_vault_key
all runtime secret files required to authenticate restored services
```

A database backup is not validated until an actual restore test succeeds.

MySQL should use `mysqldump`/equivalent consistent backup procedures. MongoDB should use `mongodump --archive --gzip`/`mongorestore` or a reviewed filesystem snapshot process.

Do not restore an n8n database without the matching persistent `N8N_ENCRYPTION_KEY`.

## 21. Resource management

Platform Admin `/docker` currently controls CPU and RAM limits through the private Docker agent.

Persistent storage quotas are a separate filesystem concern. The current root filesystem is ext4 without project quota enabled, so hard per-directory service storage quotas must not be claimed as active until a dedicated quota-capable filesystem or another reviewed quota design is deployed.

## 22. Scaling and load balancing

Scale n8n execution first through worker concurrency/additional workers. Redis distributes execution jobs; no HTTP load balancer is needed for worker distribution.

Introduce HTTP load balancing only after multiple HTTP-facing instances exist. Introduce an external/cloud load balancer and multi-node database architecture only when moving to multiple VPS nodes/high availability.

The current single VPS remains a single point of failure.

## 23. Security invariants

```text
No root SSH login.
No password SSH login.
Platform Admin 3000 stays loopback-only.
n8n main 5678 stays loopback-only.
n8n-worker publishes no host port.
Media 8082 stays loopback-only.
Redis 6379 stays Docker-private.
MySQL 3306 stays Docker-private.
MongoDB 27017 stays Docker-private.
PostgreSQL public clients use TLS/SCRAM and sslmode=verify-full.
Redis public clients use TLS on 6380.
Database root/bootstrap credentials are never used by applications.
Platform Admin receives controller credentials only.
n8n workflows receive application-scoped database credentials only.
MongoDB replica keyfile remains persistent and private.
Platform Admin never mounts docker.sock.
Docker lifecycle control remains behind the private allowlisted agent.
Main and worker share the same persistent n8n encryption key.
Media admin API remains private and token-protected.
Secrets are never committed to Git.
DOCKER-USER blocks unapproved public Docker-published ports.
```

## 24. Runtime acceptance checklist

Do not mark MySQL/MongoDB integration complete on the VPS until all of these pass:

```text
platform-mysql healthy
platform-mysql-init exited 0
platform-mongodb healthy
platform-mongodb-init exited 0
Platform Admin rebuild healthy
/mysql loads
/mongodb loads
n8n healthy
n8n-worker healthy
n8n -> mysql:3306 TCP succeeds
n8n -> mongodb:27017 TCP succeeds
platform-mysql appears in /docker
platform-mongodb appears in /docker
3306 is not publicly published
27017 is not publicly published
```
