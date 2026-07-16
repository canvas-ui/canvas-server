---
name: storage-url-scheme
description: "Unified location URL grammar — stored:// + file://, NO workspace:// scheme"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4cd9d60a-a79a-417a-9e22-07a08670d859
---

Canonical `locations[].url` grammar (full spec: `STORAGE-URL-SCHEME.md` at repo root):

- `stored://<backend>/<key>` — **canonical fetchable form** for all managed blobs. Backend names: `fs:home`, `fs:data:<abstraction>` (e.g. `fs:data:email`); `<backend>` may contain `:` so split on first `/`. Built by `WorkspaceStoredIndex.#buildDocumentLocations`.
- `file://{WORKSPACE_ROOT}/home/<path>` — WebDAV/home convention (literal `{WORKSPACE_ROOT}` token).
- `file://<deviceId>/<path>` — device-local, via `path-helpers.deviceFileUrl()`. See [[device-addressing-scheme]].
- `imap://`, `s3://`, etc. — secondary provenance only (RFC 5092 for imap).

**There is NO `workspace://` scheme and no `cache/` authority** — I proposed that first draft, it was wrong. Don't reintroduce.

Checksums: `BaseDocument.checksumArray` as `<algo>/<hash>` (e.g. `sha256/abc`), **not** `sha256:<hex>`. Colon form is internal to Stored keys only.

**Content-addressable rule:** synapsd allows ONE doc per checksum — `checksumArray[0]` is primary key; re-found blob updates existing doc's locations, no dup. Checksum source is per-abstraction (`indexOptions.checksumFields`): file/email use blob/whole-data (`checksumFields: []`; email = raw `.eml` blob hash set by imap layer); Note = `data.subject`+`data.content`, Tab/Website = `data.url`. Email header identity (messageId/from) is NOT the content key — future contacts index handles that. (Changed Email `checksumFields` from header list → `[]`.)

**Migrations: N/A** — all canvas-server instances are dev/test (first prod deploy being prepped). No migration scripts; recreate DBs instead.

**Done (this codebase):** parseLocationUrl (`synapsd path-helpers.js`); Stored.getByUrl + s3/http/imap skeleton backends; `WorkspaceStoredIndex.resolve(url)` + email layout `data/email/<account>/<folder>/<sha>.eml`; imap email cutover (locations[] + imap provenance, dropped `data.rawRef`/attachment `storageRef`, raw-blob checksum, Email schema v3.1); `scripts/migrate-email-locations.mjs` (dry-run default). Migration not yet run on a live DB.

**Deletion core BUILT** (spec: STORAGE-URL-SCHEME.md → "Deletion & Lifecycle Semantics"): `StorageBackend.capabilities`/`canDelete` (HttpBackend=RO); `Stored.deleteByUrl`; `WorkspaceStoredIndex.destroy(doc,{urls})` + `describeLocations(doc)` (picker capability flags), cascade `db.delete` when locations empty; `Workspace.destroyDocument`/`describeDocumentLocations`. Three ops: **Remove**=unlink (tree), **Delete**=`db.delete` (index, warn), **Destroy**=per-picked-location wipe (RW delete bytes; RO http/imap drop ref only; cascade index-delete at 0 locations).

**Architecture:** ALL storage backends live in `stored` (fs/s3/http/imap/…); synapsd=index only; workspace storage-agnostic. IMAP ingest (canvas-server ImapService) MOVES to stored — phased.

**IMAP delete BUILT (Phase 1):** `stored/backends/imap` real `get` (fetch raw by UID) + `delete` (STORE `\Deleted` + EXPUNGE, key `<folder>;UID=<n>`), caps `{read,delete,write:false}`. `WorkspaceStoredIndex.destroy` routes imap:// via lazy `imap:<account>` reg; creds from `config/imap.json` via `Workspace.#getImapConfig` (injected `getImapConfig`). No creds → ref-drop only. (Not live-tested against real IMAP server.)

**IMAP Phase 2 — stored becomes the storage layer (in progress).** Decisions: ALL backend config in `WORKSPACE/config/stored.json` (replaces dataBackends + imap.json); stored emits generic `object:add/change/unlink` (eventemitter2 wildcards, `:` delimiter, payload {backend,kind,key,...}); workspace consumes events to index (no storage logic in workspace); cacache caches remote blobs; SyncQueue=syncd; backend config injected at init.
- **Step A DONE:** `stored/backends/imap` full protocol — verify/listFolders/scan(emit object:add per msg, returns {inserted,lastUid})/watch(poll)/stop + get/delete. lastUid in-memory, emits `backend:state`.
- **Step B DONE:** Stored→eventemitter2; emits `object:*` (file backends dual-emit file:* + object:* kind:file; imap forwards object:add). stored 27/27 green; tree still bootable (ImapService untouched).
- **Steps C/D/E DONE — ImapService DELETED.** C: WSI loads `WORKSPACE/config/stored.json` (`{backends:{name:{driver,...}}}`), registers all backends, read/write/patch helpers. D: WSI consumes `object:*` (dispatch file→#upsertDocument, message→#indexImapMessage), `#buildEmailDocument`+email helpers moved into WSI, `backend:state`→persist lastUid; full mailbox CRUD/lifecycle on WSI (list/get/save/remove/test/discover/subscribe/sync/start/stop, getImapStatus/disableImap) operating on stored.json, protocol delegated to ImapBackend. E: `services-imap.js` routes → `request.workspace.{listImapMailboxes,saveImapMailbox,...}`; Workspace passthroughs + enableImap/disableImap/getImapStatus + `#buildStoredIndex`/`#imapReadonly` (status w/o booting sources); WorkspaceManager dropped imapService; `services.js` reload→`workspace.enableImap()`; `src/core/workspace/services/imap/` removed; `imap` dep added to stored package.json.
- **⚠ Config cliff:** old `config/imap.json` is now IGNORED (imap config lives in `config/stored.json`). Existing mailboxes must be re-added via POST `/services/imap/mailboxes` (writes stored.json). Dev/test, no migration.
- **NOT e2e'd against a live IMAP server** — ingest path (poll→object:add→indexer→put) wired + unit-verified only.
- **Fix (e2e found):** `BaseDocument.validate()` required `indexOptions.checksumFields.length≥1`, which broke email (`checksumFields:[]`, raw-blob set on `checksumArray`). Relaxed to: valid if `checksumArray` populated OR `checksumFields` declared. Content-addressable abstractions set `checksumArray` directly, no fields needed.

**Other pending:** s3 real delete. resync-purge reusing destroy. Tree policy: `.incoming`=read-only mirror (Resync only); curated decoupled. UI gating + Destroy picker + Delete warning.

Relates to [[locations-migration]], [[url-design-mirror-rest-api]].
