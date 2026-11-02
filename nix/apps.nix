# Runs each compose app in /var/lib/biscotti-apps/<name>/. Does nothing when there are none.
{ pkgs, ... }:
let
  dir = "/var/lib/biscotti-apps";
  compose = ''compose() { docker compose -p "app-$APP" --project-directory "${dir}/$APP" -f "${dir}/$APP/compose.yaml" "$@"; }'';
in
{
  systemd.tmpfiles.rules = [ "d ${dir} 0700 root root -" ];

  # Shared limit for all apps.
  systemd.slices.biscotti-apps.sliceConfig = {
    MemoryMax = "2G";
    CPUWeight = 50;
  };

  # Not restarted by upgrades. Restart to apply changes; stop keeps volumes.
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

  # Starts every app whenever Docker starts.
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
