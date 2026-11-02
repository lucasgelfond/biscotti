# VM test for apps.nix. Run: nix build .#checks.aarch64-linux.apps
{ pkgs, ... }:
let
  image = pkgs.dockerTools.buildImage {
    name = "app-test";
    tag = "latest";
    copyToRoot = [ pkgs.busybox ];
    config.Cmd = [ "httpd" "-f" "-p" "8080" "-h" "/www" ];
  };
  app = compose: pkgs.writeText "compose.yaml" compose;
in
{
  name = "apps";

  nodes.pi = {
    imports = [ ../apps.nix ];
    virtualisation.docker.enable = true;
    virtualisation.diskSize = 4096;
    virtualisation.memorySize = 2048;
    virtualisation.cores = 4;
    environment.systemPackages = [ pkgs.curl ];
    systemd.services.docker.postStart = "${pkgs.docker}/bin/docker load -i ${image}";
    systemd.tmpfiles.rules = [
      "d /var/lib/biscotti-apps/web/www 0700 root root -"
      "f /var/lib/biscotti-apps/web/www/index.html 0644 root root - hello"
      "L+ /var/lib/biscotti-apps/web/compose.yaml - - - - ${app ''
        services:
          web:
            image: app-test:latest
            pull_policy: never
            ports: ["127.0.0.1:8080:8080"]
            volumes: [./www:/www:ro]
      ''}"
      "d /var/lib/biscotti-apps/nosy 0700 root root -"
      "L+ /var/lib/biscotti-apps/nosy/compose.yaml - - - - ${app ''
        services:
          nosy:
            image: app-test:latest
            pull_policy: never
            volumes: [/var/lib/biscotti:/biscotti:ro]
      ''}"
    ];
  };

  testScript = ''
    pi.wait_for_unit("biscotti-app@web.service")
    pi.wait_until_succeeds("curl -sf http://127.0.0.1:8080/ | grep -q hello", timeout=60)
    container = pi.succeed("docker compose -p app-web ps -q").strip()
    pi.succeed(f"grep -q biscotti-apps.slice /proc/$(docker inspect -f '{{{{.State.Pid}}}}' {container})/cgroup")

    pi.wait_until_succeeds("systemctl is-failed biscotti-app@nosy.service")
    pi.succeed("journalctl -u biscotti-app@nosy.service | grep -q 'nosy: mounts /var/lib/biscotti'")
    pi.fail("docker ps -a --format '{{.Names}}' | grep -q nosy")

    pi.succeed("systemctl restart docker.service")
    pi.wait_until_succeeds("curl -sf http://127.0.0.1:8080/ | grep -q hello", timeout=300)

    pi.succeed("systemctl stop biscotti-app@web.service")
    pi.fail("docker ps -a --format '{{.Names}}' | grep -q web")
  '';
}
