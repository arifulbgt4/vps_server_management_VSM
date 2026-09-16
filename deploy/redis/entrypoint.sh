#!/bin/sh
set -eu

CONTROLLER_FILE=/run/secrets/platform_controller_password
N8N_FILE=/run/secrets/n8n_queue_password
ACL_FILE=/data/users.acl
PRESERVED=/data/users.preserved
TMP_FILE=/data/users.acl.tmp

[ -s "$CONTROLLER_FILE" ] || { echo "Redis controller password is missing" >&2; exit 1; }
[ -s "$N8N_FILE" ] || { echo "Redis n8n password is missing" >&2; exit 1; }

CONTROLLER_PASSWORD="$(cat "$CONTROLLER_FILE")"
N8N_PASSWORD="$(cat "$N8N_FILE")"

umask 077
mkdir -p /data

if [ -f "$ACL_FILE" ]; then
  awk '!/^user default / && !/^user platform_controller / && !/^user n8n_queue /' "$ACL_FILE" > "$PRESERVED"
else
  : > "$PRESERVED"
fi

{
  printf 'user default off\n'
  printf 'user platform_controller on >%s ~* &* +@all\n' "$CONTROLLER_PASSWORD"
  printf 'user n8n_queue on >%s ~* &* +@all\n' "$N8N_PASSWORD"
  cat "$PRESERVED"
} > "$TMP_FILE"

mv "$TMP_FILE" "$ACL_FILE"
rm -f "$PRESERVED"
chown -R redis:redis /data
chmod 600 "$ACL_FILE"

exec /usr/local/bin/docker-entrypoint.sh redis-server /usr/local/etc/redis/redis.conf
