#!/bin/sh
# While the bench runs (on the Pi, as root): task VMs reach EverydayBench's sites, and nothing else new. A VM's browser
# maps *.everydaybench.test to its gateway (core/vm/task/biscotti-start); its slot forwards the gateway's port 8700 to
# the host, where EverydayBench listens (in Docker, on the host's network). EverydayBench's control port stays on the
# host's loopback.
#   everydaybench-net.sh up|down [slots]
set -eu
action=$1
slots=${2:-"1 2"}
# Adds (up) or removes (down) a rule, checking first, so "up" twice adds it once and "down" alone changes nothing.
apply() {
  if "$@" -C $rule 2>/dev/null; then
    if [ "$action" = down ]; then "$@" -D $rule; fi
  elif [ "$action" = up ]; then
    "$@" -I $rule
  fi
}
for n in $slots; do
  host=10.200.$n.1
  rule="PREROUTING -i fc-task -d 172.16.0.1 -p tcp --dport 8700 -j DNAT --to-destination $host:8700"
  apply ip netns exec fc$n iptables -t nat
  rule="INPUT -i veth-fc$n -s 10.200.$n.2 -d $host -p tcp --dport 8700 -j ACCEPT"
  apply iptables
done
