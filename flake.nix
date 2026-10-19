{
  description = "Biscotti: a lightweight, Instinct-like agent harness";

  nixConfig = {
    extra-substituters = [ "https://nixos-raspberrypi.cachix.org" ];
    extra-trusted-public-keys = [
      "nixos-raspberrypi.cachix.org-1:4iMO9LXa8BqhU+Rpg6LQKiGa2lsNh/j2oiYLNOQ5sPI="
    ];
  };

  inputs = {
    # Pinned to a commit at least a week old; nixpkgs follows it for binary-cache hits.
    nixos-raspberrypi.url = "github:nvmd/nixos-raspberrypi/fa1e8ce6fa2acc637e0ef58f0f9847fb8502c8d1";
    nixpkgs.follows = "nixos-raspberrypi/nixpkgs";
  };

  outputs = { self, nixpkgs, nixos-raspberrypi, ... }@inputs:
  let
    version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
    specialArgs = inputs // { inherit version; };
  in {
    nixosConfigurations = {
      pi5 = nixos-raspberrypi.lib.nixosSystem {
        specialArgs = specialArgs // { target = "pi5"; };
        modules = [ ./nix/biscotti.nix ./nix/pi5.nix ];
      };
      vm = nixpkgs.lib.nixosSystem {
        system = "aarch64-linux";
        specialArgs = specialArgs // { target = "vm"; };
        modules = [ ./nix/biscotti.nix ./nix/vm.nix ];
      };
      mac = nixpkgs.lib.nixosSystem {
        system = "aarch64-linux";
        specialArgs = specialArgs // { target = "mac"; };
        modules = [ ./nix/biscotti.nix ./nix/mac.nix ];
      };
      aws = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = specialArgs // { target = "aws"; };
        modules = [ ./nix/biscotti.nix ./nix/aws.nix ];
      };
    };

    checks.aarch64-linux.pi5-card = nixpkgs.legacyPackages.aarch64-linux.testers.runNixOSTest (import ./nix/tests/pi5-card.nix { specialArgs = specialArgs // { target = "pi5"; }; });

    packages.aarch64-linux.pi5-sd-image = self.nixosConfigurations.pi5.config.system.build.sdImage;
    packages.aarch64-linux.mac-image = self.nixosConfigurations.mac.config.system.build.images.qemu-efi;
    # A ready AMI, for uploading with `aws ec2 import-snapshot` instead of the user-data route.
    packages.x86_64-linux.aws-image = self.nixosConfigurations.aws.config.system.build.images.amazon;
  };
}
