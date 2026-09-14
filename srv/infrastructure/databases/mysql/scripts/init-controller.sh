#!/bin/sh

CONTROLLER_PASSWORD_FILE="${MYSQL_CONTROLLER_PASSWORD_FILE:-/run/secrets/controller_password}"
CONTROLLER_USER="${MYSQL_CONTROLLER_USER:-platform_controller}"

if [ ! -r "$CONTROLLER_PASSWORD_FILE" ]; then
  echo "Missing MySQL controller password file" >&2
  return 1 2>/dev/null || exit 1
fi

CONTROLLER_PASSWORD="$(cat "$CONTROLLER_PASSWORD_FILE")"
if [ -z "$CONTROLLER_PASSWORD" ]; then
  echo "MySQL controller password is empty" >&2
  return 1 2>/dev/null || exit 1
fi

case "$CONTROLLER_USER" in
  *[!a-zA-Z0-9_]*|'')
    echo "Invalid MySQL controller username" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

CTRL_ESCAPED="$(sql_escape "$CONTROLLER_PASSWORD")"
ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-$(cat "${MYSQL_ROOT_PASSWORD_FILE:-/run/secrets/root_password}")}" 

MYSQL_PWD="$ROOT_PASSWORD" mysql --protocol=socket -uroot <<SQL
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

unset ROOT_PASSWORD CONTROLLER_PASSWORD CTRL_ESCAPED

echo "MySQL controller account is ready"
