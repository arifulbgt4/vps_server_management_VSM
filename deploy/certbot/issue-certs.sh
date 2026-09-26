#!/bin/sh
set -eu

: "${ACME_EMAIL:?ACME_EMAIL is required}"

domains="
${ADMIN_DOMAIN:-admin.openmusk.store}
${CUSTOMER_DOMAIN:-app.openmusk.store}
${SUPER_ADMIN_DOMAIN:-saas-admin.openmusk.store}
${N8N_DOMAIN:-n8n.openmusk.store}
${MEDIA_DOMAIN:-media.openmusk.store}
${API_DOMAIN:-api.openmusk.store}
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

certificate_is_fresh() {
  domain="$1"
  cert_path="/etc/letsencrypt/live/$domain/fullchain.pem"

  if [ ! -r "$cert_path" ]; then
    return 1
  fi

  python3 - "$cert_path" <<'PY'
import ssl
import sys
import time

path = sys.argv[1]
renew_before_days = 30

try:
    certificate = ssl._ssl._test_decode_cert(path)
    not_after = certificate.get("notAfter")
    if not not_after:
        raise ValueError("certificate has no notAfter field")
    expires_at = ssl.cert_time_to_seconds(not_after)
except Exception as exc:
    print(f"Unable to validate existing certificate {path}: {exc}", file=sys.stderr)
    sys.exit(1)

minimum_expiry = time.time() + (renew_before_days * 24 * 60 * 60)
sys.exit(0 if expires_at > minimum_expiry else 1)
PY
}

for domain in $domains; do
  if certificate_is_fresh "$domain"; then
    echo "Existing certificate for $domain is valid beyond the 30-day renewal window; skipping ACME request."
    continue
  fi

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
