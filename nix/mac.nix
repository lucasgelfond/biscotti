# A Lima VM on a Mac (M3 or later, nested KVM), run in Lima's plain mode (no guest agent). At boot, the user and SSH
# key Lima puts on its cidata disk become a login, so `limactl shell` works.
{ lib, modulesPath, pkgs, vms, ... }:
{
  imports = [ "${modulesPath}/profiles/qemu-guest.nix" ];
  # Task VMs on 2M huge pages, enough for all of them at once: nested, every 4K page a VM first touches is slow.
  boot.kernelParams = [ "console=hvc0" "hugepagesz=2M" "hugepages=${toString (vms.slots * vms.memMiB / 2)}" ];
  # As the image lays the disk out, so `nixos-rebuild switch --flake .#mac` can update a running Mac VM in place.
  fileSystems."/" = lib.mkDefault { device = "/dev/disk/by-label/nixos"; fsType = "ext4"; autoResize = true; };
  fileSystems."/boot" = lib.mkDefault { device = "/dev/disk/by-label/ESP"; fsType = "vfat"; };
  boot.loader.systemd-boot.enable = lib.mkDefault true;
  # Lima runs its scripts with /bin/bash.
  systemd.tmpfiles.rules = [ "L+ /bin/bash - - - - ${pkgs.bash}/bin/bash" ];

  systemd.services.lima-user = {
    wantedBy = [ "multi-user.target" ];
    before = [ "sshd.service" ];
    path = with pkgs; [ util-linux shadow yq-go ];
    serviceConfig.Type = "oneshot";
    script = ''
      mkdir -p /mnt/lima-cidata
      mountpoint -q /mnt/lima-cidata || mount -o ro /dev/disk/by-label/cidata /mnt/lima-cidata
      user() { yq ".users[0].$1" /mnt/lima-cidata/user-data; }
      name=$(user name) home=$(user homedir)
      id "$name" >/dev/null 2>&1 || useradd -m -d "$home" -u "$(user uid)" -G wheel,docker,kvm -s /run/current-system/sw/bin/bash "$name"
      install -d -m 700 -o "$name" "$home/.ssh"
      yq '.users[0].ssh-authorized-keys[]' /mnt/lima-cidata/user-data > "$home/.ssh/authorized_keys"
      chown "$name" "$home/.ssh/authorized_keys"
      # What `limactl start` waits for.
      yq '.instance-id' /mnt/lima-cidata/meta-data > /run/lima-boot-done
    '';
  };
}
