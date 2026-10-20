# Built from the repo root (see core/host/compose.yaml). trixie: the host's patched Firecracker is mounted in and
# needs glibc 2.38+.
FROM node:22.23.3-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa
RUN corepack enable
# git: the GitHub plugin clones repos for coding tasks and pushes their branches.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Dependencies from the lockfile alone, so a code change doesn't refetch them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# A stalled download can hang pnpm for good, so each try gets 10 minutes.
RUN for try in 1 2 3; do timeout 600 pnpm fetch --prod && exit 0; done; exit 1
COPY . .
RUN pnpm install --offline --frozen-lockfile --prod
CMD ["node", "core/src/main.ts"]
