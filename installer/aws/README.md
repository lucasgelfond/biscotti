# biscotti on AWS

Task VMs are Firecracker, which needs KVM: the server must be bare metal or a VM with nested virtualization. These
steps are written to be followed click by click, by you or a browser agent (Claude for Chrome and the like).

## Your settings

Every path ends the same way: a NixOS machine that waits, on first boot, for your settings in
`/var/lib/biscotti/.env`. Fill a copy of [`core/host/.env.example`](../../../core/host/.env.example) on your computer:

- `LLM_BASE_URL` (any OpenAI-compatible API) and `LLM_API_KEY`, `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`, `OWNER` (your number, e.g. `+15551234567`)
- Plugins you enable in `biscotti.json`: `EXA_API_KEY`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `GITHUB_TOKEN`
- Generated on first boot, leave out: `DB_KEY`, `TAILNET_HOST`, `FIRECRACKER_BIN`

Copy it in once over SSH (below); afterwards edit the file in place, since it then holds the generated `DB_KEY`.
Settings never go in user data: that's readable by anyone with EC2 describe access and by every process on the
instance. Nothing listens on the internet except SSH; biscotti is reached over Tailscale.

## Launch

Nested virtualization works on virtual C7i/M7i/R7i, C8i/M8i/R8i and I7i instances. `m8i.large` (2 vCPU, 8 GB, about
$0.14/hour) is enough. The official NixOS AMI applies its user data as `configuration.nix` on first boot, so the user
data is [`user-data.nix`](user-data.nix), which pulls in this repo's `aws`
configuration.

1. Open https://console.aws.amazon.com/ec2/ and pick a region near you (top right).
2. Click **Launch instance**. Name: `biscotti`.
3. Under **Application and OS Images**, click **Browse more AMIs** → **Community AMIs**, search `nixos/26.05`, and
   select the newest **x86_64** image whose owner is `427812963091`.
4. **Instance type**: `m8i.large`.
5. **Key pair**: **Create new key pair**, name `biscotti`, type ED25519, `.pem`. Save the downloaded file.
6. **Network settings**: **Allow SSH traffic** only (leave HTTP/HTTPS unchecked).
7. **Configure storage**: 40 GiB gp3.
8. Expand **Advanced details**. Set **Nested virtualization** to **Enable**. In **User data**, paste the contents of
   `installers/setup/aws/user-data.nix` with `REV` replaced by a commit of this repo (the repo is private for now, so the
   download fails until it's public; until then use the AMI below).
9. Click **Launch instance**, then **View all instances**, and copy the instance's **Public IPv4 address**.
10. On your computer, copy your settings in (replace `IP`):
    ```sh
    ssh -i ~/Downloads/biscotti.pem root@IP 'mkdir -p /var/lib/biscotti && umask 077 && cat > /var/lib/biscotti/.env' < my.env
    ```
11. Wait (~20 minutes) for a text with a Tailscale link, open it, approve the machine. A "ready" text follows.

**A ready AMI instead:** `nix build .#packages.x86_64-linux.aws-image` (on an x86_64 Linux machine or builder)
builds a VHD with biscotti built in. Upload it to S3, import it in **EC2 → Snapshots → Actions → Import snapshot**
(or `aws ec2 import-snapshot`), register an AMI from the snapshot (**Actions → Create image from snapshot**, boot mode
UEFI-preferred), and launch it as above without user data.

## Other providers

AWS only, for now. GCP (Intel VMs), Azure (Dv5/Ev5) and bare metal (Hetzner dedicated, OVH) also expose KVM and
could get a target later; Hetzner Cloud, Linode, Fly.io and Railway can't run Firecracker.

## Without KVM

Not built. It would run the task desktop as a container (Docker, or gVisor for isolation) instead of a Firecracker VM:
the same Debian image, started per task, behind the same gate network rules. It works on any VPS but loses snapshots
(each task cold-starts the desktop and pi, ~10–20 s instead of ~1 s) and the VM boundary.
