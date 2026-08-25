---
name: project-fs-backends
description: "fs (local-folder) data backends implemented — file://<deviceId> twin locations, server device.json identity, /file/<device>/<mount> tree paths"
metadata: 
  node_type: memory
  type: project
  originSessionId: 617152ee-61da-47b9-a383-b2f911bd4277
---

Local-folder ("fs") storage backends landed 2026-07-15 across server + web + CLI (see [[project-backends-tree-refactor]], [[project-device-addressing]]).

Design decisions:
- Location anchor convention (user-confirmed 2026-07-15): `stored://` is RESERVED for workspace-anchored stores (workspace:home, workspace:data); external mounts carry `file://<serverDeviceId>/<abs-path>` (+ `metadata.backend=<mount-slug>`) as their ONLY location — no stored:// twin. Rejected the generic DEVICE placeholder and deviceId-in-stored:// names.
- Backends tree uses ANCHOR-FIRST grammar (user-confirmed): `/workspace/<store>` (workspace:home → /workspace/home), `/device/<device-name>/<mount>`, connectors stay driver-first (`/imap/<account>`, `/s3/<addr>`). One-shot startup migration drops the old `/file` subtree + resyncs all file backends (`#migrateBackendsTreeGrammar` in Workspace.js). Driver remains a config/REST concept (`/:id/backends/:driver/:address` unchanged).
- Server device identity: `<SERVER_HOME>/config/device.json` (uuid, lazily created by `src/core/device/ServerDevice.js`; overrides CANVAS_DEVICE_ID / CANVAS_DEVICE_NAME). Re-association = restore file / set env / edit registry. The CLI mints the same shape (uuid, `CANVAS_DEVICE_FILE`/`CANVAS_DEVICE_ID` overrides) since 2026-08-25, so one host no longer appears twice under two id vocabularies; its file is pinned to `~/.canvas/device.json` on the machine's OWN home, never under CANVAS_HOME, which may be portable media.
- Human-readable everywhere user-facing: mount name ("Financial Reports") → slug = backend address (`financial-reports`); backends-tree node = `/file/<device-name>/<mount-slug>` (device segment from config.device.name snapshot, stable across device renames); uuid never appears in tree paths. Descriptor carries `treePath`, `config.label`, `config.device`.
- `fs` is accepted as a driver alias, canonical driver name stays `file` (route-level `drv()` mapping).
- file://<deviceId> resolution: only when deviceId === this server's device AND path is under a configured mount root (no arbitrary reads); foreign devices are reference-drop only (canvas-edge proxy later).
- Web UI parsers `backendAddressFromTreePath`/`backendFolderTarget` need the backends list (treePath prefix match) for 3-segment mount nodes.

**Why:** workspaces move between canvas-server instances; stored:// addresses are instance-local, file://<deviceId> keeps content addressable + feeds device/id/* presence bitmaps.

Bug fixed along the way: `Stored.removeBackend` is async; `applyBackendConfig` called it un-awaited before re-adding → "Backend already exists" (broke the UI exclude editor too). All removeBackend calls are now awaited.

Pre-existing test debt: WorkspaceStoredIndex.test.js has 3 stale failures (expect legacy /.backends paths and pre-{data,ranged} resolve shape) — failing before this work too.

Round 2 (2026-07-16, after user tested with /mnt/pub/Fotky - 23.5k files/122GB over SMB):
- Streaming resync: FileBackend.scan + Stored.scan take an `onFile` callback; WorkspaceStoredIndex.resync upserts each doc as it is hashed (per-file upsert errors logged+counted, never abort the scan). Before: full scan (hours) completed before ANY doc/tree path appeared, and a restart lost everything.
- Skeleton mirror: FileBackend.shape() (readdir-only walk, honors exclusions) → Stored.shape(); resync pre-pass inserts every dir under the mirror root (insertBackendPath hook = backendsTree.insertPath ignoreLocks) and returns file count as progress total. Whole folder structure (incl. empty dirs) visible in seconds.
- Startup catch-up: Workspace.start() resyncInBackground()s every enabled external mount (config.device.id + non-{WORKSPACE_ROOT} root) - a restart mid-scan resumes (stored checksum index is durable; unchanged files skip re-hash).
- Resync visibility: descriptor gets status:'syncing' + resyncing + progress {scanned,total}; `backend.resync.changed` ws event (with treePath) emitted via onResyncStateChange hook -> Workspace.emit; web UI shows animate-spin RefreshCw on the mirror node (WorkspaceM2 resyncingPaths set -> MenuTreeView) + "indexing m / n" chip with 4s poll in settings.
- Case-preserving slugs: mount address keeps case+unicode ("TestCase Mount" -> "TestCase-Mount"); #getBackendRootPath no longer lowercases (regex [^\p{L}\p{N}._:@-]/gu); bitmap keys self-lowercase in synapsd so no conflict. User's existing "fotky" mount keeps its lowercase address (snapshot); re-adding under a new name would re-hash everything (checksum cache is keyed by backend name).
- Tree auto-refresh after add/remove/toggle backend: settings.tsx invalidates the backends tree cache + dispatches window 'workspace:tree:refresh'; ws chain (DirectoryTree TREE_PATH_INSERTED -> synapsd -> workspace -> manager -> socket) verified end-to-end with a socket.io client.
