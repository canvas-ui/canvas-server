#!/bin/bash
#
# Container entrypoint for Canvas Server.
#
# Prepares the mounted data directories, makes sure a JWT secret exists, then
# hands over to the command (CMD, by default `node ./src/init.js`).

set -e

SERVER_HOME=${CANVAS_SERVER_HOME:-/opt/canvas-server/server}
USER_HOME=${CANVAS_USER_HOME:-/opt/canvas-server/users}

# Bind mounts arrive empty on first run; the server expects these to exist.
mkdir -p \
    "$SERVER_HOME/config" \
    "$SERVER_HOME/db" \
    "$SERVER_HOME/cache" \
    "$SERVER_HOME/var" \
    "$USER_HOME"

# The three per-user module roots, when they point at fixed container paths
# (the single-user case — one host dir bind-mounted per module).
for module_root in "$CANVAS_USER_WORKSPACES" "$CANVAS_USER_ROLES" "$CANVAS_USER_AGENTS"; do
    case "$module_root" in
        ''|*'{'*) continue ;;   # unset, or a per-user {USER_HOME} template
        *) mkdir -p "$module_root" ;;
    esac
done

# A JWT secret that changes on every restart invalidates every session, and the
# built-in default is a published constant. Generate once and keep it with the
# rest of the server config (bind-mounted, so it survives rebuilds).
if [ -z "$CANVAS_JWT_SECRET" ]; then
    JWT_SECRET_FILE="$SERVER_HOME/config/jwt.secret"
    if [ ! -s "$JWT_SECRET_FILE" ]; then
        openssl rand -base64 48 | tr -d '\n' > "$JWT_SECRET_FILE"
        chmod 600 "$JWT_SECRET_FILE" 2>/dev/null || true
        echo "canvas: generated a new JWT secret at $JWT_SECRET_FILE"
    fi
    CANVAS_JWT_SECRET=$(cat "$JWT_SECRET_FILE")
    export CANVAS_JWT_SECRET
fi

echo "canvas: starting Canvas Server"
echo "canvas:   server home  ${SERVER_HOME}"
echo "canvas:   users home   ${USER_HOME}"
echo "canvas:   admin        ${CANVAS_ADMIN_EMAIL:-admin@canvas.local}"
[ -n "$CANVAS_USER_WORKSPACES" ] && echo "canvas:   workspaces   ${CANVAS_USER_WORKSPACES}"
[ -n "$CANVAS_USER_ROLES" ]      && echo "canvas:   roles        ${CANVAS_USER_ROLES}"
[ -n "$CANVAS_USER_AGENTS" ]     && echo "canvas:   agents       ${CANVAS_USER_AGENTS}"
if [ -z "$CANVAS_ADMIN_PASSWORD" ]; then
    echo "canvas:   no CANVAS_ADMIN_PASSWORD set — one is generated and printed below on first run"
fi

cd /opt/canvas-server || exit 1

exec "$@"
