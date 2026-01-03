# Canvas Sharing Functionality Tests

This directory contains comprehensive tests for the new sharing functionality implemented in Canvas Server.

## Overview

The sharing functionality includes:
- **Token-based sharing**: Portable tokens for workspaces and contexts
- **Email-based sharing**: Local user sharing via email addresses
- **Secret links**: Expiring tokens with usage limits
- **Public access routes**: Anonymous access via tokens

## Test Scripts

### 1. Comprehensive Test Suite

**File**: `test-sharing-functionality.js`
**Runner**: `run-sharing-tests.sh`

Runs a complete test suite covering all sharing features:

```bash
# Run all tests
./run-sharing-tests.sh

# Or run directly with node
TOKEN=your-token-here node test-sharing-functionality.js
```

**Tests included**:
- ✅ Creating test workspace and context
- ✅ Creating sharing tokens (workspace & context)
- ✅ Creating secret link tokens with expiration
- ✅ Accessing resources via tokens
- ✅ Inserting documents via tokens
- ✅ Token validation and info retrieval
- ✅ Listing tokens
- ✅ Access denial for invalid/missing tokens
- ✅ Health checks

### 2. Manual Testing Script

**File**: `manual-sharing-test.sh`

Quick manual tests and examples:

```bash
# Basic tests
./manual-sharing-test.sh

# Test specific token
./manual-sharing-test.sh canvas-your-token-here
```

## Environment Setup

### Prerequisites

1. **Canvas Server Running**: 
   ```bash
   cd /home/idnc_sk/Code/Canvas/canvas-server
   npm start
   ```

2. **Valid API Token**: Set the TOKEN environment variable:
   ```bash
   export TOKEN="canvas-90c3ae5407c3321f3094ff56edca3fa66e1f94e620167d15"
   ```

3. **Dependencies**: Ensure `node-fetch` is installed:
   ```bash
   npm install node-fetch
   ```

## API Endpoints Tested

### Token Management
- `POST /workspaces/:id/tokens` - Create workspace token
- `GET /workspaces/:id/tokens` - List workspace tokens
- `DELETE /workspaces/:id/tokens/:hash` - Revoke workspace token
- `POST /contexts/:id/tokens` - Create context token
- `GET /contexts/:id/tokens` - List context tokens
- `DELETE /contexts/:id/tokens/:hash` - Revoke context token

### Email-based Sharing
- `POST /workspaces/:id/shares` - Share with user email
- `GET /workspaces/:id/shares` - List workspace shares
- `PUT /workspaces/:id/shares/:email` - Update share permissions
- `DELETE /workspaces/:id/shares/:email` - Revoke share

### Public Access
- `GET /pub/workspaces/:id` - Access workspace via token (Authorization header)
- `GET /pub/contexts/:id` - Access context via token (Authorization header)
- `GET /pub/workspaces/:id/documents` - List workspace documents (Authorization header)
- `POST /pub/workspaces/:id/documents` - Insert workspace documents (Authorization header)
- `GET /pub/contexts/:id/documents` - List context documents (Authorization header)
- `POST /pub/contexts/:id/documents` - Insert context documents (Authorization header)

### Token Utilities
- `POST /pub/tokens/validate` - Validate token
- `GET /pub/tokens/info` - Get token info (Authorization header)
- `DELETE /pub/tokens/revoke` - Revoke token
- `GET /pub/health` - Health check

## Example Usage

### Creating a Workspace Token

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "permissions": ["read", "write"],
    "description": "Shared access for team",
    "expiresAt": null
  }' \
  "http://127.0.0.1:8001/rest/v2/workspaces/workspace-id/tokens"
```

### Creating a Secret Link

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "permissions": ["documentRead"],
    "description": "Secret link for sharing",
    "type": "secret-link",
    "maxUses": 10,
    "expiresAt": "2024-12-31T23:59:59.999Z"
  }' \
  "http://127.0.0.1:8001/rest/v2/contexts/context-id/tokens"
```

### Accessing Shared Resource

```bash
curl -H "Authorization: Bearer canvas-abc123..." \
  "http://127.0.0.1:8001/rest/v2/pub/workspaces/workspace-id"
```

### Sharing with User Email

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userEmail": "colleague@example.com",
    "permissions": ["read", "write"],
    "description": "Project collaboration access"
  }' \
  "http://127.0.0.1:8001/rest/v2/workspaces/workspace-id/shares"
```

## Expected Results

### Successful Test Run Output

```
🚀 Starting Canvas Sharing Functionality Tests
📡 Testing against: http://127.0.0.1:8001/rest/v2
🔑 Using token: canvas-90c3ae5407c...

🧪 Test 1: Creating test workspace...
✅ Created workspace: 7c84589b-9268-45e8-9b7c-85c29adc9bca

🧪 Test 2: Creating test context...
✅ Created context: test-sharing-context

[... more tests ...]

📊 Test Results:
✅ Passed: 16
❌ Failed: 0
📈 Success Rate: 100%

🎉 All tests passed! Sharing functionality is working correctly.
```

## Troubleshooting

### Common Issues

1. **Server not running**: Ensure Canvas server is running on port 8001
2. **Invalid token**: Check that your TOKEN environment variable is valid
3. **Permission denied**: Ensure your token has admin/owner permissions
4. **Network errors**: Check firewall/network connectivity to localhost:8001

### Debug Mode

Enable verbose output:
```bash
DEBUG=canvas-server:* ./run-sharing-tests.sh
```

### Manual Verification

Use the manual test script to verify specific functionality:
```bash
./manual-sharing-test.sh
```

## Security Notes

- Tokens are hashed with SHA256 for storage
- Secret links support expiration and usage limits
- Email-based sharing requires local user accounts
- All access is logged and auditable
- Tokens can be revoked at any time by resource owners
