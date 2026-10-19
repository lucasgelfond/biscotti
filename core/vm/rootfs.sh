#!/usr/bin/env bash
# Turn the desktop image into an ext4 VM disk for Firecracker. Usage: sudo core/vm/rootfs.sh [image] [out.ext4]
# The disk is attached read-only and shared by every VM; each VM writes to its own RAM overlay.
set -euo pipefail
IMAGE=${1:-biscotti/cua-desktop:dev}
OUT=${2:-cua-desktop.ext4}
DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT

cid=$(docker create "$IMAGE")
docker export "$cid" | tar -x -C "$DIR"
docker rm "$cid" >/dev/null
# docker export drops the image's ENV; carry it into the VM.
docker image inspect "$IMAGE" --format '{{range .Config.Env}}export {{.}}{{"\n"}}{{end}}' > "$DIR/etc/biscotti-env"

# PID 1 inside the VM. First pass: move the read-only root onto a RAM overlay and start again from there.
mkdir -p "$DIR/overlay"
cat > "$DIR/sbin/biscotti-init" <<'EOF'
#!/bin/sh
if [ ! -d /.lower ]; then
  mount -t tmpfs tmpfs /overlay
  mkdir -p /overlay/upper /overlay/work /overlay/root
  mount -t overlay overlay -o lowerdir=/,upperdir=/overlay/upper,workdir=/overlay/work /overlay/root
  mkdir /overlay/root/.lower
  cd /overlay/root && pivot_root . .lower && exec chroot . /sbin/biscotti-init
fi
# Second pass: the mounts Docker would normally provide, then the task listener and Cua's desktop.
. /etc/biscotti-env
# The desktop's password (Cua's VNC script turns authentication off without one), from the host's snapshot build.
export VNC_PW=$(sed -n 's/.*biscotti\.vnc=\([^ ]*\).*/\1/p' /proc/cmdline)
mount -t proc proc /proc; mount -t sysfs sys /sys; mount -t devtmpfs dev /dev
mkdir -p /dev/pts /dev/shm; mount -t devpts devpts /dev/pts; mount -t tmpfs tmpfs /dev/shm
mount -t tmpfs tmpfs /run; mount -t tmpfs -o mode=1777 tmpfs /tmp
# Like Docker's default seccomp profile: no user namespaces (Chromium uses its setuid sandbox instead).
sysctl -qw user.max_user_namespaces=0
echo nameserver 1.1.1.1 > /etc/resolv.conf
cat /proc/net/route /etc/resolv.conf > /dev/console
# Track the host clock through KVM's PTP device, stepping on any jump (e.g. after a snapshot restore).
[ -e /dev/ptp0 ] && printf 'refclock PHC /dev/ptp0 poll -2 dpoll -2\nmakestep 0.5 -1\n' > /etc/chrony/chrony.conf && chronyd
# The gate is the VM's gateway. Ad and tracker hosts resolve nowhere: ticketing pages load several times faster.
hostname sandbox; printf '127.0.0.1 localhost sandbox\n172.16.0.1 gate\n' > /etc/hosts; cat /etc/hosts.block >> /etc/hosts
# Mirror Cua's service logs to the serial console so the host can see them.
(while :; do echo "heartbeat $(cut -d" " -f1 /proc/uptime) $(date +%T)"; sleep 2; done) > /dev/console &
(sleep 3; tail -qF /var/log/supervisor/*.log) > /dev/console 2>&1 &
# Dev hook: `biscotti.run=<script>` runs a script once X is up, output to the console.
run=$(sed -n 's/.*biscotti\.run=\([^ ]*\).*/\1/p' /proc/cmdline)
[ -n "$run" ] && (until xdpyinfo -display :1 >/dev/null 2>&1; do sleep 0.2; done; sh "$run" > /dev/console 2>&1) &
exec /usr/local/bin/biscotti-start > /dev/console 2>&1
EOF
chmod +x "$DIR/sbin/biscotti-init"

rm -f "$OUT"
mkfs.ext4 -q -d "$DIR" -L rootfs "$OUT" 3G
echo "$OUT"
