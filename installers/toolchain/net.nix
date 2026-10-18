# The task VMs' network. Each VM slot is its own network namespace, fcN, holding the tap the snapshot expects (fc-task,
# the VM at 172.16.0.2 and its gateway 172.16.0.1), so VMs restored from one snapshot never clash. A veth pair links
# each slot to the host (host 10.200.N.1, slot 10.200.N.2). VMs reach the internet and the gate (port 80 on their
# link) only: never the LAN, the tailnet, other host ports or each other.
# With container tasks, each slot is instead a Docker network, biscotti-N, whose bridge takes the veth's name and
# addresses, so the same rules apply.
{ config, lib, pkgs, ... }:
let
  slots = [ 1 2 3 ];
  # Adds an iptables rule unless it's there (so restarts are idempotent); `ns` runs it inside a slot.
  rule = ns: table: chain: args:
    let ipt = "${lib.optionalString (ns != null) "ip netns exec ${ns} "}iptables -t ${table}";
    in "${ipt} -C ${chain} ${args} 2>/dev/null || ${ipt} -I ${chain} ${args}";
  slot = n:
    let ns = "fc${toString n}"; host = "10.200.${toString n}.1"; inside = "10.200.${toString n}.2";
    in ''
      ip netns list | grep -qw ${ns} || ip netns add ${ns}
      ip link show veth-${ns} >/dev/null 2>&1 || ip link add veth-${ns} type veth peer name veth0 netns ${ns}
      ip addr replace ${host}/30 dev veth-${ns}
      ip link set veth-${ns} up
      ip -n ${ns} link set lo up
      ip -n ${ns} addr replace ${inside}/30 dev veth0
      ip -n ${ns} link set veth0 up
      ip -n ${ns} route replace default via ${host}
      ip -n ${ns} link show fc-task >/dev/null 2>&1 || ip -n ${ns} tuntap add fc-task mode tap
      ip -n ${ns} addr replace 172.16.0.1/24 dev fc-task
      ip -n ${ns} link set fc-task up
      ip netns exec ${ns} sysctl -qw net.ipv4.ip_forward=1
      # The VM's traffic leaves as the slot's address; the VM's gateway reaches the gate; the host reaches the VM's
      # task listener (4000), cua-spacesd (3211) and noVNC (6901) at the slot's address.
      ${rule ns "nat" "POSTROUTING" "-s 172.16.0.2 -o veth0 -j SNAT --to-source ${inside}"}
      ${rule ns "nat" "PREROUTING" "-i fc-task -d 172.16.0.1 -p tcp --dport 80 -j DNAT --to-destination ${host}:80"}
      ${rule ns "nat" "PREROUTING" "-i veth0 -d ${inside} -p tcp -m multiport --dports 4000,3211,6901 -j DNAT --to-destination 172.16.0.2"}
    '';
  network = n:
    let s = toString n;
    in ''
      docker network inspect biscotti-${s} >/dev/null 2>&1 || docker network create --subnet 10.200.${s}.0/24 \
        --gateway 10.200.${s}.1 -o com.docker.network.bridge.name=veth-fc${s} biscotti-${s} >/dev/null
    '';
  host = rule null;
in
{
  options.biscotti.tasks = lib.mkOption {
    type = lib.types.enum [ "firecracker" "container" ];
    default = "firecracker";
    description = "Where tasks run: Firecracker VMs, or containers where nested virtualization is slow or missing.";
  };

  config = {
    boot.kernel.sysctl."net.ipv4.ip_forward" = 1;

    systemd.services.biscotti-net = {
      description = "biscotti task VM network";
      # Docker owns FORWARD and creates DOCKER-USER, which runs first; these rules go there.
      after = [ "docker.service" ];
      requires = [ "docker.service" ];
      wantedBy = [ "multi-user.target" ];
      path = with pkgs; [ iproute2 iptables procps gnugrep docker ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = lib.concatMapStrings (if config.biscotti.tasks == "container" then network else slot) slots + ''
        ${host "nat" "POSTROUTING" "-s 10.200.0.0/16 -o veth-fc+ -j RETURN"}
        ${host "nat" "POSTROUTING" "-s 10.200.0.0/16 -j MASQUERADE"}
        # Forwarded traffic, inserted in reverse priority order.
        ${host "filter" "DOCKER-USER" "-i veth-fc+ -j ACCEPT"}
        ${host "filter" "DOCKER-USER" "-o veth-fc+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"}
        ${lib.concatMapStrings (net: host "filter" "DOCKER-USER" "-i veth-fc+ -d ${net} -j DROP" + "\n")
          [ "10.0.0.0/8" "172.16.0.0/12" "192.168.0.0/16" "100.64.0.0/10" "169.254.0.0/16" ]}
        # Traffic to the host itself: only the gate.
        ${host "filter" "INPUT" "-i veth-fc+ -j DROP"}
        ${host "filter" "INPUT" "-i veth-fc+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"}
        ${host "filter" "INPUT" "-i veth-fc+ -d 10.200.0.0/16 -p tcp --dport 80 -j ACCEPT"}
      '';
    };
  };
}
