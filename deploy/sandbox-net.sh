#!/bin/sh
# Sandbox network (idempotent): task VMs on biscotti0 reach the internet and the Caddy bridge only,
# never the LAN, the tailnet or other host ports.
set -e

ip link show biscotti0 >/dev/null 2>&1 || ip link add biscotti0 type bridge
ip addr replace 172.16.0.1/24 dev biscotti0
ip link set biscotti0 up
sysctl -qw net.ipv4.ip_forward=1

# The task VM's tap (its snapshot has guest address 172.16.0.2). An isolated bridge port reaches the host but no
# other VM.
ip link show fc-task >/dev/null 2>&1 || ip tuntap add fc-task mode tap
ip link set fc-task master biscotti0 up
bridge link set dev fc-task isolated on

ensure() { table=$1 chain=$2; shift 2; iptables -t "$table" -C "$chain" "$@" 2>/dev/null || iptables -t "$table" -I "$chain" "$@"; }

ensure nat POSTROUTING -s 172.16.0.0/24 ! -o biscotti0 -j MASQUERADE

# Forwarded traffic (Docker owns FORWARD; DOCKER-USER runs first). Inserted in reverse priority order.
ensure filter DOCKER-USER -i biscotti0 -j ACCEPT
ensure filter DOCKER-USER -o biscotti0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
  ensure filter DOCKER-USER -i biscotti0 -d "$net" -j DROP
done

# Traffic to the host itself: only the bridge port.
ensure filter INPUT -i biscotti0 -j DROP
ensure filter INPUT -i biscotti0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ensure filter INPUT -i biscotti0 -d 172.16.0.1 -p tcp --dport 80 -j ACCEPT
