#!/bin/bash
# Sets up this Mac for biscotti's mac_desktop: noVNC and websockify on the tailnet, in front of macOS Screen Sharing.
# Safe to run again.
set -euo pipefail

LABEL=online.lucasgelfond.mac-vnc
HOME_DIR="$HOME/Library/Application Support/biscotti-mac-vnc"
NOVNC_VERSION=1.7.0
NOVNC_SHA256=b1003a11b6e6e8d8f7f5e5586daae7f8ca651d8aee0aa155ff9ac841c48f52c6
WEBSOCKIFY_VERSION=0.13.0
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TS=$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)

[ -x "$TS" ] || { echo "Install Tailscale and join the tailnet first: https://tailscale.com/download/mac" >&2; exit 1; }
TS_IP=$("$TS" ip -4) || { echo "Tailscale isn't connected; sign in and run this again." >&2; exit 1; }
mkdir -p "$HOME_DIR"

# websockify, in a venv of its own (Homebrew's Python refuses pip --user).
if ! "$HOME_DIR/venv/bin/websockify" --help >/dev/null 2>&1; then
  python3 -m venv "$HOME_DIR/venv"
  "$HOME_DIR/venv/bin/pip" install -q --disable-pip-version-check "websockify==$WEBSOCKIFY_VERSION"
fi

# noVNC, a pinned release.
NOVNC="$HOME_DIR/noVNC-$NOVNC_VERSION"
if [ ! -f "$NOVNC/vnc.html" ]; then
  curl -fsSL -o "$HOME_DIR/novnc.tgz" "https://github.com/novnc/noVNC/archive/refs/tags/v$NOVNC_VERSION.tar.gz"
  echo "$NOVNC_SHA256  $HOME_DIR/novnc.tgz" | shasum -a 256 -c - >/dev/null
  tar xzf "$HOME_DIR/novnc.tgz" -C "$HOME_DIR"
  rm "$HOME_DIR/novnc.tgz"
fi

# websockify on the tailnet address only (nothing on the LAN or the internet), to Screen Sharing on localhost:5900.
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME_DIR/venv/bin/websockify</string>
    <string>--web</string><string>$NOVNC</string>
    <string>$TS_IP:6080</string>
    <string>localhost:5900</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>$HOME_DIR/websockify.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout returns before the old job is gone.
while launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; do sleep 0.2; done
launchctl bootstrap "gui/$(id -u)" "$PLIST"

cat <<EOF

Done: websockify is serving noVNC on $TS_IP:6080 (launchd job $LABEL).

Enable by hand, in System Settings:
  1. General > Sharing > Screen Sharing (or Remote Management): on.
  2. Privacy & Security > Screen Recording, and > Accessibility: allow screensharingd if it's listed.

To keep the Mac reachable, consider:
  sudo pmset -a sleep 0 disksleep 0 womp 1
  caffeinate -dimsu   # while you need it, instead

Set on biscotti: MAC_VNC_HOST=$("$TS" status --json | python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
EOF
