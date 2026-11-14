# An external VM node's configuration without flakes, for the NixOS AMI's user data (user-data.nix), like
# installer/aws/default.nix. `gate`: the biscotti host's Tailscale name. One VM of 2.5 GB, on an m8i.large.
{ gate, memMiB ? 2560, workGiB ? 20 }:
{
  imports = [ ../../nix/aws.nix ../../nix/node.nix ];
  _module.args = {
    self = ../..;
    vms = { slots = 1; inherit memMiB workGiB; };
    node = { inherit gate; };
  };
}
