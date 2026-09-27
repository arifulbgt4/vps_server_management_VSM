#!/bin/sh
set -eu

read_required() {
  file="$1"
  label="$2"
  [ -r "$file" ] || { echo "$label is not readable: $file" >&2; exit 1; }
  value="$(cat "$file")"
  [ -n "$value" ] || { echo "$label is empty" >&2; exit 1; }
  printf "%s" "$value"
}

DB_PASSWORD="$(read_required /run/secrets/db_password "Automation database password")"
REDIS_PASSWORD="$(read_required /run/secrets/redis_password "Automation Redis password")"
APP_KEY="$(read_required /run/secrets/app_encryption_key "Automation encryption key")"
INTERNAL_SECRET="$(read_required /run/secrets/internal_service_auth_secret "Automation internal auth secret")"

export DATABASE_URL="postgresql://automation_app:${DB_PASSWORD}@postgres:5432/app_db"
export REDIS_URL="redis://automation_app:${REDIS_PASSWORD}@redis:6379/0"
export APP_ENCRYPTION_KEY="$APP_KEY"
export INTERNAL_SERVICE_AUTH_SECRET="$INTERNAL_SECRET"

case "${1:-api}" in
  api|worker)
    MEDIA_KEY="$(read_required /run/secrets/media_api_key "Automation media API key")"
    export MEDIA_API_KEY="$MEDIA_KEY"
    unset MEDIA_KEY
    ;;
esac

unset DB_PASSWORD REDIS_PASSWORD APP_KEY INTERNAL_SECRET

case "${1:-api}" in
  api) exec node apps/api/dist/server.js ;;
  worker) exec node apps/worker/dist/worker.js ;;
  migrate) exec node scripts/migrate.mjs ;;
  *) exec "$@" ;;
esac
