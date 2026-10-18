#!/bin/sh
# Task VM network (idempotent). Each VM slot is its own network namespace, fcN, holding the tap the snapshot expects
# (fc-task, the VM at 172.16.0.2 and its gateway 172.16.0.1), so several VMs restored from one snapshot never clash.
# A veth pair links each slot to the host (host 10.200.N.1, slot 10.200.N.2). VMs reach the internet and the bridge
# (Caddy, port 80) only: never the LAN, the tailnet, other host ports or each other.
set -e
SLOTS="1 2 3"
sysctl -qw net.ipv4.ip_forward=1

host() { table=$1 chain=$2; shift 2; iptables -t "$table" -C "$chain" "$@" 2>/dev/null || iptables -t "$table" -I "$chain" "$@"; }

for n in $SLOTS; do
  ns=fc$n
  slot() { ip netns exec "$ns" "$@"; }
  slot_rule() { table=$1 chain=$2; shift 2; slot iptables -t "$table" -C "$chain" "$@" 2>/dev/null || slot iptables -t "$table" -I "$chain" "$@"; }

  ip netns list | grep -qw "$ns" || ip netns add "$ns"
  ip link show "veth-$ns" >/dev/null 2>&1 || ip link add "veth-$ns" type veth peer name veth0 netns "$ns"
  ip addr replace "10.200.$n.1/30" dev "veth-$ns"
  ip link set "veth-$ns" up

  slot ip link set lo up
  slot ip addr replace "10.200.$n.2/30" dev veth0
  slot ip link set veth0 up
  slot ip route replace default via "10.200.$n.1"
  slot ip link show fc-task >/dev/null 2>&1 || slot ip tuntap add fc-task mode tap
  slot ip addr replace 172.16.0.1/24 dev fc-task
  slot ip link set fc-task up
  slot sysctl -qw net.ipv4.ip_forward=1

  # The VM's traffic leaves as the slot's address; the bridge address reaches Caddy on the host; the host reaches the
  # VM's task listener (4000), cua-spacesd (3211) and noVNC (6901) at the slot's address.
  slot_rule nat POSTROUTING -s 172.16.0.2 -o veth0 -j SNAT --to-source "10.200.$n.2"
  slot_rule nat PREROUTING -i fc-task -d 172.16.0.1 -p tcp --dport 80 -j DNAT --to-destination "10.200.$n.1:80"
  slot_rule nat PREROUTING -i veth0 -d "10.200.$n.2" -p tcp -m multiport --dports 4000,3211,6901 -j DNAT --to-destination 172.16.0.2
done

host nat POSTROUTING -s 10.200.0.0/16 -o veth-fc+ -j RETURN
host nat POSTROUTING -s 10.200.0.0/16 -j MASQUERADE

# Forwarded traffic (Docker owns FORWARD; DOCKER-USER runs first). Inserted in reverse priority order.
host filter DOCKER-USER -i veth-fc+ -j ACCEPT
host filter DOCKER-USER -o veth-fc+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
  host filter DOCKER-USER -i veth-fc+ -d "$net" -j DROP
done

# Traffic to the host itself: only the bridge port.
host filter INPUT -i veth-fc+ -j DROP
host filter INPUT -i veth-fc+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
host filter INPUT -i veth-fc+ -d 10.200.0.0/16 -p tcp --dport 80 -j ACCEPT
