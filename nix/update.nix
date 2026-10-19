# Weekly, the newest release tag (vX.Y.Z), when it's newer than what's running: the system is rebuilt in place, and
# everything in /var/lib/biscotti (memory, the vault, settings) stays. Setup texts the owner once the new version is up.
{ config, pkgs, version, target, ... }:
{
  systemd.services.biscotti-upgrade = {
    description = "biscotti update to the newest release";
    path = [ config.system.build.nixos-rebuild config.nix.package pkgs.git pkgs.coreutils pkgs.gnused ];
    # A switch mustn't restart the update that's running it.
    restartIfChanged = false;
    unitConfig.X-StopOnRemoval = false;
    serviceConfig.Type = "oneshot";
    startAt = "Sun 04:00";
    script = ''
      latest=$(git ls-remote --tags --refs https://github.com/lucasgelfond/biscotti 'v*' \
        | sed -n 's|.*refs/tags/v\([0-9]*\.[0-9]*\.[0-9]*\)$|\1|p' | sort -V | tail -1)
      [ -n "$latest" ] && [ "$latest" != ${version} ] || exit 0
      [ "$(printf '%s\n%s\n' ${version} "$latest" | sort -V | tail -1)" = "$latest" ] || exit 0
      nixos-rebuild switch --flake "github:lucasgelfond/biscotti/v$latest#${target}"
    '';
  };
  # Run at the next boot when the Pi was off on Sunday morning.
  systemd.timers.biscotti-upgrade.timerConfig.Persistent = true;
}
