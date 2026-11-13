# User data for an overflow machine (NODE.md): replace REV with a commit, GATE with your biscotti host's Tailscale name
# (e.g. biscotti.tail1234.ts.net). No secrets here.
{ ... }:
{
  imports = [ (import "${builtins.fetchTarball "https://github.com/lucasgelfond/biscotti/archive/REV.tar.gz"}/installer/aws/node.nix" { gate = "GATE"; slots = 4; }) ];
}
