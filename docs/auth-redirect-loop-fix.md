# Auth Redirect Loop Fix Documentation

## Problem Description

The Canvas server was experiencing a redirect loop issue where users would get stuck bouncing between the login page (`/login`) and the workspaces page (`/workspaces`). This occurred when:

1. A user had a valid JWT token that was not expired
2. The JWT token contained a valid user ID (e.g., `oCmZ7iNP`)
3. The user was not found in the database index (`User not found in index: oCmZ7iNP`)

## Root Cause

The issue occurred due to a mismatch between the JWT token's user ID and what was stored in the user database index. This can happen when:

- **User data deletion**: User was deleted from the database but the JWT token was still valid
- **Database corruption or reset**: The user index was corrupted or reset
- **User ID format changes**: User ID format changed between token issuance and validation

## Symptoms

```
[01:04:30.010] INFO (1365515): [Auth/Me] JWT verification successful: oCmZ7iNP
[01:04:30.011] ERROR (1365515): [Auth/Me] Database error: User not found in index: oCmZ7iNP
```

The UI would show:
- User gets redirected from `/workspaces` to `/login`
- User's token is still valid, so they get redirected back to `/workspaces`
- Cycle repeats infinitely

## Solution

The fix involves three main components:

### 1. Backend: Enhanced Error Handling in Auth Routes

**File**: `src/transports/routes/auth.js`

```javascript
// Handle the specific case where user exists in token but not in database
if (dbError.message.includes('User not found in index')) {
  fastify.log.warn(`[Auth/Me] User ${userId} has valid token but missing from database - clearing authentication`);
  
  // Return a specific error that the frontend can handle
  const response = new ResponseObject().unauthorized(
    'Your session is invalid. Please log in again.',
    { 
      code: 'USER_NOT_FOUND_IN_DATABASE',
      userId: userId,
      action: 'logout'
    }
  );
  return reply.code(response.statusCode).send(response.getResponse());
}
```

### 2. Backend: Enhanced Error Handling in Auth Strategies

**Files**: `src/transports/auth/strategies.js`

Both `verifyJWT` and `verifyApiToken` functions now handle the missing user scenario:

```javascript
// Handle the specific case where user exists in token but not in database
if (userError.message.includes('User not found in index')) {
  console.warn(`[Auth/JWT] User ${decoded.sub} has valid JWT token but missing from database`);
  return response.unauthorized('Your session is invalid. Please log in again.');
}
```

### 3. Frontend: Improved Error Handling

**File**: `src/ui/web/src/services/auth.ts`

```typescript
// Handle the specific case where user exists in token but not in database
if (error instanceof Error && 
    (error.message.includes('USER_NOT_FOUND_IN_DATABASE') || 
     error.message.includes('Your session is invalid'))) {
  console.warn('User token is valid but user not found in database - clearing authentication');
  api.clearAuthToken();
  socketService.disconnect();
  return null;
}
```

## Testing

A comprehensive test suite has been created to verify the fix:

**File**: `tests/auth-redirect-loop-test.js`

To run the test:

```bash
cd /path/to/canvas-server
node tests/auth-redirect-loop-test.js
```

The test covers:
1. User creation and login
2. Valid token verification
3. Missing user scenario simulation
4. Invalid token handling
5. Expired token handling

## Prevention Measures

### 1. Database Backup and Recovery

- **Regular backups**: Implement automated backups of the user index
- **Backup verification**: Regularly verify backup integrity
- **Recovery procedures**: Document and test recovery procedures

### 2. Token Lifecycle Management

- **Shorter token expiration**: Consider shorter JWT token expiration times
- **Token refresh mechanisms**: Implement token refresh to minimize impact
- **Token validation**: Add periodic token validation checks

### 3. Monitoring and Alerting

- **Error monitoring**: Set up alerts for "User not found in index" errors
- **Authentication metrics**: Monitor authentication success/failure rates
- **Database health checks**: Regular database integrity checks

### 4. User Session Management

- **Session invalidation**: Implement proper session invalidation on user deletion
- **Token blacklisting**: Consider token blacklisting for deleted users
- **Graceful degradation**: Ensure graceful handling of authentication failures

## Implementation Notes

### Error Response Format

The error response follows the `ResponseObject` pattern:

```javascript
{
  status: 'error',
  statusCode: 401,
  message: 'Your session is invalid. Please log in again.',
  payload: {
    code: 'USER_NOT_FOUND_IN_DATABASE',
    userId: 'oCmZ7iNP',
    action: 'logout'
  }
}
```

### Frontend Error Handling

The frontend now properly handles multiple error conditions:

- `USER_NOT_FOUND_IN_DATABASE`: Specific code for missing user
- `Your session is invalid`: Generic session invalid message
- `user account no longer exists`: Account deletion message
- `Authentication required`: Generic auth failure

### Logging Improvements

Enhanced logging throughout the authentication flow:

- JWT token verification status
- User lookup results
- Error conditions and handling
- Database error specifics

## Future Improvements

1. **User Reactivation**: Implement user reactivation mechanism
2. **Token Refresh**: Add automatic token refresh functionality
3. **Database Sync**: Implement database synchronization checks
4. **User Migration**: Add user migration tools for database changes
5. **Admin Dashboard**: Create admin interface for user management

## Troubleshooting

### Common Issues

1. **Token still valid but user missing**: 
   - Check user database integrity
   - Verify token expiration settings
   - Review user deletion procedures

2. **Persistent redirect loops**:
   - Clear browser localStorage
   - Check for frontend caching issues
   - Verify API error response format

3. **Database corruption**:
   - Run database integrity checks
   - Restore from backup if necessary
   - Review recent changes or migrations

### Debug Commands

```bash
# Check user database contents
node -e "console.log(require('./src/utils/jim/index.js').createIndex('users').store)"

# Verify JWT token contents
node -e "console.log(require('jsonwebtoken').decode('YOUR_TOKEN_HERE'))"

# Test authentication endpoint
curl -H "Authorization: Bearer YOUR_TOKEN_HERE" http://localhost:8001/rest/v2/auth/me
```

## Related Files

- `src/transports/routes/auth.js`: Main authentication routes
- `src/transports/auth/strategies.js`: JWT and API token strategies
- `src/ui/web/src/services/auth.ts`: Frontend authentication service
- `src/managers/user/index.js`: User management logic
- `tests/auth-redirect-loop-test.js`: Test suite

## Conclusion

This fix ensures that when a user has a valid JWT token but is missing from the database, the system gracefully handles the error and prompts the user to log in again, breaking the redirect loop and providing a better user experience. 
