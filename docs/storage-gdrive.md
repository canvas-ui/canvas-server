# Google Drive storage backend

First remote *storage* backend (driver `gdrive`, canvas-stored ≥ 1.3.0, server ≥ 2.5.59).
A Drive folder subtree is mounted like a local folder: files are indexed as
documents under `/gdrive/<address>/…` in the backends tree, bytes are addressed
as `stored://<address>/<key>`, and uploads/copies/moves to the backend go
through the normal stored transfer paths.

This is deliberately a **stored driver**, not a workspace service: Drive holds
blobs, so identity (checksum), locations, cache, copy/move and Destroy all come
from `canvas-stored`. Connectors (github/slack/gcal/…) stay services because
their remote objects are mutable structured records, not bytes.

## Credentials

OAuth 2.0 refresh-token grant — the same flow as the Google Calendar connector,
with the `https://www.googleapis.com/auth/drive` scope:

1. Google Cloud console → enable the **Google Drive API**.
2. Create an OAuth client (type *Desktop app* is simplest) → `clientId`, `clientSecret`.
3. Run the consent flow once with `access_type=offline&prompt=consent` to get a
   `refreshToken` (e.g. the OAuth 2.0 Playground with your own client credentials,
   or any small script). Testing-mode consent screens expire refresh tokens after
   7 days — publish the app or add the user as a tester to avoid that.

Secrets are **write-only**: the server validates them against the API before
saving, keeps them in `workspace.json` (`services.stored.backends.<address>`)
next to the connector credentials, and reads return only `credentialsConfigured`.

## API

```
POST   /rest/v2/workspaces/:id/backends/gdrive
       { name, clientId, clientSecret, refreshToken, folderId?: 'root', watch?, readOnly?, pollInterval?, permanentDelete? }
GET    /rest/v2/workspaces/:id/backends/gdrive
PATCH  /rest/v2/workspaces/:id/backends/gdrive/:address   (same fields; `enabled`, `watch`; secrets: omit/true = keep)
POST   /rest/v2/workspaces/:id/backends/gdrive/:address/test
POST   /rest/v2/workspaces/:id/backends/gdrive/:address/sync
DELETE /rest/v2/workspaces/:id/backends/gdrive/:address
```

`name` is the human label; its case-preserving slug is the address (and the
tree node `/gdrive/<address>`). A cred/folder change on PATCH re-probes and
hot-swaps the live driver.

## Behaviour

| | |
|---|---|
| Keys | `/`-joined Drive names under `folderId`. Duplicate siblings → ` (<id6>)` suffix; `/` in a name → `∕`. |
| Identity | sha256 from Drive metadata (also sha1/md5). Native Google Docs have no bytes → skipped (export is a follow-up). |
| Scan | One `files.list` per folder (BFS), no downloads. Unreadable folders are carried forward, never treated as deleted. |
| Watch | Polls `changes.list` (default 60 s). Renames/moves → unlink+add with `ino = fileId`, which stored collapses into an in-place location rewrite. |
| Writes | cache → SyncQueue (in-process) → resumable upload. Existing key = in-place update (same file id, sharing survives). |
| Delete | Trash by default (`permanentDelete: true` to purge). `readOnly: true` blocks byte deletion entirely. |
| Folders | `mutableContainers` capability: create / rename / delete folders from the tree. |
| Liveness | `test` capability → token grant + root folder check; resync refuses to reconcile when the root is unreachable. |

## Known gaps

- No export of native Google Workspace documents.
- Shared drives: files are listed with `supportsAllDrives`, but the root must be a folder the token can `files.get`.
- Failed remote commits are reported once (`synced` event, `success:false`) and leave the location `synced:false`; there is no retry queue yet (same as every remote driver).
- Disk usage / exclusions are file-driver features and not offered for Drive.
