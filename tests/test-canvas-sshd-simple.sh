#!/bin/bash
set -e

# Simple Canvas SSHD Test Script
# This script provides manual testing steps for canvas-sshd

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "═══════════════════════════════════════════════════════"
echo "  Canvas SSHD - Simple Test"
echo "═══════════════════════════════════════════════════════"
echo ""

# Configuration
API_BASE="${CANVAS_API_URL:-http://localhost:8001}"
SSH_PORT="${SSH_PORT:-22222}"
TEST_EMAIL="${TEST_EMAIL:-test@canvas.local}"

echo "Configuration:"
echo "  API Base: $API_BASE"
echo "  SSH Port: $SSH_PORT"
echo "  Test Email: $TEST_EMAIL"
echo ""

# Check if admin token is set
if [ -z "$CANVAS_ADMIN_TOKEN" ]; then
    echo "ERROR: CANVAS_ADMIN_TOKEN environment variable is not set"
    echo ""
    echo "Please set it with:"
    echo "  export CANVAS_ADMIN_TOKEN='your-admin-token-here'"
    echo ""
    echo "You can find the token in server startup logs."
    exit 1
fi

echo "Step 1: Building Docker image..."
echo "────────────────────────────────────────────────────────"
cd "$PROJECT_DIR/extensions/roles/docker.canvas-sshd"
./build.sh
echo ""

echo "Step 2: Testing API connection..."
echo "────────────────────────────────────────────────────────"
curl -s -H "Authorization: Bearer $CANVAS_ADMIN_TOKEN" "$API_BASE/api/ping" | jq '.' || {
    echo "ERROR: Failed to connect to API"
    exit 1
}
echo ""

echo "Step 3: Generate SSH key pair..."
echo "────────────────────────────────────────────────────────"
SSH_KEY_PATH="$SCRIPT_DIR/.test-ssh-key"
rm -f "$SSH_KEY_PATH" "$SSH_KEY_PATH.pub"
ssh-keygen -t ed25519 -f "$SSH_KEY_PATH" -N "" -C "test-key-$(date +%s)"
echo "  Key: $SSH_KEY_PATH"
echo "  Pub: $SSH_KEY_PATH.pub"
echo ""

echo "Step 4: Reading public key..."
echo "────────────────────────────────────────────────────────"
PUB_KEY=$(cat "$SSH_KEY_PATH.pub")
echo "$PUB_KEY"
echo ""

echo "Manual steps to complete:"
echo "════════════════════════════════════════════════════════"
echo ""
echo "1. Create test user (if not exists):"
echo "   curl -X POST $API_BASE/api/admin/users \\"
echo "     -H 'Authorization: Bearer \$CANVAS_ADMIN_TOKEN' \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"name\":\"Test User\",\"email\":\"$TEST_EMAIL\",\"userType\":\"user\",\"status\":\"active\"}'"
echo ""
echo "2. Get user ID from response, then add SSH key:"
echo "   USER_ID='<user-id-from-step-1>'"
echo "   curl -X POST $API_BASE/api/admin/users/\$USER_ID/ssh-keys \\"
echo "     -H 'Authorization: Bearer \$CANVAS_ADMIN_TOKEN' \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"key\":\"$PUB_KEY\",\"name\":\"Test Key\"}'"
echo ""
echo "3. Create canvas-sshd role:"
echo "   curl -X POST $API_BASE/api/roles \\"
echo "     -H 'Authorization: Bearer \$CANVAS_ADMIN_TOKEN' \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"template\":\"docker.canvas-sshd\",\"name\":\"canvas-sshd\",\"type\":\"global\"}'"
echo ""
echo "4. Get role ID from response, then start it:"
echo "   ROLE_ID='<role-id-from-step-3>'"
echo "   curl -X POST $API_BASE/api/roles/\$ROLE_ID/start \\"
echo "     -H 'Authorization: Bearer \$CANVAS_ADMIN_TOKEN'"
echo ""
echo "5. Wait a few seconds for SSH daemon to start, then test connection:"
echo "   ssh -i $SSH_KEY_PATH -p $SSH_PORT \\"
echo "     -o StrictHostKeyChecking=no \\"
echo "     -o UserKnownHostsFile=/dev/null \\"
echo "     $TEST_EMAIL@localhost"
echo ""
echo "6. Test SFTP:"
echo "   sftp -i $SSH_KEY_PATH -P $SSH_PORT \\"
echo "     -o StrictHostKeyChecking=no \\"
echo "     -o UserKnownHostsFile=/dev/null \\"
echo "     $TEST_EMAIL@localhost"
echo ""
echo "7. Cleanup:"
echo "   rm -f $SSH_KEY_PATH $SSH_KEY_PATH.pub"
echo ""
echo "════════════════════════════════════════════════════════"
