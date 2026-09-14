# Production VPS Setup and Operations Guide

This document records the current production architecture and operating procedures for the VSM host. It covers server hardening, Docker networking, Nginx/HTTPS, PostgreSQL, Redis, n8n queue mode, Media Storage, Platform Admin, the Docker control agent, firewall policy, secrets, verification, scaling and known warnings.

> Never commit real passwords, private keys, bearer tokens, API keys, encryption keys, or generated application credentials.
>
> Documentation uses the reserved `example.com` domain. Replace it only in VPS runtime configuration with the real production domains.

## 1. Current production deployment

The production host is a single Ubuntu 24.04 LTS VPS running Docker Engine, Docker Compose, host Nginx and Certbot.

Current production services:

```text
Platform Admin         authenticated Next.js management UI
PostgreSQL             shared PostgreSQL 17 service with public TLS
Redis                  shared Redis 7.4 service with private 6379 + public TLS 6380
n8n main               editor/API/webhook process
n8n worker             queue worker for workflow execution
Media Storage          multi-user file/media service
Docker control agent   private allowlisted Docker lifecycle/metrics controller
Nginx + Certbot        reverse proxy, HTTPS and certificate lifecycle
DOCKER-USER firewall   Docker-aware published-port policy
```

Example public domains:

```text
admin.example.com   -> Platform Admin HTTPS
n8n.example.com     -> n8n HTTPS
media.example.com   -> Media Storage HTTPS
db.example.com      -> PostgreSQL TLS on 5432
redis.example.com   -> Redis TLS on 6380
```

Public ports intentionally exposed:

```text
22/tcp    SSH
80/tcp    HTTP / ACME
443/tcp   HTTPS
5432/tcp  PostgreSQL TLS
6380/tcp  Redis TLS
```

The following application ports remain private or loopback-only:

```text
3000   Platform Admin, 127.0.0.1 only
5678   n8n main, 127.0.0.1 only
5678   n8n worker health endpoint, Docker-internal only
6379   Redis plaintext, Docker-internal only
8080   Media Service container port, Docker-internal
8082   Media Service host binding, 127.0.0.1 only
```

## 2. Architecture

```text
                           Internet
                              |
                         Host Nginx
                 +------------+-------------+
                 |            |             |
          Platform Admin    n8n main    Media Service
          127.0.0.1:3000  127.0.0.1:5678 127.0.0.1:8082
                              |
                              v
                         Redis queue
                              |
                              v
                         n8n-worker

Shared internal services:
  PostgreSQL -> postgres_net
  Redis      -> redis_net
  Media      -> media_net
  Docker ctl -> management_net
```

The current deployment is a single-VPS architecture. Nginx is the HTTP reverse proxy and TLS terminator. A separate HTTP load balancer is not required while there is only one HTTP-facing instance of each service.

n8n scales workflow execution through Redis queue workers. Redis queue distribution is separate from HTTP load balancing.

## 3. Runtime filesystem layout

```text
/srv/
├── infrastructure/
│   ├── databases/
│   │   └── postgres/
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

Persistent application data must live outside disposable container layers.

## 4. Base server hardening

Use a non-root administrator account and SSH keys only.

Recommended packages:

```bash
sudo apt update
sudo apt install -y \
  curl wget git nano unzip ca-certificates gnupg \
  ufw fail2ban nginx certbot python3-certbot-nginx
```

Required SSH policy:

```text
PermitRootLogin no
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
```

Verify:

```bash
sudo sshd -T | grep -E \
  'permitrootlogin|pubkeyauthentication|passwordauthentication|kbdinteractiveauthentication'
```

Enable Fail2ban:

```bash
sudo systemctl enable --now fail2ban
```

Set timezone:

```bash
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

Docker-published ports can bypass normal UFW INPUT handling. The deployment therefore also uses an explicit `DOCKER-USER` policy.

Provider/network firewall rules should allow only the required public ports before the final DROP rule:

```text
22
80
443
5432
6380
```

Do not expose Redis `6379`, Platform Admin `3000`, n8n `5678`, or Media `8082` publicly.

Tracked Docker firewall script:

```text
srv/infrastructure/networking/postgres-public/docker-firewall.sh
```

Installed as:

```text
/usr/local/sbin/vsm-docker-firewall.sh
```

Systemd unit:

```text
srv/infrastructure/networking/postgres-public/vsm-docker-firewall.service
```

Expected `DOCKER-USER` logic:

```text
ACCEPT RELATED,ESTABLISHED
ACCEPT original destination 5432
ACCEPT original destination 6380
DROP   other NEW traffic arriving from the external interface
```

Verify:

```bash
sudo iptables -nvL DOCKER-USER --line-numbers
```

## 6. Docker networks

Required external networks:

```bash
docker network inspect proxy_net >/dev/null 2>&1 || docker network create proxy_net
docker network inspect postgres_net >/dev/null 2>&1 || docker network create postgres_net
docker network inspect redis_net >/dev/null 2>&1 || docker network create redis_net
docker network inspect management_net >/dev/null 2>&1 || docker network create management_net
docker network inspect media_net >/dev/null 2>&1 || docker network create media_net
```

Network responsibilities:

```text
proxy_net       selected application/proxy connectivity
postgres_net    same-VPS PostgreSQL connectivity; alias postgres
redis_net       same-VPS Redis connectivity; alias redis
management_net  Platform Admin <-> Docker control agent
media_net       Platform Admin/n8n <-> Media Service; alias media-service
```

Do not use the public PostgreSQL or Redis domains for same-VPS application traffic when the private Docker network is available.

## 7. Nginx and HTTPS

Host Nginx terminates HTTPS and proxies HTTP-facing applications to loopback bindings.

Example routing:

```text
admin.example.com -> http://127.0.0.1:3000
n8n.example.com   -> http://127.0.0.1:5678
media.example.com -> http://127.0.0.1:8082
```

Issue/renew certificates with Certbot. Example:

```bash
sudo certbot --nginx -d admin.example.com
sudo certbot --nginx -d n8n.example.com
sudo certbot --nginx -d media.example.com
sudo certbot renew --dry-run
```

The Media Nginx configuration streams uploads instead of buffering large files and blocks the private admin API from the public internet.

A separate load balancer is intentionally not deployed. Add one only when multiple HTTP-facing instances or multiple VPS nodes exist.

## 8. Platform Admin

Runtime path:

```text
/srv/apps/platform-admin
```

Current version:

```text
0.9.0
```

Modules:

```text
/postgres   PostgreSQL database/role/credential management
/redis      Redis ACL user/credential management
/docker     Docker metrics, logs, lifecycle and resource limits
/media      Media users, quotas, keys and files
```

Authentication uses a local administrator account, scrypt password hash and HMAC-signed session cookie.

App-local secrets:

```text
admin_password_hash
auth_session_secret
credential_vault_key
docker_agent_token
media_admin_token
```

The credential vault uses AES-256-GCM and stores encrypted credentials in the `platform_admin` PostgreSQL database through the unprivileged `platform_app` role.

Media user API keys are handled in two layers:

```text
Media Service   -> stores only the API-key hash
Platform Admin  -> stores an encrypted copy in the credential vault for authenticated Show/Hide
```

A key created before encrypted-vault support cannot be recovered from the Media Service hash; rotate it once to place the new key in the vault.

The `/media` page also contains copyable Next.js App Router examples showing server-side use of the Media API without exposing the bearer key to browser code.

Platform Admin never mounts `/var/run/docker.sock`.

## 9. PostgreSQL

Container:

```text
platform-postgres
```

Image:

```text
postgres:17-alpine
```

Runtime path:

```text
/srv/infrastructure/databases/postgres/
```

Management roles:

```text
postgres             emergency/local superuser
platform_controller  CREATEDB + CREATEROLE, not superuser
platform_app         unprivileged owner of platform_admin
```

Application roles created from Platform Admin are unprivileged.

Same-VPS applications connect privately:

```text
host=postgres
port=5432
```

Public applications use TLS:

```text
postgresql://USER:PASSWORD@db.example.com:5432/DATABASE?sslmode=verify-full
```

Relevant TLS policy:

```text
ssl = on
ssl_min_protocol_version = TLSv1.2
```

The hardened `pg_hba.conf` permits private Docker SCRAM access, rejects remote management/system identities, permits remote application roles only through TLS + SCRAM, and rejects public non-TLS sessions.

Tracked HBA template:

```text
srv/infrastructure/networking/postgres-public/pg_hba.conf
```

Verify active rules:

```bash
docker exec platform-postgres \
  psql -U postgres -d postgres \
  -c "SELECT line_number,type,database,user_name,address,auth_method,error FROM pg_hba_file_rules ORDER BY line_number;"
```

Certificate deployment script:

```text
srv/infrastructure/networking/postgres-public/deploy-postgres-cert.sh
```

Public certificate hostname example:

```text
db.example.com
```

## 10. Redis

Container:

```text
platform-redis
```

Image:

```text
redis:7.4-alpine
```

Runtime path:

```text
/srv/infrastructure/cache/redis
```

Listeners:

```text
6379  private plaintext listener on redis_net
6380  public TLS listener
```

Only TLS port `6380` is host-published.

The `default` Redis user is disabled. `platform_controller` is reserved for internal administration. Applications use dedicated ACL users generated from Platform Admin.

Private application URL:

```text
redis://USER:PASSWORD@redis:6379/0
```

Public TLS URL:

```text
rediss://USER:PASSWORD@redis.example.com:6380/0
```

Redis persists data with AOF and configured RDB snapshots.

### n8n Redis identity

n8n queue traffic uses a dedicated ACL user:

```text
n8n_queue
```

It connects internally to:

```text
redis:6379
```

Queue database index:

```text
1
```

This keeps n8n queue keys logically separate from applications using DB `0`.

The n8n Redis password is stored in:

```text
/srv/apps/n8n/secrets/redis_password
```

and is not stored in `.env`.

## 11. n8n production queue mode

Runtime path:

```text
/srv/apps/n8n
```

Image:

```text
docker.n8n.io/n8nio/n8n:2.38.7
```

Containers:

```text
n8n          main editor/API/webhook process
n8n-worker   workflow execution worker
```

Queue mode is enabled permanently in the tracked production compose:

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

Initial worker concurrency:

```text
5
```

The main and worker share:

```text
same PostgreSQL database
same N8N_ENCRYPTION_KEY
same Redis queue identity
same media_net access
```

Only `n8n` publishes a host port:

```text
127.0.0.1:5678 -> 5678
```

`n8n-worker` has no published host port.

n8n secret files:

```text
/srv/apps/n8n/secrets/db_password
/srv/apps/n8n/secrets/encryption_key
/srv/apps/n8n/secrets/redis_password
```

Never regenerate `encryption_key` after credentials exist.

The custom entrypoint reads secret files and exports the database password, encryption key and Redis password only inside the container process.

Expected worker log:

```text
n8n worker is now ready
Version: 2.38.7
Concurrency: 5
```

Health:

```bash
curl -fsS http://127.0.0.1:5678/healthz/readiness

docker exec n8n-worker \
  node -e "fetch('http://127.0.0.1:5678/healthz/readiness').then(async r=>console.log(r.status,await r.text()))"
```

Verify Redis membership:

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

For durable application images, videos, PDFs and documents, use Media Storage rather than n8n execution storage.

## 12. Media Storage Service

Runtime path:

```text
/srv/apps/media-service
```

Container:

```text
platform-media
```

Host binding:

```text
127.0.0.1:8082 -> 8080
```

Public example domain:

```text
https://media.example.com
```

Private same-VPS endpoint:

```text
http://media-service:8080
```

The service supports images, video, audio, PDF, Office/OpenDocument files, text/CSV/Markdown and common archives subject to the configured allowlist.

Storage model:

```text
physical files -> /srv/apps/media-service/storage
metadata       -> dedicated PostgreSQL media database
ownership      -> per media user
quota          -> per media user
```

Per-user quotas are enforced transactionally. The default host reserve prevents uploads from consuming the final 5 GiB of the filesystem.

Default per-file maximum:

```text
512 MiB
```

Hard delete behavior:

```text
file delete -> physical file + PostgreSQL metadata + quota usage removed
user delete -> account + API key + all metadata + all owned files removed
```

Admin operations use the private `media_net` and separate `admin_token`.

Public Nginx must not expose `/api/v1/admin/*`.

User binary endpoint:

```text
GET /api/v1/files/:id/content
Authorization: Bearer ms_live_...
```

n8n should use the private endpoint where possible:

```text
http://media-service:8080/api/v1/files/<FILE_ID>/content
```

The Media Service stores API-key hashes only. Platform Admin optionally retains an encrypted copy in its credential vault for authenticated reveal/copy actions.

## 13. Docker control agent

Runtime path:

```text
/srv/infrastructure/management/docker-agent
```

Container:

```text
platform-docker-agent
```

The agent:

```text
publishes no host port
runs on management_net
owns docker.sock
requires a bearer token
uses an exact container allowlist
supports logs/lifecycle/resource controls
persists CPU/RAM policies
```

Current default allowlist:

```text
platform-admin
platform-postgres
platform-redis
n8n
n8n-worker
platform-media
```

Persistent resource policy:

```text
/srv/infrastructure/management/docker-agent/data/resource-limits.json
```

The root-only agent token lives at:

```text
/srv/infrastructure/management/docker-agent/secrets/control_token
```

Platform Admin uses a UID/GID 1001 private copy:

```bash
sudo install \
  -o 1001 -g 1001 -m 0600 \
  /srv/infrastructure/management/docker-agent/secrets/control_token \
  /srv/apps/platform-admin/secrets/docker_agent_token
```

## 14. Docker Services resource limits

Platform Admin `/docker` shows host and container metrics and supports start/stop/restart/logs plus persistent CPU/RAM limits.

CPU percentage is relative to total VPS CPU capacity. On a 4-vCPU host:

```text
10%  = 0.40 CPU
25%  = 1.00 CPU
50%  = 2.00 CPU
100% = 4.00 CPU
```

RAM percentage is also relative to total VPS memory. Limits are maxima, not target usage.

The agent rejects unsafe live RAM reductions below current cgroup usage and verifies limits after Docker applies them.

## 15. Updating deployed services

### Platform Admin

```bash
cd /tmp/vps_server_management_VSM
git pull
cp -a srv/apps/platform-admin/. /srv/apps/platform-admin/
cd /srv/apps/platform-admin
docker compose up -d --build
docker compose ps
```

### n8n main + worker

```bash
cd /tmp/vps_server_management_VSM
git pull
cp -a srv/apps/n8n/. /srv/apps/n8n/
cd /srv/apps/n8n
docker compose config
docker compose up -d --force-recreate
docker compose ps
```

Do not overwrite or regenerate runtime secret contents.

### Media Service

```bash
cd /tmp/vps_server_management_VSM
git pull
cp -a srv/apps/media-service/. /srv/apps/media-service/
cd /srv/apps/media-service
docker compose up -d --build
docker compose ps
```

### Docker agent

```bash
cd /tmp/vps_server_management_VSM
git pull
cp srv/infrastructure/management/docker-agent/agent.mjs \
  /srv/infrastructure/management/docker-agent/agent.mjs
cp srv/infrastructure/management/docker-agent/compose.yml \
  /srv/infrastructure/management/docker-agent/compose.yml
cd /srv/infrastructure/management/docker-agent
docker compose up -d --force-recreate
```

## 16. Verification checklist

```bash
# Core containers
docker ps

# Platform Admin
docker compose -f /srv/apps/platform-admin/compose.yml ps

# n8n queue mode
docker compose -f /srv/apps/n8n/compose.yml ps
docker logs n8n --tail 100
docker logs n8n-worker --tail 100

# Media
docker compose -f /srv/apps/media-service/compose.yml ps
curl -fsS http://127.0.0.1:8082/healthz
curl -fsS https://media.example.com/healthz

# Redis
docker compose -f /srv/infrastructure/cache/redis/compose.yml ps

# Internal networks
docker network inspect redis_net \
  --format '{{range $id,$c := .Containers}}{{println $c.Name}}{{end}}'
docker network inspect media_net \
  --format '{{range $id,$c := .Containers}}{{println $c.Name}}{{end}}'

# Firewall
sudo iptables -nvL DOCKER-USER --line-numbers

# TLS renewal
sudo certbot renew --dry-run
```

Expected media network membership includes:

```text
platform-media
platform-admin
n8n
n8n-worker
```

Expected queue runtime includes two healthy containers:

```text
n8n
n8n-worker
```

## 17. Backups and recovery

Automated centralized backup orchestration is not yet implemented. Until it is, treat these as critical persistent state:

```text
PostgreSQL databases
Redis /data
/srv/apps/n8n/data
/srv/apps/n8n/secrets/encryption_key
/srv/apps/media-service/storage
Platform Admin credential-vault key
all application secret files needed for recovery
```

A PostgreSQL dump alone is not enough to recover Media Storage because the physical files live on disk. Back up the media database and media storage tree together.

Do not restore an n8n database without the matching persistent `N8N_ENCRYPTION_KEY`.

## 18. Known warnings and troubleshooting

### n8n Python task runner warning

The official n8n image may log that Python 3 is missing for the internal Python task runner. This is non-fatal when Python Code tasks are not required. For production Python Code execution, use n8n's external task-runner architecture rather than installing Python into the main image ad hoc.

### n8n JavaScript localStorage warning

The JS runner may emit an experimental localStorage warning. The JavaScript task runner can still register and operate.

### PostgreSQL client deprecation warning in n8n

A `client.query()` deprecation warning can originate from n8n or an underlying dependency. Treat it as a dependency warning unless accompanied by failed database operations or unhealthy containers.

### Redis TLS unexpected EOF

TLS scanners or clients that disconnect early can create `unexpected eof while reading` log entries. Verify with a proper TLS PING before diagnosing a service failure.

### Docker agent token EACCES

The source control token must remain `root:root 0600`. Platform Admin consumes its own UID/GID 1001 copy.

### Media API key created before vault support

The Media Service stores only the hash, so old plaintext keys cannot be reconstructed. Rotate the key once; Platform Admin will then store the new plaintext value encrypted in the credential vault.

## 19. Scaling and load-balancing policy

Current architecture does not require a separate load balancer.

Scale n8n execution first by increasing worker capacity:

```text
1. observe queue wait time, CPU, RAM and PostgreSQL connections
2. increase worker concurrency carefully, or
3. add additional n8n worker containers
```

Redis distributes execution jobs between workers; an HTTP load balancer is not needed for worker distribution.

Introduce HTTP load balancing only when there are multiple HTTP-facing instances, for example multiple n8n main/webhook processors or multiple Media Service instances.

Introduce an external/cloud load balancer and multi-node architecture when running more than one VPS and high availability is required.

The current single VPS remains a single point of failure even if a load balancer were installed on the same machine.

## 20. Security invariants

```text
No root SSH login.
No password SSH login.
Platform Admin 3000 stays loopback-only.
n8n main 5678 stays loopback-only.
n8n-worker publishes no host port.
Media 8082 stays loopback-only.
Redis 6379 stays Docker-private.
Redis public clients use TLS on 6380.
PostgreSQL public clients use TLS/SCRAM and sslmode=verify-full.
Same-VPS apps prefer private Docker networks.
Platform Admin never mounts docker.sock.
Docker lifecycle control stays behind the private allowlisted agent.
n8n uses a dedicated Redis ACL user.
Main and worker share the same persistent n8n encryption key.
Media admin API remains private and token-protected.
Media user keys are hashed in Media Service; reveal copies are encrypted in Platform Admin.
Secrets are never committed to Git.
DOCKER-USER blocks unapproved public Docker-published ports.
```

## 21. Not yet implemented

Do not assume the following exist until explicitly deployed and verified:

```text
MySQL production service
centralized monitoring/alerting stack
automated centralized backup policy
mail server / outbound mail stack
multi-VPS high availability
external/cloud load balancer
PostgreSQL HA/failover
Redis HA/cluster
object-storage backend for Media Service
```

Add future capabilities as independent infrastructure modules rather than weakening the current service boundaries.