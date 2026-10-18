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

  outputs = { self, nixpkgs, nixos-raspberrypi, ... }@inputs: {
    nixosConfigurations = {
      pi5 = nixos-raspberrypi.lib.nixosSystem {
        specialArgs = inputs;
        modules = [ ./installers/toolchain/biscotti.nix ./installers/toolchain/pi5.nix ];
      };
      vm = nixpkgs.lib.nixosSystem {
        system = "aarch64-linux";
        specialArgs = inputs;
        modules = [ ./installers/toolchain/biscotti.nix ./installers/toolchain/vm.nix ];
      };
    };

    packages.aarch64-linux.pi5-sd-image = self.nixosConfigurations.pi5.config.system.build.sdImage;
  };
}
