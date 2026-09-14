# MongoDB Production Implementation Plan

Status: **repository implementation complete; VPS deployment and runtime acceptance pending**.

The tracked implementation now includes the MongoDB infrastructure stack, single-node replica-set bootstrap, authentication/keyfile design, Platform Admin `/mongodb`, encrypted application-credential handling, n8n/private-network integration, Docker-agent allowlisting and deployment documentation.

## Implemented repository components

```text
srv/infrastructure/databases/mongodb/compose.yml
srv/infrastructure/databases/mongodb/.env.example
srv/infrastructure/databases/mongodb/.gitignore
srv/infrastructure/databases/mongodb/config/mongod.conf
srv/infrastructure/databases/mongodb/scripts/init-replica.sh
srv/infrastructure/databases/mongodb/README.md

srv/apps/platform-admin/src/lib/mongodb.ts
srv/apps/platform-admin/src/app/api/mongodb/route.ts
srv/apps/platform-admin/src/app/mongodb/page.tsx
srv/apps/platform-admin/src/app/mongodb/MongoDBManager.tsx
```

Platform Admin and n8n compose stacks are attached to `mongo_net`, and the Docker-agent allowlist includes `platform-mongodb`.

## Architecture

```text
Platform Admin ----\
                    \
                     mongo_net -> platform-mongodb -> /data/db
                    /
n8n + n8n-worker ---/

MongoDB:
  alias:       mongodb
  port:        27017 private only
  replica set: rs0
```

The initial integration intentionally publishes no host port for MongoDB.

## Identity model

```text
root                 bootstrap/emergency only
platform_controller  Platform Admin management only
application users    readWrite on their own database only
```

Platform Admin mounts only `controller_password`. It does not receive MongoDB root credentials or the replica-set keyfile.

Generated application passwords are encrypted in the existing Platform Admin AES-256-GCM credential vault.

## Replica-set bootstrap

The main container uses the official Mongo image with root initialization and starts the final server with:

```text
--replSet rs0
--auth
--keyFile /run/secrets/replica_keyfile
```

The one-shot `platform-mongodb-init` container:

```text
waits for authenticated MongoDB health
initiates rs0 when necessary
waits until the node is writable PRIMARY
creates/rotates platform_controller
exits successfully
```

The replica keyfile is persistent and must not be regenerated casually after deployment.

## Platform Admin `/mongodb`

Implemented operations:

```text
health/status
replica-set display
list databases and sizes
list managed users and roles
create database + dedicated readWrite user
rotate application-user password
reveal/hide private connection URL
hard delete database
delete database + scoped user
```

Private application URL:

```text
mongodb://USER:PASSWORD@mongodb:27017/DATABASE?authSource=DATABASE&replicaSet=rs0
```

## n8n integration

Both `n8n` and `n8n-worker` are attached to `mongo_net`. Workflow credentials must use application users generated for the target database, never `root` or `platform_controller`.

## Runtime acceptance criteria

MongoDB is not considered deployed until all of the following pass on the VPS:

```text
platform-mongodb healthy
platform-mongodb-init exited 0
rs.status() shows rs0 with one PRIMARY member
Platform Admin rebuild healthy
/mongodb loads successfully
creating a test DB/user works
generated private URL authenticates
password rotation invalidates the old password
n8n can reach mongodb:27017
hard delete removes the test database/user
platform-mongodb appears in /docker
27017 is not host-published
backup + restore test succeeds
```

## Public access policy

Public MongoDB access remains a separate future phase. Do not publish `27017` until TLS, certificate renewal, replica-set hostname discovery, provider firewall rules, Docker firewall rules and external verification have all been designed and tested.

## Backup requirement

Use a reviewed `mongodump --archive --gzip` / `mongorestore` workflow or an equivalent consistent snapshot design. A backup process is not production-ready until an actual restore test succeeds.
