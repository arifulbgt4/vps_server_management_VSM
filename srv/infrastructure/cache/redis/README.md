# Shared Redis

Production Redis service for VPS applications.

Runtime path:

```text
/srv/infrastructure/cache/redis
```

The service is attached only to the external Docker network `redis_net`; port 6379 is not published on the VPS host.

Applications should join `redis_net` and use a dedicated ACL user created from Platform Admin.

Example private application URL:

```text
redis://APP_USER:APP_PASSWORD@redis:6379/0
```

## Bootstrap

Create the controller secret before starting Redis:

```bash
mkdir -p secrets data
chmod 700 secrets
openssl rand -hex 32 > secrets/platform_controller_password
chmod 600 secrets/platform_controller_password

docker network inspect redis_net >/dev/null 2>&1 || docker network create redis_net
docker compose up -d
```

Do not expose port 6379 publicly. Use the private Docker network for same-VPS applications; add a secured tunnel/TLS design separately if remote Redis access is ever required.
