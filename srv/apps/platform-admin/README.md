# Platform Admin

Authenticated Next.js control panel for independently managed VPS services.

Current version: `0.7.0`

For the full VPS build, networking, TLS, firewall, deployment and troubleshooting history, see:

```text
docs/PRODUCTION_SETUP.md
```

## Authentication

Platform Admin uses one local administrator account, a scrypt password hash and an HMAC-signed 12-hour session cookie.

Local secrets live only on the VPS under:

```text
/srv/apps/platform-admin/secrets/
```

With HTTPS enabled:

```env
AUTH_COOKIE_SECURE=true
```

## Encrypted credential vault

Platform Admin can persist application credentials so connection URLs can be revealed later without storing plaintext passwords in the database.

The vault uses AES-256-GCM. Its master key is stored only on the VPS:

```text
/srv/apps/platform-admin/secrets/credential_vault_key
```

Encrypted credential rows are stored in the `platform_admin` PostgreSQL database through the unprivileged `platform_app` role.

## PostgreSQL manager

Available at `/postgres` after login.

Features:

```text
list databases and roles
create DB + new dedicated user
create DB using an existing user
rotate role passwords
delete database only
optionally delete database + role
reveal/hide stored remote connection URLs
copy connection URL
```

Managed application databases revoke public CONNECT/TEMPORARY privileges and use the selected owner role as the intended application identity.

Public connection format:

```text
postgresql://USER:PASSWORD@db.openmusk.store:5432/DATABASE?sslmode=verify-full
```

Public PostgreSQL uses PostgreSQL's own TLS endpoint with a CA-trusted certificate, SCRAM authentication, hardened `pg_hba.conf`, the provider firewall and the host `DOCKER-USER` policy.

## Redis manager

Available at `/redis`.

Features:

```text
health/status
list ACL users
create application ACL users
generate strong passwords
rotate passwords
delete application ACL users
reveal/hide private and public connection URLs
```

Private same-VPS Docker URL:

```text
redis://USER:PASSWORD@redis:6379/0
```

Public TLS URL:

```text
rediss://USER:PASSWORD@redis.openmusk.store:6380/0
```

Redis port `6379` is not exposed publicly.

## Docker Services manager

Available at `/docker`.

Platform Admin does not mount `/var/run/docker.sock`. A separate `platform-docker-agent` container owns the socket on private `management_net`, requires a bearer token, and only manages exact names in `DOCKER_AGENT_ALLOWLIST`.

Current Docker UI features:

```text
state and health
CPU usage %
RAM usage and %
uptime
restart count
PID count
network names and container IPs
internal/published ports
recent log viewer
start / stop / restart
CPU limit %
RAM limit %
persistent resource-limit policy
```

Metrics refresh automatically approximately every 10 seconds.

### Resource limits

CPU and RAM limits are percentages of the entire VPS.

For a 4-CPU host:

```text
10% CPU = 0.40 CPU
25% CPU = 1.00 CPU
50% CPU = 2.00 CPU
100% CPU = 4.00 CPU
```

CPU input range:

```text
1% - 100%
```

RAM input range:

```text
0.5% - 95%
```

Blank means unlimited.

The agent uses Docker cgroup resource controls and verifies the applied limits after the update. RAM limits below current cgroup usage are rejected.

Persistent policies are stored on the VPS at:

```text
/srv/infrastructure/management/docker-agent/data/resource-limits.json
```

The agent periodically reconciles these policies so they are restored after an allowlisted container is recreated.

## Required secret mounts

Platform Admin expects infrastructure secrets from:

```text
/srv/infrastructure/databases/postgres/secrets/platform_controller_password
/srv/infrastructure/databases/postgres/secrets/platform_app_password
/srv/infrastructure/cache/redis/secrets/platform_controller_password
```

App-local secrets:

```text
/srv/apps/platform-admin/secrets/admin_password_hash
/srv/apps/platform-admin/secrets/auth_session_secret
/srv/apps/platform-admin/secrets/credential_vault_key
/srv/apps/platform-admin/secrets/docker_agent_token
```

The Docker agent's root-only source token is:

```text
/srv/infrastructure/management/docker-agent/secrets/control_token
```

Platform Admin runs as UID/GID 1001, so it uses its own `0600` copy rather than directly mounting the root-only source file.

Create/update the copy with:

```bash
sudo install \
  -o 1001 -g 1001 -m 0600 \
  /srv/infrastructure/management/docker-agent/secrets/control_token \
  /srv/apps/platform-admin/secrets/docker_agent_token
```

## Required Docker networks

```bash
docker network inspect proxy_net >/dev/null 2>&1 || docker network create proxy_net
docker network inspect postgres_net >/dev/null 2>&1 || docker network create postgres_net
docker network inspect redis_net >/dev/null 2>&1 || docker network create redis_net
docker network inspect management_net >/dev/null 2>&1 || docker network create management_net
```

## Update on VPS

```bash
cd /tmp/vps_server_management_VSM
git pull
cp -a srv/apps/platform-admin/. /srv/apps/platform-admin/
cd /srv/apps/platform-admin
docker compose up -d --build
docker compose ps
docker logs platform-admin --tail 100
```

## Security invariants

```text
Port 3000 remains bound to 127.0.0.1 only.
Management APIs require admin authentication.
Credential secrets are encrypted at rest.
PostgreSQL and Redis controller credentials are never exposed to the browser.
Passwords are decrypted only for an authenticated explicit reveal request.
The web application never mounts the Docker socket.
Docker lifecycle/resource control is isolated behind a private token-authenticated allowlisted agent.
Redis plaintext 6379 remains private.
```
