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

# Source identity for the AGPL §13 offer. `.git/` is excluded from the build
# context (.dockerignore), so the image cannot work the revision out for itself
# and has to be told at build time — compose passes it from `git rev-parse HEAD`.
# A fork MUST override CANVAS_SOURCE_URL to point at the repository publishing
# its changes; leaving it pointed upstream while running modified code does not
# satisfy the licence.
ARG CANVAS_SOURCE_COMMIT=""
ARG CANVAS_SOURCE_URL="https://github.com/canvas-ui/canvas-server"
ENV CANVAS_SOURCE_COMMIT=${CANVAS_SOURCE_COMMIT} \
    CANVAS_SOURCE_URL=${CANVAS_SOURCE_URL}

# Container-internal layout: everything the instance owns lives under data/, as
# two sibling roots that are bind-mounted from the host (see docker-compose.yml)
# — server/ is runtime state, users/ is the users' own content, one subtree each.
# Siblings on purpose: mounting one THROUGH the other hides host paths and makes
# docker create the mountpoints as root.
ENV NODE_ENV=production \
    CANVAS_SERVER_HOME=/opt/canvas-server/data/server \
    CANVAS_USER_HOME=/opt/canvas-server/data/users \
    CANVAS_API_HOST=0.0.0.0 \
    CANVAS_WEB_HOST=0.0.0.0 \
    HOME=/tmp

# The entrypoint is executable regardless of how the repo was checked out
# (git tracked it as 0644, and Windows/zip checkouts drop the bit entirely).
RUN chmod +x bin/*.sh

# Both roots are bind-mounted from the host at runtime; this only makes the
# mountpoints exist and stay writable for whatever uid compose picks. A per-user
# mount lands on data/users/<email>, i.e. inside the image, not inside another bind.
RUN mkdir -p data/server data/users && chmod -R 777 data

# Never root by default. compose overrides this with the HOST user's uid:gid
# (CANVAS_UID/CANVAS_GID), which is what makes a bind-mounted ~/Canvas
# writable without a chown dance — everything the app needs at runtime is
# world-readable, so any uid works.
USER node

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -fsS http://localhost:${CANVAS_API_PORT:-8001}/rest/v2/ping || exit 1

# tini reaps the processes hooks/roles spawn.
ENTRYPOINT ["/usr/bin/tini", "--", "bin/start-server.sh"]
CMD ["node", "./src/init.js"]
