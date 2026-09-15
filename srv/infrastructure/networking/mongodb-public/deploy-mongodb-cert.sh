#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${MONGO_TLS_DOMAIN:-mongo.openmusk.store}"
SOURCE_DIR="/etc/letsencrypt/live/${DOMAIN}"
TARGET_DIR="/srv/infrastructure/databases/mongodb/tls"
CONTAINER="${MONGO_PUBLIC_CONTAINER:-platform-mongodb-public}"

if [[ ! -s "${SOURCE_DIR}/fullchain.pem" || ! -s "${SOURCE_DIR}/privkey.pem" ]]; then
  echo "Certificate files for ${DOMAIN} were not found in ${SOURCE_DIR}" >&2
  exit 1
fi

mkdir -p "${TARGET_DIR}"
TMP="${TARGET_DIR}/mongodb.pem.tmp"
cat "${SOURCE_DIR}/fullchain.pem" "${SOURCE_DIR}/privkey.pem" > "${TMP}"
chmod 0600 "${TMP}"
chown root:root "${TMP}"
mv -f "${TMP}" "${TARGET_DIR}/mongodb.pem"

if docker ps --format '{{.Names}}' | grep -Fxq "${CONTAINER}"; then
  docker restart "${CONTAINER}" >/dev/null
  echo "Deployed ${DOMAIN} certificate and restarted ${CONTAINER}."
else
  echo "Deployed ${DOMAIN} certificate. ${CONTAINER} is not running yet."
fi
