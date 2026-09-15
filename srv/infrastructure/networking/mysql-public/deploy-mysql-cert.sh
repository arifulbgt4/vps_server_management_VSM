#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${MYSQL_TLS_DOMAIN:-mysql.openmusk.store}"
SOURCE_DIR="/etc/letsencrypt/live/${DOMAIN}"
SYSTEM_CA_BUNDLE="${MYSQL_SYSTEM_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"
TARGET_DIR="/srv/infrastructure/databases/mysql/tls"
MYSQL_UID="${MYSQL_UID:-999}"
MYSQL_GID="${MYSQL_GID:-999}"
CONTAINER="${MYSQL_CONTAINER:-platform-mysql}"

for file in fullchain.pem privkey.pem; do
  if [[ ! -s "${SOURCE_DIR}/${file}" ]]; then
    echo "Certificate file ${SOURCE_DIR}/${file} was not found" >&2
    exit 1
  fi
done

if [[ ! -s "${SYSTEM_CA_BUNDLE}" ]]; then
  echo "System CA bundle ${SYSTEM_CA_BUNDLE} was not found" >&2
  exit 1
fi

mkdir -p "${TARGET_DIR}"
install -m 0644 "${SOURCE_DIR}/fullchain.pem" "${TARGET_DIR}/fullchain.pem"
install -m 0644 "${SYSTEM_CA_BUNDLE}" "${TARGET_DIR}/ca.pem"
install -m 0600 "${SOURCE_DIR}/privkey.pem" "${TARGET_DIR}/privkey.pem"
chown "${MYSQL_UID}:${MYSQL_GID}" \
  "${TARGET_DIR}/fullchain.pem" \
  "${TARGET_DIR}/ca.pem" \
  "${TARGET_DIR}/privkey.pem"

if docker ps --format '{{.Names}}' | grep -Fxq "${CONTAINER}"; then
  docker restart "${CONTAINER}" >/dev/null
  echo "Deployed ${DOMAIN} certificate and trusted CA bundle, then restarted ${CONTAINER}."
else
  echo "Deployed ${DOMAIN} certificate and trusted CA bundle. ${CONTAINER} is not running yet."
fi
