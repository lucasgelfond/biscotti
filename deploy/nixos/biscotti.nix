# The biscotti host, shared by every target (Pi 5, VM, later Hetzner).
{ pkgs, self, ... }:
let
  # Firecracker with the GICv2 snapshot-restore fixes (lucasgelfond/firecracker@biscotti-gicv2, upstream #6300 and
  # #6301), which the Pi 5's interrupt controller needs.
  firecracker = pkgs.firecracker.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ [
      (pkgs.fetchpatch {
        url = "https://github.com/lucasgelfond/firecracker/compare/e786ba84fd5e0db878392a6a1f234e1b17fcaeb2...4f39c49fbe249592ccfb9ab20f29850ca1a66df7.diff";
        excludes = [ "CHANGELOG.md" ];
        hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      })
    ];
  });
  # The repo, as built into the image; setup and the services run from here.
  repo = "${self}";
in
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
  environment.systemPackages = [ firecracker pkgs.git pkgs.jq ];
  networking.firewall.trustedInterfaces = [ "tailscale0" ];

  # The task VMs' network: the biscotti0 bridge, the VM's tap, NAT, and rules that keep VMs off everything local.
  systemd.services.biscotti-sandbox-net = {
    after = [ "docker.service" ];
    requires = [ "docker.service" ];
    wantedBy = [ "multi-user.target" ];
    path = with pkgs; [ iproute2 iptables procps ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${pkgs.bash}/bin/bash ${repo}/deploy/sandbox-net.sh";
    };
  };

  # First boot (and every boot after, as a no-op check): settings, Tailscale, the services and the VM snapshot.
  systemd.services.biscotti-setup = {
    after = [ "network-online.target" "docker.service" "tailscaled.service" "biscotti-sandbox-net.service" ];
    wants = [ "network-online.target" ];
    requires = [ "docker.service" "biscotti-sandbox-net.service" ];
    wantedBy = [ "multi-user.target" ];
    path = [ firecracker ] ++ (with pkgs; [ bash coreutils gnugrep gnused jq curl docker tailscale e2fsprogs gnutar util-linux ]);
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${pkgs.bash}/bin/bash ${repo}/deploy/setup.sh";
      TimeoutStartSec = "2h";
    };
  };

  nix.settings.experimental-features = [ "nix-command" "flakes" ];
  system.stateVersion = "26.05";
}
