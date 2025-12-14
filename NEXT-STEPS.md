# Next Steps - Canvas Roles & SSH Access

## Implementation Complete! ✅

All canvas-role infrastructure and canvas-sshd MVP have been implemented as specified.

## Quick Start (5 minutes)

### 1. Build the SSHD Docker Image

```bash
cd extensions/roles/docker.canvas-sshd
./build.sh
```

Expected output:
```
Building Canvas SSHD Docker image...
Image: canvas/sshd:latest
...
Build complete!
```

### 2. Start Canvas Server

```bash
# From project root
npm start
# or
node src/init.js
```

The server will:
- Load global roles from `./server/config/roles.json`
- Auto-start any roles listed in the `autoStart` array

### 3. Get Your Admin Token

Look for this in the server startup logs:
```
Admin API Token: canvas_xxxxxxxxxxxxxxxxxxxxx
```

Export it:
```bash
export CANVAS_ADMIN_TOKEN="canvas_xxxxxxxxxxxxxxxxxxxxx"
```

### 4. Create a Test User and Add SSH Key

```bash
# Generate SSH key
ssh-keygen -t ed25519 -f ~/.ssh/canvas-test -N ""

# Create user
USER_RESPONSE=$(curl -s -X POST http://localhost:8001/api/admin/users \
  -H "Authorization: Bearer $CANVAS_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test User",
    "email": "test@canvas.local",
    "userType": "user",
    "status": "active"
  }')

# Extract user ID
USER_ID=$(echo $USER_RESPONSE | jq -r '.data.user.id')
echo "User ID: $USER_ID"

# Add SSH key
curl -X POST http://localhost:8001/api/admin/users/$USER_ID/ssh-keys \
  -H "Authorization: Bearer $CANVAS_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"$(cat ~/.ssh/canvas-test.pub)\",\"name\":\"Test Key\"}"
```

### 5. Start the SSHD Role

Option A - Via API (manual start):
```bash
# Create role
ROLE_RESPONSE=$(curl -s -X POST http://localhost:8001/api/roles \
  -H "Authorization: Bearer $CANVAS_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "template": "docker.canvas-sshd",
    "name": "canvas-sshd",
    "type": "global"
  }')

ROLE_ID=$(echo $ROLE_RESPONSE | jq -r '.role.id')
echo "Role ID: $ROLE_ID"

# Start role
curl -X POST http://localhost:8001/api/roles/$ROLE_ID/start \
  -H "Authorization: Bearer $CANVAS_ADMIN_TOKEN"
```

Option B - Via Config (auto-start on server boot):
```bash
# Edit server/config/roles.json
# Add the role manually, then restart server
```

### 6. Connect via SSH/SFTP

```bash
# SFTP connection
sftp -i ~/.ssh/canvas-test -P 22222 \
  -o StrictHostKeyChecking=no \
  test@canvas.local@localhost

# Once connected, you can use SFTP commands:
sftp> ls
sftp> put file.txt
sftp> get file.txt
sftp> exit

# Or use SCP
echo "Hello Canvas!" > test.txt
scp -i ~/.ssh/canvas-test -P 22222 test.txt test@canvas.local@localhost:/

# Or use rsync
rsync -avz -e "ssh -i ~/.ssh/canvas-test -p 22222" \
  ./local-dir/ test@canvas.local@localhost:/remote-dir/
```

## Run Automated Tests

```bash
cd tests
export CANVAS_ADMIN_TOKEN="your-token"
./test-canvas-sshd.js
```

## Verify Everything Works

### Check Role Status

```bash
# List all roles
curl -H "Authorization: Bearer $CANVAS_ADMIN_TOKEN" \
  http://localhost:8001/api/roles

# Check specific role
curl -H "Authorization: Bearer $CANVAS_ADMIN_TOKEN" \
  http://localhost:8001/api/roles/$ROLE_ID

# View logs
curl -H "Authorization: Bearer $CANVAS_ADMIN_TOKEN" \
  "http://localhost:8001/api/roles/$ROLE_ID/logs?tail=50"
```

### Check SSH Keys

```bash
# List user's SSH keys
curl -H "Authorization: Bearer $CANVAS_ADMIN_TOKEN" \
  http://localhost:8001/api/admin/users/$USER_ID/ssh-keys
```

### Check Docker Container

```bash
# List containers
docker ps | grep canvas-sshd

# View container logs
docker logs canvas-role-canvas-sshd-$ROLE_ID

# Enter container for debugging
docker exec -it canvas-role-canvas-sshd-$ROLE_ID /bin/bash

# Check provisioned users
docker exec canvas-role-canvas-sshd-$ROLE_ID cat /etc/passwd

# Check authorized_keys
docker exec canvas-role-canvas-sshd-$ROLE_ID cat /users/test@canvas.local/.ssh/authorized_keys
```

## Troubleshooting

### "Connection refused"

```bash
# Check if role is running
curl -H "Authorization: Bearer $CANVAS_ADMIN_TOKEN" \
  http://localhost:8001/api/roles/$ROLE_ID

# Check Docker container
docker ps -a | grep canvas-sshd

# Check container logs
docker logs canvas-role-canvas-sshd-$ROLE_ID

# Check if port is in use
netstat -tlnp | grep 22222
```

### "Permission denied (publickey)"

```bash
# Verify SSH key is added
curl -H "Authorization: Bearer $CANVAS_ADMIN_TOKEN" \
  http://localhost:8001/api/admin/users/$USER_ID/ssh-keys

# Check authorized_keys in container
docker exec canvas-role-canvas-sshd-$ROLE_ID \
  cat /users/test@canvas.local/.ssh/authorized_keys

# Test with verbose SSH
ssh -vvv -i ~/.ssh/canvas-test -p 22222 test@canvas.local@localhost
```

### "User not found" or "System user creation failed"

```bash
# Check user directory exists
ls -la ./server/users/

# Check container logs for provisioning errors
docker logs canvas-role-canvas-sshd-$ROLE_ID | grep -i error

# Manually trigger user provisioning (restart container)
curl -X POST http://localhost:8001/api/roles/$ROLE_ID/restart \
  -H "Authorization: Bearer $CANVAS_ADMIN_TOKEN"
```

## Production Deployment

### 1. Change Default Port

Edit `extensions/roles/docker.canvas-sshd/role.json`:
```json
{
  "container": {
    "ports": {
      "2222": "22"  // Change from 22222
    }
  }
}
```

### 2. Set Up Auto-Start

Edit `./server/config/roles.json`:
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

### 3. Configure Firewall

```bash
# Open SSH port (example for UFW)
sudo ufw allow 22222/tcp
sudo ufw reload
```

### 4. Set Up Monitoring

```bash
# Add to your monitoring system
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:8001/api/roles/$ROLE_ID/health
```

## Documentation

- **Quick Reference**: [extensions/roles/docker.canvas-sshd/README.md](extensions/roles/docker.canvas-sshd/README.md)
- **Complete Guide**: [docs/CANVAS-ROLES-SETUP.md](docs/CANVAS-ROLES-SETUP.md)
- **Implementation Details**: [IMPLEMENTATION-SUMMARY.md](IMPLEMENTATION-SUMMARY.md)

## What's Been Implemented

✅ Global role infrastructure with persistent config  
✅ Auto-start support for global roles  
✅ Canvas-SSHD role template (Alpine + OpenSSH)  
✅ Chroot isolation per user  
✅ SSH key management API (CRUD)  
✅ Filesystem integration (authorized_keys)  
✅ Integration tests  
✅ Comprehensive documentation  

## Future Enhancements

The foundation is now in place for:
- SSH Certificate Authority (short-lived certs)
- Audit logging integration
- Web-based SFTP client
- Git over SSH support
- Bandwidth throttling
- Session recording
- 2FA support

Ready to go! 🚀
