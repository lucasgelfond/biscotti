# An overflow machine on AWS

A second machine that runs only task VMs, for when the biscotti host's slots are all busy. It holds no keys and no
data: its VMs reach the model and tools through the host's gate over Tailscale. The gate starts it (EC2
StartInstances) when it needs a slot, and stops it after `NODE_IDLE_MIN` (15) minutes with nothing running. Tasks
kept for follow-ups stay on its disk while it's stopped; a follow-up starts it again. Its slots are numbered from 101.

How the pieces talk (all over Tailscale):

- The gate calls the node's vms service at `NODE_HOST:7400` (restore, suspend, resume, stop).
- The gate reaches slot N's VM ports at `NODE_HOST`: task agent 14000+N, cua-spacesd 13200+N, noVNC 16900+N,
  Chromium DevTools 19200+N. The live desktop is `https://NODE_HOST:10440+N` (`tailscale serve` on the node).
- Slot N's VM reaches the gate at `<gate>:18100+N`, a listener per slot that only takes the node's address.

## Tailscale

1. In the admin console's access controls, add the tag and let the two machines (and only them) reach these ports.
   With the host tagged `tag:biscotti` (or use its address):
   ```jsonc
   "tagOwners": { "tag:biscotti-node": ["autogroup:admin"] },
   "grants": [
     { "src": ["tag:biscotti"], "dst": ["tag:biscotti-node"], "ip": ["tcp:7400", "tcp:14001-14099", "tcp:13201-13299", "tcp:16901-16999", "tcp:19201-19299"] },
     { "src": ["tag:biscotti-node"], "dst": ["tag:biscotti"], "ip": ["tcp:18101-18199"] },
     { "src": ["autogroup:member"], "dst": ["tag:biscotti-node"], "ip": ["tcp:10441-10499"] }
   ]
   ```
2. Create an OAuth client (Settings → OAuth clients, or Trust credentials) with the **Auth Keys: write** scope and
   the tag `tag:biscotti-node`. Its ID and secret go in the host's `.env` as `TS_OAUTH_CLIENT_ID` and
   `TS_OAUTH_CLIENT_SECRET`. The gate uses it only to make one single-use, pre-approved key the first time it starts
   the node, and puts that key in Parameter Store (`/biscotti/node/tailscale-key`), where only the node's instance
   role can read it. The node logs in with it once and stays logged in across stops.

## AWS

With the AWS CLI signed in as an admin of the account:

```sh
installer/aws/node-setup.sh us-east-1 biscotti.tail1234.ts.net <commit> m8i.xlarge
```

It makes the node's instance role, the gate's IAM user (start, stop and describe this instance; write that one
parameter), and the instance (nested virtualization on, no inbound ports, 100 GB gp3, then stopped), and prints the
settings to add to the host's `.env`. `m8i.xlarge` (16 GB) holds 4 slots of 2.5 GB; set `slots` in
`node-user-data.nix` to match a different size. Restart biscotti on the host after editing `.env`.

The first start builds the VM image and snapshot on the node (about 20 minutes), so the first task sent there waits;
later starts take a minute or two.
