# Raspberry Pi bootstrap

1. Flash **Ubuntu Server 24.04 LTS (64-bit)** with Raspberry Pi Imager (Use custom → the `.img.xz`; skip OS
   customisation). Ubuntu rather than Raspberry Pi OS because gVisor needs a 48-bit VA kernel.
2. **Before the card ever goes into the Pi**, re-insert it in the Mac and copy `user-data` and `network-config` onto
   the `system-boot` volume, replacing the ones there. (Copy `network-config.example` to `network-config` and fill in
   Wi-Fi first.)
3. Boot (~5 min). `ssh lucas@biscotti.local`, then run `deploy/install.sh`; it prints a Tailscale login link.
4. In the Tailscale admin, disable key expiry for `biscotti` (remove any stale `biscotti` first to keep the name).

## Card checklist: get it right in one trip

- **Cold-boot Wi-Fi must be 2.4 GHz (or a non-DFS 5 GHz channel).** A fresh Pi 5 starts with regulatory domain `00`
  and can't join a DFS 5 GHz channel (52–144) until an AP's country IE sets it. Switch to 5 GHz over SSH afterwards.
- **SSIDs must match exactly**, e.g. `Name-5G` versus `Name 5G`.
- **cloud-init runs once per instance.** If the card has already booted, change `instance_id` in `meta-data`, or the
  new `user-data` / `network-config` is ignored.
- **Make failures diagnosable:** have `user-data` write network state (`ip -br addr`, `wpa_cli status`, netplan files,
  `netplan-wpa*` logs) to `/boot/firmware/`, which the Mac can read.
- Validate the YAML before ejecting.
