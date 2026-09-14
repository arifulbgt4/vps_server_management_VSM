# Production VPS Setup and Operations Guide

This document records the production setup currently used for the VSM server: hardened SSH access, Docker networking, Nginx/HTTPS, PostgreSQL public TLS access, Redis private/public TLS access, Platform Admin, the private Docker control agent, firewall rules, certificate renewal, resource limits, verification commands, and the issues encountered while building the system.

> Never commit real passwords, private keys, bearer tokens, or generated application credentials. All examples below use placeholders.
>
> Domain examples use the reserved documentation domain `example.com`. Replace `example.com` with your actual domain in production.

## 1. Current deployment

The production host is a Contabo VPS running Ubuntu 24.04 LTS with Docker Engine and Docker Compose. The application architecture is intentionally split into independent infrastructure and application stacks under `/srv`.

Example production domains:

```text
admin.example.com   -> Platform Admin over HTTPS
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

Redis plaintext `6379` is private and must not be exposed publicly.

## 2. Runtime layout

The VPS uses this layout:

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
│   └── future-apps/
├── mail/
└── backups/
```

The repository tracks the Platform Admin app, Redis infrastructure, Docker control agent, PostgreSQL/Redis public-network helpers, firewall policy, and certificate deploy hooks.

## 3. Base server hardening

Create a non-root administrator account and use SSH keys only. The deployed account is `ariful`.

Recommended base packages:

```bash
sudo apt update
sudo apt install -y \
  curl wget git nano unzip ca-certificates gnupg \
  ufw fail2ban nginx certbot python3-certbot-nginx
```

SSH policy:

```text
PermitRootLogin no
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
```

Verify effective SSH settings:

```bash
sudo sshd -T | grep -E \
  'permitrootlogin|pubkeyauthentication|passwordauthentication|kbdinteractiveauthentication'
```

Expected:

```text
permitrootlogin no
pubkeyauthentication yes
passwordauthentication no
kbdinteractiveauthentication no
```

Enable Fail2ban:

```bash
sudo systemctl enable --now fail2ban
```

Set timezone:

```bash
sudo timedatectl set-timezone Asia/Dhaka
```

## 4. UFW and Contabo firewall

Host UFW policy:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Docker-published ports can bypass normal UFW INPUT handling, so the production setup also uses a `DOCKER-USER` policy. Do not rely on UFW alone for published Docker ports.

At the Contabo network firewall, keep explicit ACCEPT rules before the final DROP rule for:

```text
22/tcp
80/tcp
443/tcp
5432/tcp
6380/tcp
```

Do not add `6379/tcp`.

## 5. Docker installation and networks

Docker Engine and Compose are installed system-wide. Verify:

```bash
docker --version
docker compose version
```

Required external networks:

```bash
docker network inspect proxy_net >/dev/null 2>&1 || docker network create proxy_net
docker network inspect postgres_net >/dev/null 2>&1 || docker network create postgres_net
docker network inspect redis_net >/dev/null 2>&1 || docker network create redis_net
docker network inspect management_net >/dev/null 2>&1 || docker network create management_net
```

The production PostgreSQL network currently uses a Docker subnet in the `172.19.0.0/16` range. If Docker assigns a different subnet on a rebuilt server, update `pg_hba.conf` accordingly.

## 6. Nginx and Platform Admin HTTPS

Platform Admin runs in Docker but only publishes to localhost:

```text
127.0.0.1:3000 -> platform-admin:3000
```

Host Nginx terminates HTTPS for `admin.example.com` and proxies to `127.0.0.1:3000`.

Typical Nginx proxy block:

```nginx
server {
    server_name admin.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Issue a certificate with Certbot:

```bash
sudo certbot --nginx -d admin.example.com
```

After HTTPS is active, Platform Admin must use:

```env
AUTH_COOKIE_SECURE=true
```

## 7. Platform Admin

Runtime path:

```text
/srv/apps/platform-admin
```

Current application version:

```text
0.7.0
```

Modules currently available:

```text
/postgres   PostgreSQL database and role management
/redis      Redis ACL user and connection management
/docker     Docker service monitoring and lifecycle/resource controls
```

Authentication uses a local admin account, scrypt password hash, HMAC-signed session cookie, and a 12-hour session lifetime.

Secrets directory:

```text
/srv/apps/platform-admin/secrets/
```

Required app-side secret files:

```text
admin_password_hash
auth_session_secret
credential_vault_key
docker_agent_token
```

The credential vault uses AES-256-GCM. The master key exists only on the VPS. Application/database passwords stored for later URL reveal are encrypted in the `platform_admin` database.

The web app does not mount `/var/run/docker.sock`.

## 8. PostgreSQL production design

Container:

```text
platform-postgres
```

Image:

```text
postgres:17-alpine
```

Primary runtime path:

```text
/srv/infrastructure/databases/postgres/
```

Important runtime subpaths:

```text
config/pg_hba.conf
config/tls/server.crt
config/tls/server.key
secrets/platform_controller_password
secrets/platform_app_password
data/
backups/
```

Roles:

```text
postgres             PostgreSQL superuser; emergency/local administration only
platform_controller  Platform Admin management role; CREATEDB + CREATEROLE, not superuser
platform_app         unprivileged owner of platform_admin database
```

Application roles created from Platform Admin are unprivileged and are not granted superuser, CREATEDB, CREATEROLE, or replication privileges.

### PostgreSQL TLS

Public PostgreSQL uses PostgreSQL's own TLS listener. It is not proxied through Nginx TCP stream because direct PostgreSQL access preserves the original client source IP for `pg_hba.conf`.

Relevant PostgreSQL settings:

```text
ssl = on
ssl_cert_file = /etc/postgresql/tls/server.crt
ssl_key_file = /etc/postgresql/tls/server.key
ssl_min_protocol_version = TLSv1.2
```

Public connection format:

```text
postgresql://USER:PASSWORD@db.example.com:5432/DATABASE?sslmode=verify-full
```

Use `verify-full`, not only `require`, for production clients that support it.

### PostgreSQL `pg_hba.conf`

The tracked hardened template is:

```text
srv/infrastructure/networking/postgres-public/pg_hba.conf
```

The policy allows local/Same-VPS Docker SCRAM access, rejects remote access to management/system databases and management roles, permits remote application roles only over TLS + SCRAM, and rejects public non-TLS sessions.

Verify loaded rules:

```bash
docker exec platform-postgres \
  psql -U postgres -d postgres \
  -c "SELECT line_number,type,database,user_name,address,auth_method,error FROM pg_hba_file_rules ORDER BY line_number;"
```

Verify active HBA path:

```bash
docker exec platform-postgres \
  psql -U postgres -d postgres \
  -c "SHOW hba_file;"
```

### PostgreSQL Let's Encrypt certificate

Example certificate domain:

```text
db.example.com
```

Tracked deploy script:

```text
srv/infrastructure/networking/postgres-public/deploy-postgres-cert.sh
```

Installed on the VPS as:

```text
/usr/local/sbin/deploy-postgres-cert.sh
```

Certbot deploy hook:

```text
/etc/letsencrypt/renewal-hooks/deploy/postgres
  -> /usr/local/sbin/deploy-postgres-cert.sh
```

The hook copies the renewed Let's Encrypt certificate/private key to the PostgreSQL TLS directory with correct ownership and reloads PostgreSQL.

Verify renewal:

```bash
sudo certbot renew --dry-run
```

Optional deploy-hook simulation:

```bash
sudo certbot renew --dry-run --run-deploy-hooks
```

### PostgreSQL external verification

From another machine:

```bash
docker run --rm -it \
  -e PGPASSWORD \
  postgres:17-alpine \
  psql "host=db.example.com port=5432 dbname=YOUR_DB user=YOUR_USER sslmode=verify-full sslrootcert=system"
```

Inside `psql`:

```sql
\conninfo
SELECT current_database(), current_user;
SELECT ssl, version, cipher
FROM pg_stat_ssl
WHERE pid = pg_backend_pid();
```

Production verification succeeded with TLS 1.3 and hostname validation.

## 9. Redis production design

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

Redis listeners:

```text
6379  private plaintext listener for same-VPS Docker applications
6380  public TLS listener
```

Only port `6380` is published to the host:

```text
0.0.0.0:6380 -> 6380/tcp
```

`6379` remains internal to `redis_net`.

The Redis `default` user is disabled. `platform_controller` is the internal administrative ACL user. Application ACL users are generated by Platform Admin with strong random passwords and broad application commands while admin/dangerous command categories are denied.

Private application URL:

```text
redis://USER:PASSWORD@redis:6379/0
```

Public TLS URL:

```text
rediss://USER:PASSWORD@redis.example.com:6380/0
```

### Redis TLS

Tracked config enables TLS 1.2 and 1.3:

```text
srv/infrastructure/cache/redis/config/redis.conf
```

Certificate deploy script:

```text
srv/infrastructure/networking/redis-public/deploy-redis-cert.sh
```

Installed as:

```text
/usr/local/sbin/deploy-redis-cert.sh
```

Renewal hook:

```text
/etc/letsencrypt/renewal-hooks/deploy/redis
  -> /usr/local/sbin/deploy-redis-cert.sh
```

The deploy script copies the Let's Encrypt certificate for `redis.example.com` into the Redis TLS directory and restarts Redis after certificate renewal.

### Redis verification

Certificate hostname check:

```bash
openssl s_client \
  -connect redis.example.com:6380 \
  -servername redis.example.com \
  -verify_hostname redis.example.com \
  -verify_return_error \
  </dev/null
```

Expected:

```text
Verify return code: 0 (ok)
```

Authenticated TLS test:

```bash
read -s REDISCLI_AUTH
export REDISCLI_AUTH
echo

docker run --rm -it \
  -e REDISCLI_AUTH \
  redis:7.4-alpine \
  redis-cli \
    --tls \
    --cacert /etc/ssl/certs/ca-certificates.crt \
    -h redis.example.com \
    -p 6380 \
    --user YOUR_REDIS_USER \
    PING

unset REDISCLI_AUTH
```

Expected:

```text
PONG
```

Plaintext public Redis must fail:

```bash
nc -vz -w 3 redis.example.com 6379
```

Expected: timeout/refused.

## 10. Docker-aware firewall policy

Tracked script:

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

The policy is applied in `DOCKER-USER` and currently allows external Docker-forwarded traffic only for:

```text
5432/tcp PostgreSQL
6380/tcp Redis TLS
```

Established/related traffic is allowed, and other new traffic entering from the public interface is dropped.

Verify:

```bash
sudo iptables -nvL DOCKER-USER --line-numbers
```

Expected logical order:

```text
ACCEPT RELATED,ESTABLISHED
ACCEPT original destination port 5432
ACCEPT original destination port 6380
DROP   other NEW traffic arriving from the external interface
```

This policy intentionally means any future Docker-published public port must be explicitly added to the firewall policy.

## 11. Docker control agent

Runtime path:

```text
/srv/infrastructure/management/docker-agent
```

Container:

```text
platform-docker-agent
```

The agent:

- is private on `management_net`;
- publishes no host port;
- owns the Docker Unix socket;
- requires a bearer token;
- enforces an exact allowlist;
- supports only approved management operations;
- runs with `cap_drop: ALL` and `no-new-privileges`;
- stores persistent CPU/RAM policies under `/data/resource-limits.json`.

Default allowlist:

```text
platform-admin
platform-postgres
platform-redis
```

Agent secret:

```text
/srv/infrastructure/management/docker-agent/secrets/control_token
```

Because capabilities are dropped, the agent token must be readable by the agent's effective UID. The deployed solution uses:

```bash
sudo chown root:root \
  /srv/infrastructure/management/docker-agent/secrets/control_token
sudo chmod 600 \
  /srv/infrastructure/management/docker-agent/secrets/control_token
```

Platform Admin does not consume that root-only file directly. It uses a dedicated copy owned by UID/GID 1001:

```bash
sudo install \
  -o 1001 -g 1001 -m 0600 \
  /srv/infrastructure/management/docker-agent/secrets/control_token \
  /srv/apps/platform-admin/secrets/docker_agent_token
```

## 12. Docker Services module

The `/docker` page provides:

```text
container state / health
CPU usage %
RAM usage and %
uptime
restart count
PID count
network names and container IPs
internal and published ports
recent logs
start / stop / restart
CPU limit configuration
RAM limit configuration
persistent resource-limit policy
```

Metrics refresh automatically approximately every 10 seconds.

### CPU limit semantics

CPU limit is entered as a percentage of the entire VPS capacity.

For a 4-CPU VPS:

```text
100% = 4.0 CPU
50%  = 2.0 CPU
25%  = 1.0 CPU
10%  = 0.4 CPU
1%   = 0.04 CPU
```

The agent applies CFS quota/period values and verifies the result using Docker inspect data.

Example verified 10% limit on a 4-CPU host:

```text
CpuPeriod=100000
CpuQuota=40000
```

### RAM limit semantics

RAM percentage is also based on total VPS memory. A configured limit is a maximum, not a target usage.

The agent rejects a RAM limit that is below the container's current cgroup usage. This avoids attempting an unsafe live reduction.

Verified example for `platform-redis`:

```text
CPU limit: 10%
RAM limit: 2%
Memory: approximately 159 MiB on the current VPS
```

The persisted policy is stored at:

```text
/srv/infrastructure/management/docker-agent/data/resource-limits.json
```

Example:

```json
{
  "platform-redis": {
    "cpu_percent": 10,
    "memory_percent": 2
  }
}
```

The agent reconciles stored policies periodically so limits are re-applied after an allowlisted container is recreated.

## 13. Updating the Docker agent

```bash
cd /tmp/vps_server_management_VSM
git pull

cp \
  srv/infrastructure/management/docker-agent/agent.mjs \
  /srv/infrastructure/management/docker-agent/agent.mjs

cp \
  srv/infrastructure/management/docker-agent/compose.yml \
  /srv/infrastructure/management/docker-agent/compose.yml

cd /srv/infrastructure/management/docker-agent
docker compose up -d --force-recreate
docker compose ps
docker logs platform-docker-agent --tail 50
```

Health test:

```bash
docker exec platform-docker-agent \
  node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.text()).then(console.log)"
```

Expected:

```json
{"status":"ok"}
```

## 14. Updating Platform Admin

```bash
cd /tmp/vps_server_management_VSM
git pull

cp -a \
  srv/apps/platform-admin/. \
  /srv/apps/platform-admin/

cd /srv/apps/platform-admin
docker compose up -d --build
docker compose ps
docker logs platform-admin --tail 100
```

Platform Admin health endpoint:

```text
GET /api/health
```

The container should report healthy before considering deployment complete.

## 15. Verification checklist

Platform Admin:

```bash
docker compose -f /srv/apps/platform-admin/compose.yml ps
```

Docker agent:

```bash
docker compose -f /srv/infrastructure/management/docker-agent/compose.yml ps
```

Redis:

```bash
docker compose -f /srv/infrastructure/cache/redis/compose.yml ps
docker port platform-redis
```

Expected Redis published port:

```text
6380/tcp -> 0.0.0.0:6380
```

Firewall:

```bash
sudo iptables -nvL DOCKER-USER --line-numbers
```

Certificates:

```bash
sudo certbot renew --dry-run
```

Public PostgreSQL:

```bash
nc -vz db.example.com 5432
```

Public Redis TLS:

```bash
nc -vz redis.example.com 6380
```

Public Redis plaintext must remain blocked:

```bash
nc -vz -w 3 redis.example.com 6379
```

## 16. Problems encountered and fixes

### Docker daemon unavailable on local Mac

Symptom:

```text
Cannot connect to the Docker daemon ... Is the docker daemon running?
```

This was a local Docker Desktop issue, not PostgreSQL/Redis. Start Docker Desktop and verify with `docker info`.

### Docker agent secret `EACCES`

Symptom:

```text
EACCES: permission denied, open '/run/secrets/control_token'
```

Cause: the token was owned by `ariful:ariful` with `0600`, while the container had `cap_drop: ALL`. UID 0 without `CAP_DAC_OVERRIDE` could not bypass file permissions.

Fix: make the agent token `root:root 0600`. Keep a separate UID 1001 copy for Platform Admin.

### CPU/RAM Apply Limits initially did not work

The first implementation used a Docker update payload that was not sufficiently verified. The final implementation uses CFS `CpuPeriod/CpuQuota` for CPU, applies memory/swap-safe updates, then inspects the container and rejects the operation if Docker does not report the requested limits.

A successful agent log looks like:

```text
Resource limits updated for platform-redis: CPU=10% RAM=2%
```

### Redis TLS `unexpected eof while reading`

A log such as:

```text
SSL routines::unexpected eof while reading
```

can occur when a client or scanner connects to the TLS port and disconnects before completing the protocol exchange. It is not, by itself, evidence that the Redis TLS endpoint is broken. Confirm with a proper `redis-cli --tls` PING and certificate verification.

### `sslmode=require` versus `verify-full`

`sslmode=require` confirms encryption but does not provide the same hostname verification guarantee as `verify-full`. Production PostgreSQL URLs use `sslmode=verify-full`.

## 17. Security invariants

Keep these rules unchanged unless there is a reviewed architectural reason:

```text
No root SSH login.
No password SSH login.
Platform Admin port 3000 remains localhost-only.
Platform Admin never mounts docker.sock.
Docker agent publishes no public port.
Docker agent manages only exact allowlisted containers.
Redis 6379 stays private.
Redis public clients use rediss:// on 6380.
PostgreSQL public clients use TLS/SCRAM and sslmode=verify-full.
Management PostgreSQL roles/databases are not remotely exposed.
Secrets are never committed to Git.
Certificate renewal hooks copy renewed certificates into service-readable locations.
DOCKER-USER blocks unapproved public Docker-published ports.
```

## 18. Not yet implemented

The following are outside the completed setup documented here and should not be assumed to exist:

```text
MySQL production service
centralized monitoring/alerting stack
automated PostgreSQL/Redis backup policy
n8n production deployment on the shared PostgreSQL/Redis infrastructure
mail server / outbound mail stack
```

Add them as separate infrastructure modules rather than coupling them to the existing stacks.
