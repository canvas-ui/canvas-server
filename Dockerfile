# syntax=docker/dockerfile:1

# Canvas Server image.
#
# Build:  npm run docker:build      (or: docker compose build)
# Run:    npm run docker:up         (or: docker compose up -d)
#
# Debian slim rather than Alpine on purpose: lmdb and onnxruntime-node ship
# prebuilt glibc binaries, so the image builds without compiling native addons
# from source (musl has no prebuilds for onnxruntime).
ARG NODE_VERSION=22

# ── Build stage ─────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS builder

WORKDIR /opt/canvas-server

# Toolchain for the native modules that have no prebuild for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# The repo is a workspace root — every workspace manifest has to be present for
# `npm ci`, so the source is copied before installing (see .dockerignore for
# what is kept out).
COPY . .

# postinstall builds the web UI, which needs the workspaces' devDependencies.
# The cache mount matters here: the native deps (onnxruntime-node, lmdb) pull a
# few hundred MB of prebuilt binaries — without it every rebuild re-downloads
# them. First build slow, every one after that fast.
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci
# …and the runtime does not, so drop them again before they are copied out.
RUN npm prune --omit=dev

# ── Runtime stage ───────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# curl: healthcheck. openssl: JWT secret generation in the entrypoint.
# git: the workspace dotfile/git service shells out to it.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl openssl git tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/canvas-server
COPY --from=builder /opt/canvas-server ./

# Container-internal layout. Both trees are meant to be bind-mounted from the
# host (see docker-compose.yml) — nothing below them survives a rebuild.
ENV NODE_ENV=production \
    CANVAS_SERVER_HOME=/opt/canvas-server/server \
    CANVAS_USER_HOME=/opt/canvas-server/users \
    CANVAS_API_HOST=0.0.0.0 \
    CANVAS_WEB_HOST=0.0.0.0 \
    HOME=/tmp

# The entrypoint is executable regardless of how the repo was checked out
# (git tracked it as 0644, and Windows/zip checkouts drop the bit entirely).
RUN chmod +x bin/*.sh

RUN mkdir -p server users && chmod 777 server users

# Never root by default. compose overrides this with the HOST user's uid:gid
# (CANVAS_UID/CANVAS_GID), which is what makes a bind-mounted ~/Workspaces
# writable without a chown dance — everything the app needs at runtime is
# world-readable, so any uid works.
USER node

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -fsS http://localhost:${CANVAS_API_PORT:-8001}/rest/v2/ping || exit 1

# tini reaps the processes hooks/roles spawn.
ENTRYPOINT ["/usr/bin/tini", "--", "bin/start-server.sh"]
CMD ["node", "./src/init.js"]
