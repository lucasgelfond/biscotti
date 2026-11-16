# Firecracker for the task VMs, and the huge-page snapshot loader: shared by the biscotti host and overflow machines.
{ pkgs, self }:
{
  # On ARM, Firecracker with the GICv2 snapshot-restore fixes (lucasgelfond/firecracker@biscotti-gicv2, upstream
  # #6300 and #6301), which the Pi 5's interrupt controller needs. Stock on x86.
  firecracker = if !pkgs.stdenv.hostPlatform.isAarch64 then pkgs.firecracker else pkgs.firecracker.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ [
      (pkgs.fetchpatch {
        url = "https://github.com/lucasgelfond/firecracker/compare/e786ba84fd5e0db878392a6a1f234e1b17fcaeb2...4f39c49fbe249592ccfb9ab20f29850ca1a66df7.diff";
        excludes = [ "CHANGELOG.md" ];
        hash = "sha256-1MLhwa9oqDYIxn/j3tdHcGBVKVBr9W03ncVVFzUXLvM=";
      })
    ];
  });
  # Loads a huge-page snapshot into a restored VM (core/src/tasks.ts).
  faultAll = pkgs.runCommandCC "fault-all" { } "mkdir -p $out/bin && $CC -O2 -o $out/bin/fault-all ${self}/core/vm/uffd/fault-all.c";
}
