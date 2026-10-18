#!/bin/bash
# Build what task VMs start from: the guest kernel, the read-only disk, and one snapshot per kind, taken once the VM
# is ready for a task. Usage: sudo cua-vm/snapshots.sh [dir]   (FC_BIN picks the Firecracker binary)
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

# snapshot <kind> <tap> <guest ip> <memory MiB> <ports to wait for>
snapshot() {
  local kind=$1 tap=$2 ip=$3 mem=$4 sock=/tmp/fc-snapshot.sock
  shift 4
  rm -f "$sock"
  "$FC" --api-sock "$sock" >"$OUT/$kind.log" 2>&1 &
  local pid=$!
  until [ -S "$sock" ]; do sleep 0.05; done
  api() { curl -sf --unix-socket "$sock" -X "$1" "http://localhost$2" -H 'Content-Type: application/json' -d "$3"; }
  api PUT /boot-source "{\"kernel_image_path\":\"$OUT/vmlinux\",\"boot_args\":\"console=ttyS0 reboot=k panic=1 ro init=/sbin/biscotti-init ip=$ip::172.16.0.1:255.255.255.0::eth0:off biscotti.mode=$kind\"}"
  api PUT /drives/rootfs "{\"drive_id\":\"rootfs\",\"path_on_host\":\"$OUT/rootfs.ext4\",\"is_root_device\":true,\"is_read_only\":true}"
  api PUT /machine-config "{\"vcpu_count\":2,\"mem_size_mib\":$mem}"
  api PUT /network-interfaces/eth0 "{\"iface_id\":\"eth0\",\"host_dev_name\":\"$tap\"}"
  api PUT /actions '{"action_type":"InstanceStart"}'
  for port in "$@"; do
    until (exec 3<>"/dev/tcp/$ip/$port") 2>/dev/null; do sleep 0.2; done
  done
  api PATCH /vm '{"state":"Paused"}'
  api PUT /snapshot/create "{\"snapshot_type\":\"Full\",\"snapshot_path\":\"$OUT/$kind.snap\",\"mem_file_path\":\"$OUT/$kind.mem\"}"
  kill "$pid"
  echo "$kind snapshot: $(du -h "$OUT/$kind.mem" | cut -f1) memory"
}

snapshot headless fc-headless 172.16.0.2 1024 4000
snapshot desktop fc-desktop 172.16.0.3 2048 4000 6901 3211
