#!/usr/bin/env bash
set -euo pipefail

POSTGRES_PORT="${POSTGRES_PUBLIC_PORT:-5432}"
REDIS_TLS_PORT="${REDIS_PUBLIC_PORT:-6380}"
EXT_IF="${EXT_IF:-$(ip route show default | awk '{print $5; exit}')}"

if [[ -z "${EXT_IF}" ]]; then
  echo "Unable to determine external interface" >&2
  exit 1
fi

if ! iptables -nL DOCKER-USER >/dev/null 2>&1; then
  echo "DOCKER-USER chain is unavailable. This policy requires Docker's iptables firewall backend." >&2
  exit 1
fi

ensure_rule() {
  local position="$1"
  shift
  if ! iptables -C DOCKER-USER "$@" 2>/dev/null; then
    iptables -I DOCKER-USER "${position}" "$@"
  fi
}

ensure_rule 1 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
ensure_rule 2 -i "${EXT_IF}" -p tcp -m conntrack --ctorigdstport "${POSTGRES_PORT}" -j ACCEPT
ensure_rule 3 -i "${EXT_IF}" -p tcp -m conntrack --ctorigdstport "${REDIS_TLS_PORT}" -j ACCEPT

if ! iptables -C DOCKER-USER -i "${EXT_IF}" -m conntrack --ctstate NEW -j DROP 2>/dev/null; then
  iptables -A DOCKER-USER -i "${EXT_IF}" -m conntrack --ctstate NEW -j DROP
fi

echo "Docker firewall active on ${EXT_IF}: PostgreSQL ${POSTGRES_PORT}/tcp and Redis TLS ${REDIS_TLS_PORT}/tcp allowed; other new external Docker-forwarded connections dropped."
iptables -nL DOCKER-USER --line-numbers
