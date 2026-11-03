# mac-vnc

Your home Mac's desktop in the browser, when you ask biscotti for it: `mac_desktop` texts a link that opens a live
VNC session (noVNC), good for two hours.

## Setup

1. On the Mac, install [Tailscale](https://tailscale.com/download/mac) and join the same tailnet as biscotti.
2. Run `plugins/mac-vnc/mac/install.sh` on the Mac and turn on what it prints (Screen Sharing; Screen Recording and
   Accessibility).
3. In biscotti's `.env`, set `MAC_VNC_HOST` to the hostname the script printed, and add `mac-vnc` to `biscotti.json`.

Then ask biscotti for your Mac. Without biscotti, open the noVNC link `install.sh` prints from any device on the
tailnet (it has to be the HTTPS one: noVNC can't log in to Screen Sharing from a plain-HTTP page).

## Why this is safe

- VNC never leaves the tailnet. The session page is `https://<biscotti>:9443/mac/<id>` (tailscale serve, not Funnel),
  and the Mac's websockify listens only on localhost, reachable from the tailnet through `tailscale serve`.
- Each link has a random 24-hex id and expires after two hours. Anything else is a 404.
- The Mac opens no public port. macOS Screen Sharing still asks for your Mac's login.
- biscotti proxies only to `MAC_VNC_HOST`.

## Troubleshooting

- **Black screen**: Screen Recording permission is missing for Screen Sharing; allow it and reconnect.
- **Failed to connect**: the launchd job is dead. Check `launchctl print gui/$(id -u)/online.lucasgelfond.mac-vnc` and
  `~/Library/Application Support/biscotti-mac-vnc/websockify.log`, or run `install.sh` again.
- **Pointer offset**: the page asks for `resize=remote`; if it still drifts, reload so the Mac matches the window.
- **Can't reach it after a while**: the Mac slept. See the `pmset` and `caffeinate` lines `install.sh` prints.
