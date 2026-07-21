#!/bin/bash

# Hourly demo-workspace reset for a public canvas-server demo instance.
#
# Wipes the demo user's live workspace and restores it from a prepared backup
# tree, showing a "we'll be right back" page while the service is down. All
# paths are configurable so no instance-specific detail is baked into the repo.
#
# Config: $CANVAS_SERVER_HOME/config/demo-reset.json
#   (copy server/config/demo-reset.example.json and edit)
# Env overrides take precedence over the config file, CLI flags over env.
#
# Cron example (top of every hour, logs to the configured LOG_FILE):
#   0 * * * * CANVAS_SERVER_HOME=/opt/canvas-server/server /opt/canvas-server/scripts/reset-demo.sh
#
# The reset is intentionally destructive on DEMO_WORKSPACE only, and refuses to
# run unless the backup exists and the target path looks sane (never "/", never
# empty), so a missing/mistyped config can't wipe something it shouldn't.

set -euo pipefail

RESET_CONFIG="${RESET_CONFIG:-}"
CANVAS_ROOT="${CANVAS_ROOT:-}"
CANVAS_SERVER_HOME="${CANVAS_SERVER_HOME:-}"
CANVAS_USER="${CANVAS_USER:-}"
CANVAS_GROUP="${CANVAS_GROUP:-}"
SERVICE_NAME="${SERVICE_NAME:-}"
DEMO_WORKSPACE="${DEMO_WORKSPACE:-}"
DEMO_BACKUP="${DEMO_BACKUP:-}"
LOG_FILE="${LOG_FILE:-}"
LOCKFILE="${LOCKFILE:-}"
MAINTENANCE_PAGE="${MAINTENANCE_PAGE:-}"
MAINTENANCE_PORT="${MAINTENANCE_PORT:-}"
MAINTENANCE_HOST="${MAINTENANCE_HOST:-}"
MAINTENANCE_PID=
MAINTENANCE_SCRIPT=

usage() {
    cat <<EOF
Usage: $0 [-c config.json] [-m] [-h]
  -c  Path to demo-reset.json (default: \$CANVAS_SERVER_HOME/config/demo-reset.json)
  -m  Disable the "please stand by" maintenance page
  -h  This help

Config file: copy server/config/demo-reset.example.json to config/demo-reset.json
Env overrides: RESET_CONFIG, CANVAS_ROOT, CANVAS_SERVER_HOME, DEMO_WORKSPACE,
               DEMO_BACKUP, SERVICE_NAME, LOG_FILE, LOCKFILE, MAINTENANCE_PORT
EOF
}

set_if_unset() {
    local name=$1 value=$2
    if [[ -z "${!name-}" ]]; then
        export "$name=$value"
    fi
}

load_reset_config() {
    [[ -f "$RESET_CONFIG" ]] || return 0
    eval "$(RESET_CONFIG="$RESET_CONFIG" node --input-type=module -e "
import { readFileSync } from 'fs';
const c = JSON.parse(readFileSync(process.env.RESET_CONFIG, 'utf8'));
const line = (k, v) => {
  if (v == null || v === '') return;
  process.stdout.write('set_if_unset ' + k + ' ' + JSON.stringify(String(v)) + '\n');
};
line('CANVAS_ROOT', c.canvasRoot);
line('CANVAS_SERVER_HOME', c.canvasServerHome);
line('CANVAS_USER', c.canvasUser);
line('CANVAS_GROUP', c.canvasGroup);
line('SERVICE_NAME', c.serviceName);
line('DEMO_WORKSPACE', c.demoWorkspace);
line('DEMO_BACKUP', c.demoBackup);
line('LOG_FILE', c.logFile);
line('LOCKFILE', c.lockFile);
if (c.maintenancePage === false) line('MAINTENANCE_PAGE', 'false');
line('MAINTENANCE_PORT', c.maintenancePort);
line('MAINTENANCE_HOST', c.maintenanceHost);
")"
}

while getopts "c:mh" opt; do
    case $opt in
        c) RESET_CONFIG="$OPTARG" ;;
        m) MAINTENANCE_PAGE_CLI=false ;;
        h) usage; exit 0 ;;
        *) usage; exit 1 ;;
    esac
done

CANVAS_ROOT="${CANVAS_ROOT:-/opt/canvas-server}"
CANVAS_SERVER_HOME="${CANVAS_SERVER_HOME:-$CANVAS_ROOT/server}"
RESET_CONFIG="${RESET_CONFIG:-$CANVAS_SERVER_HOME/config/demo-reset.json}"

load_reset_config

CANVAS_USER="${CANVAS_USER:-canvas}"
CANVAS_GROUP="${CANVAS_GROUP:-www-data}"
SERVICE_NAME="${SERVICE_NAME:-canvas-server}"
DEMO_WORKSPACE="${DEMO_WORKSPACE:-$CANVAS_SERVER_HOME/users/demo@canvas.local}"
DEMO_BACKUP="${DEMO_BACKUP:-/root/demo@canvas.local}"
LOG_FILE="${LOG_FILE:-/var/log/canvas-demo-reset.log}"
LOCKFILE="${LOCKFILE:-/var/run/canvas-demo-reset.lock}"
MAINTENANCE_PAGE="${MAINTENANCE_PAGE:-true}"
MAINTENANCE_PORT="${MAINTENANCE_PORT:-${CANVAS_API_PORT:-8001}}"
MAINTENANCE_HOST="${MAINTENANCE_HOST:-${CANVAS_API_HOST:-0.0.0.0}}"
[[ -n "${MAINTENANCE_PAGE_CLI-}" ]] && MAINTENANCE_PAGE="$MAINTENANCE_PAGE_CLI"

log_message() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

check_command() {
    command -v "$1" >/dev/null 2>&1 || { log_message "Error: $1 is not installed"; exit 1; }
}

start_maintenance_page() {
    [[ "$MAINTENANCE_PAGE" == "false" ]] && return 0

    local src
    src="$(dirname "$(readlink -f "$0")")/maintenance-server.js"
    [[ -f "$src" ]] || { log_message "No maintenance-server.js found, skipping stand-by page"; return 0; }

    # Run from a copy so nothing in the working tree is a dependency of a job
    # whose whole point is to churn the filesystem.
    MAINTENANCE_SCRIPT=$(mktemp /tmp/canvas-demo-maintenance-XXXXXX.mjs)
    cp "$src" "$MAINTENANCE_SCRIPT"

    # Reset-specific copy lives here, not in the shared page, so the repo carries
    # no demo-instance detail. Deliberately vague: no user, no schedule internals.
    node "$MAINTENANCE_SCRIPT" \
        --port "$MAINTENANCE_PORT" --host "$MAINTENANCE_HOST" --root "$CANVAS_ROOT" \
        --title "Canvas demo is resetting..." \
        --heading "The demo is resetting" \
        --message "This is a shared demo instance. Its workspace is wiped and restored to a clean state on a schedule, and a reset is running right now. Please stand by - this page refreshes itself." \
        --meta-label "Reset started" \
        --status "resetting" \
        --quips '["Sweeping up the demo confetti...","Restoring the sandbox to factory settings...","Politely evicting the last visitors data...","Fluffing the pixels back into place...","Rewinding the tape..."]' \
        >>"$LOG_FILE" 2>&1 &
    MAINTENANCE_PID=$!

    sleep 1
    if kill -0 "$MAINTENANCE_PID" 2>/dev/null; then
        log_message "Maintenance page up on $MAINTENANCE_HOST:$MAINTENANCE_PORT (pid $MAINTENANCE_PID)"
    else
        log_message "Maintenance page failed to start (port $MAINTENANCE_PORT busy?), continuing without it"
        MAINTENANCE_PID=
    fi
}

stop_maintenance_page() {
    [[ -n "$MAINTENANCE_PID" ]] || { rm -f "${MAINTENANCE_SCRIPT:-}" 2>/dev/null || true; return 0; }

    log_message "Taking down maintenance page (pid $MAINTENANCE_PID)..."
    kill "$MAINTENANCE_PID" 2>/dev/null || true

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

# --- preflight -------------------------------------------------------------

touch "$LOG_FILE"
chown "$CANVAS_USER:$CANVAS_GROUP" "$LOG_FILE" 2>/dev/null || true

check_command node
check_command systemctl

if [[ "$(id -u)" != "0" ]]; then
    echo "Please run this script as root"
    exit 1
fi

getent passwd "$CANVAS_USER" >/dev/null || { log_message "Error: user $CANVAS_USER missing"; exit 1; }
getent group "$CANVAS_GROUP" >/dev/null || { log_message "Error: group $CANVAS_GROUP missing"; exit 1; }

# Guard rails around the rm -rf: never operate on an empty/degenerate target,
# and never wipe unless a backup is actually present to restore from.
case "$DEMO_WORKSPACE" in
    ""|"/"|"/root"|"/home"|"$CANVAS_ROOT"|"$CANVAS_ROOT/"|"$CANVAS_SERVER_HOME"|"$CANVAS_SERVER_HOME/users"|"$CANVAS_ROOT/users")
        log_message "Refusing to reset unsafe DEMO_WORKSPACE='$DEMO_WORKSPACE'"; exit 1 ;;
esac
[[ "$DEMO_WORKSPACE" = /* ]] || { log_message "DEMO_WORKSPACE must be an absolute path"; exit 1; }
[[ -d "$DEMO_BACKUP" ]] || { log_message "Backup tree missing: $DEMO_BACKUP — aborting before touching the workspace"; exit 1; }

if [[ -e "$LOCKFILE" ]]; then
    log_message "Another reset is already running ($LOCKFILE)."
    exit 1
fi

trap 'stop_maintenance_page; rm -f "$LOCKFILE"' EXIT
touch "$LOCKFILE"

# --- reset -----------------------------------------------------------------

log_message "Starting demo reset (workspace=$DEMO_WORKSPACE, backup=$DEMO_BACKUP)..."

log_message "Stopping $SERVICE_NAME..."
systemctl stop "$SERVICE_NAME" 2>/dev/null || log_message "Service was not running"

start_maintenance_page

log_message "Removing current workspace..."
rm -rf "$DEMO_WORKSPACE"

log_message "Restoring workspace from backup..."
# Copy the contents of the backup INTO a freshly created target dir, so the
# result is $DEMO_WORKSPACE/... regardless of trailing slashes.
mkdir -p "$DEMO_WORKSPACE"
cp -a "$DEMO_BACKUP/." "$DEMO_WORKSPACE/"

log_message "Setting ownership to $CANVAS_USER:$CANVAS_GROUP..."
chown -R "$CANVAS_USER:$CANVAS_GROUP" "$DEMO_WORKSPACE"

# Must happen before the real server starts — both want the same port.
stop_maintenance_page

log_message "Starting $SERVICE_NAME..."
systemctl start "$SERVICE_NAME" || { log_message "Failed to start $SERVICE_NAME"; exit 1; }

log_message "Demo reset completed successfully."
