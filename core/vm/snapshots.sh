#!/usr/bin/env bash
# Build what task VMs start from: the guest kernel, the read-only disk, and a snapshot of the desktop VM taken once it
# is ready for a task. Usage: sudo core/vm/snapshots.sh [dir]   (FC_BIN picks the Firecracker binary;
# HUGE_PAGES=2M puts the VM on huge pages)
set -euo pipefail
cd "$(dirname "$0")"
OUT=${1:-/var/lib/biscotti/vm}
FC=${FC_BIN:-firecracker}
KERNELS=https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20260107-89702a77e4c2-0
mkdir -p "$OUT"

case $(uname -m) in
  aarch64) arch=aarch64 sum=f744c169fdb7d997946883fc5074ea2245fb92e6c8456d845d410d31643d5578 ;;
  x86_64) arch=x86_64 sum=00ea8490cea8adfa9f39a73e4b5415daf74d4c64d8e74d7ffe934e01d746d511 ;;
esac
curl -fsSL -o "$OUT/vmlinux" "$KERNELS/$arch/vmlinux-6.1.155"
echo "$sum  $OUT/vmlinux" | sha256sum -c -

docker build -t biscotti/cua-desktop .
./rootfs.sh biscotti/cua-desktop "$OUT/rootfs.ext4"

# Boot once in slot 1 (the biscotti-net service), wait until the task listener, noVNC and cua-spacesd answer, then
# snapshot. Every slot looks the same from inside, so the snapshot restores in any of them.
sock=/tmp/fc-snapshot.sock slot=10.200.1.2
rm -f "$sock"
ip netns exec fc1 "$FC" --api-sock "$sock" >"$OUT/snapshot.log" 2>&1 &
pid=$!
until [ -S "$sock" ]; do sleep 0.05; done
api() { curl -sf --unix-socket "$sock" -X "$1" "http://localhost$2" -H 'Content-Type: application/json' -d "$3"; }
api PUT /boot-source "{\"kernel_image_path\":\"$OUT/vmlinux\",\"boot_args\":\"console=ttyS0 reboot=k panic=1 ro init=/sbin/biscotti-init ip=172.16.0.2::172.16.0.1:255.255.255.0::eth0:off\"}"
api PUT /drives/rootfs "{\"drive_id\":\"rootfs\",\"path_on_host\":\"$OUT/rootfs.ext4\",\"is_root_device\":true,\"is_read_only\":true}"
api PUT /machine-config "{\"vcpu_count\":2,\"mem_size_mib\":1280${HUGE_PAGES:+,\"huge_pages\":\"$HUGE_PAGES\"}}"
api PUT /network-interfaces/eth0 '{"iface_id":"eth0","host_dev_name":"fc-task"}'
api PUT /actions '{"action_type":"InstanceStart"}'
for port in 4000 6901 3211; do
  until (exec 3<>"/dev/tcp/$slot/$port") 2>/dev/null; do sleep 0.2; done
done
# Let idle keep-alive connections to the gate close, so no restored VM starts with a dead one.
sleep 6
api PATCH /vm '{"state":"Paused"}'
api PUT /snapshot/create "{\"snapshot_type\":\"Full\",\"snapshot_path\":\"$OUT/desktop.snap\",\"mem_file_path\":\"$OUT/desktop.mem\"}"
kill "$pid"
echo "snapshot: $(du -h "$OUT/desktop.mem" | cut -f1) memory"
