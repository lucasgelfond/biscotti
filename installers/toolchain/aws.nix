# An EC2 instance with nested virtualization. SSH is root with the instance's key pair.
{ modulesPath, ... }:
{
  imports = [ "${modulesPath}/virtualisation/amazon-image.nix" ];
}
