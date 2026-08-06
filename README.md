<p align="center">
  <img src="https://raw.githubusercontent.com/canvas-ai/.github/main/banners/canvas-banner_1200x480.jpg" alt="Canvas" width="100%" />
</p>

# There are many productivity tools, but this one is ~~yours~~ mine

..and yes, it has [pi](https://pi.dev/) integrated(..for now)
   **Thank you for your contribution to the Universe!**

## Canvas Server
Server runtime for the Canvas project.

## (Temporary) Demo instance
https://demo.cnvs.ai/pub/c/v64cxh0i

Data from all sources is indexed and abstracted away from its physical location. Users construct virtual context or directory trees on top of that data. Storage backends (local, NAS, S3) are managed transparently - writes hit local cache first, then sync to backends based on rules.

## Requirements

- Node.js **20.18+** (22 LTS is what the container image runs) and npm
- git — the repo uses submodules, and each workspace keeps its hooks in a git repo
- Docker (optional) — only for the containerized install and for [roles](#roles)

## Install & Run

```bash
git clone https://github.com/canvas-ui/canvas-server /path/to/canvas-server
cd /path/to/canvas-server
npm run update-submodules      # pulls synapsd, stored, embedd, the web UI, …
npm install                    # also builds the web UI (postinstall)
npm start                      # or: npm run dev  (debug logging, NODE_ENV=development)
```

The server listens on **http://localhost:8001** — API, web UI and WebDAV share
the port. On the **first** start it creates the admin user and prints its
credentials once:

```
================================================================================
Canvas Admin User
================================================================================
Email: admin@canvas.local
Password: <generated>
API Token: canvas-…
================================================================================
```

Set `CANVAS_ADMIN_EMAIL` / `CANVAS_ADMIN_PASSWORD` before that first start to
choose them yourself; afterwards, `CANVAS_ADMIN_RESET=true` re-applies a changed
password on the next start. Credentials are also recoverable from the log
(`$CANVAS_SERVER_HOME/log/canvas-server.log`).

### Where your data lives

All server state lives under one root, `$CANVAS_SERVER_HOME` — config, the index
db, caches, and `users/<email>/` (the per-user homes). By default that is
`./server` inside the checkout. For a personal install, run it in **user mode**
to keep data out of the repo:

```bash
npm start -- --user            # → ~/.canvas/server (users in ~/.canvas/server/users)
```

Everything under `~/.canvas/` other than `server/` is reserved for the client
apps and their caches; the server never writes there.

Each user has three module roots — workspaces, roles and agents — which live
under that user and nowhere else:

```
$CANVAS_SERVER_HOME/users/you@example.com/{Workspaces,Roles,Agents}
```

One user is one subtree, which is what makes a per-user dataset, quota or uid
possible. A single user can relocate their own roots with
`PUT /rest/v2/users/me/paths`; relocating is not a move — existing workspaces
keep working where they are, and only discovery plus newly created workspaces
follow the new root.

`CANVAS_USER_WORKSPACES` / `_ROLES` / `_AGENTS` set a server-wide default for all
three (absolute, `~`-prefixed, or templated with `{USER_HOME}` / `{HOME}`). That
makes **every** user share one directory, so it only makes sense on a single-user
instance; leave them empty otherwise.

### Running it as a service

```bash
# systemd --user unit, adjust the paths
$ nano ~/.config/systemd/user/canvas-server.service
[Unit]
Description=Canvas Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/canvas-server
ExecStart=/usr/bin/env node ./src/init.js --user
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=default.target

$ systemctl --user daemon-reload
$ systemctl --user enable --now canvas-server
```

## Docker

```bash
git clone https://github.com/canvas-ui/canvas-server /path/to/canvas-server
cd /path/to/canvas-server
./scripts/install-docker.sh          # or: npm run docker:install
```

That asks for the admin account, the port and which folders to mount, writes
`.env`, builds the image (Debian-based; the first build pulls a few hundred MB of
prebuilt native binaries) and starts the container. `--yes` accepts every default,
`--no-build` writes `.env` only. Re-running it offers to keep your existing config.

The individual steps, if you would rather drive them yourself:

```bash
npm run docker:env      # write .env with your uid/gid + $HOME paths
npm run docker:build
npm run docker:up       # http://localhost:8001
npm run docker:logs     # admin password + API token, printed on first run
```

Either way `.env` is the whole configuration — the admin account and where each
mount points:

```bash
CANVAS_ADMIN_EMAIL=you@example.com
CANVAS_ADMIN_NAME=                    # empty → derived from the email
CANVAS_ADMIN_PASSWORD=                # empty → generated and printed once
CANVAS_ADMIN_RESET=false              # true → re-apply the password on next start

CANVAS_HOST_SERVER_HOME=$HOME/.canvas/server   # config/, db/, cache/, users/ — back this up
CANVAS_HOST_WORKSPACES=$HOME/Workspaces        # ─┐ mounted into the admin user's
CANVAS_HOST_ROLES=$HOME/Roles                  #  │ home, i.e. onto
CANVAS_HOST_AGENTS=$HOME/Agents                # ─┘ users/<email>/{Workspaces,…}

CANVAS_UID=1000                       # container runs as you, so mounts stay yours
CANVAS_GID=1000
```

The container runs as your uid:gid, so workspaces created inside it are ordinary
files you own. The module roots stay per-user
(`<serverHome>/users/<email>/{Workspaces,Roles,Agents}`) — your host folders are
mounted *onto* the admin user's, which is why a multi-user instance needs no
change: everyone else's modules simply live inside the server-home mount.

Both ends of every mount must exist before the first `up`, otherwise docker
creates them as root and the container user cannot write into them.
`docker:install` and `docker:env` take care of it; if you hand-edit the paths in
`.env`, `mkdir -p` them yourself.

Other one-liners: `docker:down`, `docker:restart`, `docker:shell`, `docker:config`.

## Environment

Every setting has a default; nothing below is required. Paths shown are the
container's — a bare-metal install defaults to `./server`, or `~/.canvas/server`
when started with `--user`. `CANVAS_USER_HOME` follows the server home
(`<serverHome>/users`) unless you set it explicitly.

```bash
NODE_ENV=production
LOG_LEVEL=info
CANVAS_SERVER_HOME=/opt/canvas-server/server
CANVAS_USER_HOME=/opt/canvas-server/server/users   # default: <serverHome>/users

# Per-user module roots. Empty → <userHome>/{Workspaces,Roles,Agents}, the
# per-user layout. Setting them makes every user share one directory — single
# user only. Absolute, ~-prefixed, or templated with {USER_HOME} / {HOME}.
# A user's own override (PUT /rest/v2/users/me/paths) wins over these.
CANVAS_USER_WORKSPACES=         # e.g. ~/Workspaces on a personal instance
CANVAS_USER_ROLES=
CANVAS_USER_AGENTS=

CANVAS_ADMIN_EMAIL=admin@canvas.local
CANVAS_ADMIN_NAME=              # empty → derived from the email local part
CANVAS_ADMIN_PASSWORD=          # empty → generated and printed on first run
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

Each workspace owns a StoreD instance, configured in the workspace's `workspace.json` under `services.stored` — `{ root, cache, sync, backends }`. The home directory is just a file backend (`backends['workspace:home'] = { driver: 'file', root: '{WORKSPACE_ROOT}/home', watch: true }`); `cache` is StoreD's internal working store (thumbnails, pull-through), not a backend. Future backends (S3, SMB) sync via background worker threads. See [API.md → Backends](docs/API.md#backends-unified-storage--connector-facade) for the REST surface.

## Workspace hooks & per-workspace git

Every workspace ships a user-owned automation layer: JS hooks and declarative
`rules.json` rules that fire on workspace events (document indexed, batch
synced, email arrived), plus the shell scripts they spawn. See the
**[Workspace Hooks guide](docs/hooks.md)** for the event catalog, hook context
API, classifier, rules format and shipped examples.

Every execution lands in a per-workspace run log — inspect it with
`canvas ws <name> hooks runs [--failed]`, debug matchers with
`hooks explain <docId>`, apply a new rule to your archive with
`hooks backfill --rule <id> --dry-run`, and re-deliver a logged run with
`hooks replay <runId>` (all also available in the web UI's Automation panel
and via REST — see the guide).

Hooks, rules and scripts live in a per-workspace **git repository**, editable
from the web UI/CLI or by cloning it directly:

```bash
# basic auth: any non-empty username (git requires one), password: a canvas API token
git clone https://canvas@your-canvas-server/rest/v2/workspaces/<workspace-id>/git my-workspace
# edit hooks/ and scripts/, then push — the server redeploys and hot-reloads
```

The same repo carries your dotfiles (see the dotfile routes under
`/rest/v2/workspaces/:id/dotfiles`).

## Documentation

- [API Documentation](docs/API.md)
- [Workspace Hooks](docs/hooks.md) — events, hook context, declarative rules, examples
- [Authentication Guide](docs/auth.md)
- [Security](docs/SECURITY.md)
- [Client data-layout spec](docs/client-spec.md)
- [Web UI frontend](src/ui/web/README.md) — bundled React frontend (standalone deployment, screenshots)

## REST + Websocket transports

- [API Documentation](docs/API.md)

Document search: `GET /rest/v2/workspaces/:id/documents?q=<term>` (repeat `q=` to refine — each term AND-narrows across text + photos, the last ranks). Add `&debug=true` to include raw image-kNN cosine distances in `.debug.imageDistances`, for tuning the per-workspace image relevance floor (`imageMaxDistance`, editable in Settings → DB).

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
# stop the running instance first (Ctrl-C, or: systemctl --user stop canvas-server)
git pull origin main
npm run update-submodules
npm install                    # rebuilds the web UI
npm start
```

Containerized instances update the same way, minus the npm steps:

```bash
cd /path/to/canvas-server
git pull origin main
npm run update-submodules
npm run docker:build && npm run docker:up
```

Your data is untouched by an update: it lives in `$CANVAS_SERVER_HOME` and the
module roots, never in `node_modules` or the image.

---
This project is funded by [Augmentd Labs](https://augmentd.eu/en/labs)
