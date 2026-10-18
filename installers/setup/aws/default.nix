# The `aws` configuration without flakes, for the NixOS AMI's user data (see README.md): amazon-init writes the
# user data to /etc/nixos/configuration.nix and switches to it on first boot.
{
  imports = [ ../../toolchain/aws.nix ../../toolchain/biscotti.nix ];
  _module.args = {
    self = ../../..;
    version = (builtins.fromJSON (builtins.readFile ../../../package.json)).version;
  };
}
