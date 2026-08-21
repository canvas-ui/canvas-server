#!/usr/bin/env bash
#
# Shared plumbing for the three installers:
#
#   install-docker.sh   build the image and run it under compose
#   build-image.sh      build the image only
#   install-local.sh    run the server from this checkout, no container
#
# All of them ask the SAME questions and speak the same .env, so the answers
# carry over: an .env written by one is understood by the others. Only the
# keys that describe the container (uid/gid, mount target) are ignored by the
# local runner, and it says so rather than silently dropping them.
#
# Sourced, never executed. The caller sets ENV_FILE / ENV_EXAMPLE and may set
# ASSUME_YES=true before sourcing.

ENV_FILE=${ENV_FILE:?install-common.sh: ENV_FILE must be set before sourcing}
ENV_EXAMPLE=${ENV_EXAMPLE:?install-common.sh: ENV_EXAMPLE must be set before sourcing}
ASSUME_YES=${ASSUME_YES:-false}

# Non-interactive shells (CI, piped input) must not block on a prompt.
if [ ! -t 0 ]; then ASSUME_YES=true; fi

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
warn() { printf '\033[33m  %s\033[0m\n' "$1"; }
fail() { printf '\033[31mError: %s\033[0m\n' "$1" >&2; exit 1; }

# ── Prompts ─────────────────────────────────────────────────────────────────

# ask <variable> <question> <default>
ask() {
    local __var=$1 question=$2 default=$3 answer
    if $ASSUME_YES; then
        printf -v "$__var" '%s' "$default"
        return
    fi
    read -r -p "  $question [$default]: " answer </dev/tty || answer=''
    printf -v "$__var" '%s' "${answer:-$default}"
}

# confirm <question> <default y|n>
confirm() {
    local question=$1 default=$2 answer prompt='[y/N]'
    [ "$default" = "y" ] && prompt='[Y/n]'
    if $ASSUME_YES; then [ "$default" = "y" ]; return; fi
    read -r -p "  $question $prompt: " answer </dev/tty || answer=''
    answer=${answer:-$default}
    case "$answer" in [yY]*) return 0 ;; *) return 1 ;; esac
}

# Password, read twice without echo. Empty is a valid answer: the server then
# generates one and prints it to the log on first start.
#
# The policy checked here is the server's default (server/config/auth.json):
# a password it would reject is not silently downgraded — the server falls back
# to a generated one — but you would only find that out from the log.
ask_password() {
    local first second
    if $ASSUME_YES; then ADMIN_PASSWORD=''; return; fi
    while true; do
        read -r -s -p "  Admin password (empty = generate one for me): " first </dev/tty || first=''
        echo
        [ -z "$first" ] && { ADMIN_PASSWORD=''; return; }
        if [ ${#first} -lt 8 ] || [[ ! "$first" =~ [0-9] ]] || [[ ! "$first" =~ [^A-Za-z0-9] ]]; then
            warn "at least 8 characters, including a number and a special character"
            continue
        fi
        read -r -s -p "  Repeat password: " second </dev/tty || second=''
        echo
        [ "$first" = "$second" ] && { ADMIN_PASSWORD="$first"; return; }
        warn "passwords did not match, try again"
    done
}

# ── .env ────────────────────────────────────────────────────────────────────

# Replace a key in place (keeping .env.example's comments and ordering), or
# append it if the example does not carry it. awk via ENVIRON so no value
# can be mangled by quoting or shell expansion.
write_env() {
    local key=$1 value=$2
    # compose interpolates .env values, so a literal $ has to be doubled —
    # otherwise a password like 'a$b' silently becomes 'a' plus an unset var.
    # env_get() undoes this for the readers that are not compose.
    value=${value//\$/\$\$}
    WRITE_KEY="$key" WRITE_VALUE="$value" awk '
        BEGIN { k = ENVIRON["WRITE_KEY"]; v = ENVIRON["WRITE_VALUE"] }
        $0 ~ "^" k "=" { print k "=" v; found = 1; next }
        { print }
        END { if (!found) print k "=" v }
    ' "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
}

# env_get <key> [default] — read one value out of $ENV_FILE.
#
# Deliberately not `set -a; . .env`: the file is data, not script. Sourcing it
# would execute whatever a value expands to and would keep compose's doubled
# '$$' doubled, so a password written as 'a$$b' would be used as 'a$$b'.
env_get() {
    local key=$1 default=${2:-} line value
    [ -f "$ENV_FILE" ] || { printf '%s' "$default"; return; }
    line=$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1) || true
    [ -n "$line" ] || { printf '%s' "$default"; return; }
    value=${line#*=}
    # Strip one layer of matching quotes, then undo compose's $$ escaping.
    if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
        value=${BASH_REMATCH[1]}
    fi
    value=${value//\$\$/\$}
    printf '%s' "${value:-$default}"
}

# ── The questions ───────────────────────────────────────────────────────────

# Sets: ADMIN_EMAIL ADMIN_NAME ADMIN_PASSWORD HOST_PORT HOST_SERVER_HOME
#       HOST_USER_HOME USER_MOUNT WORKSPACE_LAYOUT
#
# <target> is "container" or "local" and only changes the wording — the answers
# and the keys they end up in are identical, which is what lets one .env drive
# either way of running the server.
ask_all() {
    local target=${1:-container}

    bold "Admin account"
    info "Created on first start. The API token is printed to the log."
    ask ADMIN_EMAIL "Admin email" "admin@canvas.local"
    ask ADMIN_NAME  "Admin username (letters, digits, - and _)" "${ADMIN_EMAIL%%@*}"
    ask_password
    echo

    bold "Network"
    if [ "$target" = "local" ]; then
        ask HOST_PORT "Port to listen on" "8001"
    else
        ask HOST_PORT "Port to publish on the host" "8001"
    fi
    echo

    bold "Storage"
    info "Server state: config, index db, caches. Nothing you edit by hand, and"
    info "the directory worth backing up."
    ask HOST_SERVER_HOME "Server home" "$HOME/.canvas/server"
    echo

    bold "Your data"
    info "Workspaces, roles and agents live under their owner — one user is one"
    info "subtree, which is what a per-user dataset or quota needs. A personal"
    info "instance points one folder at your home and that is the whole story;"
    info "a shared one names the users tree and the server fills in <email>/."
    if confirm "Personal instance (one folder for your data)?" y; then
        # The target is this user's home, so the folder holds Workspaces/Roles/
        # Agents plus a hidden .canvas/ for tokens and config. The container
        # bind-mounts it onto data/users/<email>; the local runner symlinks.
        ask HOST_USER_HOME "Your folder" "$HOME/Canvas"
        USER_MOUNT=""
    else
        ask HOST_USER_HOME "Users root" "/srv/canvas/users"
        USER_MOUNT="/opt/canvas-server/data/users"
    fi
    echo

    bold "Workspace layout"
    info "home — a workspace IS a plain folder; everything it needs to run hides"
    info "       in .workspace/. Existing folders can be turned into workspaces,"
    info "       and a workspace can be synced (Dropbox/OneDrive) or roamed."
    info "full — the classic layout: db/, cache/, home/ … as visible children."
    if confirm "Use the 'home' layout for new workspaces?" y; then
        WORKSPACE_LAYOUT=home
    else
        WORKSPACE_LAYOUT=full
    fi
    echo
}

# Write the answers to $ENV_FILE, starting from .env.example so its comments
# and ordering survive. Creates the two directories the answers name, as you
# rather than as root (docker would create a missing mount source as root).
write_answers() {
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    chmod 600 "$ENV_FILE"

    write_env CANVAS_UID "$(id -u)"
    write_env CANVAS_GID "$(id -g)"
    write_env CANVAS_HOST_PORT "$HOST_PORT"
    write_env CANVAS_ADMIN_EMAIL "$ADMIN_EMAIL"
    write_env CANVAS_ADMIN_NAME "$ADMIN_NAME"
    write_env CANVAS_ADMIN_PASSWORD "$ADMIN_PASSWORD"
    write_env CANVAS_HOST_SERVER_HOME "$HOST_SERVER_HOME"
    write_env CANVAS_HOST_USER_HOME "$HOST_USER_HOME"
    write_env CANVAS_USER_MOUNT "$USER_MOUNT"
    write_env CANVAS_WORKSPACE_LAYOUT "$WORKSPACE_LAYOUT"

    mkdir -p "$HOST_SERVER_HOME" "$HOST_USER_HOME"

    bold "Wrote $ENV_FILE"
    info "admin       $ADMIN_NAME <$ADMIN_EMAIL>"
    info "url         http://localhost:$HOST_PORT"
    info "server      $HOST_SERVER_HOME"
    if [ -n "$USER_MOUNT" ]; then
        info "users       $HOST_USER_HOME  (one <email>/ subtree per user)"
    else
        info "your data   $HOST_USER_HOME  →  ${ADMIN_EMAIL}'s home"
        info "            Workspaces/ Roles/ Agents/ + a hidden .canvas/"
    fi
    info "layout      $WORKSPACE_LAYOUT"
    echo
}

# Existing .env → ask whether to keep it. Sets KEEP_ENV.
handle_existing_env() {
    if [ -f "$ENV_FILE" ]; then
        info "Found an existing $ENV_FILE"
        if confirm "Keep it and skip the questions?" y; then
            KEEP_ENV=true
        else
            KEEP_ENV=false
            cp "$ENV_FILE" "$ENV_FILE.bak"
            info "Previous config saved to .env.bak"
        fi
    else
        KEEP_ENV=false
    fi
}

# The revision the AGPL §13 source offer points at. Empty outside a checkout.
git_head() {
    git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true
}
