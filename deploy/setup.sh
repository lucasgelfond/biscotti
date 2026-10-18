#!/bin/bash
# Bring biscotti up, or bring it up to date (safe to re-run): the installer's settings, generated secrets, Tailscale,
# the services and the task VM snapshot. Texts the owner when they need to act and when biscotti is ready.
# NixOS runs it as biscotti-setup.service; deploy/install.sh runs it on Ubuntu.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
STATE=/var/lib/biscotti
ENV=$STATE/.env
mkdir -p "$STATE" && touch "$ENV" && chmod 600 "$ENV"

get() { sed -n "s/^$1=//p" "$ENV"; }
set_default() { [ -n "$(get "$1")" ] || echo "$1=$2" >> "$ENV"; }
secret() { set_default "$1" "$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"; }

# The installer app writes its settings to the boot partition, which anyone with the card can read: move them off.
if [ -f /boot/firmware/biscotti.env ]; then
  grep -E '^[A-Z_]+=' /boot/firmware/biscotti.env | while IFS='=' read -r key value; do set_default "$key" "$value"; done
  rm /boot/firmware/biscotti.env
fi
secret VAULT_PASSWORD
secret EXECUTOR_ADMIN_PASSWORD
set_default FIRECRACKER_BIN "$(readlink -f "$(command -v firecracker)")"

docker build -q -t biscotti/agent "$REPO/agent" >/dev/null
notify() { docker run --rm --network host --env-file "$ENV" biscotti/agent node src/notify.ts "$1" || true; }

# Tailscale: with an auth key from the installer, join directly; otherwise text the owner the login link.
if ! tailscale status >/dev/null 2>&1; then
  if [ -n "$(get TS_AUTHKEY)" ]; then
    tailscale up --hostname=biscotti --auth-key="$(get TS_AUTHKEY)"
  else
    tailscale up --hostname=biscotti > "$STATE/tailscale-up.log" 2>&1 &
    until url=$(grep -o 'https://login.tailscale.com/[^ ]*' "$STATE/tailscale-up.log"); do sleep 1; done
    notify "Hi, it's biscotti! To finish setting me up, open this link and add me to your Tailscale: $url"
    until tailscale status >/dev/null 2>&1; do sleep 5; done
  fi
fi
set_default TAILNET_HOST "$(tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")')"
tailscale serve --bg --https=8443 http://127.0.0.1:4788
tailscale serve --bg --https=9443 http://127.0.0.1:8081
for n in 1 2 3; do tailscale serve --bg --https=$((10440 + n)) "http://10.200.$n.2:6901"; done
tailscale serve --bg --https=8445 http://127.0.0.1:8082

# On NixOS, binaries mounted into containers (Firecracker) need the Nix store.
compose=(docker compose --env-file "$ENV" -f "$REPO/deploy/compose.yaml")
[ -e /etc/NIXOS ] && compose+=(-f "$REPO/deploy/compose.nixos.yaml")
"${compose[@]}" up -d --build

[ -f "$STATE/vm/desktop.snap" ] || FC_BIN="$(get FIRECRACKER_BIN)" "$REPO/cua-vm/snapshots.sh" "$STATE/vm"

if [ ! -f "$STATE/ready" ]; then
  notify "I'm all set up. Text me anything!"
  touch "$STATE/ready"
fi
