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
# The questions and the .env are shared with scripts/install-local.sh (same
# server, run from this checkout instead of a container) and with
# scripts/build-image.sh (the image on its own).
#
# Flags:
#   -y, --yes         accept every default, ask nothing
#   -e, --env-file    read/write this .env instead of <repo>/.env
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
        -y|--yes)      ASSUME_YES=true ;;
        -e|--env-file) ENV_FILE="$2"; shift ;;
        --no-build)    DO_BUILD=false; DO_START=false ;;
        --no-start)    DO_START=false ;;
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

command -v docker >/dev/null 2>&1 || fail "docker is not installed — see https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || fail "the docker compose plugin is missing (docker-compose v1 is not supported)"
docker info >/dev/null 2>&1 || fail "cannot talk to the docker daemon — is it running, and is your user in the 'docker' group?"
[ -f "$ENV_EXAMPLE" ] || fail "missing $ENV_EXAMPLE — run this from a cloned canvas-server repo"

# compose only reads a .env sitting next to the compose file; anywhere else has
# to be passed explicitly on every call.
COMPOSE=(docker compose --env-file "$ENV_FILE")

# ── Existing .env ───────────────────────────────────────────────────────────

echo
bold "Canvas Server — container install"
echo

handle_existing_env

# ── Questions ───────────────────────────────────────────────────────────────

if [ "${KEEP_ENV:-false}" != "true" ]; then
    ask_all container
    write_answers
fi

# ── Build & start ───────────────────────────────────────────────────────────

cd "$REPO_ROOT"

if $DO_BUILD; then
    bold "Building the image"
    info "First build downloads a few hundred MB of prebuilt native binaries"
    info "(onnxruntime, lmdb) and takes a while; later builds reuse the cache."
    # The image cannot read .git (it is out of the build context), so the
    # revision behind the AGPL §13 source offer is passed in here.
    CANVAS_SOURCE_COMMIT="$(env_get CANVAS_SOURCE_COMMIT "$(git_head)")" "${COMPOSE[@]}" build
    echo
fi

if $DO_START; then
    bold "Starting"
    "${COMPOSE[@]}" up -d
    echo

    port=$(env_get CANVAS_HOST_PORT 8001)
    printf '  waiting for the server to answer'
    for _ in $(seq 1 60); do
        if curl -fsS "http://localhost:${port}/rest/v2/ping" >/dev/null 2>&1; then
            printf ' ok\n\n'
            bold "Canvas Server is running at http://localhost:${port}"
            if [ -z "$(env_get CANVAS_ADMIN_PASSWORD "")" ]; then
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
