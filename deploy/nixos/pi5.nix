# Raspberry Pi 5 SD image (4K pages; the 16K-page kernel breaks too much software).
{ nixos-raspberrypi, ... }:
{
  imports = with nixos-raspberrypi.nixosModules; [
    raspberry-pi-5.base
    sd-image
  ];

  boot.loader.raspberry-pi.bootloader = "kernel";

  # Nothing personal lives in the image: SSH keys and Wi-Fi credentials are read from the boot
  # partition, so anyone can drop their own `authorized_keys` and `wpa_supplicant.conf` there.
  services.openssh.authorizedKeysFiles = [ "/boot/firmware/authorized_keys" ];

  networking.wireless = {
    enable = true;
    allowAuxiliaryImperativeNetworks = true;
  };
  systemd.tmpfiles.rules = [ "L+ /etc/wpa_supplicant.conf - - - - /boot/firmware/wpa_supplicant.conf" ];

  # Set the Wi-Fi regulatory domain before connecting, so DFS 5 GHz channels work on a cold boot.
  hardware.wirelessRegulatoryDatabase = true;
  boot.extraModprobeConfig = "options cfg80211 ieee80211_regdom=US";
}
