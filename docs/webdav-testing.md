# WebDAV Implementation Testing Guide

This guide provides step-by-step instructions for testing the WebDAV workspace access implementation.

## Prerequisites

1. Canvas Server running (default: `http://localhost:3334`)
2. At least one workspace created
3. Valid authentication token (JWT or API token)

## Quick Start Test

### 1. Get Your Authentication Token

**Option A: Create an API Token**

```bash
# Login first to get a JWT
curl -X POST http://localhost:3334/rest/v2/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@canvas.local","password":"your-password"}'

# Extract the token from response, then create an API token
curl -X POST http://localhost:3334/rest/v2/auth/tokens \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"WebDAV Test Token","description":"Testing WebDAV access"}'

# Save the token that starts with "canvas-"
```

**Option B: Use JWT from Browser**
1. Login to Canvas web interface
2. Open DevTools (F12) → Application → Local Storage
3. Copy the auth token value

### 2. Test WebDAV Health Check

```bash
curl http://localhost:3334/webdav/health
```

Expected response:
```json
{
  "status": "ok",
  "service": "webdav",
  "timestamp": "2025-10-20T12:00:00.000Z"
}
```

### 3. Test OPTIONS Request (WebDAV Capability Discovery)

```bash
curl -X OPTIONS http://localhost:3334/webdav/universe/home \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -v
```

Expected headers in response:
```
DAV: 1, 2
MS-Author-Via: DAV
Allow: OPTIONS, GET, HEAD, POST, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK
```

### 4. Test PROPFIND (List Directory)

```bash
curl -X PROPFIND http://localhost:3334/webdav/universe/home \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Depth: 1" \
  -H "Content-Type: application/xml" \
  -d '<?xml version="1.0"?>
<D:propfind xmlns:D="DAV:">
  <D:allprop/>
</D:propfind>' \
  -v
```

Expected: XML response with directory listing

### 5. Test File Upload (PUT)

```bash
# Create a test file
echo "Hello from WebDAV!" > test.txt

# Upload it
curl -X PUT http://localhost:3334/webdav/universe/home/test.txt \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -T test.txt \
  -v
```

Expected: HTTP 201 Created or 204 No Content

### 6. Test File Download (GET)

```bash
curl http://localhost:3334/webdav/universe/home/test.txt \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Expected: "Hello from WebDAV!"

### 7. Test Directory Creation (MKCOL)

```bash
curl -X MKCOL http://localhost:3334/webdav/universe/home/testdir \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -v
```

Expected: HTTP 201 Created

### 8. Test File Move (MOVE)

```bash
curl -X MOVE http://localhost:3334/webdav/universe/home/test.txt \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Destination: http://localhost:3334/webdav/universe/home/testdir/test.txt" \
  -v
```

Expected: HTTP 201 Created or 204 No Content

### 9. Test File Copy (COPY)

```bash
curl -X COPY http://localhost:3334/webdav/universe/home/testdir/test.txt \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Destination: http://localhost:3334/webdav/universe/home/test-copy.txt" \
  -v
```

Expected: HTTP 201 Created or 204 No Content

### 10. Test File Deletion (DELETE)

```bash
curl -X DELETE http://localhost:3334/webdav/universe/home/test-copy.txt \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -v
```

Expected: HTTP 204 No Content

## Platform Integration Tests

### Windows Test

```cmd
@echo off
SET TOKEN=your-token-here
SET WORKSPACE=universe

echo Testing WebDAV mount...
net use W: http://localhost:3334/webdav/%WORKSPACE%/home /user:test %TOKEN%

if %ERRORLEVEL% EQU 0 (
    echo Success! Drive W: mounted
    echo Testing file operations...
    echo Hello from Windows > W:\windows-test.txt
    type W:\windows-test.txt
    del W:\windows-test.txt
    net use W: /delete
) else (
    echo Failed to mount drive
)
```

### macOS Test

```bash
#!/bin/bash
TOKEN="your-token-here"
WORKSPACE="universe"
MOUNT_POINT="$HOME/canvas-webdav-test"

echo "Testing WebDAV mount..."
mkdir -p "$MOUNT_POINT"

# Mount the share
mount_webdav -S "http://localhost:3334/webdav/$WORKSPACE/home" "$MOUNT_POINT"

if [ $? -eq 0 ]; then
    echo "Success! Mounted at $MOUNT_POINT"
    echo "Testing file operations..."
    echo "Hello from macOS" > "$MOUNT_POINT/macos-test.txt"
    cat "$MOUNT_POINT/macos-test.txt"
    rm "$MOUNT_POINT/macos-test.txt"
    umount "$MOUNT_POINT"
    rmdir "$MOUNT_POINT"
else
    echo "Failed to mount"
fi
```

### Linux Test (davfs2)

```bash
#!/bin/bash
TOKEN="your-token-here"
WORKSPACE="universe"
MOUNT_POINT="$HOME/canvas-webdav-test"

echo "Testing WebDAV mount..."
mkdir -p "$MOUNT_POINT"

# Add credentials temporarily
echo "http://localhost:3334/webdav/$WORKSPACE/home test $TOKEN" >> ~/.davfs2/secrets
chmod 600 ~/.davfs2/secrets

# Mount the share
mount.davfs "http://localhost:3334/webdav/$WORKSPACE/home" "$MOUNT_POINT"

if [ $? -eq 0 ]; then
    echo "Success! Mounted at $MOUNT_POINT"
    echo "Testing file operations..."
    echo "Hello from Linux" > "$MOUNT_POINT/linux-test.txt"
    cat "$MOUNT_POINT/linux-test.txt"
    rm "$MOUNT_POINT/linux-test.txt"
    umount "$MOUNT_POINT"
    rmdir "$MOUNT_POINT"
else
    echo "Failed to mount"
fi

# Clean up credentials
sed -i "/localhost:3334/d" ~/.davfs2/secrets
```

## Authentication Tests

### Test with Invalid Token

```bash
curl -X PROPFIND http://localhost:3334/webdav/universe/home \
  -H "Authorization: Bearer invalid-token" \
  -H "Depth: 1" \
  -v
```

Expected: HTTP 401 Unauthorized

### Test with No Token

```bash
curl -X PROPFIND http://localhost:3334/webdav/universe/home \
  -H "Depth: 1" \
  -v
```

Expected: HTTP 401 Unauthorized

### Test HTTP Basic Auth

```bash
# Base64 encode: username:token
echo -n "test@canvas.local:YOUR_TOKEN" | base64

curl -X PROPFIND http://localhost:3334/webdav/universe/home \
  -H "Authorization: Basic BASE64_STRING" \
  -H "Depth: 1" \
  -v
```

Expected: Success (HTTP 207 Multi-Status)

## Permission Tests

### Test Access to Non-Existent Workspace

```bash
curl -X PROPFIND http://localhost:3334/webdav/nonexistent/home \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Depth: 1" \
  -v
```

Expected: HTTP 404 Not Found

### Test Access to Workspace Without Permission

Create a second user and workspace, then:

```bash
# Try to access user2's workspace with user1's token
curl -X PROPFIND http://localhost:3334/webdav/user2-workspace/home \
  -H "Authorization: Bearer USER1_TOKEN" \
  -H "Depth: 1" \
  -v
```

Expected: HTTP 403 Forbidden

## Load Testing

### Simple Load Test with Apache Bench

```bash
# Install Apache Bench
sudo apt-get install apache2-utils  # Ubuntu/Debian
brew install httpd  # macOS

# Test concurrent connections
ab -n 100 -c 10 \
  -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3334/webdav/universe/home/
```

### Upload Performance Test

```bash
# Create a 10MB test file
dd if=/dev/zero of=test-10mb.bin bs=1M count=10

# Time the upload
time curl -X PUT http://localhost:3334/webdav/universe/home/test-10mb.bin \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -T test-10mb.bin
```

## Debugging

### Enable Debug Mode

```bash
# Start server with WebDAV debugging
DEBUG=webdav:* npm start
```

### Check Server Logs

Look for log entries like:
```
webdav:server Initializing WebDAV server
webdav:auth Bearer token detected
webdav:server Resolved workspace home path: /path/to/workspace/home
webdav:routes WebDAV request: PROPFIND /webdav/universe/home (user: user-id, workspace: universe)
```

### Common Issues

**Issue: "Cannot mount workspace"**
- Check workspace exists: `curl http://localhost:3334/rest/v2/workspaces`
- Verify token is valid: `curl http://localhost:3334/rest/v2/auth/token/verify -d '{"token":"YOUR_TOKEN"}'`
- Check workspace home directory was created in workspace path

**Issue: "Authentication required" on every request**
- WebDAV client may not support Bearer tokens → Use HTTP Basic Auth
- Check Authorization header is being sent
- Verify token hasn't expired (JWT tokens expire, API tokens don't)

**Issue: Slow performance**
- Check network latency
- Verify workspace is on fast storage (SSD recommended)
- Enable client-side caching

**Issue: File locks not working**
- Verify WebDAV server initialized with `lockTimeout` option
- Check client supports WebDAV Class 2
- Ensure file isn't already locked by another client

## Integration with Client Applications

### Microsoft Office

1. Open Word/Excel/PowerPoint
2. File → Open → Browse
3. Enter WebDAV URL: `http://localhost:3334/webdav/universe/home`
4. Enter credentials when prompted
5. File should open with lock enabled

### Adobe Creative Suite

1. File → Open
2. Enter WebDAV URL in file browser
3. Files will be downloaded to local cache and uploaded on save

### Git Repository in WebDAV

```bash
# Clone a repository to WebDAV
git clone https://github.com/user/repo.git /mnt/webdav/repo

# Work with it normally
cd /mnt/webdav/repo
git pull
git commit -am "Changes"
git push
```

## Continuous Integration Testing

Example GitHub Actions workflow:

```yaml
name: WebDAV Tests

on: [push, pull_request]

jobs:
  test-webdav:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      
      - name: Setup Node.js
        uses: actions/setup-node@v2
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: npm install
      
      - name: Start Canvas Server
        run: npm start &
        env:
          DEBUG: webdav:*
      
      - name: Wait for server
        run: sleep 10
      
      - name: Run WebDAV tests
        run: |
          # Health check
          curl -f http://localhost:3334/webdav/health
          
          # Get token
          TOKEN=$(curl -X POST http://localhost:3334/rest/v2/auth/login \
            -H "Content-Type: application/json" \
            -d '{"email":"admin@canvas.local","password":"admin"}' \
            | jq -r '.data.token')
          
          # Test PROPFIND
          curl -f -X PROPFIND http://localhost:3334/webdav/universe/home \
            -H "Authorization: Bearer $TOKEN" \
            -H "Depth: 1"
          
          # Test file upload
          echo "test" > test.txt
          curl -f -X PUT http://localhost:3334/webdav/universe/home/test.txt \
            -H "Authorization: Bearer $TOKEN" \
            -T test.txt
          
          # Test file download
          curl -f http://localhost:3334/webdav/universe/home/test.txt \
            -H "Authorization: Bearer $TOKEN"
```

## Next Steps

After successful testing:

1. Update main README with WebDAV feature
2. Add WebDAV section to API documentation
3. Create video tutorial for users
4. Monitor production usage and performance
5. Consider adding Apache reverse proxy for scale

