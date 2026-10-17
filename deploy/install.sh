#!/bin/bash
# Host setup after first boot. Same script on any Linux target (Pi, Hetzner, generic x86/arm64).
set -euo pipefail

command -v docker >/dev/null || curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"

if ! tailscale status >/dev/null 2>&1; then
  command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
  sudo tailscale up --hostname=biscotti
fi
