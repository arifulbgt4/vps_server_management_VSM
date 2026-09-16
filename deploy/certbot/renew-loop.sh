#!/bin/sh
set -eu

interval="${CERTBOT_RENEW_INTERVAL_SECONDS:-43200}"

while :; do
  echo "Running certificate renewal check..."
  certbot renew \
    --webroot \
    --webroot-path /var/www/certbot \
    --quiet \
    --deploy-hook "sh /opt/vsm/sync-certs.sh --restart" || true

  sleep "$interval"
done
