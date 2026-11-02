# Compose apps the owner places on this machine, one directory each: /var/lib/biscotti-apps/<name>/compose.yaml, with
# its .env beside it. Each runs as its own Docker project (app-<name>) with its own network, can't mount anything
# outside its directory (apps-check.jq), and all of them share one budget below biscotti's. With no apps, nothing runs.
{ pkgs, ... }:
let
  dir = "/var/lib/biscotti-apps";
  compose = ''compose() { docker compose -p "app-$APP" --project-directory "${dir}/$APP" -f "${dir}/$APP/compose.yaml" "$@"; }'';
in
{
  systemd.tmpfiles.rules = [ "d ${dir} 0700 root root -" ];

  # Every app's containers together: what a Pi 5 has left beside biscotti and its task VMs, and biscotti first for CPU.
  systemd.slices.biscotti-apps.sliceConfig = {
    MemoryMax = "2G";
    CPUWeight = 50;
  };

  # Up while active. A biscotti upgrade or rebuild leaves running apps alone; `systemctl restart biscotti-app@<name>`
  # applies an app's changed compose.yaml, `systemctl stop` takes it down (its volumes stay).
  systemd.services."biscotti-app@" = {
    description = "biscotti app %i";
    after = [ "docker.service" "network-online.target" ];
    requires = [ "docker.service" ];
    wants = [ "network-online.target" ];
    path = [ pkgs.docker pkgs.jq ];
    environment.APP = "%i";
    restartIfChanged = false;
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      TimeoutStartSec = "30min";
    };
    script = ''
      ${compose}
      [[ $APP =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || { echo "app names are lowercase letters, digits and dashes"; exit 1; }
      config=$(compose config --no-env-resolution --format json)
      problems=$(jq -r --arg dir "${dir}/$APP" -f ${./apps-check.jq} <<< "$config")
      [ -z "$problems" ] || { echo "$problems"; exit 1; }
      jq '{services: .services | map_values({cgroup_parent: "biscotti-apps.slice"})}' <<< "$config" > "/run/biscotti-app-$APP.json"
      compose -f "/run/biscotti-app-$APP.json" up -d --remove-orphans
    '';
    preStop = ''
      ${compose}
      compose down
    '';
  };

  # Every app placed here, whenever Docker starts: at boot, and again after Docker restarts or comes up late.
  systemd.services.biscotti-apps = {
    description = "biscotti apps";
    after = [ "docker.service" ];
    wantedBy = [ "docker.service" ];
    serviceConfig.Type = "oneshot";
    script = ''
      shopt -s nullglob
      for app in ${dir}/*/compose.yaml; do systemctl start --no-block "biscotti-app@$(basename "$(dirname "$app")").service"; done
    '';
  };
}
