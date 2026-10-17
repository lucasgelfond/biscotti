#!/bin/bash
# Turn the desktop image into an ext4 VM disk for Firecracker. Usage: sudo cua-vm/rootfs.sh [image] [out.ext4]
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

# PID 1 inside the VM: the mounts Docker would normally provide, then Cua's supervisord.
cat > "$DIR/sbin/biscotti-init" <<'EOF'
#!/bin/sh
. /etc/biscotti-env
mount -t proc proc /proc; mount -t sysfs sys /sys; mount -t devtmpfs dev /dev
mkdir -p /dev/pts /dev/shm; mount -t devpts devpts /dev/pts; mount -t tmpfs tmpfs /dev/shm
mount -t tmpfs tmpfs /run; mount -t tmpfs -o mode=1777 tmpfs /tmp
install -d -o cua -g cua -m 0700 /run/cua
echo nameserver 1.1.1.1 > /etc/resolv.conf
cat /proc/net/route /etc/resolv.conf > /dev/console
hostname sandbox; printf '127.0.0.1 localhost sandbox\n' > /etc/hosts
# Mirror Cua's service logs to the serial console so the host can see them.
(while :; do echo "heartbeat $(cut -d" " -f1 /proc/uptime)"; sleep 2; done) > /dev/console &
(sleep 3; tail -qF /var/log/supervisor/*.log) > /dev/console 2>&1 &
# Optional warm-up: `biscotti.url=<url>` on the kernel cmdline opens Firefox once X is up.
url=$(sed -n 's/.*biscotti\.url=\([^ ]*\).*/\1/p' /proc/cmdline)
[ -n "$url" ] && (until xdpyinfo -display :1 >/dev/null 2>&1; do sleep 0.2; done; runuser -u cua -- firefox-esr "$url" > /dev/console 2>&1) &
# Dev hook: `biscotti.run=<script>` runs a script once X is up, output to the console.
run=$(sed -n 's/.*biscotti\.run=\([^ ]*\).*/\1/p' /proc/cmdline)
[ -n "$run" ] && (until xdpyinfo -display :1 >/dev/null 2>&1; do sleep 0.2; done; sh "$run" > /dev/console 2>&1) &
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
EOF
chmod +x "$DIR/sbin/biscotti-init"

rm -f "$OUT"
mkfs.ext4 -q -d "$DIR" -L rootfs "$OUT" 3G
echo "$OUT"
