#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${REDIS_TLS_DOMAIN:-redis.openmusk.store}"
CONTAINER="${REDIS_CONTAINER:-platform-redis}"
IMAGE="${REDIS_IMAGE:-redis:7.4-alpine}"
SOURCE_DIR="/etc/letsencrypt/live/${DOMAIN}"
TARGET_DIR="/srv/infrastructure/cache/redis/config/tls"

if [[ ! -s "${SOURCE_DIR}/fullchain.pem" || ! -s "${SOURCE_DIR}/privkey.pem" ]]; then
  echo "Certificate files for ${DOMAIN} were not found in ${SOURCE_DIR}" >&2
  exit 1
fi

mkdir -p "${TARGET_DIR}"

if docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  REDIS_UID="$(docker exec "${CONTAINER}" id -u redis)"
  REDIS_GID="$(docker exec "${CONTAINER}" id -g redis)"
else
  REDIS_UID="$(docker run --rm "${IMAGE}" id -u redis)"
  REDIS_GID="$(docker run --rm "${IMAGE}" id -g redis)"
fi

install -m 0644 "${SOURCE_DIR}/fullchain.pem" "${TARGET_DIR}/server.crt"
install -m 0600 "${SOURCE_DIR}/privkey.pem" "${TARGET_DIR}/server.key"
chown "${REDIS_UID}:${REDIS_GID}" "${TARGET_DIR}/server.crt" "${TARGET_DIR}/server.key"

if docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  docker restart "${CONTAINER}" >/dev/null
  echo "Deployed ${DOMAIN} TLS certificate to Redis and restarted ${CONTAINER}."
else
  echo "Deployed ${DOMAIN} TLS certificate. Redis is not running yet, so no restart was needed."
fi
