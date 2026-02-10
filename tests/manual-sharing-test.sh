#!/bin/bash

# Manual Canvas Sharing Test Script
# Quick manual tests for sharing functionality

set -e

# Configuration
BASE_URL="http://127.0.0.1:8001/rest/v2"
TOKEN="${TOKEN:-canvas-59e7b70b39d452005c42764d9bb608d899a047246627615e}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🛠️  Canvas Sharing Manual Test Script${NC}"
echo -e "${BLUE}====================================${NC}"
echo ""

# Helper function for API calls
api_call() {
    local method=$1
    local endpoint=$2
    local data=$3
    local description=$4

    echo -e "${YELLOW}📡 $description${NC}"
    echo -e "${BLUE}$method $BASE_URL$endpoint${NC}"

    if [ -n "$data" ]; then
        echo -e "${BLUE}Data: $data${NC}"
        curl -s -X "$method" \
             -H "Authorization: Bearer $TOKEN" \
             -H "Content-Type: application/json" \
             -d "$data" \
             "$BASE_URL$endpoint" | jq '.' || echo "Response not JSON"
    else
        curl -s -X "$method" \
             -H "Authorization: Bearer $TOKEN" \
             "$BASE_URL$endpoint" | jq '.' || echo "Response not JSON"
    fi
    echo ""
    echo "---"
    echo ""
}

# Public API call helper
pub_call() {
    local method=$1
    local endpoint=$2
    local data=$3
    local token_param=$4
    local description=$5

    echo -e "${YELLOW}🌐 $description${NC}"
    local url="$BASE_URL/pub$endpoint"

    echo -e "${BLUE}$method $url${NC}"

    if [ -n "$data" ]; then
        echo -e "${BLUE}Data: $data${NC}"
        curl -s -X "$method" \
             ${token_param:+-H "Authorization: Bearer $token_param"} \
             -H "Content-Type: application/json" \
             -d "$data" \
             "$url" | jq '.' || echo "Response not JSON"
    else
        curl -s -X "$method" \
             ${token_param:+-H "Authorization: Bearer $token_param"} \
             "$url" | jq '.' || echo "Response not JSON"
    fi
    echo ""
    echo "---"
    echo ""
}

echo -e "${GREEN}Using token: ${TOKEN:0:20}...${NC}"
echo ""

# Test 1: List workspaces
api_call "GET" "/workspaces" "" "List all workspaces"

# Test 2: List contexts
api_call "GET" "/contexts" "" "List all contexts"

# Test 3: Health check
pub_call "GET" "/health" "" "" "Check pub routes health"

# Test 4: Token info (if token provided as argument)
if [ $# -gt 0 ]; then
    echo -e "${YELLOW}🔍 Testing provided token: $1${NC}"
    pub_call "GET" "/tokens/info" "" "$1" "Get token information"
fi

echo -e "${GREEN}✅ Manual tests completed!${NC}"
echo ""
echo -e "${YELLOW}💡 Usage examples:${NC}"
echo ""
echo -e "${BLUE}# Test specific workspace token:${NC}"
echo -e "./manual-sharing-test.sh canvas-your-workspace-token-here"
echo ""
echo -e "${BLUE}# Create a workspace token:${NC}"
echo -e "curl -X POST -H \"Authorization: Bearer $TOKEN\" \\"
echo -e "     -H \"Content-Type: application/json\" \\"
echo -e "     -d '{\"permissions\":[\"read\",\"write\"],\"description\":\"Test token\"}' \\"
echo -e "     \"$BASE_URL/workspaces/YOUR_WORKSPACE_ID/tokens\""
echo ""
echo -e "${BLUE}# Access workspace via token:${NC}"
echo -e "curl -H \"Authorization: Bearer YOUR_TOKEN\" \"$BASE_URL/pub/workspaces/YOUR_WORKSPACE_ID\""
echo ""
echo -e "${BLUE}# Create context token:${NC}"
echo -e "curl -X POST -H \"Authorization: Bearer $TOKEN\" \\"
echo -e "     -H \"Content-Type: application/json\" \\"
echo -e "     -d '{\"permissions\":[\"documentRead\"],\"description\":\"Test context token\"}' \\"
echo -e "     \"$BASE_URL/contexts/YOUR_CONTEXT_ID/tokens\""
echo ""
echo -e "${BLUE}# Share workspace with user email:${NC}"
echo -e "curl -X POST -H \"Authorization: Bearer $TOKEN\" \\"
echo -e "     -H \"Content-Type: application/json\" \\"
echo -e "     -d '{\"userEmail\":\"user@example.com\",\"permissions\":[\"read\"]}' \\"
echo -e "     \"$BASE_URL/workspaces/YOUR_WORKSPACE_ID/shares\""
