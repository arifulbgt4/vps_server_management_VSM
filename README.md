# VPS Server Management (VSM)

Production-oriented VPS infrastructure and management repository for independently deployed services.

Current production components:

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

Primary runtime layout:

```text
/srv/
├── infrastructure/
│   ├── databases/postgres/
│   ├── cache/redis/
│   ├── management/docker-agent/
│   └── networking/
└── apps/
    ├── platform-admin/
    ├── n8n/
    └── media-service/
```

## Documentation

Complete production architecture, security rules, deployment procedures, verification, queue mode, Media Storage, scaling and troubleshooting:

**[docs/PRODUCTION_SETUP.md](docs/PRODUCTION_SETUP.md)**

Application-specific documentation:

**[srv/apps/platform-admin/README.md](srv/apps/platform-admin/README.md)**

**[srv/apps/n8n/README.md](srv/apps/n8n/README.md)**

**[srv/apps/media-service/README.md](srv/apps/media-service/README.md)**

Documentation uses `example.com` as a placeholder domain. Replace it with real production domains only in VPS runtime configuration.

## Platform Admin

Runtime path:

```text
/srv/apps/platform-admin
```

Current version:

```text
0.9.0
```

Example production URL:

```text
https://admin.example.com
```

Management modules:

```text
/postgres
/redis
/docker
/media
```

The credential vault uses AES-256-GCM. Media user API keys can be shown/hidden from the authenticated Media manager because Platform Admin stores an encrypted copy while the Media Service itself stores only the API-key hash.

## n8n queue mode

Tracked production stack:

```text
srv/apps/n8n/
```

n8n runs permanently in Redis queue mode:

```text
n8n main    -> editor/API/webhooks
Redis       -> execution queue
n8n-worker  -> workflow execution, initial concurrency 5
PostgreSQL  -> persistent n8n data
```

The main process binds only to `127.0.0.1:5678`; the worker publishes no host port. Both main and worker use `postgres_net`, `redis_net` and `media_net` and share the same persistent n8n encryption key.

Queue Redis uses a dedicated ACL identity such as `n8n_queue` rather than `platform_controller`.

## Media Storage

Tracked production service:

```text
srv/apps/media-service/
```

The service stores physical files under `/srv/apps/media-service/storage` and ownership/quota/file metadata in its dedicated PostgreSQL database.

Capabilities include:

```text
per-user API keys
per-user GiB quotas
used/available usage tracking
image/video/audio/PDF/document/archive support
private binary endpoint for n8n
optional public file URLs
hard file deletion
hard user + all-owned-files deletion
host free-space reserve
```

Platform Admin reaches the private media admin API through `media_net`. n8n reaches media binaries directly through:

```text
http://media-service:8080
```

## Load balancing

A separate load balancer is not required for the current single-VPS deployment. Host Nginx handles reverse proxying and TLS, while Redis distributes n8n execution jobs to workers.

Add HTTP load balancing only after deploying multiple HTTP-facing instances, and add an external/cloud load balancer when moving to multiple VPS nodes or high availability.

## Secrets

Do not commit any file from a `secrets/` directory, private key, password, bearer token, Redis credential, credential-vault master key, n8n encryption key, media admin token, or generated application credential.
