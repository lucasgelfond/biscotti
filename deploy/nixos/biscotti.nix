# The biscotti host, shared by every target (Pi 5, VM, later Hetzner).
{ pkgs, ... }:
{
  networking.hostName = "biscotti";
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
  services.chrony.enable = true;
  virtualisation.docker.enable = true;
  environment.systemPackages = [ pkgs.firecracker pkgs.git ];

  # Sandbox VMs attach their taps to this bridge; they reach the internet but nothing local.
  networking.bridges.biscotti0.interfaces = [ ];
  networking.interfaces.biscotti0.ipv4.addresses = [ { address = "172.16.0.1"; prefixLength = 24; } ];
  networking.nat = {
    enable = true;
    internalInterfaces = [ "biscotti0" ];
  };
  networking.firewall.trustedInterfaces = [ "tailscale0" ];

  nix.settings.experimental-features = [ "nix-command" "flakes" ];
  system.stateVersion = "26.05";
}
