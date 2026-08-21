#!/usr/bin/env bash
#
# Canvas Server — build the container image.
#
#     ./scripts/build-image.sh                    (or: npm run docker:image)
#     ./scripts/build-image.sh --env-file /etc/canvas/prod.env
#     ./scripts/build-image.sh -y --tag canvas-server:2.5.58
#
# The image only, no container: install-docker.sh is the one that also runs it.
# Use this to build for a registry, for a machine that runs the container some
# other way (systemd, k8s, another host's compose), or to rebuild after a pull.
#
# The .env is read for the values that are baked in at BUILD time — the node
# version and the AGPL §13 source identity. Everything else in it (admin,
# ports, paths) is runtime configuration and is deliberately NOT baked into the
# image, so one image serves every instance.
#
# Flags:
#   -e, --env-file PATH   read/write this .env instead of <repo>/.env
#   -t, --tag NAME[:TAG]  image tag (default: canvas-server:<package version>,
#                         also tagged :latest)
#       --no-cache        build from scratch, ignoring layer cache
#       --platform LIST   e.g. linux/amd64,linux/arm64 (needs buildx)
#       --no-env          do not read or write any .env, build with defaults
#   -y, --yes             accept every default, ask nothing
#   -h, --help

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
ENV_EXAMPLE="$REPO_ROOT/.env.example"

ASSUME_YES=false
IMAGE_TAG=""
NO_CACHE=false
PLATFORM=""
USE_ENV=true

while [ $# -gt 0 ]; do
    case "$1" in
        -e|--env-file) ENV_FILE="$2"; shift ;;
        -t|--tag)      IMAGE_TAG="$2"; shift ;;
        --no-cache)    NO_CACHE=true ;;
        --platform)    PLATFORM="$2"; shift ;;
        --no-env)      USE_ENV=false ;;
        -y|--yes)      ASSUME_YES=true ;;
        -h|--help)     awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
        *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
    shift
done

# An --env-file may be relative, or name a directory holding one. Resolved to
# an absolute path because the questions are answered before the build and the
# error for a mistyped path should name the file, not fail later inside awk.
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
docker info >/dev/null 2>&1 || fail "cannot talk to the docker daemon — is it running, and is your user in the 'docker' group?"
[ -f "$REPO_ROOT/Dockerfile" ] || fail "missing $REPO_ROOT/Dockerfile — run this from a cloned canvas-server repo"

echo
bold "Canvas Server — build image"
echo

# ── .env ────────────────────────────────────────────────────────────────────

if $USE_ENV; then
    [ -f "$ENV_EXAMPLE" ] || fail "missing $ENV_EXAMPLE — run this from a cloned canvas-server repo"
    info "config      $ENV_FILE"
    handle_existing_env
    if [ "${KEEP_ENV:-false}" != "true" ]; then
        echo
        ask_all container
        write_answers
    fi
    echo
fi

# ── Build args ──────────────────────────────────────────────────────────────

# The image cannot read .git (excluded from the build context), so the revision
# behind the source offer has to be passed in. A fork MUST point the URL at the
# repository publishing ITS changes — see .env.example.
NODE_VERSION=$(env_get NODE_VERSION 22)
SOURCE_URL=$(env_get CANVAS_SOURCE_URL "https://github.com/canvas-ui/canvas-server")
SOURCE_COMMIT=$(env_get CANVAS_SOURCE_COMMIT "")
[ -n "$SOURCE_COMMIT" ] || SOURCE_COMMIT=$(git_head)

if [ -z "$IMAGE_TAG" ]; then
    VERSION=$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo "")
    IMAGE_TAG="canvas-server:${VERSION:-latest}"
fi
# A tag without an explicit :tag is a repository name; docker would default it
# to :latest, which is also the second tag below — keep it at one tag then.
EXTRA_TAG=""
case "${IMAGE_TAG##*/}" in
    *:*) [ "${IMAGE_TAG##*:}" = "latest" ] || EXTRA_TAG="${IMAGE_TAG%:*}:latest" ;;
esac

BUILD_ARGS=(
    --build-arg "NODE_VERSION=$NODE_VERSION"
    --build-arg "CANVAS_SOURCE_URL=$SOURCE_URL"
    --build-arg "CANVAS_SOURCE_COMMIT=$SOURCE_COMMIT"
    -f "$REPO_ROOT/Dockerfile"
    -t "$IMAGE_TAG"
)
if [ -n "$EXTRA_TAG" ]; then BUILD_ARGS+=(-t "$EXTRA_TAG"); fi
if $NO_CACHE; then BUILD_ARGS+=(--no-cache); fi

bold "Building"
info "image       $IMAGE_TAG${EXTRA_TAG:+  (+ $EXTRA_TAG)}"
info "node        $NODE_VERSION"
info "source      $SOURCE_URL"
info "commit      ${SOURCE_COMMIT:-(unknown — not a git checkout)}"
if [ -n "$PLATFORM" ]; then info "platform    $PLATFORM"; fi
info "First build downloads a few hundred MB of prebuilt native binaries"
info "(onnxruntime, lmdb) and takes a while; later builds reuse the cache."
echo

if [ -n "$PLATFORM" ]; then
    docker buildx version >/dev/null 2>&1 || fail "--platform needs docker buildx"
    # --load cannot hold a multi-arch result; such a build has to be pushed.
    LOAD_OR_NOT=--load
    case "$PLATFORM" in *,*) LOAD_OR_NOT="" ;; esac
    docker buildx build --platform "$PLATFORM" ${LOAD_OR_NOT:+$LOAD_OR_NOT} "${BUILD_ARGS[@]}" "$REPO_ROOT"
    if [ -z "$LOAD_OR_NOT" ]; then
        echo
        warn "a multi-arch build stays in the buildx cache — add --push to a buildx"
        warn "invocation, or build one platform at a time, to get a local image"
    fi
else
    docker build "${BUILD_ARGS[@]}" "$REPO_ROOT"
fi

echo
bold "Built $IMAGE_TAG"
if [ "$ENV_FILE" = "$REPO_ROOT/.env" ]; then
    info "Run it here:      npm run docker:up"
else
    # compose only picks up a .env next to the compose file on its own.
    info "Run it here:      docker compose --env-file $ENV_FILE up -d"
fi
info "Ship it:          docker push $IMAGE_TAG"
info "Run it by hand:"
info "  docker run -d -p 8001:8001 \\"
info "    -v \$HOME/.canvas/server:/opt/canvas-server/data/server \\"
info "    -v \$HOME/Canvas:/opt/canvas-server/data/users/admin@canvas.local \\"
info "    --user \$(id -u):\$(id -g) --name canvas-server $IMAGE_TAG"
