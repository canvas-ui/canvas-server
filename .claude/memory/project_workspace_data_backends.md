---
name: project_workspace_data_backends
description: Two default workspace data backends — workspace:home (file) + workspace:data (cacache blob store); fs:data retired
metadata: 
  node_type: memory
  type: project
  originSessionId: 23b98f1c-7ca6-459b-bcc4-fe39a1e08f7d
---

Workspace has exactly **two default data backends** (`WORKSPACE_DATA_BACKENDS` in `src/core/workspace/lib/constants.js`):

- **`workspace:home`** — `file` driver, webdav/samba-exported "roaming profile" folder; familiar UX; chokidar autoindex; `indexIncoming` → `/.incoming/workspace/home`. (renamed from `fs:home`)
- **`workspace:data`** — `cacache` driver, the **default local content-addressable blob store** for users without an external object store. Checksum-keyed, deduped, opaque on-disk layout — navigation is the synapsd virtual tree, not the disk. `stored://workspace:data/<key>`.

`fs:data` + the per-abstraction `fs:data:<abstraction>` file tree are **retired** (removed `DATA_STORED_BACKEND_PREFIX`, `dataBackendName/Root/Feature`, `ensureDataBackend`, `#isDataBackend`, `#ensureBackendForUrl`). Abstraction lives on the doc (`schema: data/abstraction/email`), not the backend. `s3` stays as a future opt-in alternative.

**Connector blob seam:** non-file sources (mail/IMAP now; offline-website download + attachment-promotion later) persist blobs via `WorkspaceStoredIndex.persistBlob(buffer)` → `stored.put(..., {backends:['workspace:data']})` → returns `{url, key, checksum, size}`. Mail service gets it injected (it's severed from stored). Email raw `.eml` + attachments now land in `workspace:data` (deduped), addressed `stored://workspace:data/<checksum>` — no more browsable `data/email/account/folder/` layout.

**Why:** user model — "dump data to workspace:data, only care about the synapsd tree." No backward compat (MVP deploy week of 2026-06-16; dev data, re-fetch email). Relates to [[project_storage_url_scheme]], [[project_canvas_fuse]], [[project_locations_device_bitmaps]]. IMAP is a per-workspace service, not a stored driver (see [[project_mvp_scope]]).
