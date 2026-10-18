# A Lima VM on a Mac (M3 or later, nested KVM), run in Lima's plain mode (no guest agent). At boot, the user and SSH
# key Lima puts on its cidata disk become a login, so `limactl shell` works.
{ modulesPath, pkgs, ... }:
{
  imports = [ "${modulesPath}/profiles/qemu-guest.nix" ];
  boot.kernelParams = [ "console=hvc0" ];
  # Nested virtualization on a Mac makes Firecracker VMs ~100x slower; the Lima VM is the boundary, so containers.
  biscotti.tasks = "container";
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
