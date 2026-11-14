# Cloud machines on AWS

Machines that run only task VMs and boxes, for when the biscotti host's slots are all busy. They hold no keys and no
data: their VMs reach the model and tools through the host's gate over Tailscale. The gate launches them from the
`biscotti-node` launch template as it needs them, up to `NODE_MAX` (4); starts and stops them, stopping each after
`NODE_IDLE_MIN` (15) idle minutes; and never terminates them, so each keeps its disk (kept tasks, the VM snapshot) and its
Tailscale name. Machine k is `biscotti-node-k` and holds slots 100k+1 to 100k+`NODE_SLOTS` (4).

How the pieces talk (all over Tailscale):

- The gate calls machine k's vms service at `biscotti-node-k:7400`.
- The gate reaches slot N's VM ports there: task agent 14000+N, cua-spacesd 13200+N, noVNC 16900+N, Chromium DevTools
  19200+N, a box's sshd 12200+N. The live desktop is `https://biscotti-node-k:10440+N`.
- Slot 100k+N's VM reaches the gate at `<gate>:18000+100k+N`, a listener that only takes machine k's address.

## Tailscale

1. In the admin console's access controls, with the host tagged `tag:biscotti`:
   ```jsonc
   "tagOwners": { "tag:biscotti-node": ["autogroup:admin"] },
   "grants": [
     { "src": ["tag:biscotti"], "dst": ["tag:biscotti-node"], "ip": ["tcp:7400", "tcp:12201-12299", "tcp:13201-13299", "tcp:14001-14099", "tcp:16901-16999", "tcp:19201-19299"] },
     { "src": ["tag:biscotti-node"], "dst": ["tag:biscotti"], "ip": ["tcp:18101-18499"] },
     { "src": ["autogroup:member"], "dst": ["tag:biscotti-node"], "ip": ["tcp:10441-10499", "tcp:12201-12299"] }
   ]
   ```
2. Create an OAuth client with the **Auth Keys: write** scope and the tag `tag:biscotti-node`; its ID and secret go in the
   host's `.env` as `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_CLIENT_SECRET`. Before launching machine k, the gate makes one
   single-use, pre-approved key and puts it in Parameter Store (`/biscotti/node/k/tailscale-key`), where only the
   machines' instance role can read it.

## AWS

With the AWS CLI signed in as an admin of the account:

```sh
installer/aws/node-setup.sh us-east-1 biscotti.tail1234.ts.net <commit> m8i.xlarge
```

It makes the machines' instance role, a security group with no inbound rules, the launch template (nested
virtualization, instance tags readable from inside, 100 GB gp3), and the gate's IAM user, which may only launch, start,
stop and terminate instances tagged `biscotti-role=node`. It prints the settings for the host's `.env`; restart biscotti
after adding them. `m8i.xlarge` (16 GB) holds 4 slots of 2.5 GB.

A new machine builds its VM image and snapshot first (about 20 minutes), so the first task sent to it waits; later
starts take a minute or two. To remove one, terminate it in the console and delete its line from
`/var/lib/biscotti/data/nodes.json`.
