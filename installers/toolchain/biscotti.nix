# The biscotti host, shared by every target (Pi 5, VM, AWS).
{ pkgs, self, version, ... }:
let
  # On ARM, Firecracker with the GICv2 snapshot-restore fixes (lucasgelfond/firecracker@biscotti-gicv2, upstream
  # #6300 and #6301), which the Pi 5's interrupt controller needs. Stock on x86.
  firecracker = if !pkgs.stdenv.hostPlatform.isAarch64 then pkgs.firecracker else pkgs.firecracker.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ [
      (pkgs.fetchpatch {
        url = "https://github.com/lucasgelfond/firecracker/compare/e786ba84fd5e0db878392a6a1f234e1b17fcaeb2...4f39c49fbe249592ccfb9ab20f29850ca1a66df7.diff";
        excludes = [ "CHANGELOG.md" ];
        hash = "sha256-1MLhwa9oqDYIxn/j3tdHcGBVKVBr9W03ncVVFzUXLvM=";
      })
    ];
  });
  # Loads a huge-page snapshot into a restored VM (core/src/tasks.ts).
  faultAll = pkgs.runCommandCC "fault-all" { } "mkdir -p $out/bin && $CC -O2 -o $out/bin/fault-all ${self}/core/vm/uffd/fault-all.c";
  # The repo, as built into the image; setup and the services run from here.
  repo = "${self}";
in
{
  imports = [ ./net.nix ./setup.nix ];
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
  services.chrony.enable = true;
  virtualisation.docker.enable = true;
  environment.systemPackages = [ firecracker pkgs.git pkgs.jq ];
  networking.firewall.trustedInterfaces = [ "tailscale0" ];

  nix.settings.experimental-features = [ "nix-command" "flakes" ];
  system.stateVersion = "26.05";
}
