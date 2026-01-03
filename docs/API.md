# REST API

> **📖 See [API Access Design](./API-ACCESS-DESIGN.md) for comprehensive authentication patterns, resource addressing, and access control documentation.**

## Main entry points

- `/auth`: Authentication and user management routes
- `/pub`: Shared content and cross-user context access
- `/workspaces`: Workspace management and operations
- `/contexts`: Context management and operations
- `/schemas`: Data abstraction schemas
- `/ping`: Server status and health checks

## Auth routes

### Authentication Configuration
- `GET /rest/v2/auth/config` - Get authentication configuration (strategies, domains)

### User Authentication
- `POST /rest/v2/auth/login` - User login (supports local, IMAP, and auto strategies)
- `POST /rest/v2/auth/logout` - User logout (client-side token invalidation)
- `POST /rest/v2/auth/register` - User registration
- `GET /rest/v2/auth/me` - Get current user profile

### Password Management
- `PUT /rest/v2/auth/password` - Update user password (requires current password)
- `POST /rest/v2/auth/forgot-password` - Request password reset email
- `POST /rest/v2/auth/reset-password` - Reset password with token

### Email Verification
- `POST /rest/v2/auth/verify-email` - Request email verification
- `GET /rest/v2/auth/verify-email/:token` - Verify email with token

### API Token Management
- `GET /rest/v2/auth/tokens` - List user's API tokens
- `POST /rest/v2/auth/tokens` - Create new API token
- `PUT /rest/v2/auth/tokens/:tokenId` - Update API token (name/description)
- `DELETE /rest/v2/auth/tokens/:tokenId` - Delete API token

### Token Verification
- `POST /rest/v2/auth/token/verify` - Verify JWT or API token validity

## Pub routes

### Shared Context Access
- `GET /rest/v2/pub/contexts/:contextId` - Get shared context by ID (token-based)

### Shared Document Operations
- `GET /rest/v2/pub/contexts/:contextId/documents` - List documents in shared context
- `POST /rest/v2/pub/contexts/:contextId/documents` - Insert documents into shared context
- `PUT /rest/v2/pub/contexts/:contextId/documents` - Update documents in shared context

## Workspaces

### Workspace Lifecycle
- `GET /rest/v2/workspaces` - List user's workspaces
- `POST /rest/v2/workspaces` - Create new workspace
- `GET /rest/v2/workspaces/:id` - Get workspace by ID
- `PUT /rest/v2/workspaces/:id` - Update workspace
- `DELETE /rest/v2/workspaces/:id` - Delete workspace

### Workspace Documents
- `GET /rest/v2/workspaces/:id/documents` - List documents in workspace
- `POST /rest/v2/workspaces/:id/documents` - Insert documents into workspace
- `PUT /rest/v2/workspaces/:id/documents` - Update documents in workspace
- `DELETE /rest/v2/workspaces/:id/documents` - Delete documents from workspace
- `DELETE /rest/v2/workspaces/:id/documents/remove` - Remove documents from workspace

### Workspace Tree Operations
- `GET /rest/v2/workspaces/:id/tree` - Get workspace tree structure
- `POST /rest/v2/workspaces/:id/tree/paths` - Insert path into workspace tree
- `DELETE /rest/v2/workspaces/:id/tree/paths` - Remove path from workspace tree
- `POST /rest/v2/workspaces/:id/tree/paths/move` - Move path in workspace tree
- `POST /rest/v2/workspaces/:id/tree/paths/copy` - Copy path in workspace tree
- `POST /rest/v2/workspaces/:id/tree/paths/merge-up` - Merge layer bitmaps upwards
- `POST /rest/v2/workspaces/:id/tree/paths/merge-down` - Merge layer bitmaps downwards

### Workspace Token Management
- `GET /rest/v2/workspaces/:id/tokens` - List workspace access tokens
- `POST /rest/v2/workspaces/:id/tokens` - Create workspace access token
- `PUT /rest/v2/workspaces/:id/tokens/:tokenId` - Update workspace access token
- `DELETE /rest/v2/workspaces/:id/tokens/:tokenId` - Delete workspace access token

## Contexts

### Context Lifecycle
- `GET /rest/v2/contexts` - List user's contexts
- `POST /rest/v2/contexts` - Create new context
- `GET /rest/v2/contexts/:id` - Get context by ID
- `PUT /rest/v2/contexts/:id` - Update context
- `DELETE /rest/v2/contexts/:id` - Delete context

### Context URL Management
- `GET /rest/v2/contexts/:id/url` - Get context URL
- `POST /rest/v2/contexts/:id/url` - Set context URL
- `GET /rest/v2/contexts/:id/path` - Get context path
- `GET /rest/v2/contexts/:id/path-array` - Get context path array

### Context Documents
- `GET /rest/v2/contexts/:id/documents` - List documents in context
- `POST /rest/v2/contexts/:id/documents` - Insert documents into context
- `PUT /rest/v2/contexts/:id/documents` - Update documents in context
- `DELETE /rest/v2/contexts/:id/documents` - Delete documents from context (direct DB deletion)
- `DELETE /rest/v2/contexts/:id/documents/remove` - Remove documents from context
- `GET /rest/v2/contexts/:id/documents/by-id/:docId` - Get document by ID
- `GET /rest/v2/contexts/:id/documents/:docId` - Get document by ID (direct route)
- `GET /rest/v2/contexts/:id/documents/by-abstraction/:abstraction` - Get documents by abstraction
- `GET /rest/v2/contexts/:id/documents/by-hash/:algo/:hash` - Get document by hash (owner-only)

### Context Tree Operations
- `GET /rest/v2/contexts/:id/tree` - Get context tree structure
- `POST /rest/v2/contexts/:id/tree/paths` - Insert path into context tree
- `DELETE /rest/v2/contexts/:id/tree/paths` - Remove path from context tree
- `POST /rest/v2/contexts/:id/tree/paths/move` - Move path in context tree
- `POST /rest/v2/contexts/:id/tree/paths/copy` - Copy path in context tree
- `POST /rest/v2/contexts/:id/tree/paths/merge-up` - Merge layer bitmaps upwards
- `POST /rest/v2/contexts/:id/tree/paths/merge-down` - Merge layer bitmaps downwards

## Schemas

### Schema Management
- `GET /rest/v2/schemas` - List all data schemas
- `GET /rest/v2/schemas/data/abstraction/:abstraction` - List schemas by abstraction type
- `GET /rest/v2/schemas/data/abstraction/:abstraction.json` - Get JSON schema for specific abstraction

## Ping

### Server Status
- `GET /ping` - Simple ping endpoint
- `GET /debug` - Debug endpoint (requires authentication)
- `GET /rest/v2/ping` - Server status with system information

# Websockets

## Workspaces

### Workspace Events
- `workspace.status.changed` - Workspace status changes
- `workspace.created` - New workspace created
- `workspace.updated` - Workspace updated
- `workspace.deleted` - Workspace deleted
- `workspace.documents.inserted` - Documents inserted into workspace
- `workspace.documents.updated` - Documents updated in workspace
- `workspace.documents.deleted` - Documents deleted from workspace
- `workspace.tree.path.inserted` - Path inserted into workspace tree
- `workspace.tree.path.removed` - Path removed from workspace tree
- `workspace.tree.path.moved` - Path moved in workspace tree
- `workspace.tree.path.copied` - Path copied in workspace tree

## Contexts

### Context Events
- `context.url.set` - Context URL changed
- `context.updated` - Context updated
- `context.locked` - Context locked
- `context.unlocked` - Context unlocked
- `context.acl.updated` - Context ACL updated
- `context.acl.revoked` - Context ACL revoked
- `context.documents.inserted` - Documents inserted into context
- `context.documents.updated` - Documents updated in context
- `context.documents.deleted` - Documents deleted from context
- `context.tree.path.inserted` - Path inserted into context tree
- `context.tree.path.removed` - Path removed from context tree
- `context.tree.path.moved` - Path moved in context tree
- `context.tree.path.copied` - Path copied in context tree

# Common

## ResponseObject

The API uses a standardized `ResponseObject` class for all responses with the following structure:

```javascript
{
  status: 'success' | 'error',
  statusCode: number,
  message: string,
  payload: any,
  count: number | null
}
```

### Response Methods
- `success(payload, message, statusCode, count)` - Generic success response
- `created(payload, message, statusCode, count)` - Resource creation success
- `found(payload, message, statusCode, count)` - Resource retrieval success
- `updated(payload, message, statusCode, count)` - Resource update success
- `deleted(message, statusCode, count)` - Resource deletion success
- `notFound(message, payload, statusCode)` - Resource not found
- `error(message, payload, statusCode)` - Generic error
- `badRequest(message, payload, statusCode)` - Invalid request
- `unauthorized(message, payload, statusCode)` - Authentication required
- `forbidden(message, payload, statusCode)` - Insufficient permissions
- `conflict(message, payload, statusCode)` - Request conflict
- `serverError(message, payload, statusCode)` - Internal server error

## Authentication

The API supports two authentication methods:

### JWT Tokens
- Used primarily for web UI authentication
- Short-lived tokens (default: 1 day)
- Include user information in payload

### API Tokens
- Long-lived tokens with `canvas-` prefix
- Used for programmatic access
- Support token-based workspace sharing via ACLs

## Access Control

### Workspace ACL
- Owner access: Full permissions (read, write, admin)
- Token-based access: Configurable permissions per token
- JWT tokens: Owner-only access

### Context ACL
- Owner access: Full permissions
- Shared access: Document-level permissions (documentRead, documentWrite, documentReadWrite)
- Cross-user context access via `/pub` routes

## Error Handling

All endpoints return standardized error responses using the `ResponseObject` class. Common error scenarios:

- **401 Unauthorized**: Invalid or missing authentication token
- **403 Forbidden**: Insufficient permissions for the requested operation
- **404 Not Found**: Requested resource doesn't exist
- **409 Conflict**: Resource conflict (e.g., duplicate names)
- **500 Internal Server Error**: Unexpected server error

## Rate Limiting

Currently no rate limiting is implemented. Consider implementing rate limiting for production deployments.

## CORS

CORS is enabled with the following configuration:
- Origin: All origins (configurable)
- Methods: GET, PUT, POST, DELETE, PATCH, OPTIONS
- Credentials: true
- Allowed headers: Content-Type, Authorization, Accept, X-App-Name, X-Selected-Session
