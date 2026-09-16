#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this bootstrap once with sudo/root: sudo ./bootstrap.sh" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  . /etc/os-release
  if [[ "${ID:-}" != "ubuntu" && "${ID:-}" != "debian" ]]; then
    echo "Automatic Docker installation supports Ubuntu/Debian only." >&2
    exit 1
  fi

  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  arch="$(dpkg --print-architecture)"
  . /etc/os-release
  echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi

docker compose version >/dev/null

mkdir -p /srv/vsm

if [[ ! -f .env && -f .env.example ]]; then
  cp .env.example .env
  chmod 600 .env
  echo "Created .env from .env.example."
fi

echo
echo "Before certificate issuance, all configured A records must point to this VPS."
echo "Provider firewall must allow TCP: 22, 80, 443, 5432, 6380, 3306, 27017."
echo

docker compose config >/dev/null
docker compose up -d --build

echo
echo "VSM deployment started."
echo "Initial admin password will be stored at: /srv/vsm/bootstrap/admin_initial_password"
echo "Check status with: docker compose ps"
echo "Check smoke test with: docker compose logs vsm-smoke"
