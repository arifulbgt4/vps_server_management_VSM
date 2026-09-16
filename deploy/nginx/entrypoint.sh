#!/bin/sh
set -eu

required_domains="
${ADMIN_DOMAIN:-admin.openmusk.store}
${N8N_DOMAIN:-n8n.openmusk.store}
${MEDIA_DOMAIN:-media.openmusk.store}
"

nginx -c /etc/nginx/acme.conf -g 'daemon off;' &
bootstrap_pid=$!

stop_bootstrap() {
  if kill -0 "$bootstrap_pid" 2>/dev/null; then
    kill -QUIT "$bootstrap_pid" 2>/dev/null || true
    wait "$bootstrap_pid" 2>/dev/null || true
  fi
}

trap 'stop_bootstrap; exit 0' TERM INT

echo "Nginx ACME bootstrap listener is ready on port 80."

while :; do
  ready=1
  for domain in $required_domains; do
    if [ ! -s "/etc/letsencrypt/live/$domain/fullchain.pem" ] || [ ! -s "/etc/letsencrypt/live/$domain/privkey.pem" ]; then
      ready=0
      break
    fi
  done
  [ "$ready" -eq 1 ] && break
  sleep 2
done

envsubst '${ADMIN_DOMAIN} ${N8N_DOMAIN} ${MEDIA_DOMAIN}' \
  < /opt/vsm/nginx.conf.template \
  > /etc/nginx/nginx.conf

nginx -t
stop_bootstrap

echo "TLS certificates found. Starting full HTTPS reverse proxy."
exec nginx -g 'daemon off;'
