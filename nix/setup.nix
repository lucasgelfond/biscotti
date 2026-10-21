# Brings biscotti up, or up to date, on every boot (a no-op once done): the installer's settings, generated secrets,
# Tailscale, the services for the plugins biscotti.json names, and the task VM snapshot. Texts the owner when they
# need to act, and leaves the agent a text for when biscotti is ready.
{ pkgs, repo, firecracker, faultAll, version, vms, ... }:
{
  systemd.tmpfiles.rules = [
    "d /var/lib/biscotti 0700 root root -"
    "d /var/lib/biscotti/data 0700 root root -"
    # The gate's and the agent's sockets: only the agent (uid 1000) and root get in.
    "d /run/biscotti 0700 1000 1000 -"
    # The gate's and the vms service's.
    "d /run/biscotti-vms 0700 root root -"
  ];

  systemd.services.biscotti-setup = {
    after = [ "network-online.target" "docker.service" "tailscaled.service" "biscotti-net.service" ];
    wants = [ "network-online.target" ];
    requires = [ "docker.service" "biscotti-net.service" ];
    wantedBy = [ "multi-user.target" ];
    path = [ firecracker ] ++ (with pkgs; [ bash coreutils gnugrep gnused jq curl docker tailscale e2fsprogs gnutar util-linux openssl iproute2 ]);
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      TimeoutStartSec = "infinity";
      Restart = "on-failure";
      RestartSec = 30;
    };
    script = ''
      STATE=/var/lib/biscotti
      ENV=$STATE/.env
      touch "$ENV" && chmod 600 "$ENV"
      get() { sed -n "s/^$1=//p" "$ENV"; }
      set_default() { [ -n "$(get "$1")" ] || { sed -i "/^$1=\$/d" "$ENV"; echo "$1=$2" >> "$ENV"; }; }

      # The installer app writes to the boot partition, which anyone with the card can read: move it all off.
      if [ -f /boot/firmware/biscotti.env ]; then
        grep -E '^[A-Z_]+=' /boot/firmware/biscotti.env | while IFS='=' read -r key value; do set_default "$key" "$value"; done
        rm /boot/firmware/biscotti.env
      fi
      [ -f /boot/firmware/biscotti.json ] && mv /boot/firmware/biscotti.json "$STATE/biscotti.json"
      [ -f "$STATE/biscotti.json" ] || cp ${repo}/biscotti.json "$STATE/biscotti.json"
      # Plugins biscotti turned on by default after this machine was set up are turned on here too; ones the owner turned
      # off stay off. (Before this list was kept, the defaults were the first six.)
      seen=$STATE/plugins-seen
      [ -f "$seen" ] || printf '%s\n' channels/spectrum exa google github artifacts embedding > "$seen"
      for p in $(jq -r '.plugins[]' ${repo}/biscotti.json); do
        grep -qx "$p" "$seen" && continue
        jq --arg p "$p" '.plugins |= if index($p) then . else . + [$p] end' "$STATE/biscotti.json" > "$STATE/biscotti.json.new"
        mv "$STATE/biscotti.json.new" "$STATE/biscotti.json"
        echo "$p" >> "$seen"
      done
      # Or the settings are copied in over SSH (cloud): wait for them.
      [ -n "$(get AI_GATEWAY_API_KEY)" ] && set_default LLM_API_KEY "$(get AI_GATEWAY_API_KEY)"
      until [ -n "$(get LLM_API_KEY)" ]; do echo "waiting for settings in $ENV"; sleep 10; done
      set_default LLM_BASE_URL https://ai-gateway.vercel.sh/v1
      set_default MODEL deepseek/deepseek-v4.1-flash-1017-fast
      set_default TASK_MODEL "$(get MODEL)"
      set_default TZ America/New_York
      set_default DB_KEY "$(openssl rand -hex 32)"
      set_default FIRECRACKER_BIN ${firecracker}/bin/firecracker
      # The installer picks a free name, so it can show the Google redirect URI upfront.
      set_default TS_HOSTNAME biscotti

      # A Pi has no clock battery: until NTP sets the time, every TLS certificate looks invalid.
      until [ "$(timedatectl show -p NTPSynchronized --value)" = yes ]; do sleep 2; done
      docker build -q -t biscotti/agent -f ${repo}/core/Dockerfile ${repo} >/dev/null
      notify() { docker run --rm --network host --env-file "$ENV" biscotti/agent node plugins/channels/spectrum/notify.ts "$1" || true; }

      # Tailscale: text the owner the login link.
      if ! tailscale status >/dev/null 2>&1; then
        tailscale up --hostname="$(get TS_HOSTNAME)" > "$STATE/tailscale-up.log" 2>&1 &
        until url=$(grep -o 'https://login.tailscale.com/[^ ]*' "$STATE/tailscale-up.log"); do sleep 1; done
        notify "Hi, it's biscotti! To finish setting me up, open this link and add me to your Tailscale: $url"
        until tailscale status >/dev/null 2>&1; do sleep 5; done
      fi
      set_default TAILNET_HOST "$(tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")')"

      # What the owner opens, on the tailnet: each VM slot's desktop, the vault's forms and pages. Artifacts are public
      # (Funnel) under unguessable names, so iMessage can show link previews; nothing else is.
      plugins=$(jq -r '.plugins[]' "$STATE/biscotti.json")
      has() { grep -qx "$1" <<< "$plugins"; }
      for n in $(seq ${toString vms.slots}); do tailscale serve --bg --https=$((10440 + n)) "http://10.200.$n.2:6901"; done
      # The vault's one-time forms, and Google's and other services' sign-in callbacks.
      tailscale serve --bg --https=9443 http://127.0.0.1:4791
      if has google; then tailscale serve --bg --https=9443 --set-path=/oauth http://127.0.0.1:4792; fi
      if has mcp; then tailscale serve --bg --https=9443 --set-path=/mcp-oauth http://127.0.0.1:4793; fi
      if has artifacts; then tailscale funnel --bg --https=443 http://127.0.0.1:8082; fi

      # Huge pages reserved (the Mac): task VMs run on them.
      huge=$([ "$(cat /proc/sys/vm/nr_hugepages)" -gt 0 ] && echo 2M || true)
      # Rebuilt when the VM's source (the task agent or the desktop) or its memory changes.
      vm_source=$({ cd ${repo}/core/vm && find . -type f | sort | xargs sha256sum; echo ${toString vms.memMiB}; } | sha256sum | cut -d' ' -f1)
      if [ ! -f "$STATE/vm/desktop.snap" ] || [ "$(cat "$STATE/vm/source" 2>/dev/null)" != "$vm_source" ]; then
        rm -f "$STATE/vm/desktop.snap"
        # The warm VMs hold the slots' network devices the build boots on; compose starts them again below.
        docker stop biscotti-vms-1 2>/dev/null || true
        VM_MEM_MIB=${toString vms.memMiB} HUGE_PAGES=$huge FC_BIN=${firecracker}/bin/firecracker ${repo}/core/vm/snapshots.sh "$STATE/vm"
        echo "$vm_source" > "$STATE/vm/source"
      fi
      # The gate, the agent and the vms service, plus the services of the plugins that bring one. Nix-built binaries
      # mounted into the vms service (the patched Firecracker) load their libraries from the Nix store.
      {
        echo "include:"
        for p in $plugins; do [ -f "${repo}/plugins/$p/compose.yaml" ] && echo "  - ${repo}/plugins/$p/compose.yaml"; done
        echo "services:"
        echo "  gate:"
        echo "    environment: { VM_SLOTS: \"${toString vms.slots}\" }"
        echo "  vms:"
        echo "    volumes: [ /nix/store:/nix/store:ro ]"
        echo "    environment: { VM_SLOTS: \"${toString vms.slots}\"''${huge:+, UFFD_HANDLER: ${faultAll}/bin/fault-all} }"
        [ -z "$huge" ] || echo "    devices: [ /dev/userfaultfd ]"
      } > "$STATE/compose.plugins.yaml"
      # The agent texts it once it's listening (from here, a second Photon connection would take its messages away).
      if [ ! -f "$STATE/ready" ]; then
        echo "I'm all set up. Text me anything!" > "$STATE/data/welcome"
        touch "$STATE/ready"
      elif [ "$(cat "$STATE/version" 2>/dev/null)" != ${version} ]; then
        echo "I updated myself to biscotti v${version}. Your memory and settings are as they were." > "$STATE/data/welcome"
      fi
      echo ${version} > "$STATE/version"
      docker compose --env-file "$ENV" -f ${repo}/core/host/compose.yaml -f "$STATE/compose.plugins.yaml" up -d --build --remove-orphans

    '';
  };
}
