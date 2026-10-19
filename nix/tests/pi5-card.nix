# The Pi's first boot without the Pi: its card config (pi5-card.nix) and setup in a VM, with a card holding what the
# installer app writes and simulated Wi-Fi (mac80211_hwsim), one radio the access point, the other the Pi's.
# Run: nix build .#checks.aarch64-linux.pi5-card
{ specialArgs }:
{ pkgs, lib, ... }:
let
  ssid = "Taylor Wongstein";
  password = "test-password";
  card = pkgs.runCommand "card.img" { nativeBuildInputs = [ pkgs.dosfstools pkgs.mtools ]; } ''
    truncate -s 64M $out
    mkfs.vfat -n FIRMWARE $out
    cat > wpa_supplicant.conf <<'EOF'
    ctrl_interface=/run/wpa_supplicant
    update_config=1
    country=US
    network={
      ssid="${ssid}"
      psk="${password}"
    }
    EOF
    echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey test" > authorized_keys
    printf 'OWNER=+15555550100\nLLM_API_KEY=test\nSPECTRUM_PROJECT_ID=test\nSPECTRUM_PROJECT_SECRET=test\nTS_HOSTNAME=biscotti-test\n' > biscotti.env
    echo '{"plugins":["channels/spectrum"]}' > biscotti.json
    mcopy -i $out wpa_supplicant.conf authorized_keys biscotti.env biscotti.json ::
  '';
in
{
  name = "pi5-card";
  node.specialArgs = specialArgs;

  nodes.pi = {
    imports = [ ../biscotti.nix ../pi5-card.nix ];
    virtualisation.memorySize = 3072;
    virtualisation.cores = 4;
    virtualisation.diskSize = 8192;
    # The card, as the sd-image module mounts it; snapshot=on keeps the store copy unchanged while the guest writes.
    virtualisation.qemu.options = [ "-drive file=${card},format=raw,if=virtio,snapshot=on" ];
    virtualisation.fileSystems."/boot/firmware" = {
      device = "/dev/disk/by-label/FIRMWARE";
      fsType = "vfat";
      options = [ "noatime" "noauto" "x-systemd.automount" "x-systemd.idle-timeout=1min" ];
    };

    boot.kernelModules = [ "mac80211_hwsim" ];
    boot.extraModprobeConfig = "options mac80211_hwsim radios=2";
    # The test framework turns Wi-Fi off in VMs.
    networking.wireless.enable = lib.mkOverride 9 true;
    # wlan1 is the access point's, so the Pi's supplicant only takes wlan0 (a unit per interface here).
    networking.wireless.interfaces = [ "wlan0" ];
    systemd.services.wpa_supplicant-wlan0 = {
      after = [ "biscotti-wifi.service" ];
      requires = [ "biscotti-wifi.service" ];
    };
    environment.systemPackages = [ pkgs.iw ];
    services.hostapd = {
      enable = true;
      radios.wlan1 = {
        band = "2g";
        channel = 6;
        countryCode = "US";
        networks.wlan1 = {
          inherit ssid;
          authentication = {
            mode = "wpa2-sha1";
            wpaPassword = password;
          };
        };
      };
    };
    networking.interfaces.wlan1.ipv4.addresses = [ { address = "192.168.77.1"; prefixLength = 24; } ];
    services.dnsmasq = {
      enable = true;
      settings = {
        interface = "wlan1";
        bind-dynamic = true;
        port = 0;
        dhcp-range = "192.168.77.10,192.168.77.50";
      };
    };
    networking.firewall.interfaces.wlan1.allowedUDPPorts = [ 67 ];
    systemd.services.dnsmasq.after = [ "hostapd.service" ];
  };

  testScript = ''
    pi.start()
    pi.wait_until_succeeds("iw dev wlan0 link | grep -q 'SSID: ${ssid}'", timeout=180)
    pi.wait_until_succeeds("ip -4 addr show wlan0 | grep -q 'inet 192.168.77.'", timeout=120)
    pi.succeed("cmp /boot/firmware/wpa_supplicant.conf /etc/wpa_supplicant/imperative.conf")

    # Setup moves the installer's settings off the card.
    pi.wait_until_succeeds("grep -q '^OWNER=+15555550100' /var/lib/biscotti/.env", timeout=180)
    pi.wait_until_succeeds("grep -q '^DB_KEY=' /var/lib/biscotti/.env", timeout=60)
    pi.fail("test -e /boot/firmware/biscotti.env")
    pi.succeed("test -f /var/lib/biscotti/biscotti.json")
    pi.succeed("test -s /boot/firmware/authorized_keys")

    pi.succeed("systemctl start biscotti-status")
    status = pi.succeed("cat /boot/firmware/biscotti-status.txt")
    print(status)
    assert "SSID: ${ssid}" in status, "the status file should show Wi-Fi connected"
    pi.fail("grep -q -e LLM_API_KEY -e SPECTRUM_PROJECT_SECRET /boot/firmware/biscotti-status.txt")
  '';
}
