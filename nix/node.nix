# An overflow machine: task VMs only, for a biscotti host's gate elsewhere on the tailnet (core/src/nodes.ts). No keys,
# no data, no gate or agent: the VMs reach the model and tools through that gate over Tailscale, and the gate reaches
# them through the forwards below. See installer/aws/NODE.md.
#
# `node.gate`: the gate's Tailscale name. `vms`: slots, memory and work disk, as on the host (flake.nix).
{ lib, pkgs, self, vms, node, ... }:
let
  inherit (import ./firecracker.nix { inherit pkgs self; }) firecracker faultAll;
  repo = "${self}";
  slots = lib.range 1 vms.slots;
  # The gate listens for slot N's VM at 18000 + 100 + N (GATE_PORT_BASE + slot); the gate reaches VM port P of slot N
  # here at REMOTE_PORTS[P] + N (core/src/plugin.ts).
  remotePorts = { "4000" = 14000; "3211" = 13200; "6901" = 16900; "9223" = 19200; };
  forward = name: listen: to: {
    "biscotti-fwd-${name}" = {
      after = [ "biscotti-net.service" "tailscaled.service" ];
      wants = [ "biscotti-net.service" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        ExecStart = "${pkgs.socat}/bin/socat TCP-LISTEN:${listen},fork,reuseaddr ${to}";
        Restart = "always";
        RestartSec = 2;
      };
    };
  };
in
{
  imports = [ ./net.nix ];
  _module.args = { inherit repo firecracker faultAll; };

  networking.hostName = "biscotti-node";
  time.timeZone = "UTC";
  services.tailscale.enable = true;
  services.resolved.enable = true;
  services.chrony.enable = true;
  virtualisation.docker.enable = true;
  environment.systemPackages = [ firecracker pkgs.git pkgs.jq ];
  # Only Tailscale reaches the forwards (and the instance's security group allows SSH alone).
  networking.firewall.trustedInterfaces = [ "tailscale0" ];
  networking.dhcpcd.denyInterfaces = [ "veth*" "docker*" "br-*" "tailscale*" ];
  services.udev.extraRules = ''
    KERNEL=="userfaultfd", GROUP="kvm", MODE="0660"
  '';
  systemd.tmpfiles.rules = [
    "d /var/lib/biscotti 0700 root root -"
    "d /var/lib/biscotti/work 0755 root root -"
    "d /run/biscotti-vms 0700 root root -"
  ] ++ map (n: "d /var/lib/biscotti/work/${toString n} 0700 ${toString (1100 + n)} ${toString (1100 + n)} -") slots;

  # Each slot: its VM's gate traffic to the gate, and the gate's to its VM's ports. And the vms service's API.
  systemd.services = lib.mkMerge (
    [ (forward "vms" "7400" "UNIX-CONNECT:/run/biscotti-vms/vms.sock") ]
    ++ map (n: forward "gate-${toString n}" "80,bind=10.200.${toString n}.1" "TCP:${node.gate}:${toString (18100 + n)}") slots
    ++ lib.concatMap (n: lib.mapAttrsToList (port: base: forward "${port}-${toString n}" (toString (base + n)) "TCP:10.200.${toString n}.2:${port}") remotePorts) slots
    ++ [ {
      biscotti-node = {
        after = [ "network-online.target" "docker.service" "tailscaled.service" "biscotti-net.service" ];
        wants = [ "network-online.target" ];
        requires = [ "docker.service" "biscotti-net.service" ];
        wantedBy = [ "multi-user.target" ];
        path = [ firecracker ] ++ (with pkgs; [ bash coreutils gnugrep gnused jq curl docker tailscale awscli2 e2fsprogs gnutar util-linux openssl iproute2 ]);
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          TimeoutStartSec = "infinity";
          Restart = "on-failure";
          RestartSec = 30;
        };
        script = ''
          STATE=/var/lib/biscotti
          # The first boot joins the tailnet with the one-time key the gate put in Parameter Store (its instance role
          # may read only that). Later boots are already logged in.
          if ! tailscale status >/dev/null 2>&1; then
            token=$(curl -sf -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
            region=$(curl -sf -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/placement/region)
            key=$(aws ssm get-parameter --region "$region" --name /biscotti/node/tailscale-key --with-decryption --query Parameter.Value --output text)
            tailscale up --auth-key="$key" --advertise-tags=tag:biscotti-node --hostname=${node.hostname or "biscotti-node"}
          fi
          for n in ${toString slots}; do tailscale serve --bg --https=$((10440 + n)) "http://10.200.$n.2:6901"; done

          docker build -q -t biscotti/agent -f ${repo}/core/Dockerfile ${repo} >/dev/null
          vm_source=$({ cd ${repo}/core/vm && find . -type f | sort | xargs sha256sum; echo ${toString vms.memMiB} ${toString vms.workGiB}; } | sha256sum | cut -d' ' -f1)
          if [ ! -f "$STATE/vm/desktop.snap" ] || [ "$(cat "$STATE/vm/source" 2>/dev/null)" != "$vm_source" ]; then
            rm -f "$STATE/vm/desktop.snap"
            docker rm -f biscotti-vms 2>/dev/null || true
            VM_MEM_MIB=${toString vms.memMiB} WORK_GIB=${toString vms.workGiB} FC_BIN=${firecracker}/bin/firecracker ${repo}/core/vm/snapshots.sh "$STATE/vm"
            echo "$vm_source" > "$STATE/vm/source"
          fi
          # The vms service, as on the host (core/host/compose.yaml).
          docker rm -f biscotti-vms 2>/dev/null || true
          docker run -d --name biscotti-vms --restart unless-stopped --network none --init --read-only --tmpfs /tmp \
            --cap-drop ALL --cap-add SYS_ADMIN --cap-add SETUID --cap-add SETGID --cap-add KILL \
            ${lib.concatMapStrings (n: "--group-add ${toString (1100 + n)} ") slots}--security-opt no-new-privileges:true \
            --device /dev/kvm --device /dev/net/tun \
            --mount type=bind,source=/run/netns,target=/run/netns,readonly,bind-propagation=rslave \
            -v "$STATE/vm:/var/lib/biscotti/vm:ro" -v "$STATE/work:/var/lib/biscotti/work" -v /nix/store:/nix/store:ro \
            -v ${firecracker}/bin/firecracker:/usr/local/bin/firecracker:ro -v /run/biscotti-vms:/run/biscotti-vms \
            -e VM_DIR=/var/lib/biscotti/vm -e WORK_DIR=/var/lib/biscotti/work -e FIRECRACKER=/usr/local/bin/firecracker \
            -e TASK_UID_BASE=1100 -e VM_SLOTS=${toString vms.slots} \
            biscotti/agent node core/src/vms-main.ts
        '';
      };
    } ]
  );

  nix.settings.experimental-features = [ "nix-command" "flakes" ];
  system.stateVersion = "26.05";
}
