#!/bin/sh
set -eu

: "${ACME_EMAIL:?ACME_EMAIL is required}"

domains="
${ADMIN_DOMAIN:-admin.openmusk.store}
${N8N_DOMAIN:-n8n.openmusk.store}
${MEDIA_DOMAIN:-media.openmusk.store}
${POSTGRES_DOMAIN:-db.openmusk.store}
${REDIS_DOMAIN:-redis.openmusk.store}
${MYSQL_DOMAIN:-mysql.openmusk.store}
${MONGO_DOMAIN:-mongo.openmusk.store}
"

if [ -n "${PUBLIC_IPV4:-}" ]; then
  python3 - "$PUBLIC_IPV4" $domains <<'PY'
import socket, sys
expected = sys.argv[1]
failed = False
for domain in sys.argv[2:]:
    try:
        addresses = sorted({item[4][0] for item in socket.getaddrinfo(domain, 80, socket.AF_INET, socket.SOCK_STREAM)})
    except Exception as exc:
        print(f"DNS check failed for {domain}: {exc}", file=sys.stderr)
        failed = True
        continue
    if expected not in addresses:
        print(f"DNS mismatch for {domain}: expected {expected}, got {addresses}", file=sys.stderr)
        failed = True
if failed:
    sys.exit(1)
PY
fi

staging_args=""
if [ "${ACME_STAGING:-false}" = "true" ]; then
  staging_args="--staging"
fi

for domain in $domains; do
  echo "Ensuring Let's Encrypt certificate for $domain"
  certbot certonly \
    --webroot \
    --webroot-path /var/www/certbot \
    --preferred-challenges http \
    --cert-name "$domain" \
    -d "$domain" \
    --email "$ACME_EMAIL" \
    --agree-tos \
    --non-interactive \
    --no-eff-email \
    --keep-until-expiring \
    --key-type ecdsa \
    $staging_args
done

touch /var/www/certbot/.certs-ready
echo "All VSM certificates are present."
