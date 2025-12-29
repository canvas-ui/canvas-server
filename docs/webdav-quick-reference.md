# WebDAV Quick Reference

## Connection URL
```
http(s)://[server]/webdav/[workspace-name]/home
```

## Authentication

### Bearer Token (Recommended)
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:3334/webdav/workspace/home
```

### HTTP Basic Auth (Fallback)
- **Username:** Any value (e.g., email)
- **Password:** Your JWT or API token

## Quick Commands

### List Files (PROPFIND)
```bash
curl -X PROPFIND \
  -H "Authorization: Bearer TOKEN" \
  -H "Depth: 1" \
  http://localhost:3334/webdav/workspace/home/
```

### Upload File (PUT)
```bash
curl -X PUT \
  -H "Authorization: Bearer TOKEN" \
  -T myfile.txt \
  http://localhost:3334/webdav/workspace/home/myfile.txt
```

### Download File (GET)
```bash
curl -H "Authorization: Bearer TOKEN" \
  http://localhost:3334/webdav/workspace/home/myfile.txt
```

### Create Directory (MKCOL)
```bash
curl -X MKCOL \
  -H "Authorization: Bearer TOKEN" \
  http://localhost:3334/webdav/workspace/home/newfolder
```

### Delete File/Directory (DELETE)
```bash
curl -X DELETE \
  -H "Authorization: Bearer TOKEN" \
  http://localhost:3334/webdav/workspace/home/myfile.txt
```

### Move/Rename (MOVE)
```bash
curl -X MOVE \
  -H "Authorization: Bearer TOKEN" \
  -H "Destination: http://localhost:3334/webdav/workspace/home/newname.txt" \
  http://localhost:3334/webdav/workspace/home/oldname.txt
```

### Copy (COPY)
```bash
curl -X COPY \
  -H "Authorization: Bearer TOKEN" \
  -H "Destination: http://localhost:3334/webdav/workspace/home/copy.txt" \
  http://localhost:3334/webdav/workspace/home/original.txt
```

## Platform-Specific Mount Commands

### Windows
```cmd
net use W: http://localhost:3334/webdav/workspace/home /user:email
```

### macOS
```bash
mount_webdav -S http://localhost:3334/webdav/workspace/home ~/mount-point
```

### Linux (davfs2)
```bash
mount.davfs http://localhost:3334/webdav/workspace/home ~/mount-point
```

## Supported WebDAV Methods

- **OPTIONS** - Capability discovery
- **GET** - Download files
- **HEAD** - Get file metadata
- **POST** - Upload (alternative)
- **PUT** - Upload/update files
- **DELETE** - Delete files/directories
- **PROPFIND** - List directory contents
- **PROPPATCH** - Update properties
- **MKCOL** - Create directory
- **COPY** - Copy files/directories
- **MOVE** - Move/rename files/directories
- **LOCK** - Lock files (Class 2)
- **UNLOCK** - Unlock files (Class 2)

## Response Codes

- **200 OK** - Success (GET)
- **201 Created** - Resource created (PUT, MKCOL, COPY, MOVE)
- **204 No Content** - Success, no content (PUT, DELETE)
- **207 Multi-Status** - PROPFIND response
- **401 Unauthorized** - Invalid/missing token
- **403 Forbidden** - No permission
- **404 Not Found** - Resource doesn't exist
- **409 Conflict** - Resource already exists
- **423 Locked** - Resource is locked

## Debugging

### Enable Debug Logs
```bash
DEBUG=webdav:* npm start
```

### Health Check
```bash
curl http://localhost:3334/webdav/health
```

## Common Headers

### Request Headers
- `Authorization: Bearer TOKEN` - Authentication
- `Depth: 0|1|infinity` - Recursion depth for PROPFIND
- `Destination: URL` - Target for COPY/MOVE
- `Overwrite: T|F` - Overwrite existing in COPY/MOVE
- `If: (<lock-token>)` - Lock token for locked resources

### Response Headers
- `DAV: 1, 2` - WebDAV compliance levels
- `MS-Author-Via: DAV` - Microsoft WebDAV indicator
- `ETag` - Entity tag for caching
- `Lock-Token` - Token for locked resources

## See Also

- [Full WebDAV Documentation](./webdav-access.md)
- [Testing Guide](./webdav-testing.md)
- [Workspace Management](./workspace-management.md)

