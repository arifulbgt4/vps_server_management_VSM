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
    └── platform-admin/
```

## Documentation

The complete production setup, security model, deployment procedure, verification commands, resource-limit behavior, certificate renewal, firewall policy, and troubleshooting history are documented here:

**[docs/PRODUCTION_SETUP.md](docs/PRODUCTION_SETUP.md)**

Platform Admin-specific documentation:

**[srv/apps/platform-admin/README.md](srv/apps/platform-admin/README.md)**

## Current Platform Admin

Runtime path:

```text
/srv/apps/platform-admin
```

Current version:

```text
0.7.0
```

Production URL:

```text
https://admin.openmusk.store
```

Management modules:

```text
/postgres
/redis
/docker
```

Do not commit any file from a `secrets/` directory, private key, password, bearer token, credential-vault master key, or generated application credential.
