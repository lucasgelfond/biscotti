# The biscotti host, shared by every target (Pi 5, VM, AWS).
{ pkgs, self, version, nixpkgs-tailscale, ... }:
let
  inherit (import ./firecracker.nix { inherit pkgs self; }) firecracker faultAll;
  # The repo, as built into the image; setup and the services run from here.
  repo = "${self}";
in
{
  imports = [ ./net.nix ./setup.nix ./update.nix ];
  _module.args = { inherit repo firecracker faultAll; };

  networking.hostName = "biscotti";
  system.nixos.label = "biscotti-v${version}";
  time.timeZone = "UTC";

  # A generic user: each installer provides their own SSH key (see the target files).
  users.users.biscotti = {
    isNormalUser = true;
    extraGroups = [ "wheel" "kvm" "docker" ];
  };
  security.sudo.wheelNeedsPassword = false;
  services.openssh = {
    enable = true;
    settings.PasswordAuthentication = false;
  };

  services.tailscale.enable = true;
  # 1.104.2 (TS-2026-013), until 26.05 has it (flake.nix).
  services.tailscale.package = nixpkgs-tailscale.legacyPackages.${pkgs.stdenv.hostPlatform.system}.tailscale;
  # A DNS cache: Node looks a name up on every request, and over the Pi's Wi-Fi a lookup can take seconds.
  services.resolved.enable = true;
  services.chrony.enable = true;
  virtualisation.docker.enable = true;
  environment.systemPackages = [ firecracker pkgs.git pkgs.jq pkgs.iw ];
  # Firecracker restoring a huge-page snapshot (the Mac) opens /dev/userfaultfd; it runs as a slot's user in group kvm.
  services.udev.extraRules = ''
    KERNEL=="userfaultfd", GROUP="kvm", MODE="0660"
  '';
  networking.firewall.trustedInterfaces = [ "tailscale0" ];
  # Docker's and the VM slots' links have fixed addresses; dhcpcd segfaults on them as they come and go, taking Wi-Fi
  # down with it.
  networking.dhcpcd.denyInterfaces = [ "veth*" "docker*" "br-*" "tailscale*" ];

  nix.settings.experimental-features = [ "nix-command" "flakes" ];
  system.stateVersion = "26.05";
}
