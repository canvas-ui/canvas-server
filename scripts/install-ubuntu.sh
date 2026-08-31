#!/bin/bash

# This script installs and sets up the Canvas Server on an Ubuntu system.
# It installs Node.js 22, clones the Canvas Server repository, and sets up the service.

# Set default values for environment variables
CANVAS_ROOT="${CANVAS_ROOT:-/opt/canvas-server}"
CANVAS_USER="${CANVAS_USER:-canvas}"
CANVAS_GROUP="${CANVAS_GROUP:-www-data}"
CANVAS_REPO_URL="${CANVAS_REPO_URL:-https://github.com/canvas-ui/canvas-server.git}"
CANVAS_REPO_TARGET_BRANCH="${CANVAS_REPO_TARGET_BRANCH:-dev}"
NODEJS_VERSION="${NODEJS_VERSION:-22}"
WEB_ADMIN_EMAIL="${WEB_ADMIN_EMAIL:-$(hostname)@cnvs.ai}"
WEB_FQDN="${WEB_FQDN:-my.cnvs.ai}"

# Function to display usage information
usage() {
    echo "Usage: $0 [-r canvas_root] [-u canvas_user] [-g canvas_group] [-b canvas_repo_branch] [-n nodejs_version] [-e web_admin_email] [-f web_fqdn]"
    echo "  -r: Canvas root directory (default: /opt/canvas-server)"
    echo "  -u: Canvas user (default: canvas)"
    echo "  -g: Canvas group (default: www-data)"
    echo "  -b: Canvas repository branch (default: dev)"
    echo "  -n: Node.js version (default: 22)"
    echo "  -e: Web admin email (default: $(hostname)@cnvs.ai)"
    echo "  -f: Web FQDN (default: my.cnvs.ai)"
    exit 1
}

# Parse command line options
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
        \?) echo "Invalid option -$OPTARG" >&2; usage ;;
    esac
done

# Ensure script is run as root
if [ $(id -u) -ne 0 ]; then
    echo "Please run this script as root"
    exit 1
fi

# Ensure system is Ubuntu
if [ ! -f /etc/os-release ]; then
    echo "This script is intended for Ubuntu systems only"
    exit 1
fi

# Function to handle errors
handle_error() {
    local exit_code=$1
    local msg=$2
    echo "Error: $msg"
    exit $exit_code
}

# Function to set up the NodeSource repository
setup_nodejs_repository() {
    echo "Setting up Node.js $NODEJS_VERSION repository..."

    if ! mkdir -p /usr/share/keyrings; then
        handle_error "$?" "Failed to create /usr/share/keyrings directory"
    fi

    # Clean up any existing NodeSource configurations
    rm -f /usr/share/keyrings/nodesource.gpg || true
    rm -f /etc/apt/sources.list.d/nodesource.list || true
    rm -f /etc/apt/preferences.d/nsolid || true
    rm -f /etc/apt/preferences.d/nodejs || true

    # Download and import the NodeSource signing key
    if ! curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg; then
        handle_error "$?" "Failed to download and import the NodeSource signing key"
    fi

    if ! chmod 644 /usr/share/keyrings/nodesource.gpg; then
        handle_error "$?" "Failed to set correct permissions on /usr/share/keyrings/nodesource.gpg"
    fi

    # Add NodeSource repository
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODEJS_VERSION.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list > /dev/null

    # Set package preferences
    echo "Package: nsolid" | tee /etc/apt/preferences.d/nsolid > /dev/null
    echo "Pin: origin deb.nodesource.com" | tee -a /etc/apt/preferences.d/nsolid > /dev/null
    echo "Pin-Priority: 600" | tee -a /etc/apt/preferences.d/nsolid > /dev/null

    echo "Package: nodejs" | tee /etc/apt/preferences.d/nodejs > /dev/null
    echo "Pin: origin deb.nodesource.com" | tee -a /etc/apt/preferences.d/nodejs > /dev/null
    echo "Pin-Priority: 600" | tee -a /etc/apt/preferences.d/nodejs > /dev/null

    if ! apt-get update; then
        handle_error "$?" "Failed to update package lists"
    fi
}

# Function to install Canvas service
install_canvas_service() {
    if [ ! -f /etc/systemd/system/canvas-server.service ]; then
        echo "Creating systemd service for Canvas Server..."
        cat > /etc/systemd/system/canvas-server.service <<EOF
[Unit]
Description=Canvas Server
After=network.target

[Service]
Type=simple
User=$CANVAS_USER
Group=$CANVAS_GROUP
WorkingDirectory=$CANVAS_ROOT
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=30
Environment=NODE_ENV=production
Environment=CANVAS_SERVER_HOME=$CANVAS_ROOT/server
Environment=CANVAS_USER_HOME=$CANVAS_ROOT/users

[Install]
WantedBy=multi-user.target
EOF

        systemctl daemon-reload
        systemctl enable canvas-server
        echo "Canvas Server systemd service created and enabled"
    fi
}

# Function to install the inference daemon service
#
# canvas-inferd is NOT a dependency of canvas-server — it is a separate process
# with its own dependency tree, which is what keeps the native model runtime
# (and its CUDA postinstall) out of the API server's install. It gets its own
# unit so a model worker crash restarts inference alone, and so inference can be
# left off entirely on a box that does not want it.
#
# RuntimeDirectory=canvas gives /run/canvas (mode 0750, owned by the canvas
# user) — the default socket location both sides resolve to with nothing
# configured. Keep it in step with socket-path.js in BOTH packages.
install_inferd_service() {
    if ! command -v canvas-inferd >/dev/null 2>&1; then
        echo "canvas-inferd not installed — skipping (embedding and dense search stay disabled)"
        echo "  install it with: npm install -g canvas-ui/canvas-inferd"
        return 0
    fi
    if [ ! -f /etc/systemd/system/canvas-inferd.service ]; then
        echo "Creating systemd service for Canvas Inferd..."
        cat > /etc/systemd/system/canvas-inferd.service <<EOF
[Unit]
Description=Canvas Inference Daemon
# Ordering only, not a requirement: canvas-server starts and serves without it,
# degrading to keyword search, and its client reconnects when this comes back.
Before=canvas-server.service

[Service]
Type=simple
User=$CANVAS_USER
Group=$CANVAS_GROUP
WorkingDirectory=$CANVAS_ROOT
RuntimeDirectory=canvas
RuntimeDirectoryMode=0750
ExecStart=$(command -v canvas-inferd) --socket /run/canvas/inferd.sock --config $CANVAS_ROOT/server/config/inferd.json
Restart=always
RestartSec=10
# Models are large and loading one is a burst; do not let the supervisor treat
# a slow first load as a failure.
TimeoutStartSec=300
Environment=NODE_ENV=production
Environment=CANVAS_INFERD_CACHE_DIR=$CANVAS_ROOT/server/inferd/models

[Install]
WantedBy=multi-user.target
EOF

        systemctl daemon-reload
        systemctl enable canvas-inferd
        echo "Canvas Inferd systemd service created and enabled"
    fi
}

# Function to update Canvas Server
update_canvas() {
    echo "Updating Canvas Server in $CANVAS_ROOT..."
    cd $CANVAS_ROOT || handle_error "$?" "Failed to change directory to $CANVAS_ROOT"

    install_canvas_service
    install_inferd_service

    if systemctl is-active --quiet canvas-server; then
        echo "Stopping Canvas Server..."
        systemctl stop canvas-server
    fi

    if [ -d node_modules ]; then
        echo "Removing old node_modules..."
        rm -rf node_modules
    fi

    echo "Pulling latest changes from git (branch: $CANVAS_REPO_TARGET_BRANCH)..."
    if ! git pull origin $CANVAS_REPO_TARGET_BRANCH; then
        handle_error "$?" "Failed to pull latest changes from git"
    fi

    # Ensure correct ownership before running npm commands as CANVAS_USER
    if ! chown -R $CANVAS_USER:$CANVAS_GROUP $CANVAS_ROOT; then
        handle_error "$?" "Failed to set permissions before npm operations"
    fi


    echo "Installing dependencies as $CANVAS_USER..."
    if ! su -s /bin/bash "$CANVAS_USER" -c "cd $CANVAS_ROOT && npm install"; then
        handle_error "$?" "Failed to install dependencies via npm as $CANVAS_USER"
    fi


    echo "Starting Canvas Server..."
    if ! systemctl start canvas-server; then
        handle_error "$?" "Failed to start canvas-server"
    fi

    echo "Canvas Server updated and started successfully"
}

# Function to install Canvas Server
install_canvas() {
    echo "Installing Canvas Server to $CANVAS_ROOT..."
    if ! git clone $CANVAS_REPO_URL $CANVAS_ROOT; then
        handle_error "$?" "Failed to clone Canvas Server repository"
    fi

    cd $CANVAS_ROOT || handle_error "$?" "Failed to change directory to $CANVAS_ROOT"

    if ! git checkout $CANVAS_REPO_TARGET_BRANCH; then
        handle_error "$?" "Failed to checkout branch $CANVAS_REPO_TARGET_BRANCH"
    fi

    # Ensure correct ownership before running npm commands as CANVAS_USER
    if ! chown -R $CANVAS_USER:$CANVAS_GROUP $CANVAS_ROOT; then
        handle_error "$?" "Failed to set permissions before npm operations"
    fi


    echo "Installing dependencies as $CANVAS_USER..."
    if ! su -s /bin/bash "$CANVAS_USER" -c "cd $CANVAS_ROOT && npm install"; then
        handle_error "$?" "Failed to install dependencies via npm as $CANVAS_USER"
    fi


    install_canvas_service

    echo "Starting Canvas Server..."
    if ! systemctl start canvas-server; then
        handle_error "$?" "Failed to start canvas-server"
    fi

    echo "Canvas Server installed and started successfully"
}

# Main installation process
echo "Starting Canvas Server installation on Ubuntu..."

# Ensure system is up-to-date
echo "Updating system packages..."
if ! apt-get update && apt-get upgrade -y; then
    handle_error "$?" "Failed to update and upgrade system"
fi

# Install system utilities
echo "Installing system utilities..."
if ! apt-get install -y apt-transport-https ca-certificates gnupg openssh-server bridge-utils vnstat ethtool bind9-utils bind9-dnsutils socat whois ufw curl wget git unattended-upgrades update-notifier-common postfix build-essential nano; then
    handle_error "$?" "Failed to install system utilities"
fi

# Install Node.js
echo "Checking Node.js installation..."
if [ ! $(command -v node) ] || [ ! $(node --version | grep -o "v$NODEJS_VERSION") ]; then
    echo "Node.js $NODEJS_VERSION not found or incorrect version. Installing..."
    setup_nodejs_repository
    if ! apt-get install -y nodejs; then
        handle_error "$?" "Failed to install Node.js"
    fi

    # Verify installation
    if ! node --version; then
        handle_error "$?" "Failed to verify Node.js installation"
    fi
    if ! npm --version; then
        handle_error "$?" "Failed to verify npm installation"
    fi

    echo "Node.js $NODEJS_VERSION installed successfully"
else
    echo "Node.js $(node --version) already installed"
fi

# Create service group
echo "Creating service group $CANVAS_GROUP..."
if ! getent group $CANVAS_GROUP > /dev/null 2>&1; then
    if ! groupadd $CANVAS_GROUP; then
        handle_error "$?" "Failed to create service group $CANVAS_GROUP"
    fi
    echo "Service group $CANVAS_GROUP created"
else
    echo "Service group $CANVAS_GROUP already exists"
fi

# Create service user
echo "Creating service user $CANVAS_USER..."
if ! id $CANVAS_USER > /dev/null 2>&1; then
    if ! useradd --comment "Canvas Server User" --system --shell /bin/false --gid $CANVAS_GROUP --home $CANVAS_ROOT $CANVAS_USER; then
        handle_error "$?" "Failed to create service user $CANVAS_USER"
    fi
    echo "Service user $CANVAS_USER created"
else
    echo "Service user $CANVAS_USER already exists"
fi

# Add canvas-server path to git config
echo "Configuring git safe directory..."
if ! git config --global --add safe.directory $CANVAS_ROOT; then
    echo "Warning: Failed to add canvas-server path to git config"
fi

# Install or update Canvas Server
if [ ! -d $CANVAS_ROOT ]; then
    install_canvas
else
    echo "Existing Canvas Server installation found. Updating..."
    update_canvas
fi

# Final status check
echo "Checking Canvas Server status..."
if ! systemctl status canvas-server; then
    handle_error "$?" "Failed to check canvas-server status"
fi

echo ""
echo "Canvas Server installation/update completed successfully!"
echo "Service status: $(systemctl is-active canvas-server)"
echo "Service enabled: $(systemctl is-enabled canvas-server)"
echo ""
echo "Canvas Server should be accessible on:"
echo "  - API + Web UI: http://localhost:8001"
echo ""
echo "Useful commands:"
echo "  - Check status: systemctl status canvas-server"
echo "  - View logs: journalctl -u canvas-server -f"
echo "  - Restart: systemctl restart canvas-server"
echo "  - Stop: systemctl stop canvas-server"
