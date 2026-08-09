#!/bin/ash

# Installs Canvas Server on Alpine (Node >=20, OpenRC service).
# Works on a vanilla Alpine VPS (enables community repo — npm lives there).
CANVAS_ROOT="${CANVAS_ROOT:-/opt/canvas-server}"
CANVAS_USER="${CANVAS_USER:-canvas}"
CANVAS_GROUP="${CANVAS_GROUP:-www-data}"
CANVAS_REPO_URL="${CANVAS_REPO_URL:-https://github.com/canvas-ui/canvas-server.git}"
CANVAS_REPO_TARGET_BRANCH="${CANVAS_REPO_TARGET_BRANCH:-dev}"
NODEJS_VERSION="${NODEJS_VERSION:-22}"
WEB_ADMIN_EMAIL="${WEB_ADMIN_EMAIL:-$(hostname)@cnvs.ai}"
WEB_FQDN="${WEB_FQDN:-my.cnvs.ai}"

usage() {
    echo "Usage: $0 [-r canvas_root] [-u canvas_user] [-g canvas_group] [-b branch] [-n nodejs_version] [-e email] [-f fqdn]"
    exit 1
}

while getopts "r:u:g:b:n:e:f:h" opt; do
    case $opt in
        r) CANVAS_ROOT="$OPTARG" ;;
        u) CANVAS_USER="$OPTARG" ;;
        g) CANVAS_GROUP="$OPTARG" ;;
        b) CANVAS_REPO_TARGET_BRANCH="$OPTARG" ;;
        n) NODEJS_VERSION="$OPTARG" ;;
        e) WEB_ADMIN_EMAIL="$OPTARG" ;;
        f) WEB_FQDN="$OPTARG" ;;
        h) usage ;;
        ?) echo "Invalid option -$OPTARG" >&2; usage ;;
    esac
done

[ "$(id -u)" -eq 0 ] || { echo "Please run as root"; exit 1; }
grep -q -i 'ID=alpine' /etc/os-release || { echo "Alpine Linux only"; exit 1; }

handle_error() {
    echo "Error: $2"
    exit "$1"
}

# npm / ufw / whois live in community; many VPS images ship it commented out
enable_community_repo() {
    local repos=/etc/apk/repositories
    if grep -qE '^[#[:space:]]*https?://.*/community' "$repos"; then
        sed -i -E 's|^[#[:space:]]*(https?://.*/community.*)|\1|' "$repos"
    elif ! grep -qE '/community' "$repos"; then
        local main
        main=$(grep -E '^https?://.*/main$' "$repos" | head -1) || true
        [ -n "$main" ] && echo "${main%/main}/community" >> "$repos"
    fi
}

setup_nodejs() {
    local major
    major=$(node --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')
    if [ -n "$major" ] && [ "$major" -ge "$NODEJS_VERSION" ] && command -v npm >/dev/null; then
        echo "Node.js $(node --version) already installed"
        return 0
    fi
    apk add --no-cache nodejs npm || handle_error "$?" "Failed to install Node.js"
    command -v node >/dev/null || handle_error 1 "node not found after install"
    command -v npm >/dev/null || handle_error 1 "npm not found after install"
    major=$(node --version | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')
    [ -n "$major" ] && [ "$major" -ge "$NODEJS_VERSION" ] \
        || handle_error 1 "Need Node.js >= $NODEJS_VERSION, got $(node --version)"
}

run_as_canvas() {
    su -s /bin/ash "$CANVAS_USER" -c "cd \"$CANVAS_ROOT\" && $1" || handle_error "$?" "$2"
}

install_canvas_service() {
    local node_bin
    node_bin=$(command -v node) || handle_error 1 "node not found"

    cat > /etc/conf.d/canvas-server <<EOF
NODE_ENV=production
CANVAS_SERVER_HOME=$CANVAS_ROOT/server
CANVAS_USER_HOME=$CANVAS_ROOT/users
EOF

    cat > /etc/init.d/canvas-server <<EOF
#!/sbin/openrc-run

name="Canvas Server"
description="Canvas Server"

supervisor=supervise-daemon
command="$node_bin"
command_args="./src/init.js"
command_user="$CANVAS_USER:$CANVAS_GROUP"
command_background=yes
directory="$CANVAS_ROOT"
pidfile="/run/\${RC_SVCNAME}.pid"

depend() {
    need net
}
EOF
    chmod +x /etc/init.d/canvas-server
    rc-update add canvas-server default 2>/dev/null || true
}

stop_canvas() {
    rc-service canvas-server stop 2>/dev/null || true
}

start_canvas() {
    rc-service canvas-server start || handle_error "$?" "Failed to start canvas-server"
}

update_canvas() {
    echo "Updating Canvas Server in $CANVAS_ROOT..."
    cd "$CANVAS_ROOT" || handle_error "$?" "Failed to cd to $CANVAS_ROOT"

    install_canvas_service
    stop_canvas

    [ -d node_modules ] && rm -rf node_modules

    git pull origin "$CANVAS_REPO_TARGET_BRANCH" || handle_error "$?" "git pull failed"

    chown -R "$CANVAS_USER:$CANVAS_GROUP" "$CANVAS_ROOT" || handle_error "$?" "chown failed"

    run_as_canvas "npm install" "npm install failed"

    start_canvas
    echo "Canvas Server updated."
}

install_canvas() {
    echo "Installing Canvas Server to $CANVAS_ROOT..."
    git clone --branch "$CANVAS_REPO_TARGET_BRANCH" "$CANVAS_REPO_URL" "$CANVAS_ROOT" \
        || handle_error "$?" "git clone failed"

    cd "$CANVAS_ROOT" || handle_error "$?" "Failed to cd to $CANVAS_ROOT"
    chown -R "$CANVAS_USER:$CANVAS_GROUP" "$CANVAS_ROOT" || handle_error "$?" "chown failed"

    run_as_canvas "npm install" "npm install failed"

    install_canvas_service
    start_canvas
    echo "Canvas Server installed."
}

echo "Enabling Alpine community repository (required for npm)..."
enable_community_repo

echo "Updating Alpine packages..."
apk update && apk upgrade || handle_error "$?" "apk update/upgrade failed"

# build-base/python3/linux-headers: native modules (lmdb, sharp, …)
# gcompat/libstdc++: best-effort glibc binaries (onnxruntime-node still limited on musl)
apk add --no-cache \
    openrc git curl wget build-base python3 linux-headers nano ca-certificates \
    openssh socat whois ufw bind-tools gcompat libstdc++ \
    || handle_error "$?" "Failed to install system utilities"

setup_nodejs

getent group "$CANVAS_GROUP" >/dev/null || addgroup -S "$CANVAS_GROUP" || handle_error "$?" "addgroup failed"
# -H: do not pre-create home (git clone owns $CANVAS_ROOT)
id "$CANVAS_USER" >/dev/null 2>&1 \
    || adduser -S -D -H -s /sbin/nologin -G "$CANVAS_GROUP" -h "$CANVAS_ROOT" "$CANVAS_USER" \
    || handle_error "$?" "adduser failed"

git config --global --add safe.directory "$CANVAS_ROOT" 2>/dev/null \
    || echo "Warning: failed to add safe.directory for $CANVAS_ROOT"

if [ ! -d "$CANVAS_ROOT/.git" ]; then
    install_canvas
else
    update_canvas
fi

echo ""
echo "Canvas Server installation/update completed."
rc-service canvas-server status || true
echo ""
echo "  rc-service canvas-server start|stop|restart|status"
echo "  API + Web UI: http://localhost:8001"
echo ""
echo "Note: onnxruntime-node is glibc-built; local ONNX embeddings may fail on musl."
echo "      Use an external embed provider, or install on Ubuntu for full local ORT."

exit 0
