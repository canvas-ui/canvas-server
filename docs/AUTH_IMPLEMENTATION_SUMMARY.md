# Auth System Implementation Summary

## Overview

Successfully refactored the authentication system to support multiple authentication mechanisms with portable user tokens and per-resource access tokens.

## Completed Features

### 1. Token Storage Migration ✅
- **Migrated from jim index to file-based storage**
  - User-level tokens now stored in `{user_home}/config/tokens.json`
  - Tokens are portable when users move their home directory
  - Backward compatibility maintained with jim index for passwords and rate limits
- **Files Modified:**
  - `src/transports/auth/service.js` - Added `TokenManager` class
  - `src/Server.js` - Pass `userHomePath` to authService initialization

### 2. Global API Token Generation ✅
- **Auto-generate tokens on user creation**
  - Each new user gets a default global API token
  - Token grants access to all user's resources
  - Stored in user's `config/tokens.json`
- **Files Modified:**
  - `src/core/user/index.js` - Added authService injection and token generation in create method
  - `src/Server.js` - Inject authService into users manager

### 3. Per-Resource Token Support ✅
- **Workspace-level access tokens**
  - Each workspace can have multiple access tokens
  - Tokens stored in `workspace.json` under `acl.tokens`
  - Token format: `canvas-workspace-{random-hex}`
- **New Workspace Methods:**
  - `createToken(options)` - Create workspace access token
  - `listTokens()` - List all tokens for workspace
  - `deleteToken(hash)` - Delete a specific token
  - `verifyToken(value)` - Verify token against workspace ACL
- **Files Modified:**
  - `src/core/workspace/Workspace.js` - Added token management methods

### 4. Hybrid Token Verification ✅
- **Checks both user and resource tokens**
  - First tries user-level token verification
  - Falls back to workspace-level token verification
  - Sets `request.resourceToken` metadata for resource tokens
- **Files Modified:**
  - `src/transports/auth/strategies.js` - Updated `verifyApiToken` function

### 5. LDAP Authentication ✅
- **Full LDAP strategy implementation**
  - User authentication via LDAP bind
  - Auto-create users on successful LDAP auth
  - Support for multiple LDAP servers (failover)
  - Configurable search filters and attributes
- **New File:**
  - `src/transports/auth/ldap-strategy.js` - Complete LDAP implementation
- **Files Modified:**
  - `src/transports/auth/strategies.js` - Integrated LDAP into login flow
  - `src/transports/routes/auth.js` - Added LDAP support to auth routes

### 6. LDAP Configuration ✅
- **Added LDAP to auth.json**
  - Primary and secondary server configuration
  - Comprehensive example configurations
- **Files Modified:**
  - `src/transports/auth/service.js` - Added LDAP to default config
  - `src/transports/routes/auth.js` - Expose LDAP config in `/auth/config` endpoint

### 7. API Routes for Resource Tokens ✅
- **Updated workspace token routes**
  - `POST /workspaces/:id/tokens` - Create token
  - `GET /workspaces/:id/tokens` - List tokens
  - `DELETE /workspaces/:id/tokens/:hash` - Delete token
  - Uses new Workspace methods
- **Files Modified:**
  - `src/transports/routes/workspaces/tokens.js` - Updated to use Workspace methods

### 8. Comprehensive Configuration Examples ✅
- **Created example config files**
  - `server/config/auth.example.json` - All auth strategies with comments
  - `server/config/ldap.example.json` - LDAP-specific examples (AD, OpenLDAP, etc.)
  - `server/config/smtp.example.json` - SMTP configuration examples

## Architecture

### Token Storage Strategy (Hybrid)

1. **User-Level Tokens** (`{user_home}/config/tokens.json`)
   - Global API tokens
   - Password reset tokens
   - Email verification tokens
   - Portable across canvas-server instances

2. **Resource-Level Tokens** (in resource config files)
   - `workspace.json` → `acl.tokens`
   - Fine-grained access control
   - Per-resource permissions
   - Stay with the resource when shared

### Authentication Mechanisms

1. **Local (email + password)** - ✅ Already implemented, always enabled
2. **API Tokens** - ✅ Migrated to file-based storage
3. **IMAP** - ✅ Already implemented
4. **LDAP** - ✅ Newly implemented
5. **OAuth2** - ⏸️ Deferred to future (config placeholder created)

### Token Types

1. **Global User Tokens**
   - Format: `canvas-{random-hex}`
   - Grants access to all user's resources
   - Auto-generated on user creation

2. **Workspace Tokens**
   - Format: `canvas-workspace-{random-hex}`
   - Grants access only to specific workspace
   - Configurable permissions (read, write, admin)

## Configuration Files

### Required Configuration
- `server/config/auth.json` - Main auth configuration (auto-created with defaults)
- `server/config/smtp.json` - Email configuration (optional)

### Example Files (for reference)
- `server/config/auth.example.json` - Complete example with all strategies
- `server/config/ldap.example.json` - LDAP-specific examples
- `server/config/smtp.example.json` - SMTP examples

## Dependencies

### Required
- All existing dependencies (bcryptjs, jsonwebtoken, etc.)

### Optional
- `ldapjs` - Required for LDAP authentication
  - Install with: `npm install ldapjs`
  - LDAP auth will be disabled if not installed

## API Endpoints

### Authentication
- `GET /rest/v2/auth/config` - Get available auth strategies
- `POST /rest/v2/auth/login` - Login (supports local, imap, ldap, auto)
- `POST /rest/v2/auth/register` - Register new user
- `GET /rest/v2/auth/tokens` - List user's API tokens
- `POST /rest/v2/auth/tokens` - Create new API token
- `DELETE /rest/v2/auth/tokens/:id` - Delete API token

### Workspace Tokens
- `POST /rest/v2/workspaces/:id/tokens` - Create workspace token
- `GET /rest/v2/workspaces/:id/tokens` - List workspace tokens
- `DELETE /rest/v2/workspaces/:id/tokens/:hash` - Delete workspace token

## Token Portability

### User Migration
When a user moves their home directory to a different canvas-server instance:

1. **User tokens** (`config/tokens.json`) move with them ✅
2. **Workspace tokens** (in `workspace.json`) move with workspaces ✅
3. User can still access their workspaces using their global token ✅

### Resource Sharing
When sharing a workspace:

1. Workspace config includes `acl.tokens` ✅
2. Resource-specific tokens travel with the workspace ✅
3. Recipients can access using the workspace token ✅

## Testing Checklist

- [x] Local email+password auth still works
- [x] API tokens work from user config files
- [x] Global user token grants access to all resources
- [x] Workspace tokens are created and stored correctly
- [x] Token verification checks both user and workspace tokens
- [ ] IMAP auth still works (requires IMAP server for testing)
- [ ] LDAP authentication works (requires LDAP server and ldapjs package)
- [ ] User home migration preserves tokens
- [ ] Config examples are complete and documented

## Notes

1. **LDAP Package**: LDAP authentication requires `ldapjs` package. Install with:
   ```bash
   npm install ldapjs
   ```

2. **Security**: 
   - Always change the JWT secret in production
   - Use LDAPS (port 636) for LDAP in production
   - Never commit `auth.json` or `smtp.json` with real credentials

3. **Backward Compatibility**:
   - Existing jim-based tokens still work
   - New tokens are created in file-based storage
   - Gradual migration as users log in

4. **Future Enhancements**:
   - OAuth2 support (config placeholder exists)
   - Context-level tokens
   - Agent-level tokens
   - Role-level tokens

## Files Created/Modified

### Created
- `src/transports/auth/ldap-strategy.js`
- `server/config/auth.example.json`
- `server/config/ldap.example.json`
- `server/config/smtp.example.json`
- `AUTH_IMPLEMENTATION_SUMMARY.md`

### Modified
- `src/transports/auth/service.js`
- `src/transports/auth/strategies.js`
- `src/transports/routes/auth.js`
- `src/transports/routes/workspaces/tokens.js`
- `src/core/user/index.js`
- `src/core/workspace/Workspace.js`
- `src/Server.js`

