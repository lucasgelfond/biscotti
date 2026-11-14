# The `aws` configuration without flakes, for the NixOS AMI's user data (see README.md): amazon-init writes the
# user data to /etc/nixos/configuration.nix and switches to it on first boot. The arguments are the flake's.
let
  tailscale = (builtins.fromJSON (builtins.readFile ../../flake.lock)).nodes.nixpkgs-tailscale.locked;
  nixpkgs-tailscale = builtins.fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/${tailscale.rev}.tar.gz";
    sha256 = tailscale.narHash;
  };
in
{
  imports = [ ../../nix/aws.nix ../../nix/biscotti.nix ];
  _module.args = {
    self = ../..;
    version = (builtins.fromJSON (builtins.readFile ../../package.json)).version;
    target = "aws";
    vms = import ../../nix/vms.nix;
    nixpkgs-tailscale.legacyPackages.x86_64-linux = import nixpkgs-tailscale { system = "x86_64-linux"; };
  };
}
