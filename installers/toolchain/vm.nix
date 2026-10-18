# Local test target: `nixos-rebuild build-vm --flake .#vm`, SSH on localhost:2222.
{ lib, ... }:
{
  # Local-only test VM (forwarded to localhost): password login instead of an installer's key.
  users.users.biscotti.password = "biscotti";
  services.openssh.settings.PasswordAuthentication = lib.mkForce true;

  virtualisation.vmVariant.virtualisation = {
    memorySize = 2048;
    cores = 2;
    graphics = false;
    forwardPorts = [ { from = "host"; host.port = 2222; guest.port = 22; } ];
  };
}
