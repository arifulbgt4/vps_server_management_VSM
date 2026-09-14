# VPS Server Management (VSM)

Production-oriented VPS infrastructure and management repository for independently deployed services.

Current production components:

```text
Platform Admin         Next.js management UI
PostgreSQL             shared database service with public TLS
Redis                  shared cache/service with private 6379 + public TLS 6380
Docker control agent   private allowlisted lifecycle/metrics/resource controller
Nginx + Certbot        HTTPS and certificate lifecycle
DOCKER-USER firewall   explicit Docker published-port policy
n8n                    production app scaffold using shared PostgreSQL
```

Primary runtime layout on the VPS:

```text
/srv/
├── infrastructure/
│   ├── databases/postgres/
│   ├── cache/redis/
│   ├── management/docker-agent/
│   └── networking/
└── apps/
    ├── platform-admin/
    └── n8n/
```

## Documentation

The complete production setup, security model, deployment procedure, verification commands, resource-limit behavior, certificate renewal, firewall policy, and troubleshooting history are documented here:

**[docs/PRODUCTION_SETUP.md](docs/PRODUCTION_SETUP.md)**

Application-specific documentation:

**[srv/apps/platform-admin/README.md](srv/apps/platform-admin/README.md)**

**[srv/apps/n8n/README.md](srv/apps/n8n/README.md)**

Documentation uses `example.com` as a placeholder domain. Replace it with the real production domain only in VPS runtime configuration.

## Current Platform Admin

Runtime path:

```text
/srv/apps/platform-admin
```

Current version:

```text
0.8.0
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
```

## n8n app

Tracked production scaffold:

```text
srv/apps/n8n/
```

The n8n stack uses a dedicated PostgreSQL database/user on the shared `postgres_net`, stores its encryption key and DB password outside Git, binds port `5678` to localhost only, and is intended to be exposed through host Nginx + HTTPS.

Do not commit any file from a `secrets/` directory, private key, password, bearer token, credential-vault master key, n8n encryption key, or generated application credential.
