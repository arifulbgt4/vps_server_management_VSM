#!/bin/sh
set -eu

DB_PASSWORD_FILE="${N8N_DB_PASSWORD_FILE:-/run/secrets/db_password}"
ENCRYPTION_KEY_FILE="${N8N_ENCRYPTION_KEY_FILE:-/run/secrets/encryption_key}"
REDIS_PASSWORD_FILE="${N8N_REDIS_PASSWORD_FILE:-/run/secrets/redis_password}"

if [ ! -r "$DB_PASSWORD_FILE" ]; then
  echo "n8n database password file is not readable: $DB_PASSWORD_FILE" >&2
  exit 1
fi

if [ ! -r "$ENCRYPTION_KEY_FILE" ]; then
  echo "n8n encryption key file is not readable: $ENCRYPTION_KEY_FILE" >&2
  exit 1
fi

if [ ! -r "$REDIS_PASSWORD_FILE" ]; then
  echo "n8n Redis password file is not readable: $REDIS_PASSWORD_FILE" >&2
  exit 1
fi

DB_PASSWORD="$(cat "$DB_PASSWORD_FILE")"
ENCRYPTION_KEY="$(cat "$ENCRYPTION_KEY_FILE")"
REDIS_PASSWORD="$(cat "$REDIS_PASSWORD_FILE")"

if [ -z "$DB_PASSWORD" ]; then
  echo "n8n database password is empty" >&2
  exit 1
fi

if [ "${#ENCRYPTION_KEY}" -lt 32 ]; then
  echo "n8n encryption key must be at least 32 characters" >&2
  exit 1
fi

if [ -z "$REDIS_PASSWORD" ]; then
  echo "n8n Redis password is empty" >&2
  exit 1
fi

export DB_POSTGRESDB_PASSWORD="$DB_PASSWORD"
export N8N_ENCRYPTION_KEY="$ENCRYPTION_KEY"
export QUEUE_BULL_REDIS_PASSWORD="$REDIS_PASSWORD"

unset DB_PASSWORD ENCRYPTION_KEY REDIS_PASSWORD

if [ "$#" -eq 0 ]; then
  set -- start
fi

exec n8n "$@"
