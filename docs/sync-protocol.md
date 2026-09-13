# Workspace sync protocol (file plane)

The wire contract between a canvas-server **hub** and any **device mirror**
(canvas-fuse `--mirror`, the later canvas-edge daemon, or a hub mirroring one of
its own backends to another canvas instance). It covers *files* on a
path-addressed storage backend (`workspace:home` by default); the document
database stays on the hub, which is the single writer of synapsd.

Design in `docs/sync.md`. Server: `src/transports/routes/workspaces/objects.js`,
`mirrors.js`, `sync.js`; the primitives live in canvas-stored ≥ 1.5
(`writeObject`, `changes`, `listObjects`).

## Identity and addressing

- `GET /rest/v2/ping` → `payload.instanceId` — the hub's stable install id
  (`<SERVER_HOME>/db/instance.json`). A mirror records it; URL, port and tunnel
  are routing detail.
- Every route below is under `/rest/v2/workspaces/:id/backends/:driver/:address`
  where `:driver` is `file` and `:address` is the backend name (`workspace:home`,
  URL-encoded as `workspace%3Ahome`). Only enabled, path-addressed, writable
  `file` backends are exposed.
- Auth: the user's JWT, an API token, or a **device token** (`POST
  /rest/v2/auth/devices/register`). A mirror sends its device id as
  `X-Canvas-Origin` on every mutation.
- Keys are relative paths, `/`-separated, NFC-normalized by the hub. `.`/`..`
  segments, absolute paths, NUL, the workspace internals (`.workspace/**`) and
  anything the backend's exclusion list ignores (all dotfiles by default) are
  refused — `400 INVALID_KEY`, `409 KEY_INTERNAL`, `409 KEY_EXCLUDED`.

Responses use the standard envelope `{ status, statusCode, message, payload,
count, code? }`; byte responses (`GET objects/*`) are raw.

## Listing and change feed

| verb | path | notes |
|---|---|---|
| `GET` | `objects?prefix=&cursor=&limit=` | `payload = { objects: [{ key, sha256, size, mtime, mimeType }], cursor, head }` — key order; pass `cursor` back to continue, `null` = done; `head` is the change-log head at listing time |
| `GET` | `changes?since=<seq>&limit=` | `payload = { changes: [{ seq, ts, op, key, from?, sha256, size, mtime, origin? }], head, oldest, cursor }`; `op ∈ put \| delete \| rename` (`from` on rename). `410 CURSOR_TOO_OLD` (`payload.oldest`) when `since` predates the retained log — rebuild from the listing, then tail from `head` |

The feed is a **dirty-key notification with last known state**, coalesced per
key inside one hub transaction. A reader must re-stat the key (HEAD) before
acting; it must never replay ops blindly. Entries whose `origin` equals the
reader's own device id are its echoes.

`mtime` values are milliseconds since the epoch. `sha256` is the lowercase hex
digest of the bytes.

## Objects

| verb | path | request | response |
|---|---|---|---|
| `HEAD` | `objects/<key>` | `If-None-Match` | `200` + headers below, `304`, `404 NOT_FOUND` |
| `GET` | `objects/<key>` | `Range: bytes=a-b`, `If-None-Match` | `200` bytes, `206` + `Content-Range`, `304`, `416 RANGE_NOT_SATISFIABLE`, `404` |
| `PUT` | `objects/<key>` | raw body (any `Content-Type`, streamed, ≤ 20 GiB) **or** `?sha256=<hex>` with an empty body to place bytes already uploaded via `POST /blobs` | `201` created / `200` replaced (`payload.previous.sha256`) / `200 payload.unchanged`, payload carries `docId` + `version`; `412 PRECONDITION_FAILED` (`payload.current = { sha256, size, mtime, docId?, version? }` or `null`), `422 CHECKSUM_MISMATCH`, `404 BLOB_NOT_FOUND`, `503 BACKEND_OFFLINE` |
| `DELETE` | `objects/<key>` | `If-Match` | `200 { key, sha256, seq, docId, version }`, `404`, `412` |
| `POST` | `objects/rename` | `{ from, to, ifMatch?, origin? }` | `200 { from, to, sha256, seq, docId, version }`, `404`, `409 TARGET_EXISTS`, `412` |

Headers on `HEAD`/`GET`: `ETag: "<sha256>"`, `X-Canvas-Sha256`, `X-Canvas-Size`,
`X-Canvas-Mtime` (ms), `X-Canvas-Doc-Id`, `X-Canvas-Version`, `Last-Modified`,
`Accept-Ranges: bytes`, `Content-Type` (the indexed mime).

`version` is the document's **row version** (synapsd 3.20+): `1` on insert, `+1`
on every row write on the hub, minted by the hub only. It is the field a
replica records per document to claim "I hold the current version" (see
`docs/durable-workspaces.md`); `sha256` answers "do I need the bytes".

Request headers on `PUT`/`DELETE`:

| header | meaning |
|---|---|
| `If-Match: "<sha256>"` | the bytes the caller believes are at the key (its base); evaluated against the hub index right before the swap |
| `If-Match: d<docId>.v<n>` | the document **and its version** the caller last saw at the key (`X-Canvas-Doc-Id` / `X-Canvas-Version`); catches same-content re-saves and rename-then-edit that a digest cannot. Both halves must match — a byte edit is a succession, i.e. a new document whose counter restarts at 1. A mismatch is the same `412` with `current.docId` / `current.version`; a match is checked again as the digest right before the swap |
| `If-None-Match: *` | the key must be free (create) |
| `X-Canvas-Sha256` | digest of the body; a mismatch is refused (`422`) and nothing is committed |
| `X-Canvas-Mtime` | ms or ISO; applied to the file so both sides agree on "when" |
| `X-Canvas-Origin` | the caller's device id, stamped on the change-log entry |
| `X-Canvas-Conflict-Of: <key>` | conflict upload — see below |
| `X-Canvas-Conflict-Mode: inbox \| rename` | `inbox` (default) or Dropbox-style `rename` |
| `X-Canvas-Base-Sha256`, `X-Canvas-Device-Name` | recorded on the conflict entry |

A `PUT` over existing bytes is a **succession**: the document behind the old
bytes hands its curated placements to the document behind the new bytes
(exactly what a local edit does); the hub's own watcher echo is suppressed.
`DELETE` orphans the document (its metadata, tags and placements survive; the
bytes re-bind if they ever come back). `rename` keeps the document and its id.

## Conflicts

When both the mirror and the hub changed a key since the mirror's base, the
**hub version keeps the name**. The mirror uploads its version with
`X-Canvas-Conflict-Of: <key>`:

- `inbox` mode: the bytes land in the managed store (`workspace:data`) as a
  file document tagged `custom/sync/conflict`, related `derived-from` to the
  document at the key; `201 { docId, key, conflictOf, sha256, hubDocId, hubSha256 }`.
  The mirror then pulls the hub version into place.
- `rename` mode: the mirror PUTs to the conflict-copy key it chose
  (`<stem> (conflict from <device> <YYYY-MM-DD HHmm>).<ext>`) with the header;
  the hub writes it like any object and marks the document.

Resolution (web UI or CLI):

| verb | path | body / result |
|---|---|---|
| `GET` | `/rest/v2/workspaces/:id/sync/conflicts` | `[{ docId, key, backend, mode, device, deviceName, ts, incoming: { sha256, size, mtime }, base: { sha256 }, hub: { sha256, size, mtime, docId } \| null, resolvable }]` |
| `POST` | `/rest/v2/workspaces/:id/sync/conflicts/:docId/resolve` | `{ keep: "hub" \| "incoming" \| "both" }` → `{ keep, survivorDocId, resultKey?, resolvedAt }` |

`hub` destroys the incoming version. `incoming` moves the incoming bytes onto the
key (the displaced hub document is orphaned; its placements, tags and asserted
relations move to the survivor). `both` moves the incoming bytes to a
conflict-copy name with a *copy* of the original's curation. Either way the
mirror sees the outcome as ordinary changes on the feed.

## Mirror status

| verb | path | body / result |
|---|---|---|
| `POST` | `/rest/v2/workspaces/:id/mirrors/:deviceId/status` | `{ backend?, client: fuse\|daemon\|other, path?, prefixes?, cursor, pending, failed, conflicts, reverted?, skipped, state, direction?: bi\|pull\|push, lastSync, lastError?, version?, applied?, full? }` → `{ mirror, head, replica }`. A device token may only report for its own device id |
| `GET` | `/rest/v2/workspaces/:id/mirrors` | the caller's devices mirroring this workspace, each with `head`, `lag = head − cursor`, `replica: { role, required }`, `behind` (documents whose current version the device lacks) |
| `PATCH` | `/rest/v2/workspaces/:id/mirrors/:deviceId` | `{ required?, role?: full\|cache }` — replica policy (workspace.json `replicas`); a cache never counts |
| `GET` | `/rest/v2/workspaces/:id/mirrors/protection?sample=20` | the protection walk: `{ required, total, unversioned, protected, unprotected, partial, replicas: { <deviceId>: { behind, held, required } }, oldestUnprotected: [{ key, docId, version, mtime }], policy }` |
| `DELETE` | `/rest/v2/workspaces/:id/mirrors/:deviceId` | forget the record |
| `DELETE` | `/rest/v2/auth/devices/:deviceId` | revoke the device (tokens + record); the mirror gets `401` next |

### Protection evidence (`applied`)

`applied` is `[[docId, version], …]`: documents whose bytes the device has
verified against the digest and fsynced, at the row version the hub reported
for them (`docId`/`version` on listing entries, feed entries, `HEAD` headers
and every mutation result). A delta is what changed since the previous report;
`full: true` means the array is the device's complete ledger and replaces what
the hub holds for it (sent once after start, so a hub that lost its replica
table rebuilds). The hub stores the pairs per device (never on the device
record), keeps the highest version it has seen, and computes *protected* as
"every replica marked required holds the current version" — see
`docs/durable-workspaces.md`. The pairs are evidence only; they never influence
the sync decision itself.

## Live nudges

Subscribe to `workspace:<id>` on the socket (device token accepted). The hub
emits `backend.changed { workspaceId, backend, seq }`, throttled per backend
(≈300 ms), whenever its change log advances; `seq` is the log head. Treat it as
"poll `changes` now", never as the change itself. `sync.conflict.created` /
`sync.conflict.resolved` carry `{ workspaceId, docId, key, ... }`.

## Client algorithm (reference)

Per key, with `L` = local sha, `B` = base ledger sha (last agreed with the hub),
`R` = hub sha (from the feed, confirmed with `HEAD`):

| L vs B | R vs B | do |
|---|---|---|
| = | = | nothing |
| ≠ | = | push: `PUT` with `If-Match: B` (`If-None-Match: *` when B absent); L absent → `DELETE If-Match: B` |
| = | ≠ | pull `GET` (R absent → local copy to trash) |
| ≠ | ≠, L = R | adopt: base := L |
| ≠ | ≠, L ≠ R | conflict: keep L locally, upload with `X-Canvas-Conflict-Of`, pull R, base := R |
| absent | ≠ | pull (edit beats delete) |
| ≠ | absent | push as new |

Write `B` only after the byte operation succeeded (push → response `sha256`/`seq`;
pull → the `ETag`). Persist the feed cursor only after a whole batch reconciled.
Never persist hub document ids — they are recycled; keys and digests are the
identity. On `410` rebuild the base from `objects` (listing) and continue from
`head`.
