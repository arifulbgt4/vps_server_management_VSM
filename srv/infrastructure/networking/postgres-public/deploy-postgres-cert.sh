#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${POSTGRES_TLS_DOMAIN:-db.openmusk.store}"
CONTAINER="${POSTGRES_CONTAINER:-platform-postgres}"
SOURCE_DIR="/etc/letsencrypt/live/${DOMAIN}"
TARGET_DIR="/srv/infrastructure/databases/postgres/config/tls"

if [[ ! -s "${SOURCE_DIR}/fullchain.pem" || ! -s "${SOURCE_DIR}/privkey.pem" ]]; then
  echo "Certificate files for ${DOMAIN} were not found in ${SOURCE_DIR}" >&2
  exit 1
fi

mkdir -p "${TARGET_DIR}"

PG_UID="$(docker exec "${CONTAINER}" id -u postgres)"
PG_GID="$(docker exec "${CONTAINER}" id -g postgres)"

install -m 0644 "${SOURCE_DIR}/fullchain.pem" "${TARGET_DIR}/server.crt"
install -m 0600 "${SOURCE_DIR}/privkey.pem" "${TARGET_DIR}/server.key"
chown "${PG_UID}:${PG_GID}" "${TARGET_DIR}/server.crt" "${TARGET_DIR}/server.key"

docker kill --signal=HUP "${CONTAINER}" >/dev/null

echo "Deployed ${DOMAIN} TLS certificate to PostgreSQL and reloaded the server."
