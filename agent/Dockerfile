# trixie: the host's patched Firecracker is mounted in and needs glibc 2.38+.
FROM node:22.23.3-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY SYSTEM.md ./
COPY drizzle drizzle
COPY src src
CMD ["node", "src/main.ts"]
