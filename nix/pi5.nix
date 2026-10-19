# Raspberry Pi 5 SD image (4K pages; the 16K-page kernel breaks too much software).
{ nixos-raspberrypi, ... }:
{
  imports = with nixos-raspberrypi.nixosModules; [
    raspberry-pi-5.base
    sd-image
    ./pi5-card.nix
  ];

  boot.loader.raspberry-pi.bootloader = "kernel";
  # A plain .img, which the installer app writes as is.
  sdImage.compressImage = false;
}
