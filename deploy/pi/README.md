# Raspberry Pi bootstrap

1. Flash **Ubuntu Server 24.04 LTS (64-bit)** with Raspberry Pi Imager (Use custom → the `.img.xz`; skip OS customisation).
   Ubuntu rather than Raspberry Pi OS because gVisor needs a 48-bit VA kernel.
2. Re-insert the card. Copy `network-config.example` to `network-config` and fill in Wi-Fi.
3. Copy `user-data` and `network-config` onto the `system-boot` volume, replacing the existing ones.
4. Boot (~5 min). `ssh lucas@biscotti.local`, then run `deploy/install.sh`; it prints a Tailscale login link.
5. In the Tailscale admin, disable key expiry for `biscotti`.
