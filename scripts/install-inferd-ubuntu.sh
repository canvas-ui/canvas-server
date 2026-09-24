#!/usr/bin/env bash
#
# Canvas Inferd — install and supervise the inference daemon on Ubuntu.
#
#     sudo ./scripts/install-inferd-ubuntu.sh
#     sudo ./scripts/install-inferd-ubuntu.sh --branch main --cuda
#     sudo ./scripts/install-inferd-ubuntu.sh --unit-only
#
# canvas-inferd is deliberately NOT a dependency of canvas-server: it is a
# separate process with its own dependency tree, which is what keeps the native
# model runtime (onnxruntime, transformers.js) and its CUDA postinstall out of
# the API server's install. See docs/inferd-split.md.
#
# This script therefore owns the whole inference side of a deployment:
#   1. install the `canvas-inferd` binary globally from git
#   2. create the model cache directory
#   3. write a starter config if there is none (the unit passes --config, and
#      the daemon EXITS if that file is unreadable — so it must exist)
#   4. write, enable and start the canvas-inferd.service unit
#
# It is safe to re-run: an existing config is never overwritten, and the unit is
# rewritten only with --force-unit.
#
# Nothing here is required for canvas-server to run. Without the daemon the
# server boots normally, logs a warning, indexes documents, and degrades dense
# search to keyword search.
#
# Flags:
#       --root PATH       canvas-server root (default: /opt/canvas-server)
#       --user NAME       service user (default: canvas)
#       --group NAME      service group (default: www-data)
#       --branch REF      canvas-inferd git ref to install (default: main)
#       --socket PATH     unix socket to listen on (default: /run/canvas/inferd.sock)
#       --cache-dir PATH  model cache (default: <serverHome>/inferd/models)
#       --config PATH     daemon config (default: <serverHome>/config/inferd.json)
#       --env-file PATH   read settings from this .env instead of <repo>/.env
#       --no-env          ignore the .env entirely; flags and defaults only
#       --enable          install even when CANVAS_INFERD_ENABLED is off, and
#                         write that key back as true
#       --cuda            let onnxruntime-node fetch CUDA binaries (default: skipped)
#       --unit-only       binary is already installed; only write/refresh the unit
#       --force-unit      overwrite an existing canvas-inferd.service
#       --no-start        install and enable, but do not start the daemon
#   -h, --help
#
# Settings resolve flag > environment variable > .env > default.
#
# The environment variables are CANVAS_ROOT, CANVAS_USER, CANVAS_GROUP,
# INFERD_REPO_TARGET_BRANCH, CANVAS_SERVER_HOME, CANVAS_INFERD_SOCKET,
# CANVAS_INFERD_CACHE_DIR and CANVAS_INFERD_CONFIG — so install-ubuntu.sh can
# hand its own settings through unchanged.
#
# The .env is the same file install-docker.sh / install-local.sh write, read
# with the same helper (scripts/lib/install-common.sh), so an existing
# deployment is picked up rather than a second one invented beside it:
#
#   CANVAS_HOST_SERVER_HOME   where config/ and the model cache go
#   CANVAS_INFERD_ENABLED     false → this script does nothing (see --enable)
#   OLLAMA_HOST               seeds the starter config's ollamaHost
#   CANVAS_INFERD_SOCKET / _CACHE_DIR / _CONFIG / CANVAS_INFERD_BRANCH
#   CANVAS_ROOT / CANVAS_USER / CANVAS_GROUP

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

log() { echo "[canvas-inferd] $*"; }
fail() { echo "[canvas-inferd] Error: $*" >&2; exit 1; }

# Settings come from four places, in this order of precedence:
#
#   1. a command-line flag
#   2. an environment variable            (how install-ubuntu.sh hands its own
#                                          settings through)
#   3. the deployment's .env              (loaded below — same file the docker
#                                          and local installers write, so one
#                                          answer serves every way of running)
#   4. the built-in default
#
# The environment is captured HERE, before anything assigns a default, because
# once a default lands there is no way to tell "the operator set this" from
# "nobody set it" — and that difference is the whole precedence order.
ENV_CANVAS_ROOT="${CANVAS_ROOT-}"
ENV_CANVAS_USER="${CANVAS_USER-}"
ENV_CANVAS_GROUP="${CANVAS_GROUP-}"
ENV_BRANCH="${INFERD_REPO_TARGET_BRANCH-}"
ENV_SOCKET="${CANVAS_INFERD_SOCKET-}"
ENV_CACHE_DIR="${CANVAS_INFERD_CACHE_DIR-}"
ENV_CONFIG="${CANVAS_INFERD_CONFIG-}"
ENV_SERVER_HOME="${CANVAS_SERVER_HOME-}"

INFERD_REPO="${INFERD_REPO:-canvas-ui/canvas-inferd}"
ENV_FILE="$REPO_ROOT/.env"

FLAG_ROOT=""
FLAG_USER=""
FLAG_GROUP=""
FLAG_BRANCH=""
FLAG_SOCKET=""
FLAG_CACHE_DIR=""
FLAG_CONFIG=""
INSTALL_CUDA=false
UNIT_ONLY=false
FORCE_UNIT=false
DO_START=true
FORCE_ENABLE=false

while [ $# -gt 0 ]; do
    case "$1" in
        --root)       FLAG_ROOT="$2"; shift ;;
        --user)       FLAG_USER="$2"; shift ;;
        --group)      FLAG_GROUP="$2"; shift ;;
        --branch)     FLAG_BRANCH="$2"; shift ;;
        --socket)     FLAG_SOCKET="$2"; shift ;;
        --cache-dir)  FLAG_CACHE_DIR="$2"; shift ;;
        --config)     FLAG_CONFIG="$2"; shift ;;
        --env-file)   ENV_FILE="$2"; shift ;;
        --no-env)     ENV_FILE="" ;;
        --enable)     FORCE_ENABLE=true ;;
        --cuda)       INSTALL_CUDA=true ;;
        --unit-only)  UNIT_ONLY=true ;;
        --force-unit) FORCE_UNIT=true ;;
        --no-start)   DO_START=false ;;
        -h|--help)    awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
        *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
    shift
done

# --- .env ---------------------------------------------------------------
# Reuse scripts/lib/install-common.sh's env_get/write_env rather than parsing
# the file again here: it already handles quoting and compose's doubled '$$',
# and a second parser would drift from the one the other installers use. The
# file is read as DATA, never sourced.
#
# The lib may be absent when this script is copied to a box on its own, so it
# degrades to "no .env" rather than failing — every key it would have supplied
# has a flag and an environment variable.
ENV_LOADED=false
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] && [ -f "$SCRIPT_DIR/lib/install-common.sh" ]; then
    ENV_EXAMPLE="$REPO_ROOT/.env.example"
    # shellcheck source=lib/install-common.sh
    . "$SCRIPT_DIR/lib/install-common.sh"
    # install-common.sh defines its own log/fail wording; keep ours.
    log() { echo "[canvas-inferd] $*"; }
    fail() { echo "[canvas-inferd] Error: $*" >&2; exit 1; }
    ENV_LOADED=true
    log "Reading existing settings from $ENV_FILE"
elif [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
    log "Found $ENV_FILE but not scripts/lib/install-common.sh — ignoring it"
fi

# env_get <key> [default], with no .env in play.
if [ "$ENV_LOADED" = false ]; then
    env_get() { printf '%s' "${2:-}"; }
fi

# pick <flag> <environment> <.env key> <default>
pick() {
    local flag=$1 environment=$2 key=$3 default=$4
    if [ -n "$flag" ]; then printf '%s' "$flag"; return; fi
    if [ -n "$environment" ]; then printf '%s' "$environment"; return; fi
    printf '%s' "$(env_get "$key" "$default")"
}

CANVAS_ROOT="$(pick "$FLAG_ROOT" "$ENV_CANVAS_ROOT" CANVAS_ROOT /opt/canvas-server)"
CANVAS_USER="$(pick "$FLAG_USER" "$ENV_CANVAS_USER" CANVAS_USER canvas)"
CANVAS_GROUP="$(pick "$FLAG_GROUP" "$ENV_CANVAS_GROUP" CANVAS_GROUP www-data)"
INFERD_REPO_TARGET_BRANCH="$(pick "$FLAG_BRANCH" "$ENV_BRANCH" CANVAS_INFERD_BRANCH main)"

# Where server state lives. CANVAS_HOST_SERVER_HOME is the .env key every other
# installer already uses for exactly this, so an existing deployment's config/
# and cache/ are found instead of a second set being created under $CANVAS_ROOT.
# A relative value is resolved against the repo, the way compose reads it.
SERVER_HOME="$(pick "" "$ENV_SERVER_HOME" CANVAS_HOST_SERVER_HOME "$CANVAS_ROOT/server")"
case "$SERVER_HOME" in
    /*) ;;
    *) SERVER_HOME="$(cd "$REPO_ROOT" && mkdir -p "$SERVER_HOME" && cd "$SERVER_HOME" && pwd)" ;;
esac

INFERD_SOCKET="$(pick "$FLAG_SOCKET" "$ENV_SOCKET" CANVAS_INFERD_SOCKET /run/canvas/inferd.sock)"
INFERD_CACHE_DIR="$(pick "$FLAG_CACHE_DIR" "$ENV_CACHE_DIR" CANVAS_INFERD_CACHE_DIR "$SERVER_HOME/inferd/models")"
INFERD_CONFIG="$(pick "$FLAG_CONFIG" "$ENV_CONFIG" CANVAS_INFERD_CONFIG "$SERVER_HOME/config/inferd.json")"

# An Ollama the operator already told the rest of the stack about seeds the
# starter config, so "I have an Ollama" is answered once, in one file.
OLLAMA_HOST_VALUE="$(env_get OLLAMA_HOST "${OLLAMA_HOST-}")"

# Embeddings can be switched off for the whole deployment. Honour that rather
# than installing a daemon the server has been told not to use.
INFERD_ENABLED="$(pick "" "${CANVAS_INFERD_ENABLED-}" CANVAS_INFERD_ENABLED true)"

UNIT_FILE=/etc/systemd/system/canvas-inferd.service

[ "$(id -u)" -eq 0 ] || fail "run this script as root"
[ -f /etc/os-release ] || fail "this script is intended for Ubuntu systems"
command -v systemctl >/dev/null 2>&1 || fail "systemd not found — supervise canvas-inferd with pm2 or your own supervisor instead"

if [ "$INFERD_ENABLED" != "true" ] && [ "$FORCE_ENABLE" = false ]; then
    log "CANVAS_INFERD_ENABLED=$INFERD_ENABLED (${ENV_FILE:-environment}) — nothing to do"
    log "  install anyway with --enable (which also flips that key to true)"
    exit 0
fi

log "Settings: root=$CANVAS_ROOT user=$CANVAS_USER:$CANVAS_GROUP serverHome=$SERVER_HOME"
log "          socket=$INFERD_SOCKET config=$INFERD_CONFIG cache=$INFERD_CACHE_DIR"

# --- node ---------------------------------------------------------------
# No NodeSource setup here: install-ubuntu.sh owns that, and this script is
# either run after it or on a box that already has Node.
command -v node >/dev/null 2>&1 || fail "Node.js not found — run scripts/install-ubuntu.sh first"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js >= 20 required (found $(node --version))"

# --- service user -------------------------------------------------------
# Same user as canvas-server: the socket is 0750 under a canvas-owned runtime
# directory, so both sides being one identity is what makes the default work.
getent group "$CANVAS_GROUP" >/dev/null 2>&1 || groupadd "$CANVAS_GROUP" || fail "failed to create group $CANVAS_GROUP"
if ! id "$CANVAS_USER" >/dev/null 2>&1; then
    useradd --comment "Canvas Server User" --system --shell /bin/false \
        --gid "$CANVAS_GROUP" --home "$CANVAS_ROOT" "$CANVAS_USER" \
        || fail "failed to create user $CANVAS_USER"
    log "created service user $CANVAS_USER"
fi

# --- binary -------------------------------------------------------------
if [ "$UNIT_ONLY" = false ]; then
    log "Installing build prerequisites..."
    apt-get install -y --no-install-recommends build-essential python3 ca-certificates git curl \
        || fail "failed to install build prerequisites"

    # onnxruntime-node's postinstall fetches CUDA execution-provider binaries
    # from a Microsoft CDN. On a CPU box that is a slow download of something
    # never loaded, and on a box with blocked egress it fails the install
    # outright — so it is opt-in via --cuda.
    CUDA_ENV="ONNXRUNTIME_NODE_INSTALL_CUDA=skip"
    if [ "$INSTALL_CUDA" = true ]; then
        CUDA_ENV=""
        log "CUDA execution-provider binaries will be downloaded (--cuda)"
    fi

    log "Installing canvas-inferd from $INFERD_REPO#$INFERD_REPO_TARGET_BRANCH..."
    env $CUDA_ENV npm install -g "github:$INFERD_REPO#$INFERD_REPO_TARGET_BRANCH" \
        || fail "npm install -g canvas-inferd failed"
fi

INFERD_BIN="$(command -v canvas-inferd || true)"
[ -n "$INFERD_BIN" ] || fail "canvas-inferd is not on PATH after install"
log "Binary: $INFERD_BIN ($(canvas-inferd --help >/dev/null 2>&1 && echo ok || echo 'does not run — check the install'))"

# --- cache dir ----------------------------------------------------------
# Models are downloaded on first use and are large; keeping them on the canvas
# root means they survive a reinstall of the package and are backed up with the
# rest of the deployment.
mkdir -p "$INFERD_CACHE_DIR" || fail "failed to create $INFERD_CACHE_DIR"
chown -R "$CANVAS_USER:$CANVAS_GROUP" "$INFERD_CACHE_DIR"
log "Model cache: $INFERD_CACHE_DIR"

# --- config -------------------------------------------------------------
# The unit passes --config unconditionally and the daemon exits 1 on an
# unreadable config file, so the file has to exist even when it says nothing.
# Every key is optional; built-in defaults are bge-small (text) and CLIP ViT-B/32
# (image), both local ONNX. Point a space at an `openai`-compatible provider to
# use a GPU box — or leave that to the per-workspace setting in the web UI,
# which overrides this file.
mkdir -p "$(dirname "$INFERD_CONFIG")" || fail "failed to create $(dirname "$INFERD_CONFIG")"
if [ ! -f "$INFERD_CONFIG" ]; then
    # Written by node rather than a heredoc: the values interpolated here come
    # from .env and the command line, and a path with a quote or a backslash in
    # it would otherwise produce a config file the daemon refuses to parse —
    # which, because the unit passes --config, is a daemon that will not start.
    #
    # An OLLAMA_HOST from .env is carried over: the built-in `ollama` provider
    # id is otherwise pinned to loopback, which is the wrong host for the one
    # deployment that bothered to write that key down.
    [ -n "$OLLAMA_HOST_VALUE" ] && log "Carrying OLLAMA_HOST=$OLLAMA_HOST_VALUE into the config"
    CACHE_DIR="$INFERD_CACHE_DIR" OLLAMA_HOST_VALUE="$OLLAMA_HOST_VALUE" \
    node -e '
        const fs = require("fs");
        const config = {
            cacheDir: process.env.CACHE_DIR,
            concurrency: 2,
            providers: {},
            spaces: {},
            summarize: { image: { enabled: false } },
        };
        if (process.env.OLLAMA_HOST_VALUE) { config.ollamaHost = process.env.OLLAMA_HOST_VALUE; }
        fs.writeFileSync(process.argv[1], JSON.stringify(config, null, 4) + "\n");
    ' "$INFERD_CONFIG" || fail "failed to write $INFERD_CONFIG"
    log "Wrote starter config: $INFERD_CONFIG"
else
    log "Keeping existing config: $INFERD_CONFIG (not touched)"
fi
chown "$CANVAS_USER:$CANVAS_GROUP" "$INFERD_CONFIG"

# --- socket directory ---------------------------------------------------
# /run/canvas is what RuntimeDirectory=canvas gives us (mode 0750, canvas-owned)
# and is the default both packages resolve to with nothing configured — keep it
# in step with socket-path.js in BOTH packages. A socket placed anywhere else
# needs its directory created here and CANVAS_INFERD_SOCKET set for the server.
SOCKET_DIR="$(dirname "$INFERD_SOCKET")"
RUNTIME_DIRECTIVES=""
if [ "$SOCKET_DIR" = "/run/canvas" ]; then
    RUNTIME_DIRECTIVES=$'RuntimeDirectory=canvas\nRuntimeDirectoryMode=0750'
else
    mkdir -p "$SOCKET_DIR" || fail "failed to create $SOCKET_DIR"
    chown "$CANVAS_USER:$CANVAS_GROUP" "$SOCKET_DIR"
    chmod 0750 "$SOCKET_DIR"
    log "Non-default socket path — set CANVAS_INFERD_SOCKET=$INFERD_SOCKET for canvas-server too"
fi

# --- unit ---------------------------------------------------------------
if [ -f "$UNIT_FILE" ] && [ "$FORCE_UNIT" = false ]; then
    log "Keeping existing unit: $UNIT_FILE (re-run with --force-unit to rewrite)"
else
    cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Canvas Inference Daemon
# Ordering only, not a requirement: canvas-server starts and serves without it,
# degrading to keyword search, and its client reconnects when this comes back.
Before=canvas-server.service
After=network.target

[Service]
Type=simple
User=$CANVAS_USER
Group=$CANVAS_GROUP
WorkingDirectory=$CANVAS_ROOT
$RUNTIME_DIRECTIVES
ExecStart=$INFERD_BIN --socket $INFERD_SOCKET --config $INFERD_CONFIG
Restart=always
RestartSec=10
# Models are large and loading one is a burst; do not let the supervisor treat
# a slow first load as a failure.
TimeoutStartSec=300
Environment=NODE_ENV=production
Environment=HOME=$CANVAS_ROOT
Environment=CANVAS_INFERD_CACHE_DIR=$INFERD_CACHE_DIR

[Install]
WantedBy=multi-user.target
EOF
    log "Wrote unit: $UNIT_FILE"
fi

systemctl daemon-reload
systemctl enable canvas-inferd >/dev/null 2>&1 || fail "failed to enable canvas-inferd"

# --enable is the operator saying "yes, run inference here"; record it where the
# rest of the stack reads that answer, so the next installer run agrees.
if [ "$FORCE_ENABLE" = true ] && [ "$ENV_LOADED" = true ] && [ "$INFERD_ENABLED" != "true" ]; then
    write_env CANVAS_INFERD_ENABLED true
    log "Set CANVAS_INFERD_ENABLED=true in $ENV_FILE"
fi

if [ "$DO_START" = false ]; then
    log "Installed and enabled; not started (--no-start)"
    exit 0
fi

log "Starting canvas-inferd..."
systemctl restart canvas-inferd || fail "failed to start canvas-inferd (journalctl -u canvas-inferd -n 50)"

# The socket appearing is the only honest readiness signal: the server finds the
# daemon by that path and by nothing else.
for _ in $(seq 1 30); do
    [ -S "$INFERD_SOCKET" ] && break
    sleep 1
done

if [ -S "$INFERD_SOCKET" ]; then
    log "Listening on $INFERD_SOCKET"
else
    log "WARNING: $INFERD_SOCKET did not appear within 30s — check: journalctl -u canvas-inferd -n 50"
fi

echo ""
log "Done. Status: $(systemctl is-active canvas-inferd) / $(systemctl is-enabled canvas-inferd)"
echo ""
echo "  Logs:    journalctl -u canvas-inferd -f"
echo "  Restart: systemctl restart canvas-inferd"
echo "  Config:  $INFERD_CONFIG    (per-workspace overrides live in the web UI)"
echo ""
echo "  canvas-server needs no change if it runs as $CANVAS_USER and the socket is"
echo "  at /run/canvas/inferd.sock — both sides resolve that path by default."
