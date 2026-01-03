# Pub Routes Email-to-User-ID Redirection (Removed)

This feature was removed to avoid leaking emails/user identifiers in URLs.

**Canonical public routes are ID-only:**

- `GET /rest/v2/pub/workspaces/:workspaceId`
- `GET /rest/v2/pub/contexts/:contextId`

**Token transport is `Authorization: Bearer canvas-…` only.**

### Before (User ID required)
```
GET /pub/abc123/contexts/myproject
```

### After (Email supported)
```
GET /pub/user@example.com/contexts/myproject
# Redirects to: GET /pub/abc123/contexts/myproject
```

### Before (User ID required)
```
POST /pub/def456/contexts/work/shares
```

### After (Email supported)
```
POST /pub/admin@company.com/contexts/work/shares
# Redirects to: POST /pub/def456/contexts/work/shares
```

## Implementation Details

### Helper Function

The redirection logic is implemented in the `resolveUserIdFromEmail` helper function:

```javascript
const resolveUserIdFromEmail = async (request, reply, targetUserId) => {
  // Check if targetUserId looks like an email
  if (!validator.isEmail(targetUserId)) {
    return null; // Not an email, return null to continue with original targetUserId
  }

  try {
    // Try to find user by email
    const user = await fastify.userManager.getUserByEmail(targetUserId);
    if (user && user.id) {
      // Redirect to the user ID-based URL
      const originalUrl = request.url;
      const newUrl = originalUrl.replace(`/${targetUserId}/`, `/${user.id}/`);
      
      fastify.log.info(`Redirecting email-based URL to user ID: ${originalUrl} -> ${newUrl}`);
      return reply.redirect(301, newUrl);
    }
  } catch (error) {
    // User not found by email, continue with original targetUserId
    fastify.log.debug(`User not found by email: ${targetUserId}`);
  }
  
  return null; // No redirect needed
};
```

### Integration

The helper function is called at the beginning of each route handler:

```javascript
// Check if targetUserId is an email and redirect if needed
const redirectResult = await resolveUserIdFromEmail(request, reply, request.params.targetUserId);
if (redirectResult) {
  return redirectResult; // Redirect has been sent
}
```

## Benefits

1. **User-Friendly URLs**: Users can share links using email addresses instead of cryptic user IDs
2. **Backward Compatibility**: Existing user ID-based URLs continue to work unchanged
3. **SEO Friendly**: Email-based URLs are more descriptive and memorable
4. **Automatic Resolution**: No manual lookup required - the system handles the conversion automatically

## Error Handling

- If an email is provided but no user is found, the request continues with the email as-is (which will likely result in a 404)
- If the email format is invalid, the request continues with the original parameter
- All existing error handling for invalid user IDs remains unchanged

## Testing

The functionality is tested in `tests/pub-email-redirect-test.js` which verifies:
- Email validation logic
- URL redirection construction
- Edge cases and error conditions 
