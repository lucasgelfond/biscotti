# Local test target: `nixos-rebuild build-vm --flake .#vm`, SSH on localhost:2222.
{ ... }:
{
  virtualisation.vmVariant.virtualisation = {
    memorySize = 2048;
    cores = 2;
    graphics = false;
    forwardPorts = [ { from = "host"; host.port = 2222; guest.port = 22; } ];
  };
}
