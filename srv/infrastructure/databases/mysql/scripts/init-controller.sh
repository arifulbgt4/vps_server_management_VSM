#!/bin/sh
set -eu

ROOT_PASSWORD_FILE="${MYSQL_ROOT_PASSWORD_FILE:-/run/secrets/root_password}"
CONTROLLER_PASSWORD_FILE="${MYSQL_CONTROLLER_PASSWORD_FILE:-/run/secrets/controller_password}"
MYSQL_HOST="${MYSQL_HOST:-mysql}"
CONTROLLER_USER="${MYSQL_CONTROLLER_USER:-platform_controller}"

[ -r "$ROOT_PASSWORD_FILE" ] || { echo "Missing MySQL root password file" >&2; exit 1; }
[ -r "$CONTROLLER_PASSWORD_FILE" ] || { echo "Missing MySQL controller password file" >&2; exit 1; }

ROOT_PASSWORD="$(cat "$ROOT_PASSWORD_FILE")"
CONTROLLER_PASSWORD="$(cat "$CONTROLLER_PASSWORD_FILE")"

[ -n "$ROOT_PASSWORD" ] || { echo "MySQL root password is empty" >&2; exit 1; }
[ -n "$CONTROLLER_PASSWORD" ] || { echo "MySQL controller password is empty" >&2; exit 1; }

case "$CONTROLLER_USER" in
  *[!a-zA-Z0-9_]*|'') echo "Invalid MySQL controller username" >&2; exit 1 ;;
esac

sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

CTRL_ESCAPED="$(sql_escape "$CONTROLLER_PASSWORD")"

export MYSQL_PWD="$ROOT_PASSWORD"

until mysqladmin ping -h "$MYSQL_HOST" -uroot --silent >/dev/null 2>&1; do
  sleep 2
done

mysql -h "$MYSQL_HOST" -uroot <<SQL
CREATE USER IF NOT EXISTS '${CONTROLLER_USER}'@'%' IDENTIFIED BY '${CTRL_ESCAPED}';
ALTER USER '${CONTROLLER_USER}'@'%' IDENTIFIED BY '${CTRL_ESCAPED}';
REVOKE ALL PRIVILEGES, GRANT OPTION FROM '${CONTROLLER_USER}'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER,
      SHOW DATABASES, CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE,
      CREATE VIEW, SHOW VIEW, CREATE ROUTINE, ALTER ROUTINE, CREATE USER,
      EVENT, TRIGGER
ON *.* TO '${CONTROLLER_USER}'@'%' WITH GRANT OPTION;
FLUSH PRIVILEGES;
SQL

unset MYSQL_PWD ROOT_PASSWORD CONTROLLER_PASSWORD CTRL_ESCAPED

echo "MySQL controller account is ready"
