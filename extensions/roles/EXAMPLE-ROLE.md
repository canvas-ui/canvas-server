# Canvas Roles Setup

Complete documentation for Canvas role system with canvas-sshd MVP implementation.

## Overview

Canvas roles are dockerized services that extend Canvas functionality. There are two types:

- **Global Roles**: Server-wide services managed by Canvas admin (e.g., SSH daemon, MinIO)
- **Workspace Roles**: User-scoped services tied to workspaces (e.g., dev environments, agents)

## Architecture

```
Canvas Server
├── Core Services
│   ├── Users
│   ├── Workspaces (Universe = user home)
│   └── Roles (Docker-based services)
├── Role Manager
│   ├── Global Role Config (./server/config/roles.json)
│   ├── Docker Integration
│   ├── Volume Mapping
│   └── Security Policies
└── Extensions
    └── roles/
        ├── docker.canvas-sshd/     ← Global role
        ├── docker.minio/            ← Global role
        └── docker.llm-agent/        ← Workspace role
```

## Global Roles Configuration

Global roles are persisted in `./server/config/roles.json`:

```json
{
  "global": [
    {
      "id": "canvas-sshd",
      "name": "Canvas SSH Daemon",
      "template": "docker.canvas-sshd",
      "type": "global",
      "status": "running",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ],
  "autoStart": ["canvas-sshd"]
}
```

Roles listed in `autoStart` will start automatically when Canvas server initializes.

## Canvas SSHD Role

The MVP global role providing secure SSH/SFTP access to user home directories.

### Features

- **Chroot Isolation**: Each user chrooted to `/users/user@email.tld/`
- **Public Key Auth Only**: No password authentication
- **SFTP Support**: Built-in via OpenSSH internal-sftp
- **Auto-provisioning**: Scans and provisions users on startup
- **Minimal Image**: Alpine Linux (~50MB)

### Quick Start

#### 1. Build Docker Image

```bash
cd extensions/roles/docker.canvas-sshd
./build.sh
```

#### 2. Add SSH Key for User

```bash
# Generate key pair
ssh-keygen -t ed25519 -f ~/.ssh/canvas-key -N ""

# Add via API
curl -X POST http://localhost:8001/api/admin/users/{userId}/ssh-keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"$(cat ~/.ssh/canvas-key.pub)\",\"name\":\"My Key\"}"
```

#### 3. Create and Start Role

Via API:
```bash
# Create role
curl -X POST http://localhost:8001/api/roles \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "template": "docker.canvas-sshd",
    "name": "canvas-sshd",
    "type": "global"
  }'

# Start role (get roleId from previous response)
curl -X POST http://localhost:8001/api/roles/{roleId}/start \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Or add to `./server/config/roles.json` for auto-start (see above).

#### 4. Connect via SSH

```bash
# SFTP
sftp -P 22222 user@email.tld@your-server

# SCP
scp -P 22222 file.txt user@email.tld@your-server:/

# rsync
rsync -avz -e "ssh -p 22222" ./local/ user@email.tld@your-server:/remote/
```

### Security Model

**Container Security:**
- Runs as root (required for chroot)
- Host network mode (direct port binding)
- No unnecessary Linux capabilities
- Users inside chroot are unprivileged

**SSH Security:**
- Public key authentication only
- No password authentication
- No shell access (SFTP only)
- No TCP forwarding or tunneling
- Per-user chroot isolation

**File Permissions:**
```
/users/user@email.tld/
├── dev/null          # Required device (root:root)
├── tmp/              # Temp dir (1777)
├── .ssh/             # SSH keys (700, user:user)
│   └── authorized_keys (600, user:user)
└── [user files]      # User's files (user:user)
```

## SSH Key Management API

### List Keys

```bash
GET /api/admin/users/{userId}/ssh-keys
```

Response:
```json
{
  "success": true,
  "data": {
    "keys": [
      {
        "id": "abc123xyz",
        "name": "My Laptop Key",
        "type": "ssh-ed25519",
        "fingerprint": "SHA256:...",
        "md5Fingerprint": "aa:bb:cc:...",
        "addedAt": "2024-01-01T00:00:00.000Z",
        "lastUsed": null
      }
    ],
    "total": 1
  }
}
```

### Add Key

```bash
POST /api/admin/users/{userId}/ssh-keys
Content-Type: application/json

{
  "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5... user@host",
  "name": "My Key"
}
```

### Remove Key

```bash
DELETE /api/admin/users/{userId}/ssh-keys/{keyId}
```

## Role Manager API

### List Roles

```bash
GET /api/roles?type=global
GET /api/roles?type=workspace&workspaceId={id}
```

### Create Role

```bash
POST /api/roles
Content-Type: application/json

{
  "template": "docker.canvas-sshd",
  "name": "canvas-sshd",
  "type": "global"
}
```

### Role Lifecycle

```bash
POST /api/roles/{roleId}/start
POST /api/roles/{roleId}/stop
POST /api/roles/{roleId}/restart
DELETE /api/roles/{roleId}
```

### Role Information

```bash
GET /api/roles/{roleId}
GET /api/roles/{roleId}/logs?tail=100
GET /api/roles/{roleId}/stats
GET /api/roles/{roleId}/health
```

## Creating Custom Roles

### Directory Structure

```
extensions/roles/my-custom-role/
├── role.json         # Role definition
├── Dockerfile        # Container build
├── entrypoint.sh     # Startup script (optional)
├── build.sh          # Build helper
└── README.md         # Documentation
```

### Role Template (role.json)

```json
{
  "id": "my-custom-role",
  "name": "My Custom Role",
  "description": "Description of what this role does",
  "version": "1.0.0",
  "type": "global",
  "category": "category-name",
  "tags": ["tag1", "tag2"],
  
  "container": {
    "image": "canvas/my-role:latest",
    "ports": {
      "8080": "80"
    },
    "healthcheck": {
      "test": ["CMD", "curl", "-f", "http://localhost/health"],
      "interval": "30s",
      "timeout": "5s",
      "retries": 3
    },
    "restart": "unless-stopped"
  },
  
  "volumes": [
    {
      "host": "server:/data/my-role",
      "container": "/data",
      "mode": "rw"
    }
  ],
  
  "environment": {
    "MY_ENV_VAR": "value"
  },
  
  "lifecycle": {
    "autoStart": true,
    "dependencies": []
  },
  
  "resources": {
    "cpu": "0.5",
    "memory": "512Mi"
  }
}
```

### Volume Path Prefixes

- `server:/path` - Server data directory (global roles)
- `workspace:/path` - Workspace root (workspace roles)
- `role:/path` - Role-specific data directory
- `socket:/path` - Unix socket directory
- `/absolute/path` - Absolute host path (restricted)

### Build and Deploy

```bash
# 1. Build image
cd extensions/roles/my-custom-role
docker build -t canvas/my-role:latest .

# 2. Test locally
docker run --rm -p 8080:80 canvas/my-role:latest

# 3. Create via API
curl -X POST http://localhost:8001/api/roles \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{
    "template": "my-custom-role",
    "name": "my-role-instance",
    "type": "global"
  }'
```

## Testing

### Automated Test

```bash
# Set admin token
export CANVAS_ADMIN_TOKEN="your-admin-token"

# Run test
cd tests
./test-canvas-sshd.js
```

### Manual Test

```bash
# Follow interactive test steps
cd tests
./test-canvas-sshd-simple.sh
```

## Troubleshooting

### Canvas SSHD

**Check container status:**
```bash
docker ps | grep canvas-sshd
docker logs canvas-role-canvas-sshd-{roleId}
```

**Verify user provisioning:**
```bash
docker exec canvas-role-canvas-sshd-{roleId} cat /etc/passwd
```

**Check authorized_keys:**
```bash
docker exec canvas-role-canvas-sshd-{roleId} cat /users/user@email.tld/.ssh/authorized_keys
```

**Test SSH with verbose output:**
```bash
ssh -vvv -p 22222 user@email.tld@localhost
```

**Common issues:**

1. **"Permission denied (publickey)"**
   - Verify SSH key is added via API
   - Check authorized_keys file exists and has correct permissions
   - Ensure username matches email address exactly

2. **"Connection refused"**
   - Verify role is running: `GET /api/roles/{roleId}`
   - Check Docker container is up: `docker ps`
   - Verify port 22222 is not in use: `netstat -tlnp | grep 22222`

3. **"Chroot error"**
   - Check user directory permissions (755, owned by root)
   - Verify dev/null exists in chroot
   - Check sshd container logs for details

### Role Manager

**List all roles:**
```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:8001/api/roles
```

**Check role logs:**
```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:8001/api/roles/{roleId}/logs?tail=100"
```

**View Docker state:**
```bash
docker ps -a | grep canvas-role
docker inspect canvas-role-{name}-{id}
```

## Development

### Hot Reload Changes

For role template changes:
```bash
# Edit role.json
vim extensions/roles/docker.canvas-sshd/role.json

# Restart role via API
curl -X POST http://localhost:8001/api/roles/{roleId}/restart \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

For container code changes:
```bash
# Rebuild image
cd extensions/roles/docker.canvas-sshd
./build.sh

# Stop old container
curl -X POST http://localhost:8001/api/roles/{roleId}/stop \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Remove old container
docker rm canvas-role-canvas-sshd-{roleId}

# Start fresh
curl -X POST http://localhost:8001/api/roles/{roleId}/start \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Debugging Containers

```bash
# Enter running container
docker exec -it canvas-role-canvas-sshd-{roleId} /bin/bash

# Check logs in real-time
docker logs -f canvas-role-canvas-sshd-{roleId}

# Inspect container config
docker inspect canvas-role-canvas-sshd-{roleId}
```

## Production Considerations

### Security

1. **Change default SSH port** from 22222 to something less obvious
2. **Use SSH Certificate Authority** instead of individual keys (future enhancement)
3. **Enable audit logging** for all SSH connections
4. **Implement rate limiting** on SSH authentication attempts
5. **Regular key rotation** policy for users

### Performance

1. **Resource limits**: Adjust CPU/memory limits in role.json
2. **Connection limits**: Configure MaxSessions in sshd_config
3. **Bandwidth throttling**: Add QoS rules if needed

### Monitoring

1. **Health checks**: Monitor role health via `/api/roles/{roleId}/health`
2. **Metrics**: Collect container stats via `/api/roles/{roleId}/stats`
3. **Logging**: Forward container logs to centralized logging system
4. **Alerts**: Set up alerts for role failures

### Backup

1. **SSH keys**: Backed up in Canvas database (./server/db)
2. **User files**: Regular backup of ./server/users/
3. **Role configs**: Version control ./server/config/roles.json

## Future Enhancements

1. **SSH Certificate Authority** - Short-lived certs instead of long-lived keys
2. **Audit Logging** - Log all SSH connections to Canvas event stream
3. **Bandwidth Throttling** - QoS for file transfers
4. **Web SFTP Client** - Browser-based file manager in Canvas UI
5. **Git over SSH** - Allow `git clone ssh://user@host:22222/repo.git`
6. **2FA Support** - Two-factor authentication for SSH connections
7. **Session Recording** - Record and replay SSH sessions
8. **IP Whitelisting** - Restrict SSH access by IP address

## References

- [OpenSSH Documentation](https://www.openssh.com/manual.html)
- [Docker Security Best Practices](https://docs.docker.com/engine/security/)
- [Canvas Role API](./API.md#roles)
- [SSH Key Management Guide](./ssh-key-management.md)
