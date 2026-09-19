#!/bin/sh
set -eu

SUPERUSER_FILE=/run/secrets/postgres_superuser_password
APP_PASSWORD_FILE=/run/secrets/automation_db_password

[ -s "$SUPERUSER_FILE" ] || { echo "PostgreSQL superuser password is missing" >&2; exit 1; }
[ -s "$APP_PASSWORD_FILE" ] || { echo "Automation database password is missing" >&2; exit 1; }

export PGPASSWORD="$(cat "$SUPERUSER_FILE")"
APP_PASSWORD="$(cat "$APP_PASSWORD_FILE")"
ESCAPED_APP_PASSWORD="$(printf "%s" "$APP_PASSWORD" | sed "s/'/''/g")"

until pg_isready -h postgres -p 5432 -U postgres -d postgres >/dev/null 2>&1; do
  sleep 2
done

psql -v ON_ERROR_STOP=1 -h postgres -U postgres -d postgres <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'automation_app') THEN
    CREATE ROLE automation_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${ESCAPED_APP_PASSWORD}';
  ELSE
    ALTER ROLE automation_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${ESCAPED_APP_PASSWORD}';
  END IF;
END
\$\$;
SQL

if ! psql -At -h postgres -U postgres -d postgres -c "SELECT 1 FROM pg_database WHERE datname='app_db'" | grep -qx 1; then
  createdb -h postgres -U postgres -O automation_app app_db
fi

psql -v ON_ERROR_STOP=1 -h postgres -U postgres -d postgres <<SQL
ALTER DATABASE app_db OWNER TO automation_app;
GRANT CONNECT ON DATABASE app_db TO automation_app;
SQL

# Extensions are database-scoped. Only app_db receives pgvector.
psql -v ON_ERROR_STOP=1 -h postgres -U postgres -d app_db <<SQL
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
GRANT USAGE ON SCHEMA public TO automation_app;
SQL

echo "Automation PostgreSQL role, app_db, pgcrypto and vector are ready."
