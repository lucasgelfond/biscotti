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

### Firefox, same script everywhere (`firefox-in-vm.sh`, fresh profile per run)

After removing Cua's fixed sleeps (`start-novnc.sh` `sleep 5` → readiness poll): **runc desktop ready 3.6 s** (was 7.3 s);
gVisor still 8.1 s (its own overhead: empty-container start+exit 1.7 s, `docker exec` 0.22 s; XFCE/Xvnc start
slower under syscall interception). Firecracker cold boot 4.6 s.

| Runtime | example.com ×2 | Wikipedia ×2 |
|---|---|---|
| Docker (runc) | 3.5, 3.9 s | 5.5, 5.8 s |
| **Firecracker 2 vCPU / 1 GiB** | **2.7, 2.5 s** | **4.3, 5.6 s** |
| Firecracker 4 vCPU / 2 GiB | 8.0 (overlapped desktop start), 3.3 s | 6.6, 6.4 s |
| gVisor (runsc, systrap) | 13.3, 15.4 s | 12.3, 8.2 s |
| microsandbox 0.7.8 (shared profile, earlier run) | 7.9 s | 10.5 s |

### microsandbox (libkrun) on the Pi
- Runs the same image (`docker save | msb load`, 19 s): desktop ready 12.2 s, 163 MiB of 512 MiB.
- **Full snapshots and forks are refused on GICv2:** `ARM execution-state capture requires VGICv3; this
  controller does not expose complete interrupt state`. Cold boot only on the Pi.
- Firefox is slow (virtio-fs rootfs).

### gVisor checkpoint/restore via Docker
`docker checkpoint create` works (15.9 s); `docker start --checkpoint` fails (`bind-mount /proc/0/ns/net …
no such file`). gVisor's docs call Docker C/R support partial; using `runsc` directly would be needed.

## Beliefs (updated as we go)

- **Firecracker is the runtime.** Firefox in a 2-vCPU VM is as fast as plain Docker and 2–4× faster than gVisor
  on file-heavy work. Plus a hardware isolation boundary and (once restore is fixed) ~0.3 s clean resets.
- **gVisor's cost is file I/O and syscalls**, not just startup: 8–15 s fresh-profile Firefox versus 3.5–5.8 s.
  It's the portable fallback (no KVM), not the default.
- **The restore freeze is a Firecracker GICv2 bug:** banked SGI/PPI distributor state (IRQs 0–31, incl. the
  timer PPI 27) isn't saved, so restored guests get no timer interrupts (heartbeat stops). Patch in
  `development/firecracker-gicv2/`. microsandbox refusing GICv2 snapshots corroborates it.
- 2 vCPUs is the right VM size on the 4-core Pi; 4 vCPUs doesn't help.


- **Firecracker snapshot restore is fast but not yet usable on the Pi.** It gives a
  booted VM in ~0.3 s and a first screenshot in ~0.7 s, but after restore the **GUI
  apps freeze**: the XFCE panel clock and Firefox stop updating and ignore input.
  The kernel, networking, Xvnc (serves frames) and websockify (HTTP 200 in ~10–20 ms
  after one ~5 s stall) keep working. Same with 1 vCPU, so it isn't SMP/GICv2 IPIs.
  Suspects: the guest clock jumping across the restore (timers / CLOCK_REALTIME),
  D-Bus, or the CI guest kernel's config. Needs a deeper dig.
- **Firefox renders a black page inside the Firecracker VM** even on a fresh boot
  (input and navigation work, so the title changes). Fine in Docker/gVisor.
  Probably the graphics path (WebRender / SHM); try `MOZ_WEBRENDER=0` or
  software GL.
- **A restored VM wakes up with the snapshot's wall clock.** It must be resynced
  after each restore (or HTTPS certificate checks break).
- **Cold-booted Firecracker works** (7.3 s, same as Docker), including outbound
  networking once FORWARD rules allow the tap (Docker sets FORWARD to DROP).

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
