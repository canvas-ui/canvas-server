# Canvas API Access Design

## Overview

This document defines the access patterns and authentication mechanisms for the Canvas Server REST API. The API supports different access methods for workspace and context resources, with clear separation between personal and shared resource access.

## Authentication Methods

### 1. JWT Tokens (Web UI)
- **Purpose**: Primary authentication for web interface users
- **Scope**: Access to user's own resources only
- **Lifetime**: Short-lived (default: 1 day)
- **Format**: Standard JWT bearer token
- **Usage**: Web application sessions

```bash
# Example usage
curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
     http://localhost:8001/rest/v2/workspaces
```

### 2. API Tokens (Programmatic Access)
- **Purpose**: Long-lived programmatic access and workspace sharing
- **Scope**: User's own resources + shared resources via workspace ACLs
- **Lifetime**: Long-lived or permanent (configurable expiration)
- **Format**: `canvas-` prefixed tokens
- **Usage**: CLI tools, scripts, integrations

```bash
# Example usage
curl -H "Authorization: Bearer canvas-ae651b2333fa2ee6be289f9f3d81831b1b040a472aba4c39" \
     http://localhost:8001/rest/v2/workspaces
```

## Resource Access Patterns

### Personal Workspace Access

#### List User's Own Workspaces
```
GET /rest/v2/workspaces
```
- **Authentication**: JWT or API token
- **Returns**: All workspaces owned by the authenticated user
- **Access Control**: User can only see their own workspaces

#### Access Specific Workspace (by ID or Name)
```
GET /rest/v2/workspaces/:id
```
- **Authentication**: JWT or API token
- **Resource Identifier**: Can be workspace UUID or workspace name
- **Access Control**: 
  - JWT tokens: Owner access only
  - API tokens: Owner access OR workspace ACL permissions

#### Supported Workspace Identifiers
1. **Workspace UUID**: `7c84589b-9268-45e8-9b7c-85c29adc9bca`
2. **Workspace Name**: `universe`, `my-project`, etc.
3. **Resource Address**: `user.name/workspace.name` (address resolver middleware)

### Shared Resource Access

#### Public/Shared Context Access
```
GET /rest/v2/pub/:targetUserId/contexts/:contextId
POST /rest/v2/pub/:ownerUserId/contexts/:contextId/shares
DELETE /rest/v2/pub/:ownerUserId/contexts/:contextId/shares/:sharedWithUserId
```
- **Purpose**: Access contexts shared by other users
- **Authentication**: JWT or API token required
- **Access Control**: Based on context ACL permissions
- **Scope**: Context-level sharing only (no workspace sharing via pub routes)

### API Token Workspace Sharing

API tokens can access workspaces beyond their owner through workspace-level ACLs stored in `workspace.json`:

```json
{
  "acl": {
    "tokens": {
      "sha256:abc123...": {
        "permissions": ["read", "write"],
        "description": "Jane's laptop",
        "createdAt": "2024-01-01T00:00:00Z",
        "expiresAt": null
      }
    }
  }
}
```

#### Token Hash Generation
```javascript
const tokenHash = `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;
```

#### Permission Levels
- `read`: List documents, get workspace info
- `write`: Insert/update documents, modify workspace tree
- `admin`: Full workspace management, ACL modification

## Resource Addressing

### Simple Resource Addresses
Format: `user.name/resource.name`

Examples:
- `admin/universe` → resolves to workspace owned by user "admin" named "universe"
- `john.doe/my-project` → resolves to workspace owned by user "john.doe" named "my-project"

### Address Resolution Middleware
- **Location**: `src/transports/middleware/address-resolver.js`
- **Purpose**: Converts user-friendly addresses to internal IDs
- **Scope**: Applied to routes with `:id` parameters
- **Behavior**: 
  - Detects addresses containing `/`
  - Resolves `user.name/resource.name` to internal UUIDs
  - Passes through regular IDs unchanged
  - Stores original address for response inclusion

### Remote References (CLI Only)
Format: `user@remote:workspace[/path]`

Examples:
- `admin@canvas.local:universe`
- `john.doe@remote.server.com:shared-workspace/subfolder`

**Note**: Remote references are handled by CLI clients and converted to simple addresses before sending to the API.

## Access Control Matrix

| Resource Type | JWT Token | API Token (Owner) | API Token (ACL) | Pub Routes |
|---------------|-----------|-------------------|-----------------|------------|
| List Own Workspaces | ✅ | ✅ | ✅ | ❌ |
| Access Own Workspace | ✅ | ✅ | ✅ | ❌ |
| Access Shared Workspace | ❌ | ❌ | ✅ (if ACL permits) | ❌ |
| List Own Contexts | ✅ | ✅ | ✅ | ❌ |
| Access Own Context | ✅ | ✅ | ✅ | ❌ |
| Access Shared Context | ❌ | ❌ | ❌ | ✅ (if shared) |
| Share Context | ✅ | ✅ | ❌ | ✅ (owner only) |

## Error Responses

### Common HTTP Status Codes

#### 401 Unauthorized
```json
{
  "status": "error",
  "statusCode": 401,
  "message": "Valid authentication required"
}
```

#### 403 Forbidden
```json
{
  "status": "error", 
  "statusCode": 403,
  "message": "Access denied to workspace abc123. Token lacks required permission: read"
}
```

#### 404 Not Found
```json
{
  "status": "error",
  "statusCode": 404, 
  "message": "Workspace not found: admin/nonexistent"
}
```

## Implementation Notes

### Workspace ACL Middleware
- **Location**: `src/transports/middleware/workspace-acl.js`
- **Purpose**: Validates workspace access for both JWT and API tokens
- **Logic**:
  1. Try owner access first (fastest path)
  2. For API tokens: try token-based ACL access
  3. For JWT tokens: owner access only

### Address Resolution Process
1. **Detection**: Check if `:id` parameter contains `/`
2. **Resolution**: Call manager's `resolveIdFromSimpleIdentifier()` method
3. **Replacement**: Replace `:id` with resolved internal UUID
4. **Storage**: Store original address for response inclusion

### Response Enhancement
API responses include `resourceAddress` field when available:

```json
{
  "status": "success",
  "payload": {
    "workspace": { /* workspace data */ },
    "access": { /* access info */ },
    "resourceAddress": "admin/universe"
  }
}
```

## Configuration

### Environment Variables
- `JWT_SECRET`: Secret for JWT token signing
- `AUTH_TOKEN_*`: Configuration for API token settings

### ACL Configuration
Workspace ACLs are stored in individual `workspace.json` files:
```
/server/users/user@domain.com/workspace.json
```

### Context Sharing
Context sharing is managed through the context manager and stored in context-specific ACL structures.

## Security Considerations

1. **Token Scope**: JWT tokens limited to owner access only
2. **ACL Validation**: Token hashes verified against workspace ACLs
3. **Expiration**: Both JWT and API tokens support expiration
4. **Permission Checks**: Granular permission checking (read/write/admin)
5. **Owner Validation**: Strict owner verification for sensitive operations

## Testing Examples

### Valid API Token Access
```bash
# List own workspaces
curl -H "Authorization: Bearer canvas-abc123..." \
     http://localhost:8001/rest/v2/workspaces

# Access workspace by name  
curl -H "Authorization: Bearer canvas-abc123..." \
     http://localhost:8001/rest/v2/workspaces/universe

# Access workspace by resource address
curl -H "Authorization: Bearer canvas-abc123..." \
     http://localhost:8001/rest/v2/workspaces/admin/universe
```

### Valid JWT Access
```bash
# List own workspaces
curl -H "Authorization: Bearer eyJhbGciOi..." \
     http://localhost:8001/rest/v2/workspaces

# Access own workspace
curl -H "Authorization: Bearer eyJhbGciOi..." \
     http://localhost:8001/rest/v2/workspaces/my-workspace
```

### Shared Context Access
```bash
# Access shared context via pub routes
curl -H "Authorization: Bearer canvas-abc123..." \
     http://localhost:8001/rest/v2/pub/other-user-id/contexts/shared-context-id
``` 
