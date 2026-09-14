# MongoDB Production Implementation Plan

Status: **planned, not yet deployed**.

This document defines how MongoDB should be added to the existing VSM production architecture without weakening the current PostgreSQL, Redis, n8n, Media Storage, Platform Admin, Docker-agent, firewall, and secret-management boundaries.

> Documentation uses `example.com` placeholders. Do not commit real passwords, keyfiles, certificates, bearer tokens, or generated application credentials.

## 1. Goals

The MongoDB implementation should provide:

```text
shared MongoDB service on the VPS
private same-VPS Docker connectivity
MongoDB authentication enabled from first production start
single-node replica set for transactions/change streams and future scaling
per-application database users
Platform Admin /mongodb management page
encrypted credential reveal through the existing Platform Admin vault
n8n main + worker private MongoDB access
Docker Services monitoring/lifecycle/resource controls
backup/restore procedures
optional public TLS access as a separate hardened phase
```

MongoDB must remain an independent infrastructure stack. It must not be bundled into n8n, Media Storage, or Platform Admin containers.

## 2. Architecture decision

Initial production topology:

```text
Platform Admin
     |
     | mongo_net
     v
platform-mongodb <----- n8n main
     ^                  n8n-worker
     |
     +-- persistent /data/db

MongoDB logical roles:
  bootstrap root        -> emergency/bootstrap only
  platform_controller   -> management operations only
  app database users    -> readWrite only on their own database
```

Planned container and network names:

```text
Container: platform-mongodb
Network:   mongo_net
Alias:     mongodb
Port:      27017 inside Docker
Replica:   rs0
```

### Private-first policy

The first deployment will **not publish MongoDB 27017 to the public internet**.

Same-VPS applications will connect through:

```text
mongodb:27017
```

This avoids adding a new public attack surface while the internal service, authentication, backups, monitoring, and Platform Admin integration are being validated.

Public MongoDB access, if required later, is a separate phase and must not be enabled until TLS, hostname/replica-set behavior, provider firewall rules, DOCKER-USER rules, certificate renewal, and external verification are complete.

## 3. MongoDB version policy

Use the official MongoDB Community Docker image and pin a supported stable version. Do not use `latest` in production.

Implementation rule:

```text
mongo:<explicit-supported-version>
```

At implementation time, verify the current supported MongoDB Community release and pin the exact intended major/minor or patch policy before deployment.

## 4. Runtime layout

Planned VPS layout:

```text
/srv/infrastructure/databases/mongodb/
├── compose.yml
├── .env
├── config/
│   └── mongod.conf
├── scripts/
│   ├── entrypoint.sh
│   └── init-replica.sh
├── secrets/
│   ├── root_password
│   ├── controller_password
│   └── replica_keyfile
├── data/
└── backups/
```

Tracked repository layout:

```text
srv/infrastructure/databases/mongodb/
├── compose.yml
├── .env.example
├── .gitignore
├── config/mongod.conf
├── scripts/entrypoint.sh
├── scripts/init-replica.sh
└── README.md
```

The following must remain outside Git:

```text
.env
secrets/
data/
backups/
```

## 5. MongoDB server configuration

Target production settings:

```yaml
net:
  port: 27017
  bindIpAll: true

security:
  authorization: enabled
  keyFile: /run/secrets/replica_keyfile

replication:
  replSetName: rs0

storage:
  dbPath: /data/db
  wiredTiger:
    engineConfig:
      cacheSizeGB: 1
```

`bindIpAll` is acceptable only because the first deployment has no public port publication and access is constrained by Docker networking.

The initial WiredTiger cache target is intentionally conservative because this VPS also runs PostgreSQL, Redis, n8n main/worker, Media Storage and Platform Admin. Re-tune it only after observing real memory pressure and workload.

## 6. Single-node replica set from day one

MongoDB should start as a single-node replica set:

```text
rs0
```

Reason:

```text
supports multi-document transactions
supports change streams
keeps future replica-set expansion possible
avoids migrating from standalone mode later
```

The replica-set member should initially advertise the Docker-resolvable hostname:

```text
mongodb:27017
```

All same-VPS clients attached to `mongo_net` can resolve this hostname.

A persistent replica-set keyfile must be generated once and kept in:

```text
/srv/infrastructure/databases/mongodb/secrets/replica_keyfile
```

Do not rotate it casually after the deployment is active.

## 7. Authentication and roles

### Bootstrap root

A strong bootstrap root credential is required for initial setup and emergency administration.

It must not be used by applications or n8n workflows.

Secret file:

```text
/srv/infrastructure/databases/mongodb/secrets/root_password
```

### Platform controller

Create a dedicated operational account:

```text
platform_controller
```

It should have only the administrative permissions required by Platform Admin to:

```text
list databases
inspect database statistics
create/delete managed databases
create/rotate/delete managed application users
inspect managed users
perform health/status checks
```

Do not use the bootstrap root account from the Platform Admin runtime.

Controller secret:

```text
/srv/infrastructure/databases/mongodb/secrets/controller_password
```

### Application users

Each managed application database gets its own user.

Default role:

```text
readWrite on exactly one application database
```

Application users must not receive:

```text
root
userAdminAnyDatabase
dbAdminAnyDatabase
clusterAdmin
readWriteAnyDatabase
```

System databases are reserved:

```text
admin
config
local
```

Platform Admin must reject attempts to create/delete these names as application databases.

## 8. Connection URL model

Private same-VPS URL:

```text
mongodb://USER:PASSWORD@mongodb:27017/DATABASE?authSource=DATABASE&replicaSet=rs0
```

The password must be URL encoded when constructing a connection string.

Platform Admin should store application MongoDB passwords only in its existing AES-256-GCM credential vault so authenticated users can explicitly Show/Hide/Copy a connection URL.

MongoDB itself stores password verifiers, not recoverable plaintext passwords.

## 9. Platform Admin `/mongodb` module

Add a new authenticated module:

```text
/mongodb
```

Planned files:

```text
srv/apps/platform-admin/src/app/mongodb/page.tsx
srv/apps/platform-admin/src/app/mongodb/MongoManager.tsx
srv/apps/platform-admin/src/app/mongodb/mongodb.module.css
srv/apps/platform-admin/src/app/api/mongodb/route.ts
srv/apps/platform-admin/src/lib/mongodb.ts
```

Add the official Node.js MongoDB driver to Platform Admin dependencies.

Planned UI capabilities:

```text
MongoDB online/offline status
server version
replica-set status
list managed databases
create database + dedicated user
create database using an existing managed user only when safe
rotate application-user password
enable explicit Show/Hide connection URL through credential vault
delete database only
delete database + its dedicated user
show database size and basic stats
copy private connection URL
```

Potential public URL support must remain hidden until the public-TLS phase is explicitly enabled.

### Platform Admin runtime settings

Planned environment values:

```text
MONGO_HOST=mongodb
MONGO_PORT=27017
MONGO_REPLICA_SET=rs0
MONGO_CONTROLLER_USER=platform_controller
MONGO_CONTROLLER_AUTH_DB=admin
MONGO_CONTROLLER_PASSWORD_FILE=/run/secrets/mongo_controller_password
```

Platform Admin should mount only the controller credential, not the root credential or replica keyfile.

## 10. Platform Admin credential vault integration

Reuse the existing credential vault rather than inventing a second secrets database.

Suggested vault service namespace:

```text
mongodb
```

Suggested vault identity:

```text
username = <mongo application username>
```

For safer disambiguation when the same username could exist in multiple auth databases, use a stable composite identity such as:

```text
<DATABASE>:<USERNAME>
```

Create/rotate flow:

```text
Platform Admin generates strong password
        -> creates/updates MongoDB user
        -> encrypts plaintext password into credential_vault
        -> returns connection URL once to authenticated UI
```

Delete flow:

```text
remove MongoDB user/database as requested
        -> delete matching credential-vault record
```

## 11. Docker network integration

Create external network:

```bash
docker network inspect mongo_net >/dev/null 2>&1 || docker network create mongo_net
```

Attach:

```text
platform-mongodb
platform-admin
n8n
n8n-worker
```

Do not attach unrelated containers unless they need MongoDB.

Expected network membership after deployment:

```text
platform-mongodb
platform-admin
n8n
n8n-worker
```

## 12. n8n integration

Both `n8n` and `n8n-worker` must join `mongo_net` because:

```text
main process may perform credential tests/editor operations
worker executes MongoDB workflow nodes
```

Use the private hostname:

```text
mongodb
```

Do not route same-VPS n8n MongoDB traffic through a future public MongoDB domain.

Application credentials used by n8n should be dedicated database users, never `platform_controller` or root.

## 13. Docker Services integration

Add:

```text
platform-mongodb
```

to `DOCKER_AGENT_ALLOWLIST`.

Then `/docker` can expose:

```text
state/health
CPU/RAM usage
logs
start/stop/restart
persistent resource limits
```

Do not apply aggressive resource limits on first launch. Observe actual behavior first.

## 14. Health checks

Container health must use an authenticated MongoDB ping.

Conceptual check:

```javascript
db.adminCommand({ ping: 1 })
```

Operational verification should include:

```text
container healthy
MongoDB ping succeeds
replica set reports PRIMARY
controller authentication succeeds
application user can read/write own database
application user cannot access another database
n8n main resolves mongodb
n8n worker resolves mongodb
```

Replica-set verification:

```javascript
rs.status()
db.hello()
```

## 15. Backup and restore

MongoDB must not be considered production-ready until backup/restore commands are documented and tested.

Logical backup target:

```bash
mongodump --archive --gzip
```

Restore target:

```bash
mongorestore --archive --gzip
```

Backup scope must include:

```text
all required application databases
MongoDB user/role configuration needed for recovery
replica keyfile
controller/root secret material required for disaster recovery
```

Store backups under:

```text
/srv/infrastructure/databases/mongodb/backups/
```

Automated off-host backup remains a separate future task, but at least one restore test must succeed before calling the MongoDB deployment complete.

## 16. Public MongoDB TLS phase (optional, not phase 1)

Public exposure is **disabled by default**.

If external MongoDB access is required later, implement it as a reviewed second phase.

Target public domain:

```text
mongo.example.com
```

Before publishing `27017/tcp`, all of the following must be complete:

```text
native MongoDB TLS or a reviewed TLS TCP front-end
CA-trusted certificate for mongo.example.com
TLS 1.2+ policy
certificate renewal deploy hook
strong authentication
replica-set hostname/discovery strategy for external clients
provider/network firewall rule for 27017
DOCKER-USER rule for 27017
external hostname/certificate verification
negative test proving unauthorized access fails
```

Public URL shape if enabled:

```text
mongodb://USER:PASSWORD@mongo.example.com:27017/DATABASE?authSource=DATABASE&tls=true&replicaSet=rs0
```

For a single-node replica set, external client discovery must be tested carefully. Do not publish the port until the advertised replica-set hostname is reachable in the intended client topology, or the supported direct-connection strategy has been explicitly verified.

## 17. Firewall changes

### Phase 1

No new public firewall port is required.

`27017` stays private on `mongo_net`.

### Optional public phase

Only after TLS/public verification:

```text
Provider firewall: allow 27017/tcp
DOCKER-USER:        allow original destination 27017/tcp
```

Then retain the final DROP rule for other unapproved Docker-published ports.

## 18. Logging and observability

Initial monitoring sources:

```text
MongoDB container logs
Docker CPU/RAM metrics
MongoDB serverStatus/dbStats through authenticated controller
replica-set state
VPS disk usage
```

Platform Admin `/mongodb` should show a concise status summary, but should not expose arbitrary shell execution.

Centralized monitoring/alerting remains a future infrastructure task.

## 19. Resource policy for the current VPS

The current host runs several persistent services, so MongoDB must start conservatively.

Initial policy:

```text
WiredTiger cacheSizeGB: 1 GiB
Docker hard CPU/RAM limit: leave unset until baseline measurements exist
Disk: persistent data under /srv/infrastructure/databases/mongodb/data
```

After real workload data is available, consider an explicit Docker RAM cap only if it remains comfortably above MongoDB's cache + connection/process overhead.

Never tune MongoDB by starving PostgreSQL, Redis, n8n workers, or the operating system page cache.

## 20. Security invariants

The implementation is not acceptable if any of these are violated:

```text
MongoDB authorization is enabled.
Root is bootstrap/emergency only.
Platform Admin uses a dedicated controller identity.
Applications use dedicated per-database users.
MongoDB 27017 is not public in phase 1.
Same-VPS applications use mongo_net.
Secrets are file-mounted and never committed to Git.
Replica keyfile is persistent and protected.
Platform Admin never exposes controller/root credentials to the browser.
Credential reveal uses the existing encrypted vault.
System databases cannot be deleted from the UI.
Docker agent can manage only the allowlisted platform-mongodb container.
Backups are tested before production sign-off.
```

## 21. Implementation phases

### Phase A — infrastructure scaffold

```text
create srv/infrastructure/databases/mongodb/
add pinned MongoDB compose
add mongod.conf
add secret-file startup handling
add persistent data/backups directories
add single-node replica-set initialization
add authenticated healthcheck
add mongo_net
```

### Phase B — bootstrap and validation

```text
generate root/controller/keyfile secrets
start platform-mongodb
initialize rs0
create platform_controller
verify PRIMARY
verify authentication
verify persistence across restart/recreate
```

### Phase C — Platform Admin

```text
add mongodb driver
add /mongodb UI
add /api/mongodb route
add database/user CRUD
add password rotation
add encrypted credential storage/reveal
add reserved-database protections
```

### Phase D — application networking

```text
attach Platform Admin to mongo_net
attach n8n main to mongo_net
attach n8n-worker to mongo_net
verify private connection from each required container
```

### Phase E — Docker control integration

```text
add platform-mongodb to Docker agent allowlist
verify logs/lifecycle/metrics/resource controls
```

### Phase F — backup/restore test

```text
create test database/data
mongodump
remove test data
mongorestore
verify restored data and permissions
```

### Phase G — documentation + production sign-off

```text
update README.md
update docs/PRODUCTION_SETUP.md
add MongoDB runtime README
record exact pinned MongoDB version
record verification output
mark MongoDB as deployed only after all acceptance criteria pass
```

### Phase H — optional public TLS

Only if there is an actual requirement for external MongoDB clients.

## 22. Acceptance criteria

MongoDB can be marked production-deployed only when all of the following are true:

```text
platform-mongodb is healthy
rs0 has one PRIMARY member
authorization is enabled
root secret is not used by applications
platform_controller works from Platform Admin only
application user is limited to its own DB
Platform Admin /mongodb can create/list/rotate/delete safely
credential reveal works through encrypted vault
n8n main connects privately
n8n-worker connects privately
MongoDB data survives container recreation
Docker /docker page includes platform-mongodb
backup + restore test succeeds
no secrets exist in Git
27017 remains private unless public-TLS phase was separately completed
```

## 23. Rollback plan

If the deployment fails before application adoption:

```text
stop platform-mongodb
remove MongoDB attachments from platform-admin/n8n compose files
remove platform-mongodb from Docker-agent allowlist
leave data + secrets intact for diagnosis
remove mongo_net only after all attached containers are detached
```

Do not delete `/srv/infrastructure/databases/mongodb/data` or secret files during rollback unless the MongoDB instance is intentionally being destroyed.

## 24. Planned repository changes

Implementation will touch approximately:

```text
srv/infrastructure/databases/mongodb/*
srv/apps/platform-admin/package.json
srv/apps/platform-admin/compose.yml
srv/apps/platform-admin/src/lib/mongodb.ts
srv/apps/platform-admin/src/app/api/mongodb/route.ts
srv/apps/platform-admin/src/app/mongodb/*
srv/apps/n8n/compose.yml
srv/infrastructure/management/docker-agent/compose.yml
README.md
docs/PRODUCTION_SETUP.md
```

The implementation should be done incrementally and verified on the VPS after each phase rather than introducing public access and application integration in one untested change.
