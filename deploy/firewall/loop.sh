#!/bin/sh
set -eu

POSTGRES_PORT="${POSTGRES_PUBLIC_PORT:-5432}"
REDIS_PORT="${REDIS_PUBLIC_PORT:-6380}"
MYSQL_PORT="${MYSQL_PUBLIC_PORT:-3306}"
MONGO_PORT="${MONGO_PUBLIC_PORT:-27017}"
HTTP_PORT="${HTTP_PORT:-80}"
HTTPS_PORT="${HTTPS_PORT:-443}"

while ! iptables -nL DOCKER-USER >/dev/null 2>&1; do
  echo "Waiting for Docker DOCKER-USER chain..."
  sleep 2
done

EXT_IF="${EXT_IF:-$(ip route show default | awk '{print $5; exit}')}"

ensure_rule() {
  position="$1"
  shift
  if ! iptables -C DOCKER-USER "$@" 2>/dev/null; then
    iptables -I DOCKER-USER "$position" "$@"
  fi
}

apply_policy() {
  ensure_rule 1 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  ensure_rule 2 -i "$EXT_IF" -p tcp -m conntrack --ctorigdstport "$HTTP_PORT" -j ACCEPT
  ensure_rule 3 -i "$EXT_IF" -p tcp -m conntrack --ctorigdstport "$HTTPS_PORT" -j ACCEPT
  ensure_rule 4 -i "$EXT_IF" -p tcp -m conntrack --ctorigdstport "$POSTGRES_PORT" -j ACCEPT
  ensure_rule 5 -i "$EXT_IF" -p tcp -m conntrack --ctorigdstport "$REDIS_PORT" -j ACCEPT
  ensure_rule 6 -i "$EXT_IF" -p tcp -m conntrack --ctorigdstport "$MYSQL_PORT" -j ACCEPT
  ensure_rule 7 -i "$EXT_IF" -p tcp -m conntrack --ctorigdstport "$MONGO_PORT" -j ACCEPT

  if ! iptables -C DOCKER-USER -i "$EXT_IF" -m conntrack --ctstate NEW -j DROP 2>/dev/null; then
    iptables -A DOCKER-USER -i "$EXT_IF" -m conntrack --ctstate NEW -j DROP
  fi
}

while :; do
  apply_policy
  sleep 30
done
