#!/bin/sh
set -eu

SECRET_FILE=/run/secrets/platform_controller_password
ACL_FILE=/data/users.acl
PRESERVED=/data/users.preserved
TMP_FILE=/data/users.acl.tmp

if [ ! -s "$SECRET_FILE" ]; then
  echo "Redis controller password secret is missing" >&2
  exit 1
fi

CONTROLLER_PASSWORD=$(cat "$SECRET_FILE")
umask 077
mkdir -p /data

if [ -f "$ACL_FILE" ]; then
  awk '!/^user default / && !/^user platform_controller /' "$ACL_FILE" > "$PRESERVED"
else
  : > "$PRESERVED"
fi

{
  printf 'user default off\n'
  printf 'user platform_controller on >%s ~* &* +@all\n' "$CONTROLLER_PASSWORD"
  cat "$PRESERVED"
} > "$TMP_FILE"

mv "$TMP_FILE" "$ACL_FILE"
rm -f "$PRESERVED"
chmod 600 "$ACL_FILE"

exec redis-server /usr/local/etc/redis/redis.conf
