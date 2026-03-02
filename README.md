# Canvas Server

Server runtime for the Canvas project.

Data from all sources is indexed and abstracted away from its physical location. Users construct virtual context or directory trees on top of that data. Storage backends (local, NAS, S3) are managed transparently — writes hit local cache first, then sync to backends based on rules.

## Install & Run

```bash
git clone https://github.com/canvas-ai/canvas-server /path/to/canvas-server
cd /path/to/canvas-server
npm run update-submodules
npm install
npm run dev
```

## Docker

```bash
git clone https://github.com/canvas-ai/canvas-server /path/to/canvas-server
cd /path/to/canvas-server
CANVAS_SERVER_HOME=~/.canvas docker-compose up --build
```

## Environment

```bash
NODE_ENV=production
LOG_LEVEL=info
CANVAS_SERVER_HOME=/opt/canvas-server/server
CANVAS_USER_HOME=/opt/canvas-server/users
CANVAS_ADMIN_EMAIL=admin@canvas.local
CANVAS_ADMIN_PASSWORD=          # required on first run
CANVAS_ADMIN_RESET=false
CANVAS_API_PORT=8001
CANVAS_API_HOST=0.0.0.0
CANVAS_JWT_SECRET=              # auto-generated if empty
CANVAS_JWT_TOKEN_EXPIRY=7d
```

## Architecture

```
Transports:   REST (/rest/v2)  ·  WebSocket (socket.io)  ·  WebDAV (/dav)
Core:         Users  ·  Workspaces  ·  Contexts  ·  Roles  ·  Agents
Storage:      StoreD (cache-first blob storage, multi-backend)
Index:        SynapsD (LMDB + roaring bitmaps, context/directory trees)
```

Each workspace owns a StoreD instance. The home directory is just a file backend (`{ driver: 'file', root: './home', watch: true }`). Future backends (S3, SMB) sync via background worker threads.

## REST + Websocket transports

- [API Documentation](docs/API.md)

## WebDAV

Workspace data is exposed via WebDAV with three virtual root directories:

```
/workspaces/:workspace/dav/
├── Home/          → raw filesystem (workspace home dir, read/write)
├── Context/       → ContextTree (AND-semantic layer intersections, read-only)
└── Directories/   → DirectoryTree (traditional VFS paths, read-only)
```

- **Home/** — the workspace's local home directory, full read/write. Files dropped here are auto-indexed into SynapsD.
- **Context/** — the virtual context tree. Documents appear as files at their context intersections. Read-only.
- **Directories/** — traditional directory-based VFS. Documents organized by path. Read-only.

### Mounting

```bash
# URL format
http(s)://<host>:<port>/workspaces/<workspace>/dav

# Linux (davfs2)
sudo mount.davfs http://localhost:8001/workspaces/universe/dav ~/canvas
# or in /etc/fstab:
# http://localhost:8001/workspaces/universe/dav /home/user/canvas davfs user,noauto 0 0

# macOS (Finder: Go → Connect to Server, or)
mount_webdav -S http://localhost:8001/workspaces/universe/dav ~/canvas

# Windows (Explorer: Map Network Drive, or)
net use Z: http://localhost:8001/workspaces/universe/dav /user:your@email.com
```

Authenticate with your email + password, or use an API token as the password (username is ignored for token auth).

### Rclone mounts (recommended)

```bash
# Create your your root dirs (Contexts will be merged under Workspaces soon)
mkdir ~/Workspaces ~/Contexts 

# Create two separate service templates for Workspace and Context mounts
# Context mounts are somewhat specific, hence need a different cfg

$ nano ~/.config/systemd/user/rclone-context@.service
[Unit]
Description=rclone: Remote Canvas Context mount %i
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/rclone mount %i: %h/Contexts/%i \
  --vfs-cache-mode off \
  --dir-cache-time 0 \
  --no-modtime \
  --no-checksum \
  --create-empty-dirs \
  --config %h/.config/rclone/rclone-contexts.conf
ExecStop=/usr/bin/fusermount -u %h/Contexts/%i
Restart=on-failure

[Install]
WantedBy=default.target


$ nano ~/.config/systemd/user/rclone-workspace@.service
[Unit]
Description=rclone: Remote Canvas Workspace mount %i
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/rclone mount %i: %h/Workspaces/%i \
  --vfs-cache-mode full \
  --vfs-cache-max-size 30G \
  --create-empty-dirs \
  --config %h/.config/rclone/rclone-workspaces.conf
ExecStop=/usr/bin/fusermount -u %h/Workspaces/%i
Restart=on-failure

[Install]
WantedBy=default.target


$ nano ~/.config/rclone/rclone-contexts.conf
[Universe]
type = webdav
url = https://canvas.mydomain.tld/contexts/universe/dav
vendor = other
user = myuser
pass = rclone-encrypted-password

$ nano ~/.config/rclone/rclone-workspaces.conf
[Universe]
type = webdav
url = https://canvas.mydomain.tld/workspaces/universe/dav
vendor = other
user = myuser
pass = rclone-encrypted-password

# Activate both mounts
$ systemctl --user daemon-reload
$ systemctl --user enable --now rclone-workspace@Universe
$ systemctl --user enable --now rclone-context@Universe
```

## Authentication

- **JWT tokens** — web UI sessions
- **API tokens** (`canvas-*` prefix) — CLI, Electron, browser extensions, programmatic access
- **Workspace tokens** (`canvas-workspace-*`) — scoped to a single workspace

## Roles

Dockerized services extending Canvas functionality:

- **Global roles** — server-wide (SSH daemon, MinIO S3, etc.)
- **Workspace roles** — user-scoped (dev environments, AI agents)

Configure in `./server/config/roles.json` or via REST API / Web UI.

## Update

```bash
cd /path/to/canvas-server
npm run stop
rm -rf ./node_modules
git pull origin main
npm run update-submodules
npm install
npm start
```

---
This project is funded by [Augmentd Labs](https://augmentd.eu/en/labs)
