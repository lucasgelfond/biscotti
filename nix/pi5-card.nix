# What the Pi reads from its card's boot partition (FAT, readable on any computer): the SSH key and Wi-Fi the
# installer app writes, and a status file it writes back, so a Pi that never comes online can be diagnosed from the
# card. Nothing personal lives in the image. Hardware-free, so the first-boot test (tests/pi5-card.nix) runs it too.
{ pkgs, ... }:
{
  # The installer's SSH key, moved off the card at boot (anyone who borrows the card could add their own there), into a
  # file only root can change. A key put on the card later is added to it.
  services.openssh.authorizedKeysFiles = [ "/var/lib/biscotti-ssh/authorized_keys" ];
  systemd.services.biscotti-ssh-keys = {
    description = "SSH key from the boot partition";
    before = [ "sshd.service" ];
    wantedBy = [ "multi-user.target" ];
    unitConfig.RequiresMountsFor = "/boot/firmware";
    serviceConfig.Type = "oneshot";
    script = ''
      [ -f /boot/firmware/authorized_keys ] || exit 0
      install -d -m 755 /var/lib/biscotti-ssh
      keys=/var/lib/biscotti-ssh/authorized_keys
      cat "$keys" /boot/firmware/authorized_keys 2>/dev/null | grep -v '^\s*$' | sort -u > "$keys.new"
      chmod 644 "$keys.new"
      mv "$keys.new" "$keys"
      rm /boot/firmware/authorized_keys
    '';
  };

  # wpa_supplicant reads /etc/wpa_supplicant/imperative.conf and re-owns it before starting, which a link to the FAT
  # partition can't take: copy the card's file in on every boot, so editing it on the card changes the network.
  networking.wireless = {
    enable = true;
    allowAuxiliaryImperativeNetworks = true;
  };
  systemd.services.biscotti-wifi = {
    description = "Wi-Fi from the boot partition";
    before = [ "wpa_supplicant.service" ];
    requiredBy = [ "wpa_supplicant.service" ];
    unitConfig.RequiresMountsFor = "/boot/firmware";
    serviceConfig.Type = "oneshot";
    script = ''
      [ -f /boot/firmware/wpa_supplicant.conf ] || exit 0
      install -D -m 664 -o wpa_supplicant -g wpa_supplicant /boot/firmware/wpa_supplicant.conf /etc/wpa_supplicant/imperative.conf
    '';
  };

  # Set the Wi-Fi regulatory domain before connecting, so DFS 5 GHz channels work on a cold boot.
  hardware.wirelessRegulatoryDatabase = true;
  boot.extraModprobeConfig = "options cfg80211 ieee80211_regdom=US";

  # No secrets in it: the card is readable by anyone holding it.
  systemd.services.biscotti-status = {
    description = "Write biscotti's status to the boot partition";
    unitConfig.RequiresMountsFor = "/boot/firmware";
    path = with pkgs; [ coreutils iproute2 iw systemd tailscale gnused ];
    serviceConfig.Type = "oneshot";
    # Every section runs, whatever fails.
    script = ''
      set +e
      {
        echo "biscotti status, $(date -u)"; echo
        echo "== network"; ip -br addr; ip route; echo
        echo "== wi-fi"; iw dev wlan0 link; echo
        echo "== tailscale"; tailscale status 2>&1 | head -5; echo
        echo "== failed units"; systemctl --failed --no-legend; echo
        echo "== setup"; systemctl is-active biscotti-setup; journalctl -b -u biscotti-setup -n 40 --no-pager -o short-monotonic | sed -E 's#https://login.tailscale.com/[^ ]*#<login link>#'
        echo; echo "== wi-fi log"; journalctl -b -u wpa_supplicant -u biscotti-wifi -n 25 --no-pager -o short-monotonic
      } > /boot/firmware/biscotti-status.txt 2>&1
    '';
  };
  systemd.timers.biscotti-status = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "90s";
      OnUnitActiveSec = "3min";
    };
  };
}
