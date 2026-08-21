#!/usr/bin/env bash
#
# Canvas Server — local install, no container.
#
#     ./scripts/install-local.sh              (or: npm run local:install)
#     ./scripts/install-local.sh --env-file /etc/canvas/prod.env
#     ./scripts/install-local.sh -y --dev
#
# Same questions and the same .env as install-docker.sh — the difference is
# only what runs the server: this one installs the dependencies of THIS git
# checkout and starts `node ./src/init.js` in the foreground, as you, with no
# image and no daemon in between. Stop it with Ctrl-C.
#
# What the container does through mounts, this does through paths: the two
# host directories from the .env become CANVAS_SERVER_HOME and the users root
# directly, and a personal instance's folder is symlinked into place as that
# user's home — the same shape (<users>/<email>/{Workspaces,Roles,Agents}), so
# the same .env can later be handed to the container without moving data.
#
# Flags:
#   -e, --env-file PATH   read/write this .env instead of <repo>/.env
#       --no-install      skip `npm install` (dependencies already present)
#       --no-start        set everything up, but do not start the server
#       --dev             NODE_ENV=development, LOG_LEVEL=debug
#   -y, --yes             accept every default, ask nothing
#   -h, --help

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
ENV_EXAMPLE="$REPO_ROOT/.env.example"

ASSUME_YES=false
DO_INSTALL=true
DO_START=true
DEV_MODE=false

while [ $# -gt 0 ]; do
    case "$1" in
        -e|--env-file) ENV_FILE="$2"; shift ;;
        --no-install)  DO_INSTALL=false ;;
        --no-start)    DO_START=false ;;
        --dev)         DEV_MODE=true ;;
        -y|--yes)      ASSUME_YES=true ;;
        -h|--help)     awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
        *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
    shift
done

if [ -d "$ENV_FILE" ]; then ENV_FILE="$ENV_FILE/.env"; fi
ENV_DIR="$(dirname "$ENV_FILE")"
if [ -d "$ENV_DIR" ]; then
    ENV_FILE="$(cd "$ENV_DIR" && pwd)/$(basename "$ENV_FILE")"
else
    echo "Error: no such directory: $ENV_DIR (from --env-file)" >&2; exit 1
fi

# shellcheck source=lib/install-common.sh
. "$REPO_ROOT/scripts/lib/install-common.sh"

# ── Prerequisites ───────────────────────────────────────────────────────────

[ -f "$REPO_ROOT/package.json" ] || fail "missing $REPO_ROOT/package.json — run this from a cloned canvas-server repo"
[ -f "$ENV_EXAMPLE" ] || fail "missing $ENV_EXAMPLE — run this from a cloned canvas-server repo"
command -v node >/dev/null 2>&1 || fail "node is not installed — Canvas needs Node.js 20 or newer (https://nodejs.org)"
command -v npm  >/dev/null 2>&1 || fail "npm is not installed"

# The engines field is the source of truth; lmdb and onnxruntime-node only ship
# prebuilds for the versions it names, so an older node fails at install time
# with a compiler error rather than anything readable.
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
NODE_WANTED=$(node -p "((require('$REPO_ROOT/package.json').engines||{}).node||'>=20').replace(/[^0-9.]/g,'').split('.')[0] || 20")
if [ "$NODE_MAJOR" -lt "$NODE_WANTED" ]; then
    fail "node $NODE_MAJOR is too old — this server needs $NODE_WANTED or newer (you have $(node --version))"
fi

echo
bold "Canvas Server — local install"
info "repo        $REPO_ROOT"
info "node        $(node --version)"
info "config      $ENV_FILE"
echo

# ── .env ────────────────────────────────────────────────────────────────────

handle_existing_env
if [ "${KEEP_ENV:-false}" != "true" ]; then
    echo
    ask_all local
    write_answers
fi

# ── Paths ───────────────────────────────────────────────────────────────────

# The container reads the host paths through two bind mounts; here they ARE the
# paths, so the same two keys map straight onto the server's own variables.
SERVER_HOME=$(env_get CANVAS_HOST_SERVER_HOME "$REPO_ROOT/data/server")
USER_PATH=$(env_get CANVAS_HOST_USER_HOME "$REPO_ROOT/data/users")
USER_MOUNT=$(env_get CANVAS_USER_MOUNT "")
ADMIN_EMAIL=$(env_get CANVAS_ADMIN_EMAIL "admin@canvas.local")
# The server lowercases the email when it resolves a user's home; the link has
# to be created under the same name or it would sit next to a real directory.
ADMIN_EMAIL_LC=$(printf '%s' "$ADMIN_EMAIL" | tr '[:upper:]' '[:lower:]')
PORT=$(env_get CANVAS_HOST_PORT 8001)

# A path relative to the repo (the .env.example defaults are ./data/...) means
# relative to the repo, not to wherever this was invoked from.
case "$SERVER_HOME" in /*) ;; *) SERVER_HOME="$REPO_ROOT/${SERVER_HOME#./}" ;; esac
case "$USER_PATH"   in /*) ;; *) USER_PATH="$REPO_ROOT/${USER_PATH#./}" ;; esac

if [ -n "$USER_MOUNT" ]; then
    # Multi-user: the answer names the users tree itself, server fills in <email>/.
    USERS_ROOT="$USER_PATH"
    PERSONAL_HOME=""
else
    # Personal: the answer names ONE user's home. The container binds it onto
    # data/users/<email>; the local equivalent is a symlink at the same place,
    # which keeps <users>/<email>/ the canonical layout for the server while the
    # data lives where you asked for it.
    USERS_ROOT="$SERVER_HOME/users"
    PERSONAL_HOME="$USER_PATH"
fi

mkdir -p "$SERVER_HOME/config" "$SERVER_HOME/db" "$SERVER_HOME/cache" "$SERVER_HOME/var" "$USERS_ROOT"

if [ -n "$PERSONAL_HOME" ]; then
    mkdir -p "$PERSONAL_HOME"
    LINK="$USERS_ROOT/$ADMIN_EMAIL_LC"
    if [ -L "$LINK" ]; then
        # Re-running with a different folder should follow the answer, but a
        # link that already points there is left alone (relinking is a no-op
        # that would still churn the mtime).
        if [ "$(readlink "$LINK")" != "$PERSONAL_HOME" ]; then
            ln -sfn "$PERSONAL_HOME" "$LINK"
            info "repointed $LINK → $PERSONAL_HOME"
        fi
    elif [ -e "$LINK" ]; then
        # A real directory here is someone's existing data — moving or deleting
        # it is not this script's call.
        warn "$LINK already exists as a real directory"
        warn "leaving it alone; $PERSONAL_HOME is NOT being used"
        warn "move it aside and re-run, or answer 'no' to the personal question"
        PERSONAL_HOME=""
    else
        ln -s "$PERSONAL_HOME" "$LINK"
    fi
fi

# ── Dependencies ────────────────────────────────────────────────────────────

cd "$REPO_ROOT"

if $DO_INSTALL; then
    bold "Installing dependencies"
    info "postinstall also builds the web UI, so the first run takes a few minutes."
    npm install
    echo
fi

# ── JWT secret ──────────────────────────────────────────────────────────────

# Same rule as the container entrypoint: a secret that changes on every restart
# invalidates every session, and the built-in default is a published constant.
JWT_SECRET=$(env_get CANVAS_JWT_SECRET "")
if [ -z "$JWT_SECRET" ]; then
    JWT_SECRET_FILE="$SERVER_HOME/config/jwt.secret"
    if [ ! -s "$JWT_SECRET_FILE" ]; then
        if command -v openssl >/dev/null 2>&1; then
            openssl rand -base64 48 | tr -d '\n' > "$JWT_SECRET_FILE"
        else
            node -e "process.stdout.write(require('crypto').randomBytes(48).toString('base64'))" > "$JWT_SECRET_FILE"
        fi
        chmod 600 "$JWT_SECRET_FILE" 2>/dev/null || true
        info "generated a new JWT secret at $JWT_SECRET_FILE"
    fi
    JWT_SECRET=$(cat "$JWT_SECRET_FILE")
fi

# ── Environment ─────────────────────────────────────────────────────────────

export CANVAS_SERVER_HOME="$SERVER_HOME"
export CANVAS_USER_HOME="$USERS_ROOT"
export CANVAS_API_PORT="$PORT"
export CANVAS_WEB_PORT="$PORT"
export CANVAS_JWT_SECRET="$JWT_SECRET"

export CANVAS_ADMIN_EMAIL="$ADMIN_EMAIL"
export CANVAS_ADMIN_NAME="$(env_get CANVAS_ADMIN_NAME "")"
export CANVAS_ADMIN_PASSWORD="$(env_get CANVAS_ADMIN_PASSWORD "")"
export CANVAS_ADMIN_RESET="$(env_get CANVAS_ADMIN_RESET false)"

export CANVAS_WORKSPACE_LAYOUT="$(env_get CANVAS_WORKSPACE_LAYOUT home)"
export CANVAS_JWT_TOKEN_EXPIRY="$(env_get CANVAS_JWT_TOKEN_EXPIRY 7d)"
export CANVAS_ALLOW_INSECURE_REMOTE_IMPORT="$(env_get CANVAS_ALLOW_INSECURE_REMOTE_IMPORT false)"
export CANVAS_INFERD_ENABLED="$(env_get CANVAS_INFERD_ENABLED true)"

# Only exported when set: empty values here would pin every user's module roots
# to an empty path / override the source identity with nothing.
for optional in CANVAS_USER_WORKSPACES CANVAS_USER_ROLES CANVAS_USER_AGENTS OLLAMA_HOST CANVAS_SOURCE_URL; do
    value=$(env_get "$optional" "")
    if [ -n "$value" ]; then export "$optional=$value"; fi
done
# Outside a container .git IS readable, so the server works the revision out
# itself — only override it if the .env pins one.
value=$(env_get CANVAS_SOURCE_COMMIT "")
if [ -n "$value" ]; then export CANVAS_SOURCE_COMMIT="$value"; fi

if $DEV_MODE; then
    export NODE_ENV=development
    export LOG_LEVEL=debug
else
    export NODE_ENV="$(env_get NODE_ENV production)"
    export LOG_LEVEL="$(env_get LOG_LEVEL info)"
fi

echo
bold "Ready"
info "url         http://localhost:$PORT"
info "server      $SERVER_HOME"
if [ -n "$PERSONAL_HOME" ]; then
    info "your data   $PERSONAL_HOME  (linked as $USERS_ROOT/$ADMIN_EMAIL_LC)"
else
    info "users       $USERS_ROOT  (one <email>/ subtree per user)"
fi
info "admin       $ADMIN_EMAIL"
if [ -z "$CANVAS_ADMIN_PASSWORD" ]; then
    info "            no password set — one is generated and printed below on first run"
fi
info "mode        $NODE_ENV (log level $LOG_LEVEL)"
echo

if ! $DO_START; then
    bold "Not starting (--no-start)"
    info "Start it with: ./scripts/install-local.sh --no-install --env-file $ENV_FILE"
    info "which is what applies the .env — plain \`npm start\` does not read it."
    exit 0
fi

bold "Starting Canvas Server — Ctrl-C to stop"
echo
exec node ./src/init.js
