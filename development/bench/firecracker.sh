#!/bin/bash
# Firecracker timings for the desktop VM: cold boot, snapshot, restore.
# Usage: sudo bench/firecracker.sh {boot [url]|snapshot|restore|stop}   (run from a dir with vmlinux + cua-desktop.ext4)
set -euo pipefail
SOCK=/tmp/fc.sock TAP=fc0 HOST_IP=172.16.0.1 GUEST_IP=172.16.0.2

api() { curl -sf --unix-socket $SOCK -X "$1" "http://localhost$2" -H 'Content-Type: application/json' ${3:+-d "$3"}; }
now() { date +%s.%N; }
elapsed() { awk "BEGIN{printf \"%.2f\", $(now) - $1}"; }
wait_ready() { until (exec 3<>/dev/tcp/$GUEST_IP/3211) 2>/dev/null && (exec 3<>/dev/tcp/$GUEST_IP/6901) 2>/dev/null; do sleep 0.05; done; }

start_fc() {
  pkill -x firecracker 2>/dev/null || true; sleep 0.2; rm -f $SOCK
  ip link show $TAP >/dev/null 2>&1 || {
    ip tuntap add $TAP mode tap && ip addr add $HOST_IP/30 dev $TAP && ip link set $TAP up
    sysctl -qw net.ipv4.ip_forward=1
    iptables -t nat -C POSTROUTING -s $GUEST_IP -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s $GUEST_IP -j MASQUERADE
    # Docker sets FORWARD to DROP; let the VM's traffic through.
    iptables -I FORWARD -i $TAP -j ACCEPT
    iptables -I FORWARD -o $TAP -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  }
  firecracker --api-sock $SOCK >>/tmp/fc.log 2>&1 &
  until [ -S $SOCK ]; do sleep 0.01; done
}

case $1 in
boot)
  t=$(now); start_fc
  api PUT /boot-source "{\"kernel_image_path\":\"vmlinux\",\"boot_args\":\"console=ttyS0 reboot=k panic=1 init=/sbin/biscotti-init ip=$GUEST_IP::$HOST_IP:255.255.255.252::eth0:off${2:+ biscotti.url=$2}\"}"
  api PUT /drives/rootfs '{"drive_id":"rootfs","path_on_host":"cua-desktop.ext4","is_root_device":true,"is_read_only":false}'
  api PUT /machine-config '{"vcpu_count":2,"mem_size_mib":1024}'
  api PUT /network-interfaces/eth0 "{\"iface_id\":\"eth0\",\"host_dev_name\":\"$TAP\"}"
  api PUT /actions '{"action_type":"InstanceStart"}'
  wait_ready; echo "cold boot ready in $(elapsed $t)s" ;;
snapshot)
  t=$(now); api PATCH /vm '{"state":"Paused"}'
  api PUT /snapshot/create '{"snapshot_type":"Full","snapshot_path":"desktop.snap","mem_file_path":"desktop.mem"}'
  echo "snapshot taken in $(elapsed $t)s ($(du -h desktop.mem | cut -f1) memory file)" ;;
restore)
  t=$(now); start_fc
  api PUT /snapshot/load '{"snapshot_path":"desktop.snap","mem_backend":{"backend_type":"File","backend_path":"desktop.mem"},"resume_vm":true}'
  wait_ready; echo "restore ready in $(elapsed $t)s" ;;
stop)
  pkill -x firecracker || true ;;
esac
