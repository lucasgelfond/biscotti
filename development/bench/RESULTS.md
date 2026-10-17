# Sandbox runtime bake-off

Hardware: Raspberry Pi 5 (8 GB), Ubuntu Server 24.04.5 arm64, **64 GB microSD**
(slow I/O; NVMe numbers will be better). Docker 29.9.1, gVisor release-20261012.0,
Firecracker v1.17.0 with CI guest kernel 6.1.155.

Image: `biscotti/cua-desktop:dev` (`cua-vm/Dockerfile`): XFCE, TigerVNC, noVNC,
Firefox ESR, cua-spacesd. 1.41 GB on disk, 353 MB compressed.

## Results

"Ready" = `docker run` until X, noVNC and cua-spacesd all respond (`bench/ready.sh`).
It includes a fixed `sleep 5` in Cua's noVNC start script, so the desktop itself
is ready ~5 s sooner. Firefox = cold `firefox-esr --headless --screenshot <url>`.

| Runtime | Ready | Idle RAM | Firefox example.com | Firefox Wikipedia | RAM after Firefox |
|---|---|---|---|---|---|
| Docker (runc) | 7.3 s | 145 MB | 2.5 s | 3.0 s | 175 MB |
| gVisor (runsc, systrap) | 8.0 s | 195 MB | 3.2 s | 4.3 s | 258 MB |
| Firecracker (raw), cold boot | 7.3 s | (1 GB VM) | — | — | — |
| **Firecracker, snapshot restore** | **0.27–0.31 s warm cache, 0.45 s cold** | — | — | — | — |
| microsandbox | — | — | — | — | — |

Firecracker details: 2 vCPU, 1024 MiB, tap networking, rootfs = `docker export` of
the same image → ext4 (`cua-vm/rootfs.sh`, 47 s to build, 1.1 GB used of 3 GB).
Snapshot creation took 19 s (1 GB memory file written to SD). Restore loads
memory lazily, so the SD card barely matters for restore.

## Beliefs (updated as we go)

- **Firecracker snapshot restore is the cold-start answer:** a booted desktop in
  ~0.3 s, ~25× faster than any cold boot. It works on the Pi 5 (GICv2, KVM).

- **gVisor works on the Pi with the full desktop** (Ubuntu kernel, 48-bit VA).
  It costs ~30–40% more on browser work and ~50% more RAM than runc. Acceptable.
- **The desktop is light:** ~150–260 MB per sandbox while browsing simple pages,
  far below the 1–2 GB I estimated. The Pi could hold several warm sandboxes.
- **Boot time is dominated by Cua's fixed sleeps**, not the runtime. Trimming
  `start-novnc.sh`'s `sleep 5` (we don't need noVNC for the agent) is the
  biggest cheap win.
- **Wi-Fi was the first real bottleneck**, not compute: 2.4 GHz gave
  0.15–0.7 MB/s, 5 GHz gives ~21 MB/s (Mac on the same network: ~52 MB/s).
- Earlier wrong beliefs: "Firecracker lacks GICv2" (it merged in 2019);
  "the Pi can't use DFS channels" (it can; the real cause was an SSID typo).
