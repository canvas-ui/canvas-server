# There are many productivity tools, but this one is ~~yours~~ mine

..and yes, it has [pi](https://pi.dev/) integrated  
   **Thank you for your contribution to the Universe!**

## Canvas Server
Server runtime for the Canvas project.


Canvas comes with [pi](https://pi.dev/) integrated ...for now at least ;)

Data from all sources is indexed and abstracted away from its physical location. Users construct virtual context or directory trees on top of that data. Storage backends (local, NAS, S3) are managed transparently - writes hit local cache first, then sync to backends based on rules.

## Install & Run

```bash
git clone https://github.com/canvas-ui/canvas-server /path/to/canvas-server
cd /path/to/canvas-server
npm run update-submodules
npm install
npm run dev
```

## Docker

```bash
git clone https://github.com/canvas-ui/canvas-server /path/to/canvas-server
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

## Logs

Server logs are written to stdout and to:

```bash
$CANVAS_SERVER_HOME/log/canvas-server.log
```

Admin users can inspect logs in the web UI at:

```bash
/admin/logs
```

Admin API access:

```bash
# Tail recent log lines
GET /rest/v2/admin/logs?tail=200&level=info&module=auth

# Live stream logs
GET /rest/v2/admin/logs/stream?tail=200&level=info&module=auth
```

Both endpoints require admin authentication.

## Admin maintenance

Index-rebuild endpoints for when a workspace's search/feature indexes drift from
its documents — e.g. a corpus indexed before a given index existed, or a tail left
unindexed by the bounded backfill at startup. All require admin authentication and
run **in-process** (no database-lock conflict with the live server). `:workspace`
accepts a workspace id (UUID) or name.

```bash
# Rebuild full-text (Lance/BM25) index — backfills every document not yet indexed.
# Idempotent (already-indexed docs are skipped). Synchronous; FTS only.
POST /rest/v2/admin/workspaces/:workspace/reindex-search
# → { indexed, alreadyIndexed, totalDocs }

# Rebuild dense-vector embeddings — enqueues every embeddable document missing a
# vector. ASYNC: returns after enqueuing; the embedding queue drains off-thread
# (model inference per doc). Idempotent. Only schemas in semantic.embeddableSchemas
# are embedded (default notes; tabs/files are not). Track progress via getStats().
POST /rest/v2/admin/workspaces/:workspace/reindex-embeddings
# → { enqueued, totalEmbeddable, queued, embeddableSchemas }

# Rebuild feature/schema bitmaps from stored documents.
POST /rest/v2/admin/workspaces/:workspace/reindex-features
# → { indexed }
```

Example:

```bash
curl -X POST -H "Authorization: Bearer <admin-token>" \
  https://<host>:<port>/rest/v2/admin/workspaces/universe/reindex-search
```

Index rebuilds are deliberately **not** run automatically on server start (to keep
startup fast and predictable) — trigger them explicitly via these endpoints.

## WebDAV

Workspace data is exposed via WebDAV with three virtual root directories:

```
/workspaces/:workspace/dav/
├── Home/          → raw filesystem (workspace home dir, read/write)
├── Context/       → ContextTree (AND-semantic layer intersections, read-only)
└── Directories/   → DirectoryTree (traditional VFS paths, read-only)
```

- **Home/** - the workspace's local home directory, full read/write. Files dropped here are auto-indexed into SynapsD.
- **Context/** - the virtual context tree. Documents appear as files at their context intersections. Read-only.
- **Directories/** - traditional directory-based VFS. Documents organized by path. Read-only.

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
mkdir -p ~/Workspaces/{foo,bar,baz} ~/Contexts/{foo,bar,baz} 

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

Full configuration, examples, and troubleshooting: **[Authentication Guide](docs/auth.md)**

| Strategy | Description |
|----------|-------------|
| **Local** | Email/password accounts stored on the server |
| **IMAP** | Login with mail-server credentials; auto-creates users per configured domain |
| **LDAP / AD** | Directory bind (OpenLDAP, Active Directory); auto-creates users on first login |

Token types:

- **JWT tokens** - web UI sessions
- **API tokens** (`canvas-*` prefix) - CLI, Electron, browser extensions, programmatic access
- **Workspace tokens** (`canvas-workspace-*`) - scoped to a single workspace

LDAP/AD is available today via `strategies.ldap` in `server/config/auth.json` (uses the bundled `ldapjs` package). Active Directory is LDAP under the hood - point at your DC with `ldaps://` and an AD-specific search filter. See [LDAP / Active Directory](docs/auth.md#ldap--active-directory-authentication) in the auth guide.

## Roles

Dockerized services extending Canvas functionality:

- **Global roles** - server-wide (SSH daemon, MinIO S3, etc.)
- **Workspace roles** - user-scoped (dev environments, AI agents)

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
