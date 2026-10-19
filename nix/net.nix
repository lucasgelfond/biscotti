# The task VMs' network. Each VM slot is its own network namespace, fcN, holding the tap the snapshot expects (fc-task,
# the VM at 172.16.0.2 and its gateway 172.16.0.1), so VMs restored from one snapshot never clash. A veth pair links
# each slot to the host (host 10.200.N.1, slot 10.200.N.2). VMs reach the internet and the gate (port 80 on their
# link) only: never the LAN, the tailnet, other host ports, each other or another slot's gate.
{ lib, pkgs, ... }:
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
      # task listener (4000), cua-spacesd (3211), noVNC (6901) and Chromium
      # DevTools (9223, for the vault to type into pages) at the slot's address.
      ${rule ns "nat" "POSTROUTING" "-s 172.16.0.2 -o veth0 -j SNAT --to-source ${inside}"}
      ${rule ns "nat" "PREROUTING" "-i fc-task -d 172.16.0.1 -p tcp --dport 80 -j DNAT --to-destination ${host}:80"}
      ${rule ns "nat" "PREROUTING" "-i veth0 -d ${inside} -p tcp -m multiport --dports 4000,3211,6901,9223 -j DNAT --to-destination 172.16.0.2"}
    '';
  host = rule null;
in
{
  boot.kernel.sysctl."net.ipv4.ip_forward" = 1;

  # The namespaces exist before Docker starts the agent, which only sees /run/netns as it was when it started.
  systemd.services.biscotti-netns = {
    before = [ "docker.service" ];
    wantedBy = [ "docker.service" ];
    path = with pkgs; [ iproute2 gnugrep ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = lib.concatMapStrings (n: "ip netns list | grep -qw fc${toString n} || ip netns add fc${toString n}\n") slots;
  };

  systemd.services.biscotti-net = {
    description = "biscotti task VM network";
    # Docker owns FORWARD and creates DOCKER-USER, which runs first; these rules go there.
    after = [ "docker.service" ];
    requires = [ "docker.service" ];
    wantedBy = [ "multi-user.target" ];
    path = with pkgs; [ iproute2 iptables procps gnugrep ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = lib.concatMapStrings slot slots + ''
      ${host "nat" "POSTROUTING" "-s 10.200.0.0/16 -o veth-fc+ -j RETURN"}
      ${host "nat" "POSTROUTING" "-s 10.200.0.0/16 -j MASQUERADE"}
      # Forwarded traffic, inserted in reverse priority order.
      ${host "filter" "DOCKER-USER" "-i veth-fc+ -j ACCEPT"}
      ${host "filter" "DOCKER-USER" "-o veth-fc+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"}
      ${lib.concatMapStrings (net: host "filter" "DOCKER-USER" "-i veth-fc+ -d ${net} -j DROP" + "\n")
        [ "10.0.0.0/8" "172.16.0.0/12" "192.168.0.0/16" "100.64.0.0/10" "169.254.0.0/16" ]}
      # The same drops before routing, so they hold whatever order Docker and Tailscale put FORWARD's chains in
      # (Tailscale's accepts traffic out tailscale0): anything from a VM that isn't for the host itself or the internet.
      ${lib.concatMapStrings (net: host "raw" "PREROUTING" "-i veth-fc+ -d ${net} -j DROP" + "\n")
        [ "10.0.0.0/8" "172.16.0.0/12" "192.168.0.0/16" "100.64.0.0/10" "169.254.0.0/16" ]}
      ${host "raw" "PREROUTING" "-i veth-fc+ -m addrtype --dst-type LOCAL -j RETURN"}
      ip6tables -t raw -C PREROUTING -i veth-fc+ -j DROP 2>/dev/null || ip6tables -t raw -I PREROUTING -i veth-fc+ -j DROP
      # Traffic to the host itself: only the gate, each VM at its own slot's address (slot 2 can't act as slot 1).
      iptables -D INPUT -i veth-fc+ -d 10.200.0.0/16 -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
      ${host "filter" "INPUT" "-i veth-fc+ -j DROP"}
      ${host "filter" "INPUT" "-i veth-fc+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"}
      ${lib.concatMapStrings (n: host "filter" "INPUT" "-i veth-fc${toString n} -s 10.200.${toString n}.2 -d 10.200.${toString n}.1 -p tcp --dport 80 -j ACCEPT" + "\n") slots}
    '';
  };
}
