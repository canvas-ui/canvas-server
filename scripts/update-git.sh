#!/bin/bash

# Git pull + rebuild for canvas-server. Config: $CANVAS_SERVER_HOME/config/update.json
# Cron example (daily 3am, dev channel):
#   0 3 * * * CANVAS_SERVER_HOME=/opt/canvas-server/server /opt/canvas-server/scripts/update-git.sh

TARGET_BRANCH_CLI=
CANVAS_ROOT="${CANVAS_ROOT:-}"
CANVAS_SERVER_HOME="${CANVAS_SERVER_HOME:-}"
UPDATE_CONFIG="${UPDATE_CONFIG:-}"
CANVAS_USER="${CANVAS_USER:-}"
CANVAS_GROUP="${CANVAS_GROUP:-}"
TARGET_BRANCH="${TARGET_BRANCH:-}"
LOG_FILE="${LOG_FILE:-}"
REQUIRED_NODE_VERSION="${REQUIRED_NODE_VERSION:-}"
LOCKFILE="${LOCKFILE:-}"
MAINTENANCE_PAGE="${MAINTENANCE_PAGE:-}"
MAINTENANCE_PORT="${MAINTENANCE_PORT:-}"
MAINTENANCE_HOST="${MAINTENANCE_HOST:-}"
MAINTENANCE_PID=

usage() {
    cat <<EOF
Usage: $0 [-b branch] [-c config.json] [-m] [-h]
  -b  Git branch (overrides config; default: dev)
  -c  Path to update.json (default: \$CANVAS_SERVER_HOME/config/update.json)
  -m  Disable the "please stand by" maintenance page
  -h  This help

Config file: copy server/config/update.example.json to config/update.json
Env overrides: TARGET_BRANCH, CANVAS_ROOT, CANVAS_SERVER_HOME, HTTP_PROXY, HTTPS_PROXY, NO_PROXY,
               WEB_BUILD, WEB_SRC_REPO, WEB_SRC_BRANCH, WEB_SRC_DIR
Channel in JSON: "dev" -> branch dev, "prod" -> branch main (unless "branch" is set)

Web UI: built fresh from the monorepo source on every update (config "web" block),
so a push to the web repo is enough — no release tarball required. The pinned
canvas-web tarball from npm ci remains the fallback if the source build fails.

While the update runs, a stand-by page is served on the API port (8001 by default,
override with maintenancePort/MAINTENANCE_PORT) and is torn down right before
canvas-server starts.
EOF
}

set_if_unset() {
    local name=$1 value=$2
    if [[ -z "${!name-}" ]]; then
        export "$name=$value"
    fi
}

load_update_config() {
    [[ -f "$UPDATE_CONFIG" ]] || return 0
  eval "$(UPDATE_CONFIG="$UPDATE_CONFIG" node --input-type=module -e "
import { readFileSync } from 'fs';
const c = JSON.parse(readFileSync(process.env.UPDATE_CONFIG, 'utf8'));
const line = (k, v) => {
  if (v == null || v === '') return;
  process.stdout.write('set_if_unset ' + k + ' ' + JSON.stringify(String(v)) + '\n');
};
const channel = c.channel === 'prod' ? 'main' : 'dev';
line('TARGET_BRANCH', c.branch || channel);
line('CANVAS_ROOT', c.canvasRoot);
line('CANVAS_SERVER_HOME', c.canvasServerHome);
const w = c.web || {};
if (w.build === false) line('WEB_BUILD', 'false');
line('WEB_SRC_REPO', w.repo);
line('WEB_SRC_BRANCH', w.branch);
line('WEB_SRC_DIR', w.srcDir);
line('CANVAS_USER', c.canvasUser);
line('CANVAS_GROUP', c.canvasGroup);
line('LOG_FILE', c.logFile);
line('LOCKFILE', c.lockFile);
line('REQUIRED_NODE_VERSION', c.requiredNodeVersion);
if (c.maintenancePage === false) line('MAINTENANCE_PAGE', 'false');
line('MAINTENANCE_PORT', c.maintenancePort);
line('MAINTENANCE_HOST', c.maintenanceHost);
const p = c.proxy || {};
line('HTTP_PROXY', p.http || p.https);
line('HTTPS_PROXY', p.https || p.http);
line('NO_PROXY', p.noProxy);
")"
}

apply_proxy_env() {
    local http="${HTTP_PROXY:-${http_proxy:-}}"
    local https="${HTTPS_PROXY:-${https_proxy:-$http}}"
    local noproxy="${NO_PROXY:-${no_proxy:-}}"
    [[ -n "$http" ]] && export http_proxy="$http" HTTP_PROXY="$http"
    [[ -n "$https" ]] && export https_proxy="$https" HTTPS_PROXY="$https"
    [[ -n "$noproxy" ]] && export no_proxy="$noproxy" NO_PROXY="$noproxy"
}

while getopts "b:c:mh" opt; do
    case $opt in
        b) TARGET_BRANCH_CLI="$OPTARG" ;;
        c) UPDATE_CONFIG="$OPTARG" ;;
        m) MAINTENANCE_PAGE_CLI=false ;;
        h) usage; exit 0 ;;
        *) usage; exit 1 ;;
    esac
done

CANVAS_ROOT="${CANVAS_ROOT:-/opt/canvas-server}"
CANVAS_SERVER_HOME="${CANVAS_SERVER_HOME:-$CANVAS_ROOT/server}"
UPDATE_CONFIG="${UPDATE_CONFIG:-$CANVAS_SERVER_HOME/config/update.json}"

load_update_config

CANVAS_USER="${CANVAS_USER:-canvas}"
CANVAS_GROUP="${CANVAS_GROUP:-www-data}"
TARGET_BRANCH="${TARGET_BRANCH:-dev}"
LOG_FILE="${LOG_FILE:-/var/log/canvas-deploy.log}"
REQUIRED_NODE_VERSION="${REQUIRED_NODE_VERSION:-20}"
LOCKFILE="${LOCKFILE:-/var/run/canvas-update.lock}"
MAINTENANCE_PAGE="${MAINTENANCE_PAGE:-true}"
MAINTENANCE_PORT="${MAINTENANCE_PORT:-${CANVAS_API_PORT:-8001}}"
MAINTENANCE_HOST="${MAINTENANCE_HOST:-${CANVAS_API_HOST:-0.0.0.0}}"
# Web UI source build (the primary path — see build_web_ui). The packaged
# canvas-web tarball is only the fallback when the source build cannot run.
WEB_BUILD="${WEB_BUILD:-true}"
WEB_SRC_REPO="${WEB_SRC_REPO:-https://github.com/canvas-ui/canvas.git}"
WEB_SRC_BRANCH="${WEB_SRC_BRANCH:-main}"
WEB_SRC_DIR="${WEB_SRC_DIR:-$CANVAS_ROOT/web-src}"
[[ -n "$TARGET_BRANCH_CLI" ]] && TARGET_BRANCH="$TARGET_BRANCH_CLI"
[[ -n "${MAINTENANCE_PAGE_CLI-}" ]] && MAINTENANCE_PAGE="$MAINTENANCE_PAGE_CLI"

apply_proxy_env

log_message() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

run_as_canvas_user() {
    if [[ "$(id -u)" == "0" ]]; then
        su -s /bin/bash "$CANVAS_USER" -c "cd $CANVAS_ROOT && $1"
    else
        cd "$CANVAS_ROOT" && eval "$1"
    fi
}

check_command() {
    command -v "$1" >/dev/null 2>&1 || { log_message "Error: $1 is not installed"; exit 1; }
}

check_node_version() {
    local current_version
    current_version=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [[ "$current_version" -lt $REQUIRED_NODE_VERSION ]]; then
        log_message "Error: Node.js >= $REQUIRED_NODE_VERSION required (have $current_version)"
        exit 1
    fi
}

start_maintenance_page() {
    [[ "$MAINTENANCE_PAGE" == "false" ]] && return 0

    local src="$(dirname "$(readlink -f "$0")")/maintenance-server.js"
    [[ -f "$src" ]] || { log_message "No maintenance-server.js found, skipping stand-by page"; return 0; }

    # Run from a copy outside the repo: the git reset below rewrites the working
    # tree (and clean_node_modules walks it) while this process is alive.
    MAINTENANCE_SCRIPT=$(mktemp /tmp/canvas-maintenance-XXXXXX.mjs)
    cp "$src" "$MAINTENANCE_SCRIPT"

    node "$MAINTENANCE_SCRIPT" --port "$MAINTENANCE_PORT" --host "$MAINTENANCE_HOST" --root "$CANVAS_ROOT" \
        >>"$LOG_FILE" 2>&1 &
    MAINTENANCE_PID=$!

    sleep 1
    if kill -0 "$MAINTENANCE_PID" 2>/dev/null; then
        log_message "Maintenance page up on $MAINTENANCE_HOST:$MAINTENANCE_PORT (pid $MAINTENANCE_PID)"
    else
        # Almost always the old service still holding the port. Not fatal.
        log_message "Maintenance page failed to start (port $MAINTENANCE_PORT busy?), continuing without it"
        MAINTENANCE_PID=
    fi
}

stop_maintenance_page() {
    [[ -n "$MAINTENANCE_PID" ]] || { rm -f "${MAINTENANCE_SCRIPT:-}" 2>/dev/null; return 0; }

    log_message "Taking down maintenance page (pid $MAINTENANCE_PID)..."
    kill "$MAINTENANCE_PID" 2>/dev/null || true

    # Wait for the port to actually be released before the real server claims it.
    local i
    for i in {1..10}; do
        kill -0 "$MAINTENANCE_PID" 2>/dev/null || break
        sleep 0.5
    done
    kill -9 "$MAINTENANCE_PID" 2>/dev/null || true
    wait "$MAINTENANCE_PID" 2>/dev/null || true

    MAINTENANCE_PID=
    rm -f "${MAINTENANCE_SCRIPT:-}" 2>/dev/null || true
}

# Build the web UI from the monorepo source so a push is enough to update it —
# the pinned canvas-web release tarball lags behind pushes (and may not even
# exist yet for a fresh change). Build failures are NON-FATAL: whatever dist is
# already in place (the npm-ci-installed tarball) keeps serving, so a broken UI
# build can never take the server update down with it.
#
# Uses corepack to honour the monorepo's pinned pnpm (`packageManager` field);
# the install is filtered to canvas-web + its workspace deps, not the whole
# monorepo. The checkout lives outside node_modules (clean_node_modules wipes
# those) and is shallow — history is not needed to build.
build_web_ui() {
    [[ "$WEB_BUILD" == "false" ]] && { log_message "Web UI source build disabled (web.build=false)"; return 0; }
    if ! command -v corepack >/dev/null 2>&1; then
        log_message "corepack not available — keeping the packaged web UI"
        return 0
    fi

    log_message "Building web UI from $WEB_SRC_REPO#$WEB_SRC_BRANCH..."
    if [[ -d "$WEB_SRC_DIR/.git" ]]; then
        run_as_canvas_user "cd '$WEB_SRC_DIR' && /usr/bin/git fetch --depth 1 origin '$WEB_SRC_BRANCH' && /usr/bin/git reset --hard FETCH_HEAD" \
            || { log_message "Web source fetch failed — keeping the packaged web UI"; return 0; }
    else
        run_as_canvas_user "/usr/bin/git clone --depth 1 --branch '$WEB_SRC_BRANCH' '$WEB_SRC_REPO' '$WEB_SRC_DIR'" \
            || { log_message "Web source clone failed — keeping the packaged web UI"; return 0; }
    fi

    # COREPACK_ENABLE_DOWNLOAD_PROMPT=0: first corepack use downloads the pinned
    # pnpm and must not stall an unattended update on a Y/n prompt.
    if run_as_canvas_user "cd '$WEB_SRC_DIR' && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --filter canvas-web... --frozen-lockfile" \
        && run_as_canvas_user "cd '$WEB_SRC_DIR/apps/web' && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm run build" \
        && [[ -f "$WEB_SRC_DIR/apps/web/dist/index.html" ]]; then
        rm -rf "$WEB_DIST"
        mkdir -p "$(dirname "$WEB_DIST")"
        cp -a "$WEB_SRC_DIR/apps/web/dist" "$WEB_DIST"
        local rev webver
        rev=$(cd "$WEB_SRC_DIR" && git rev-parse --short HEAD 2>/dev/null || echo '?')
        webver=$(node -p "try{require('$WEB_SRC_DIR/apps/web/package.json').version}catch{'?'}" 2>/dev/null)
        # Provenance marker: the final "Web UI serving" log reads this, and it
        # makes "which build is this box actually serving" a one-file answer.
        echo "$webver $WEB_SRC_BRANCH@$rev $(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$WEB_DIST/.source-build"
        chown -R "$CANVAS_USER:$CANVAS_GROUP" "$WEB_DIST"
        log_message "Web UI built from source ($webver, $WEB_SRC_BRANCH@$rev)"
    else
        log_message "Web UI build failed — keeping the packaged canvas-web dist"
    fi
}

clean_node_modules() {
    log_message "Recursively cleaning node_modules..."
    local dir
    while IFS= read -r dir; do
        [[ -d "$dir" ]] && rm -rf "$dir"
    done < <(find "$CANVAS_ROOT" -type d -name node_modules 2>/dev/null)
}

touch "$LOG_FILE"
chown "$CANVAS_USER:$CANVAS_GROUP" "$LOG_FILE" 2>/dev/null || true

log_message "Checking system requirements..."
check_command git
check_command node
check_node_version

if [[ "$(id -u)" != "0" ]]; then
    echo "Please run this script as root"
    exit 1
fi

getent passwd "$CANVAS_USER" >/dev/null || { echo "Error: user $CANVAS_USER missing"; exit 1; }
getent group "$CANVAS_GROUP" >/dev/null || { echo "Error: group $CANVAS_GROUP missing"; exit 1; }

if [[ -e "$LOCKFILE" ]]; then
    log_message "Another update is already running ($LOCKFILE)."
    exit 1
fi

trap 'stop_maintenance_page; rm -f "$LOCKFILE"' EXIT
touch "$LOCKFILE"

log_message "Starting canvas-server update (branch=$TARGET_BRANCH, root=$CANVAS_ROOT)..."

[[ -d "$CANVAS_ROOT" ]] || { log_message "Missing $CANVAS_ROOT — install first."; exit 1; }

log_message "Stopping canvas-server..."
systemctl stop canvas-server 2>/dev/null || log_message "Service was not running"

start_maintenance_page

clean_node_modules

log_message "Setting permissions on $CANVAS_ROOT..."
chown -R "$CANVAS_USER:$CANVAS_GROUP" "$CANVAS_ROOT"

log_message "Pulling origin/$TARGET_BRANCH..."
run_as_canvas_user "/usr/bin/git fetch origin $TARGET_BRANCH"
run_as_canvas_user "/usr/bin/git reset --hard origin/$TARGET_BRANCH"

log_message "Installing dependencies..."
# npm ci = strict, reproducible install from the committed package-lock.json
# (fails on lockfile/package.json drift instead of silently re-resolving a
# different, possibly-broken tree). Requires package-lock.json to be tracked.
# synapsd/stored arrive as pinned git deps; the pinned canvas-web tarball is
# installed here too, but only as the FALLBACK web UI — build_web_ui below
# replaces it with a fresh source build.
run_as_canvas_user "/usr/bin/npm ci" || { log_message "npm ci failed"; exit 1; }

# npm ci restores the LOCKFILE-PINNED commits of the git deps — which lag main
# by however long ago the lockfile was regenerated. An update must leave every
# component at its latest main: refresh them explicitly. --no-save keeps
# package.json/lockfile untouched (the repo stays reproducible; the BOX runs
# latest). Non-fatal: a refresh failure leaves the pinned versions serving.
GIT_DEPS="${GIT_DEPS:-canvas-synapsd canvas-stored canvas-inferd}"
log_message "Refreshing git deps to latest main ($GIT_DEPS)..."
if run_as_canvas_user "/usr/bin/npm update $GIT_DEPS --no-save"; then
    for dep in $GIT_DEPS; do
        v=$(node -p "try{require('$CANVAS_ROOT/node_modules/$dep/package.json').version}catch{'?'}" 2>/dev/null)
        log_message "  $dep -> $v"
    done
else
    log_message "Git dep refresh failed — keeping lockfile-pinned versions"
fi

WEB_DIST="$CANVAS_ROOT/node_modules/canvas-web/dist"

# Primary web UI path: build the latest from source (non-fatal on failure —
# the tarball dist installed by npm ci above keeps serving).
build_web_ui

[[ -f "$WEB_DIST/index.html" ]] || { log_message "Missing $WEB_DIST/index.html (tarball install AND source build both failed)"; exit 1; }
if [[ -f "$WEB_DIST/.source-build" ]]; then
    log_message "Web UI serving: source build $(cat "$WEB_DIST/.source-build")"
else
    log_message "Web UI serving: packaged tarball $(node -p "try{require('$CANVAS_ROOT/node_modules/canvas-web/package.json').version}catch{'?'}" 2>/dev/null) (SOURCE BUILD DID NOT RUN — check log above)"
fi

# Must happen before the real server starts, both want the same port.
stop_maintenance_page

log_message "Starting canvas-server..."
systemctl start canvas-server || { log_message "Failed to start canvas-server"; exit 1; }

log_message "Update completed successfully."
