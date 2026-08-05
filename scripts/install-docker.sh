#!/usr/bin/env bash
#
# Canvas Server — containerized install.
#
# Run it from a cloned repo:
#
#     ./scripts/install-docker.sh          (or: npm run docker:install)
#
# Asks a handful of questions, writes .env, builds the image and starts the
# container. Re-running it is safe: it offers to keep the existing .env, and
# nothing outside .env and the directories you name is touched.
#
# Flags:
#   -y, --yes         accept every default, ask nothing
#       --no-build    write .env only (build later with: npm run docker:build)
#       --no-start    build, but do not start the container
#   -h, --help

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
ENV_EXAMPLE="$REPO_ROOT/.env.example"

ASSUME_YES=false
DO_BUILD=true
DO_START=true

while [ $# -gt 0 ]; do
    case "$1" in
        -y|--yes)    ASSUME_YES=true ;;
        --no-build)  DO_BUILD=false; DO_START=false ;;
        --no-start)  DO_START=false ;;
        -h|--help)   sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
    shift
done

# Non-interactive shells (CI, piped input) must not block on a prompt.
if [ ! -t 0 ]; then ASSUME_YES=true; fi

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
warn() { printf '\033[33m  %s\033[0m\n' "$1"; }
fail() { printf '\033[31mError: %s\033[0m\n' "$1" >&2; exit 1; }

# ── Prerequisites ───────────────────────────────────────────────────────────

command -v docker >/dev/null 2>&1 || fail "docker is not installed — see https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || fail "the docker compose plugin is missing (docker-compose v1 is not supported)"
docker info >/dev/null 2>&1 || fail "cannot talk to the docker daemon — is it running, and is your user in the 'docker' group?"
[ -f "$ENV_EXAMPLE" ] || fail "missing $ENV_EXAMPLE — run this from a cloned canvas-server repo"

# ── Prompt helpers ──────────────────────────────────────────────────────────

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
ask_password() {
    local first second
    if $ASSUME_YES; then ADMIN_PASSWORD=''; return; fi
    while true; do
        read -r -s -p "  Admin password (empty = generate one for me): " first </dev/tty || first=''
        echo
        [ -z "$first" ] && { ADMIN_PASSWORD=''; return; }
        read -r -s -p "  Repeat password: " second </dev/tty || second=''
        echo
        [ "$first" = "$second" ] && { ADMIN_PASSWORD="$first"; return; }
        warn "passwords did not match, try again"
    done
}

# ── Existing .env ───────────────────────────────────────────────────────────

echo
bold "Canvas Server — container install"
echo

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

# ── Questions ───────────────────────────────────────────────────────────────

if [ "${KEEP_ENV:-false}" != "true" ]; then
    bold "Admin account"
    info "Created on first start. The API token is printed to the log."
    ask ADMIN_EMAIL "Admin email" "admin@canvas.local"
    ask ADMIN_NAME  "Admin username (letters, digits, - and _)" "${ADMIN_EMAIL%%@*}"
    ask_password
    echo

    bold "Network"
    ask HOST_PORT "Port to publish on the host" "8001"
    echo

    bold "Storage"
    info "Server state (config, index db, caches) — the directory worth backing up."
    info "Per-user homes live inside it, at <server home>/users."
    ask HOST_SERVER_HOME "Server home" "$HOME/.canvas/server"
    echo

    bold "Your folders"
    info "Workspaces, roles and agents are per-user modules. Mount them from your"
    info "home directory and they stay ordinary folders you can open in a file manager."
    if confirm "Mount host folders for workspaces/roles/agents?" y; then
        ask HOST_WORKSPACES "Workspaces" "$HOME/Workspaces"
        ask HOST_ROLES      "Roles"      "$HOME/Roles"
        ask HOST_AGENTS     "Agents"     "$HOME/Agents"
        MOUNT_MODULES=true
    else
        # No pinned roots: every user gets <userHome>/{Workspaces,Roles,Agents}
        # inside the mounted users home — the multi-user shape.
        HOST_WORKSPACES="$HOST_SERVER_HOME/modules/workspaces"
        HOST_ROLES="$HOST_SERVER_HOME/modules/roles"
        HOST_AGENTS="$HOST_SERVER_HOME/modules/agents"
        MOUNT_MODULES=false
    fi
    echo

    # ── Write .env ──────────────────────────────────────────────────────────

    # Replace a key in place (keeping .env.example's comments and ordering), or
    # append it if the example does not carry it. awk via ENVIRON so no value
    # can be mangled by quoting or shell expansion.
    write_env() {
        local key=$1 value=$2
        # compose interpolates .env values, so a literal $ has to be doubled —
        # otherwise a password like 'a$b' silently becomes 'a' plus an unset var.
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

    cp "$ENV_EXAMPLE" "$ENV_FILE"
    chmod 600 "$ENV_FILE"

    write_env CANVAS_UID "$(id -u)"
    write_env CANVAS_GID "$(id -g)"
    write_env CANVAS_HOST_PORT "$HOST_PORT"
    write_env CANVAS_ADMIN_EMAIL "$ADMIN_EMAIL"
    write_env CANVAS_ADMIN_NAME "$ADMIN_NAME"
    write_env CANVAS_ADMIN_PASSWORD "$ADMIN_PASSWORD"
    write_env CANVAS_HOST_SERVER_HOME "$HOST_SERVER_HOME"
    write_env CANVAS_HOST_WORKSPACES "$HOST_WORKSPACES"
    write_env CANVAS_HOST_ROLES "$HOST_ROLES"
    write_env CANVAS_HOST_AGENTS "$HOST_AGENTS"

    if [ "$MOUNT_MODULES" = "false" ]; then
        # Unset the in-container roots so each user falls back to their own
        # <userHome>/{Workspaces,Roles,Agents}.
        write_env CANVAS_USER_WORKSPACES ""
        write_env CANVAS_USER_ROLES ""
        write_env CANVAS_USER_AGENTS ""
    fi

    # The compose mounts are bind mounts: docker would create them as root.
    mkdir -p "$HOST_SERVER_HOME/users" "$HOST_WORKSPACES" "$HOST_ROLES" "$HOST_AGENTS"

    bold "Wrote $ENV_FILE"
    info "admin       $ADMIN_NAME <$ADMIN_EMAIL>"
    info "url         http://localhost:$HOST_PORT"
    info "server      $HOST_SERVER_HOME"
    info "users       $HOST_SERVER_HOME/users"
    info "workspaces  $HOST_WORKSPACES"
    info "roles       $HOST_ROLES"
    info "agents      $HOST_AGENTS"
    echo
fi

# ── Build & start ───────────────────────────────────────────────────────────

cd "$REPO_ROOT"

if $DO_BUILD; then
    bold "Building the image"
    info "First build downloads a few hundred MB of prebuilt native binaries"
    info "(onnxruntime, lmdb) and takes a while; later builds reuse the cache."
    docker compose build
    echo
fi

if $DO_START; then
    bold "Starting"
    docker compose up -d
    echo

    port=$(grep -E '^CANVAS_HOST_PORT=' "$ENV_FILE" | cut -d= -f2-)
    port=${port:-8001}
    printf '  waiting for the server to answer'
    for _ in $(seq 1 60); do
        if curl -fsS "http://localhost:${port}/rest/v2/ping" >/dev/null 2>&1; then
            printf ' ok\n\n'
            bold "Canvas Server is running at http://localhost:${port}"
            if [ -z "$(grep -E '^CANVAS_ADMIN_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)" ]; then
                info "The generated admin password and API token are in the log:"
                info "  npm run docker:logs"
            fi
            info "Stop it with: npm run docker:down"
            exit 0
        fi
        printf '.'
        sleep 2
    done
    printf '\n'
    warn "the server did not answer within 2 minutes — check: npm run docker:logs"
    exit 1
fi

bold "Done"
info "Build:  npm run docker:build"
info "Start:  npm run docker:up"
