# VPS Server Management (VSM)

Production-oriented VPS infrastructure and management repository for independently deployed services.

Current deployed production components:

```text
Platform Admin         Next.js management UI
PostgreSQL             shared database service with public TLS
Redis                  shared cache/queue service with private 6379 + public TLS 6380
n8n main               editor/API/webhook process
n8n worker             Redis queue worker for workflow execution
Media Storage          multi-user file storage with quotas, API keys and hard deletion
Docker control agent   private allowlisted lifecycle/metrics/resource controller
Nginx + Certbot        HTTPS and certificate lifecycle
DOCKER-USER firewall   explicit Docker published-port policy
```

Tracked integrations ready for VPS deployment:

```text
MySQL                  private mysql_net service + Platform Admin /mysql
MongoDB                private mongo_net single-node rs0 + Platform Admin /mongodb
```

Primary runtime layout:

```text
/srv/
├── infrastructure/
│   ├── databases/postgres/
│   ├── databases/mysql/
│   ├── databases/mongodb/
│   ├── cache/redis/
│   ├── management/docker-agent/
│   └── networking/
└── apps/
    ├── platform-admin/
    ├── n8n/
    └── media-service/
```

## Documentation

Complete production architecture, security rules, deployment procedures, verification, queue mode, database services, Media Storage, scaling and troubleshooting:

**[docs/PRODUCTION_SETUP.md](docs/PRODUCTION_SETUP.md)**

Platform Admin login, password retrieval, username change, password reset and session invalidation:

**[docs/PLATFORM_ADMIN_ACCESS.md](docs/PLATFORM_ADMIN_ACCESS.md)**

MongoDB design history and acceptance plan:

**[docs/MONGODB_IMPLEMENTATION_PLAN.md](docs/MONGODB_IMPLEMENTATION_PLAN.md)**

Service documentation:

**[srv/infrastructure/databases/mysql/README.md](srv/infrastructure/databases/mysql/README.md)**

**[srv/infrastructure/databases/mongodb/README.md](srv/infrastructure/databases/mongodb/README.md)**

**[srv/apps/platform-admin/README.md](srv/apps/platform-admin/README.md)**

**[srv/apps/n8n/README.md](srv/apps/n8n/README.md)**

**[srv/apps/media-service/README.md](srv/apps/media-service/README.md)**

Documentation uses `example.com` as a placeholder domain. Replace it with real production domains only in VPS runtime configuration.

## Platform Admin

Runtime path:

```text
/srv/apps/platform-admin
```

Current tracked version:

```text
1.0.0
```

Management modules:

```text
/postgres
/mysql
/mongodb
/redis
/docker
/media
```

After first bootstrap, the generated Platform Admin password can be read with:

```bash
sudo cat /srv/vsm/bootstrap/admin_initial_password
```

The effective username comes from `ADMIN_USERNAME` in the root `.env` and defaults to `admin`. For changing the username or securely resetting the password, follow **[docs/PLATFORM_ADMIN_ACCESS.md](docs/PLATFORM_ADMIN_ACCESS.md)**. Changing `VSM_ADMIN_PASSWORD` in `.env` alone does not change an already initialized password because the persisted password hash is reused.

PostgreSQL, MySQL, MongoDB, Redis and Media credentials that must be recoverable are stored encrypted with the existing AES-256-GCM credential vault. Database root/bootstrap secrets are never exposed to the browser and are not mounted into Platform Admin.

## MySQL integration

Tracked infrastructure:

```text
srv/infrastructure/databases/mysql/
```

Design:

```text
platform-mysql
  -> private mysql_net
  -> mysql:3306 Docker alias
  -> persistent /var/lib/mysql
  -> root credential for bootstrap/emergency only
  -> platform_controller for Platform Admin management
  -> dedicated database-scoped application users
```

No host port is published. Platform Admin `/mysql`, n8n main and n8n-worker use `mysql_net`.

## MongoDB integration

Tracked infrastructure:

```text
srv/infrastructure/databases/mongodb/
```

Design:

```text
platform-mongodb
  -> private mongo_net
  -> mongodb:27017 Docker alias
  -> authorization enabled
  -> single-node replica set rs0
  -> persistent /data/db
  -> replica-set keyfile authentication
  -> root credential for bootstrap/emergency only
  -> platform_controller for Platform Admin management
  -> readWrite application users scoped to their database
```

No host port is published. Platform Admin `/mongodb`, n8n main and n8n-worker use `mongo_net`.

## n8n queue mode

n8n runs permanently in Redis queue mode:

```text
n8n main    -> editor/API/webhooks
Redis       -> execution queue
n8n-worker  -> workflow execution, initial concurrency 5
PostgreSQL  -> persistent n8n data
```

Both main and worker are now tracked on:

```text
postgres_net
redis_net
mysql_net
mongo_net
media_net
```

This allows workflow nodes to reach database services over private Docker networking without public database ports.

## Media Storage

The service stores physical files under `/srv/apps/media-service/storage` and ownership/quota/file metadata in its dedicated PostgreSQL database. Platform Admin reaches the private media admin API through `media_net`; n8n reaches media binaries directly through `http://media-service:8080`.

## Load balancing

A separate load balancer is not required for the current single-VPS deployment. Host Nginx handles reverse proxying and TLS, while Redis distributes n8n execution jobs to workers.

Add HTTP load balancing only after deploying multiple HTTP-facing instances, and add an external/cloud load balancer when moving to multiple VPS nodes or high availability.

## Deployment status rule

Repository code being present does not mean a service is already running on the VPS. MySQL and MongoDB must be copied to `/srv`, their runtime secrets/directories/networks must be created, their containers must pass health checks, and Platform Admin must be rebuilt before they are considered deployed.

## Secrets

Do not commit any file from a `secrets/` directory, private key, password, bearer token, Redis credential, credential-vault master key, n8n encryption key, media admin token, MySQL root/controller credential, MongoDB root/controller/keyfile, or generated application credential.

## n8n Automation SaaS runtime

VSM hosts the backend runtime and can serve the Customer Panel and SaaS Super Admin Panel as separate HTTPS services. Local panel development remains supported.

New runtime services: `automation-db-init`, `automation-migrate`, `automation-api`, and `automation-worker`. The existing `n8n-worker` remains the n8n execution worker and is not replaced.

PostgreSQL stays on the Alpine PostgreSQL 17 base and gains pgvector capability. The `vector` extension is enabled only in the SaaS `app_db`, so other VSM databases continue to behave as normal PostgreSQL databases.

Deployment and update commands: **[docs/AUTOMATION_SERVICE.md](docs/AUTOMATION_SERVICE.md)**
