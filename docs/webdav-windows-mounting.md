# WebDAV Windows Mounting Guide

This guide explains how to mount Canvas WebDAV workspaces on Windows systems.

## Authentication Methods Supported

Canvas WebDAV supports multiple authentication methods:

1. **Bearer Token Authentication** (recommended for API clients)
2. **Basic Authentication with API Token** (recommended for Windows File Explorer)
3. **Basic Authentication with Username/Password** (traditional authentication)

## Prerequisites

1. **Canvas Server Running**: Ensure your Canvas server is running and accessible
2. **API Token**: You need a valid Canvas API token
3. **Workspace Access**: You must have access to the workspace you want to mount

## Creating an API Token

### Method 1: Using Canvas CLI
```bash
# Create a new API token
canvas auth tokens create "WebDAV Access Token"

# List existing tokens
canvas auth tokens list
```

### Method 2: Using the Helper Script
```bash
# Create a token for a specific user
node tests/create-webdav-token.js create admin@canvas.local "My WebDAV Token"

# List tokens for a user
node tests/create-webdav-token.js list admin@canvas.local
```

### Method 3: Using the Web UI
1. Log in to the Canvas Web UI
2. Navigate to Settings > API Tokens
3. Click "Create New Token"
4. Provide a name and description
5. Copy the generated token immediately

## Windows Mounting Instructions

### Step 1: Open File Explorer
1. Open Windows File Explorer
2. Right-click on "This PC" in the left sidebar
3. Select "Map network drive..."

### Step 2: Configure the Drive
1. **Drive Letter**: Choose an available drive letter (e.g., Z:)
2. **Folder**: Enter your WebDAV URL in the format:
   ```
   http://your-server:8001/webdav/workspace-name/home/
   ```
   Replace:
   - `your-server` with your Canvas server hostname/IP
   - `workspace-name` with the actual workspace name
   - `8001` with your Canvas server port (if different)

### Step 3: Authentication
1. **Check "Connect using different credentials"**
2. Click "Connect"
3. Enter your credentials using **one of these methods**:

#### Method A: API Token (Recommended)
- **Username**: Your email address (e.g., `admin@canvas.local`) or any username
- **Password**: Your Canvas API token (starts with `canvas-`)

#### Method B: Username/Password (Traditional)
- **Username**: Your email address (e.g., `admin@canvas.local`)
- **Password**: Your Canvas account password

### Step 4: Complete Setup
1. Click "OK" to authenticate
2. Click "Finish" to complete the mapping
3. The WebDAV drive should now appear in File Explorer

## Troubleshooting

### Common Issues

#### "jwt malformed" Error
- **Cause**: The system is trying to parse a password as a JWT token
- **Solution**: 
  1. If using username/password, ensure the user exists and password is correct
  2. If using API token, ensure the token starts with `canvas-`
  3. Check that the token is valid and not expired

#### "No authorization header provided" Error
- **Cause**: Windows is not sending authentication credentials
- **Solution**: Ensure you checked "Connect using different credentials" and entered the correct token

#### "Invalid token" Error
- **Cause**: The API token is incorrect or expired
- **Solution**: 
  1. Verify the token is correct (starts with `canvas-`)
  2. Check if the token has expired
  3. Create a new token if needed

#### "Workspace not found" Error
- **Cause**: The workspace name in the URL is incorrect
- **Solution**: 
  1. Verify the workspace name is correct
  2. Ensure you have access to the workspace
  3. Check the workspace exists in Canvas

#### Connection Timeout
- **Cause**: Network connectivity issues
- **Solution**:
  1. Verify the server URL is correct
  2. Check if the Canvas server is running
  3. Test connectivity with: `ping your-server`

### Testing WebDAV Authentication

Use the provided test script to verify your setup:

```bash
# Set your API token
export WEBDAV_TOKEN=your-canvas-api-token-here

# Run the Windows compatibility test
node tests/test-webdav-windows-compatibility.js
```

This will test:
- Unauthenticated requests (should return 401)
- Bearer token authentication
- Basic authentication
- PROPFIND requests (directory listing)
- Windows-specific headers
- Error handling

## WebDAV URL Format

The WebDAV URL follows this pattern:
```
http://server:port/webdav/workspace-name/home/
```

### Examples:
- `http://localhost:8001/webdav/universe/home/`
- `http://canvas.example.com:8001/webdav/my-workspace/home/`
- `https://canvas.example.com/webdav/project-alpha/home/`

## Security Considerations

1. **Token Security**: 
   - Keep your API tokens secure
   - Don't share tokens in plain text
   - Rotate tokens regularly

2. **Network Security**:
   - Use HTTPS in production environments
   - Consider VPN access for remote connections
   - Implement proper firewall rules

3. **Access Control**:
   - Only grant workspace access to authorized users
   - Regularly review workspace permissions
   - Monitor token usage

## Advanced Configuration

### Using Different Authentication Methods

#### Bearer Token (for API clients)
```bash
curl -H "Authorization: Bearer canvas-your-token-here" \
     http://your-server:8001/webdav/workspace/home/
```

#### Basic Authentication (for WebDAV clients)
```bash
curl -H "Authorization: Basic $(echo -n 'user:canvas-your-token-here' | base64)" \
     http://your-server:8001/webdav/workspace/home/
```

### Custom User Agents

Some Windows WebDAV clients send specific user agents. Canvas supports:
- `Microsoft-WebDAV-MiniRedir/*` (Windows File Explorer)
- `Microsoft-WebDAV/*` (Other Microsoft clients)
- Generic WebDAV clients

## Support

If you encounter issues:

1. **Check the logs**: Look for WebDAV-related debug messages
2. **Test connectivity**: Use the provided test scripts
3. **Verify configuration**: Ensure all URLs and tokens are correct
4. **Check permissions**: Verify workspace access permissions

For additional help, refer to the Canvas documentation or contact your system administrator.
