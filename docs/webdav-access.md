# WebDAV Access to Workspace Home Folders

Canvas Server provides WebDAV access to workspace home directories, enabling native file manager integration across Windows, macOS, and Linux. This allows you to mount workspace folders as network drives and work with them using your operating system's native file manager.

## Connection URL Format

```
http(s)://[server-address]/webdav/[workspace-name]/home
```

**Example:**
```
http://localhost:3334/webdav/my-workspace/home
```

## Authentication

WebDAV supports two authentication methods:

### 1. Bearer Token (Recommended)

Add your Canvas JWT or API token as a Bearer token in the Authorization header:

```
Authorization: Bearer your-jwt-or-api-token-here
```

### 2. HTTP Basic Authentication (Fallback)

Some WebDAV clients that don't support Bearer tokens can use HTTP Basic Authentication:

- **Username:** Any value (e.g., your email or username)
- **Password:** Your Canvas JWT or API token

## Platform-Specific Instructions

### Windows

#### Method 1: Command Line (Quick)

Open Command Prompt or PowerShell and run:

```cmd
net use W: http://localhost:3334/webdav/workspace-name/home /user:your-email
```

When prompted, enter your Canvas JWT or API token as the password.

#### Method 2: File Explorer (GUI)

1. Open **File Explorer**
2. Click **This PC** in the left sidebar
3. Click **Computer** → **Map network drive** in the toolbar
4. Choose a drive letter (e.g., `W:`)
5. Enter folder: `http://localhost:3334/webdav/workspace-name/home`
6. Check **Connect using different credentials**
7. Click **Finish**
8. Enter your Canvas credentials when prompted

#### Troubleshooting Windows

If you encounter SSL/TLS errors with HTTPS, you may need to configure Windows to allow basic authentication over HTTPS:

1. Open Registry Editor (`regedit`)
2. Navigate to: `HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\WebClient\Parameters`
3. Set `BasicAuthLevel` to `2` (allows basic auth over SSL)
4. Restart the WebClient service: `net stop webclient && net start webclient`

### macOS

#### Using Finder

1. Open **Finder**
2. Press `⌘K` or select **Go** → **Connect to Server**
3. Enter server address: `http://localhost:3334/webdav/workspace-name/home`
4. Click **Connect**
5. Select **Registered User** for authentication
6. **Name:** Your email or username
7. **Password:** Your Canvas JWT or API token
8. Click **Connect**

The workspace will be mounted and appear in Finder's sidebar.

#### Using Command Line

```bash
# Create mount point
mkdir -p ~/Volumes/canvas-workspace

# Mount the WebDAV share
mount_webdav -S http://localhost:3334/webdav/workspace-name/home ~/Volumes/canvas-workspace
```

When prompted, enter your credentials (username = any, password = token).

### Linux

#### Method 1: Using davfs2 (Recommended)

1. **Install davfs2:**

   ```bash
   # Debian/Ubuntu
   sudo apt-get install davfs2
   
   # Fedora/RHEL
   sudo dnf install davfs2
   
   # Arch Linux
   sudo pacman -S davfs2
   ```

2. **Add your user to the davfs2 group:**

   ```bash
   sudo usermod -a -G davfs2 $USER
   ```

   Log out and back in for the group change to take effect.

3. **Create mount point:**

   ```bash
   mkdir -p ~/canvas/workspace-name
   ```

4. **Add credentials to secrets file:**

   ```bash
   # Edit ~/.davfs2/secrets (create directory if needed)
   mkdir -p ~/.davfs2
   echo "http://localhost:3334/webdav/workspace-name/home your-email your-jwt-token" >> ~/.davfs2/secrets
   chmod 600 ~/.davfs2/secrets
   ```

5. **Mount the WebDAV share:**

   ```bash
   mount.davfs http://localhost:3334/webdav/workspace-name/home ~/canvas/workspace-name
   ```

6. **Auto-mount at startup (optional):**

   Add to `/etc/fstab`:
   ```
   http://localhost:3334/webdav/workspace-name/home /home/username/canvas/workspace-name davfs user,noauto,uid=username 0 0
   ```

#### Method 2: Using GNOME Files (Nautilus)

1. Open **Files** (Nautilus)
2. Press `Ctrl+L` to show location bar
3. Enter: `dav://localhost:3334/webdav/workspace-name/home`
4. Enter credentials when prompted
5. The share will be mounted and accessible in the sidebar

#### Method 3: Using KDE Dolphin

1. Open **Dolphin** file manager
2. Enter in location bar: `webdav://localhost:3334/webdav/workspace-name/home`
3. Enter credentials when prompted

## Obtaining Your Authentication Token

### JWT Token (Session Token)

1. Log in to Canvas Server via the web interface
2. Open browser developer tools (F12)
3. Go to **Application** → **Local Storage** → Your Canvas domain
4. Find the key `canvas-auth-token` or similar
5. Copy the token value

### API Token (Permanent)

1. Log in to Canvas Server
2. Navigate to **Settings** → **API Tokens**
3. Click **Create New Token**
4. Give it a descriptive name (e.g., "WebDAV Access")
5. Copy the generated token (starts with `canvas-`)

**Note:** API tokens are more suitable for WebDAV access as they don't expire with your session.

## Supported Operations

Canvas WebDAV server supports Class 2 WebDAV, which includes:

- **Read:** Browse directories, download files
- **Write:** Upload files, create directories
- **Delete:** Remove files and directories
- **Move/Rename:** Move or rename files and directories
- **Copy:** Copy files and directories
- **Lock/Unlock:** File locking for collaborative editing (Microsoft Office compatibility)

## File Locking

File locking is enabled by default with a 1-hour timeout. This ensures:

- Microsoft Office documents can be opened and edited safely
- Multiple users don't overwrite each other's changes
- Locks are automatically released after 1 hour of inactivity

## Permissions

WebDAV access respects Canvas workspace permissions:

- **Workspace Owner:** Full read/write access
- **Users with Read Permission:** Can browse and download files
- **Users with Write Permission:** Can upload, modify, and delete files
- **No Permission:** Access denied

## Performance Tips

1. **Use API Tokens:** They're more efficient than JWT tokens for long-running connections
2. **Keep Connections Alive:** WebDAV clients typically maintain persistent connections
3. **Avoid Large Files:** For files > 100MB, consider using the REST API upload endpoint instead
4. **Local Caching:** Most WebDAV clients cache files locally for better performance

## Troubleshooting

### "401 Unauthorized" Error

- Verify your token is valid and not expired
- Ensure you're using the correct authentication format
- Check that you have access to the requested workspace

### "403 Forbidden" Error

- You don't have permission to access this workspace
- Contact the workspace owner to grant you access

### "404 Not Found" Error

- Verify the workspace name is correct
- Ensure the workspace exists and has a `/home` directory
- Check the connection URL format

### Connection Timeout

- Verify Canvas Server is running and accessible
- Check firewall rules allow connections on the Canvas port
- Try using the IP address instead of hostname

### Slow Performance

- Check network latency between client and server
- Consider mounting with read-only mode if you only need to browse files
- Use wired connection instead of Wi-Fi for large file operations

### SSL/TLS Certificate Errors (HTTPS)

- For self-signed certificates, you may need to add them to your system's trust store
- On Windows, see troubleshooting section above for BasicAuthLevel registry setting
- Consider using HTTP for local/development environments

## Security Considerations

### Production Deployments

1. **Use HTTPS:** Always use HTTPS in production to encrypt credentials and data
2. **Rotate Tokens:** Regularly rotate API tokens used for WebDAV access
3. **Limit Permissions:** Grant minimum necessary permissions to users
4. **Monitor Access:** Review WebDAV access logs for suspicious activity
5. **Use API Tokens:** Prefer API tokens over JWT session tokens

### Development/Local Access

- HTTP is acceptable for `localhost` or local network access
- Still use strong tokens even in development
- Don't commit tokens to version control

## Examples

### Mounting Multiple Workspaces

You can mount multiple workspaces simultaneously:

**Windows:**
```cmd
net use W: http://localhost:3334/webdav/workspace1/home /user:user
net use X: http://localhost:3334/webdav/workspace2/home /user:user
```

**macOS/Linux:**
```bash
mount_webdav http://localhost:3334/webdav/workspace1/home ~/canvas/workspace1
mount_webdav http://localhost:3334/webdav/workspace2/home ~/canvas/workspace2
```

### Scripting WebDAV Operations

You can use tools like `curl` or `cadaver` to script WebDAV operations:

```bash
# List directory contents
curl -X PROPFIND \
  -H "Authorization: Bearer your-token" \
  http://localhost:3334/webdav/workspace-name/home/

# Upload a file
curl -T myfile.txt \
  -H "Authorization: Bearer your-token" \
  http://localhost:3334/webdav/workspace-name/home/myfile.txt

# Download a file
curl -o myfile.txt \
  -H "Authorization: Bearer your-token" \
  http://localhost:3334/webdav/workspace-name/home/myfile.txt
```

## Additional Resources

- [WebDAV Protocol (RFC 4918)](https://tools.ietf.org/html/rfc4918)
- [Canvas Server API Documentation](./api-documentation.md)
- [Workspace Management Guide](./workspace-management.md)

## Support

If you encounter issues not covered in this guide:

1. Check Canvas Server logs for error messages
2. Enable debug mode: `DEBUG=webdav:* npm start`
3. Report issues on the Canvas Server GitHub repository
4. Contact your Canvas Server administrator

