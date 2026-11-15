# An external VM node: an EC2 machine running one task VM for a biscotti host's gate elsewhere on the tailnet
# (plugins/external-vm-node). No keys, no data, no gate or agent: the VM reaches the model and tools through that gate
# over Tailscale, and the gate reaches the VM's ports here, forwarded as they are.
#
# `node.gate`: the gate's Tailscale name. `vms`: the VM's memory and work disk, as on the host (flake.nix).
{ lib, pkgs, self, vms, node, ... }:
let
  inherit (import ./firecracker.nix { inherit pkgs self; }) firecracker faultAll;
  repo = "${self}";
  slots = [ 1 ];
  # This is node k (its instance's biscotti-node-index tag, written to /run/biscotti-node-index at boot): slot 100 + k to
  # the gate, which listens for its VM at 18000 + 100 + k. The VM's ports, as they are: task agent, cua-spacesd, noVNC,
  # DevTools; its sshd at 2222 (this machine's own is on 22).
  vmPorts = { "4000" = "4000"; "3211" = "3211"; "6901" = "6901"; "9223" = "9223"; "2222" = "22"; };
  forward = name: listen: to: {
    "biscotti-fwd-${name}" = {
      after = [ "biscotti-net.service" "tailscaled.service" "biscotti-node-index.service" ];
      wants = [ "biscotti-net.service" "biscotti-node-index.service" ];
      wantedBy = [ "multi-user.target" ];
      # `to` may use $k, this node's number.
      script = "k=$(cat /run/biscotti-node-index); exec ${pkgs.socat}/bin/socat TCP-LISTEN:${listen},fork,reuseaddr ${to}";
      serviceConfig = {
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

  # The VM's gate traffic to the gate, the gate's to the VM's ports, and the vms service's API.
  systemd.services = lib.mkMerge (
    [ (forward "vms" "7400" "UNIX-CONNECT:/run/biscotti-vms/vms.sock") ]
    ++ [ (forward "gate" "80,bind=10.200.1.1" "TCP:${node.gate}:$((18100 + k))") ]
    ++ lib.mapAttrsToList (listen: port: forward port listen "TCP:10.200.1.2:${port}") vmPorts
    ++ [ {
      biscotti-node-index = {
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        path = with pkgs; [ curl coreutils ];
        serviceConfig = { Type = "oneshot"; RemainAfterExit = true; Restart = "on-failure"; RestartSec = 5; };
        script = ''
          token=$(curl -sf -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
          curl -sf -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/tags/instance/biscotti-node-index > /run/biscotti-node-index.new
          mv /run/biscotti-node-index.new /run/biscotti-node-index
        '';
      };
      biscotti-node = {
        after = [ "network-online.target" "docker.service" "tailscaled.service" "biscotti-net.service" "biscotti-node-index.service" ];
        wants = [ "network-online.target" ];
        requires = [ "docker.service" "biscotti-net.service" "biscotti-node-index.service" ];
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
          # The first boot joins the tailnet with the Tailscale OAuth client's secret (setup.sh put it in Parameter Store,
          # which only these machines' role reads), used as a pre-approved key for the node tag. Later boots are already in.
          k=$(cat /run/biscotti-node-index)
          if ! tailscale status >/dev/null 2>&1; then
            token=$(curl -sf -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
            region=$(curl -sf -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/placement/region)
            secret=$(aws ssm get-parameter --region "$region" --name /biscotti/node/tailscale --with-decryption --query Parameter.Value --output text)
            tailscale up --auth-key="$secret?ephemeral=false&preauthorized=true" --advertise-tags=tag:biscotti-node --hostname="biscotti-node-$k"
          fi
          tailscale serve --bg --https=10441 http://10.200.1.2:6901
          tailscale serve --bg --https=10541 http://10.200.1.2:8000

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
            -e TASK_UID_BASE=1100 -e VM_SLOTS=1 \
            biscotti/agent node core/src/vms-main.ts
        '';
      };
    } ]
  );

  nix.settings.experimental-features = [ "nix-command" "flakes" ];
  system.stateVersion = "26.05";
}
