#!/bin/sh
set -eu

read_secret() {
  file="$1"
  [ -s "$file" ] || { echo "Missing secret: $file" >&2; exit 1; }
  cat "$file"
}

escape_sql() {
  printf "%s" "$1" | sed "s/'/''/g"
}

CTRL_PASS="$(escape_sql "$(read_secret /run/secrets/platform_controller_password)")"
APP_PASS="$(escape_sql "$(read_secret /run/secrets/platform_app_password)")"
N8N_PASS="$(escape_sql "$(read_secret /run/secrets/n8n_db_password)")"
MEDIA_PASS="$(escape_sql "$(read_secret /run/secrets/media_db_password)")"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_controller') THEN
    CREATE ROLE platform_controller LOGIN CREATEDB CREATEROLE NOSUPERUSER PASSWORD '${CTRL_PASS}';
  ELSE
    ALTER ROLE platform_controller WITH LOGIN CREATEDB CREATEROLE NOSUPERUSER PASSWORD '${CTRL_PASS}';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    CREATE ROLE platform_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${APP_PASS}';
  ELSE
    ALTER ROLE platform_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${APP_PASS}';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n_app') THEN
    CREATE ROLE n8n_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${N8N_PASS}';
  ELSE
    ALTER ROLE n8n_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${N8N_PASS}';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'media_app') THEN
    CREATE ROLE media_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${MEDIA_PASS}';
  ELSE
    ALTER ROLE media_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${MEDIA_PASS}';
  END IF;
END
\$\$;
SQL

create_db() {
  db="$1"
  owner="$2"
  if ! psql -At --username "$POSTGRES_USER" --dbname postgres -c "SELECT 1 FROM pg_database WHERE datname='${db}'" | grep -q 1; then
    createdb --username "$POSTGRES_USER" --owner "$owner" "$db"
  fi
}

create_db platform_admin platform_app
create_db n8n n8n_app
create_db media_service media_app

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
GRANT CONNECT ON DATABASE platform_admin TO platform_app;
GRANT CONNECT ON DATABASE n8n TO n8n_app;
GRANT CONNECT ON DATABASE media_service TO media_app;
SQL

echo "PostgreSQL VSM roles and databases are ready."
