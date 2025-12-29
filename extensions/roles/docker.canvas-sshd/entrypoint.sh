#!/bin/bash
set -e

# Canvas SSHD Entrypoint
# Provisions users and starts SSH daemon with chroot isolation

USERS_PATH="${CANVAS_USERS_PATH:-/users}"
LOG_LEVEL="${LOG_LEVEL:-INFO}"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

log "Starting Canvas SSH Daemon..."
log "Users path: $USERS_PATH"
log "Log level: $LOG_LEVEL"

# Ensure users directory exists
if [ ! -d "$USERS_PATH" ]; then
    log "ERROR: Users directory not found: $USERS_PATH"
    exit 1
fi

# Function to create chroot structure for a user
setup_chroot_structure() {
    local user_home="$1"
    local username="$2"

    log "Setting up chroot structure for $username at $user_home"

    # Create required directories for chroot
    mkdir -p "$user_home/dev"
    mkdir -p "$user_home/tmp"
    mkdir -p "$user_home/.ssh"

    # Create /dev/null if it doesn't exist
    if [ ! -e "$user_home/dev/null" ]; then
        mknod -m 666 "$user_home/dev/null" c 1 3 || log "WARNING: Could not create /dev/null"
    fi

    # Set proper permissions
    chmod 755 "$user_home"
    chmod 755 "$user_home/dev"
    chmod 1777 "$user_home/tmp"
    chmod 700 "$user_home/.ssh"

    # Set ownership (root owns the chroot directory)
    chown root:root "$user_home"
    chown root:root "$user_home/dev"

    log "Chroot structure created for $username"
}

# Function to provision a system user
provision_user() {
    local email="$1"
    local user_home="$USERS_PATH/$email"

    # Skip if not a directory
    if [ ! -d "$user_home" ]; then
        return
    fi

    # Convert email to valid username (replace @ and . with _)
    local username=$(echo "$email" | tr '@.' '__')

    log "Provisioning user: $email (system user: $username)"

    # Check if user already exists
    if id "$username" &>/dev/null; then
        log "System user $username already exists"
    else
        # Create system user without home directory (we use Canvas home)
        useradd -M -s /sbin/nologin "$username" || {
            log "WARNING: Failed to create system user $username"
            return
        }
        log "Created system user: $username"
    fi

    # Get user's UID
    local uid=$(id -u "$username")

    # Setup chroot structure
    setup_chroot_structure "$user_home" "$username"

    # Handle SSH authorized keys
    if [ -f "$user_home/.ssh/authorized_keys" ]; then
        # Set proper ownership for .ssh directory and authorized_keys
        chown -R "$uid:$uid" "$user_home/.ssh"
        chmod 600 "$user_home/.ssh/authorized_keys"
        log "Configured SSH keys for $username"
    else
        log "No SSH keys found for $username"
    fi

    # Create a minimal file structure in user home
    # Everything except .ssh and the required chroot dirs should be owned by the user
    find "$user_home" -mindepth 1 -maxdepth 1 ! -name '.ssh' ! -name 'dev' ! -name 'tmp' -exec chown -R "$uid:$uid" {} \;
}

# Scan users directory and provision all users
log "Scanning users directory: $USERS_PATH"
user_count=0

for user_dir in "$USERS_PATH"/*; do
    if [ -d "$user_dir" ]; then
        email=$(basename "$user_dir")
        provision_user "$email"
        user_count=$((user_count + 1))
    fi
done

log "Provisioned $user_count user(s)"

# Check if any users were provisioned
if [ $user_count -eq 0 ]; then
    log "WARNING: No users found in $USERS_PATH"
fi

# Start SSH daemon in foreground
log "Starting SSH daemon on port ${SSH_PORT:-22}"
exec /usr/sbin/sshd -D -e
