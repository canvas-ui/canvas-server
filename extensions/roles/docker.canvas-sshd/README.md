# Canvas SSHD Role

Secure SSH/SFTP access to Canvas user home directories with automatic chroot isolation.

## Features

- **Chroot Isolation**: Each user is automatically chrooted to their own directory
- **Public Key Authentication Only**: No password authentication for enhanced security
- **SFTP Support**: Built-in SFTP using OpenSSH's internal-sftp subsystem
- **Automatic User Provisioning**: Scans Canvas users and creates system users on startup
- **Minimal Footprint**: Alpine Linux base (~50MB image)

## Security Model

### Authentication
- Only public key authentication is allowed
- Users manage SSH keys via Canvas API
- Keys stored in `./server/users/user@email.tld/.ssh/authorized_keys`

### Isolation
- Each user is chrooted to `/users/user@email.tld/`
- Users can only access their own files
- No shell access - SFTP only (internal-sftp)
- No TCP forwarding or tunneling

### Container Security
- Runs as root in container (required for chroot)
- Chrooted users are unprivileged
- Host network mode for direct port binding
- No unnecessary capabilities

## Usage

### Building the Image

```bash
cd extensions/roles/docker.canvas-sshd
./build.sh
```

### Creating the Role

Via Canvas API:
```bash
curl -X POST http://localhost:8001/api/roles \
  -H "Content-Type: application/json" \
  -d '{
    "template": "docker.canvas-sshd",
    "name": "canvas-sshd",
    "type": "global"
  }'
```

Or add to `server/config/roles.json`:
```json
{
  "global": [
    {
      "id": "canvas-sshd",
      "name": "Canvas SSH Daemon",
      "template": "docker.canvas-sshd",
      "type": "global",
      "status": "created"
    }
  ],
  "autoStart": ["canvas-sshd"]
}
```

### Connecting via SSH/SFTP

**SSH (SFTP only):**
```bash
sftp -P 22222 user@email.tld@your-server-host
```

**SCP:**
```bash
scp -P 22222 file.txt user@email.tld@your-server-host:/
```

**rsync:**
```bash
rsync -avz -e "ssh -p 22222" ./local-dir/ user@email.tld@your-server-host:/remote-dir/
```

## Configuration

### Port Mapping

Default port is 22222 (host) → 22 (container). Change in `role.json`:
```json
{
  "container": {
    "ports": {
      "2222": "22"
    }
  }
}
```

### Environment Variables

- `CANVAS_USERS_PATH`: Path to users directory (default: `/users`)
- `SSH_PORT`: SSH port inside container (default: `22`)
- `LOG_LEVEL`: Log verbosity (default: `INFO`)

## User Setup

### Adding SSH Keys

Users must add their SSH public keys via Canvas API:

```bash
# Add SSH key
curl -X POST http://localhost:8001/api/users/{userId}/ssh-keys \
  -H "Content-Type: application/json" \
  -d '{
    "key": "ssh-rsa AAAAB3NzaC1yc2EAAA... user@host"
  }'

# List keys
curl http://localhost:8001/api/users/{userId}/ssh-keys

# Remove key
curl -X DELETE http://localhost:8001/api/users/{userId}/ssh-keys/{keyId}
```

Keys are automatically written to `./server/users/user@email.tld/.ssh/authorized_keys`.

### Chroot Structure

Each user directory requires this structure (auto-created by entrypoint):
```
/users/user@email.tld/
├── dev/
│   └── null          # Required device node
├── tmp/              # Temp directory (1777)
├── .ssh/             # SSH keys (700)
│   └── authorized_keys (600)
└── [user files]      # User's actual files
```

## Troubleshooting

### Check container logs
```bash
docker logs canvas-role-canvas-sshd-{roleId}
```

### Test SSH connection
```bash
ssh -vvv -p 22222 user@email.tld@localhost
```

### Verify user provisioning
```bash
docker exec canvas-role-canvas-sshd-{roleId} cat /etc/passwd
```

### Check authorized_keys
```bash
docker exec canvas-role-canvas-sshd-{roleId} cat /users/user@email.tld/.ssh/authorized_keys
```

## Known Limitations

- No shell access (SFTP/SCP only)
- Email addresses with special characters may not work properly
- Container must run as root (required for chroot)

## Future Enhancements

- SSH Certificate Authority for short-lived certs
- Audit logging integration with Canvas
- Bandwidth throttling
- Git over SSH support
- Web-based SFTP client in Canvas UI
