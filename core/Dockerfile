# Built from the repo root (see core/host/compose.yaml). trixie: the host's patched Firecracker is mounted in and
# needs glibc 2.38+.
FROM node:22.23.3-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa
RUN corepack enable
# git: the GitHub plugin clones repos for coding tasks and pushes their branches. ssh: the gate runs pi-env's daemon in
# task VMs (vm-env.ts).
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Dependencies from the lockfile alone, so a code change doesn't refetch them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# A stalled download can hang pnpm for good, so each try gets an hour: enough for the largest package (Claude Code's
# binary, ~100 MB) on a slow connection. The store is a build cache, so a try (or the next build) carries on from the
# packages the last one finished.
# pi-durable-ahp comes from a private GitHub repo, over ssh with the read-only deploy key the build mounts (compose.yaml's
# build.ssh), checked against GitHub's own host key.
RUN mkdir -p -m 700 /root/.ssh && echo "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl" > /root/.ssh/known_hosts
RUN --mount=type=ssh --mount=type=cache,id=pnpm-store,target=/pnpm-store for try in 1 2 3; do timeout 3600 pnpm fetch --prod --store-dir /pnpm-store && exit 0; done; exit 1
COPY . .
RUN --mount=type=ssh --mount=type=cache,id=pnpm-store,target=/pnpm-store pnpm install --offline --frozen-lockfile --prod --store-dir /pnpm-store --package-import-method copy
CMD ["node", "core/src/main.ts"]
