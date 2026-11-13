# An overflow machine's configuration without flakes, for the NixOS AMI's user data (see NODE.md), like default.nix.
# Set `gate` to the biscotti host's Tailscale name; `vms` sizes its slots (2.5 GB each: 4 on an m8i.xlarge).
{ gate, slots ? 4, memMiB ? 2560, workGiB ? 20 }:
{
  imports = [ ../../nix/aws.nix ../../nix/node.nix ];
  _module.args = {
    self = ../..;
    vms = { inherit slots memMiB workGiB; };
    node = { inherit gate; };
  };
}
