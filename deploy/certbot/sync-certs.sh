#!/bin/sh
set -eu

POSTGRES_DOMAIN="${POSTGRES_DOMAIN:-db.openmusk.store}"
REDIS_DOMAIN="${REDIS_DOMAIN:-redis.openmusk.store}"
MYSQL_DOMAIN="${MYSQL_DOMAIN:-mysql.openmusk.store}"
MONGO_DOMAIN="${MONGO_DOMAIN:-mongo.openmusk.store}"
TLS_ROOT="${TLS_ROOT:-/srv/vsm/tls}"

copy_pair() {
  domain="$1"
  target="$2"
  uid="$3"
  gid="$4"

  source="/etc/letsencrypt/live/$domain"
  [ -s "$source/fullchain.pem" ] || { echo "Missing $source/fullchain.pem" >&2; exit 1; }
  [ -s "$source/privkey.pem" ] || { echo "Missing $source/privkey.pem" >&2; exit 1; }

  mkdir -p "$target"
  cp "$source/fullchain.pem" "$target/server.crt.tmp"
  cp "$source/privkey.pem" "$target/server.key.tmp"
  chmod 0644 "$target/server.crt.tmp"
  chmod 0600 "$target/server.key.tmp"
  chown "$uid:$gid" "$target/server.crt.tmp" "$target/server.key.tmp"
  mv -f "$target/server.crt.tmp" "$target/server.crt"
  mv -f "$target/server.key.tmp" "$target/server.key"
}

copy_pair "$POSTGRES_DOMAIN" "$TLS_ROOT/postgres" 70 70
copy_pair "$REDIS_DOMAIN" "$TLS_ROOT/redis" 999 999

mysql_source="/etc/letsencrypt/live/$MYSQL_DOMAIN"
mkdir -p "$TLS_ROOT/mysql"
cp "$mysql_source/fullchain.pem" "$TLS_ROOT/mysql/fullchain.pem.tmp"
cp "$mysql_source/privkey.pem" "$TLS_ROOT/mysql/privkey.pem.tmp"
cp /etc/ssl/certs/ca-certificates.crt "$TLS_ROOT/mysql/ca.pem.tmp"
chmod 0644 "$TLS_ROOT/mysql/fullchain.pem.tmp" "$TLS_ROOT/mysql/ca.pem.tmp"
chmod 0600 "$TLS_ROOT/mysql/privkey.pem.tmp"
chown 999:999 "$TLS_ROOT/mysql/fullchain.pem.tmp" "$TLS_ROOT/mysql/privkey.pem.tmp" "$TLS_ROOT/mysql/ca.pem.tmp"
mv -f "$TLS_ROOT/mysql/fullchain.pem.tmp" "$TLS_ROOT/mysql/fullchain.pem"
mv -f "$TLS_ROOT/mysql/privkey.pem.tmp" "$TLS_ROOT/mysql/privkey.pem"
mv -f "$TLS_ROOT/mysql/ca.pem.tmp" "$TLS_ROOT/mysql/ca.pem"

mongo_source="/etc/letsencrypt/live/$MONGO_DOMAIN"
mkdir -p "$TLS_ROOT/mongodb"
cat "$mongo_source/fullchain.pem" "$mongo_source/privkey.pem" > "$TLS_ROOT/mongodb/mongodb.pem.tmp"
chmod 0600 "$TLS_ROOT/mongodb/mongodb.pem.tmp"
chown 0:0 "$TLS_ROOT/mongodb/mongodb.pem.tmp"
mv -f "$TLS_ROOT/mongodb/mongodb.pem.tmp" "$TLS_ROOT/mongodb/mongodb.pem"

echo "Database TLS files synchronized."

if [ "${1:-}" = "--restart" ]; then
  token_file="${DOCKER_AGENT_TOKEN_FILE:-/run/secrets/docker_agent_token}"
  [ -s "$token_file" ] || { echo "Docker agent token unavailable; certificates copied but services were not restarted." >&2; exit 0; }

  token="$(cat "$token_file")"
  export VSM_AGENT_TOKEN="$token"

  python3 <<'PY'
import os
import time
import urllib.request

token = os.environ["VSM_AGENT_TOKEN"]
base = os.environ.get("DOCKER_AGENT_URL", "http://docker-agent:8080")
services = [
    "platform-postgres",
    "platform-redis",
    "platform-mysql",
    "platform-mongodb-public",
    "platform-proxy",
]
for name in services:
    req = urllib.request.Request(
        f"{base}/services/{name}/restart",
        method="POST",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            print(f"Restarted {name}: HTTP {response.status}")
    except Exception as exc:
        print(f"Unable to restart {name}: {exc}")
    time.sleep(1)
PY
fi
