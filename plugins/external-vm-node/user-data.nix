# User data for an external VM node (setup.sh fills in REV, a commit, and GATE, the biscotti host's Tailscale name).
# No secrets here.
{ ... }:
{
  imports = [ (import "${builtins.fetchTarball "https://github.com/lucasgelfond/biscotti/archive/REV.tar.gz"}/plugins/external-vm-node/node.nix" { gate = "GATE"; }) ];
}
