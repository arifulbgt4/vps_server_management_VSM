#!/bin/sh
set -eu

ROOT_PASSWORD_FILE="${MONGO_ROOT_PASSWORD_FILE:-/run/secrets/root_password}"
CONTROLLER_PASSWORD_FILE="${MONGO_CONTROLLER_PASSWORD_FILE:-/run/secrets/controller_password}"
MONGO_HOST="${MONGO_HOST:-mongodb}"
ROOT_USER="${MONGO_ROOT_USER:-root}"
CONTROLLER_USER="${MONGO_CONTROLLER_USER:-platform_controller}"
REPLICA_SET="${MONGO_REPLICA_SET:-rs0}"

[ -r "$ROOT_PASSWORD_FILE" ] || { echo "Missing MongoDB root password file" >&2; exit 1; }
[ -r "$CONTROLLER_PASSWORD_FILE" ] || { echo "Missing MongoDB controller password file" >&2; exit 1; }

ROOT_PASSWORD="$(cat "$ROOT_PASSWORD_FILE")"
CONTROLLER_PASSWORD="$(cat "$CONTROLLER_PASSWORD_FILE")"

[ -n "$ROOT_PASSWORD" ] || { echo "MongoDB root password is empty" >&2; exit 1; }
[ -n "$CONTROLLER_PASSWORD" ] || { echo "MongoDB controller password is empty" >&2; exit 1; }

case "$CONTROLLER_USER" in
  *[!a-zA-Z0-9_]*|'') echo "Invalid MongoDB controller username" >&2; exit 1 ;;
esac

ROOT_URI="mongodb://${ROOT_USER}:${ROOT_PASSWORD}@${MONGO_HOST}:27017/admin?authSource=admin&directConnection=true"

until mongosh "$ROOT_URI" --quiet --eval "quit(db.adminCommand('ping').ok ? 0 : 2)" >/dev/null 2>&1; do
  sleep 2
done

mongosh "$ROOT_URI" --quiet --eval "
try {
  const s = rs.status();
  if (!s.ok) throw new Error('replica not ready');
} catch (e) {
  rs.initiate({_id: '${REPLICA_SET}', members: [{_id: 0, host: '${MONGO_HOST}:27017'}]});
}
"

until mongosh "$ROOT_URI" --quiet --eval "quit(db.hello().isWritablePrimary ? 0 : 2)" >/dev/null 2>&1; do
  sleep 2
done

mongosh "$ROOT_URI" --quiet --eval "
const adminDb = db.getSiblingDB('admin');
const existing = adminDb.getUser('${CONTROLLER_USER}');
const roles = [
  {role: 'userAdminAnyDatabase', db: 'admin'},
  {role: 'dbAdminAnyDatabase', db: 'admin'},
  {role: 'readWriteAnyDatabase', db: 'admin'},
  {role: 'clusterMonitor', db: 'admin'}
];
if (existing) {
  adminDb.updateUser('${CONTROLLER_USER}', {pwd: '${CONTROLLER_PASSWORD}', roles});
} else {
  adminDb.createUser({user: '${CONTROLLER_USER}', pwd: '${CONTROLLER_PASSWORD}', roles});
}
"

unset ROOT_PASSWORD CONTROLLER_PASSWORD ROOT_URI

echo "MongoDB replica set and controller account are ready"
