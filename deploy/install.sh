#!/bin/bash
# Host setup on a Debian/Ubuntu machine (the NixOS image does all of this declaratively).
# Run from the repo: deploy/install.sh. Needs deploy/.env (see .env.example).
set -euo pipefail
cd "$(dirname "$0")"

command -v docker >/dev/null || curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker,kvm "$USER"

if ! tailscale status >/dev/null 2>&1; then
  command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
  sudo tailscale up --hostname=biscotti
fi

sudo install -D -m 755 sandbox-net.sh /opt/biscotti/sandbox-net.sh
sudo install -m 644 sandbox-net.service /etc/systemd/system/sandbox-net.service
sudo systemctl daemon-reload
sudo systemctl enable --now sandbox-net

secret() { grep -q "^$1=." .env || echo "$1=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')" >> .env; }
secret VAULT_PASSWORD
secret EXECUTOR_ADMIN_PASSWORD
sudo docker compose up -d
sudo tailscale serve --bg --https=8443 http://127.0.0.1:4788
sudo tailscale serve --bg --https=9443 http://127.0.0.1:8081
