#!/bin/ash

# Installs Canvas Server on Alpine (Node 20, OpenRC service).
CANVAS_ROOT="${CANVAS_ROOT:-/opt/canvas-server}"
CANVAS_USER="${CANVAS_USER:-canvas}"
CANVAS_GROUP="${CANVAS_GROUP:-www-data}"
CANVAS_REPO_URL="${CANVAS_REPO_URL:-https://github.com/canvas-ui/canvas-server.git}"
CANVAS_REPO_TARGET_BRANCH="${CANVAS_REPO_TARGET_BRANCH:-dev}"
NODEJS_VERSION="${NODEJS_VERSION:-20}"
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
grep -q -i 'NAME="Alpine Linux"' /etc/os-release || { echo "Alpine Linux only"; exit 1; }

handle_error() {
    echo "Error: $2"
    exit "$1"
}

setup_nodejs() {
    if command -v node >/dev/null && node --version | grep -q "^v$NODEJS_VERSION" && command -v npm >/dev/null; then
        echo "Node.js $(node --version) already installed"
        return 0
    fi
    apk add --no-cache nodejs npm || handle_error "$?" "Failed to install Node.js"
    command -v node >/dev/null || handle_error 1 "node not found after install"
    command -v npm >/dev/null || handle_error 1 "npm not found after install"
}

install_canvas_service() {
    [ -f /etc/init.d/canvas-server ] && return 0
    echo "Creating OpenRC service for Canvas Server..."
    cat > /etc/init.d/canvas-server <<EOF
#!/sbin/openrc-run

name="Canvas Server"
description="Canvas Server"

supervisor=supervise-daemon
command="/usr/bin/npm"
command_args="run start"
command_user="$CANVAS_USER"
command_background=yes
directory="$CANVAS_ROOT"
pidfile="/run/\${RC_SVCNAME}.pid"

export NODE_ENV=production
export CANVAS_SERVER_HOME="$CANVAS_ROOT/server"
export CANVAS_USER_HOME="$CANVAS_ROOT/users"

depend() {
    need net
}
EOF
    chmod +x /etc/init.d/canvas-server
    rc-update add canvas-server default
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

    su -s /bin/ash "$CANVAS_USER" -c "cd \"$CANVAS_ROOT\" && npm run update-submodules" || handle_error "$?" "submodule update failed"
    su -s /bin/ash "$CANVAS_USER" -c "cd \"$CANVAS_ROOT\" && npm install" || handle_error "$?" "npm install failed"
    su -s /bin/ash "$CANVAS_USER" -c "cd \"$CANVAS_ROOT\" && npm run build" || handle_error "$?" "npm run build failed"

    start_canvas
    echo "Canvas Server updated."
}

install_canvas() {
    echo "Installing Canvas Server to $CANVAS_ROOT..."
    git clone --branch "$CANVAS_REPO_TARGET_BRANCH" "$CANVAS_REPO_URL" "$CANVAS_ROOT" \
        || handle_error "$?" "git clone failed"

    cd "$CANVAS_ROOT" || handle_error "$?" "Failed to cd to $CANVAS_ROOT"
    chown -R "$CANVAS_USER:$CANVAS_GROUP" "$CANVAS_ROOT" || handle_error "$?" "chown failed"

    su -s /bin/ash "$CANVAS_USER" -c "cd \"$CANVAS_ROOT\" && npm run update-submodules" || handle_error "$?" "submodule update failed"
    su -s /bin/ash "$CANVAS_USER" -c "cd \"$CANVAS_ROOT\" && npm install" || handle_error "$?" "npm install failed"
    su -s /bin/ash "$CANVAS_USER" -c "cd \"$CANVAS_ROOT\" && npm run build" || handle_error "$?" "npm run build failed"

    install_canvas_service
    start_canvas
    echo "Canvas Server installed."
}

echo "Updating Alpine packages..."
apk update && apk upgrade || handle_error "$?" "apk update/upgrade failed"

apk add --no-cache git curl wget build-base nano ca-certificates openssh socat whois ufw bind-tools \
    || handle_error "$?" "Failed to install system utilities"

setup_nodejs

getent group "$CANVAS_GROUP" >/dev/null || addgroup -S "$CANVAS_GROUP" || handle_error "$?" "addgroup failed"
id "$CANVAS_USER" >/dev/null 2>&1 || adduser -S -D -s /sbin/nologin -G "$CANVAS_GROUP" -h "$CANVAS_ROOT" "$CANVAS_USER" \
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
echo "  API: http://localhost:8001"

exit 0
