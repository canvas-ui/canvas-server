# Workspace sync — device mirrors (file plane)

Roaming-profile sync for a workspace's files: the cloud instance ("hub") holds
the workspace, every device keeps `workspace:home` (or a part of it) in sync
with it, offline-first, without ever overwriting anyone's bytes. The database
plane (contexts, notes, tags — synapsd) stays on the hub, which remains its
single writer; the primary/secondary design for replicating *that* lives in
`TODO.sync.md` and is untouched by this.

Wire contract: `docs/sync-protocol.md`.

## Shape

```
device                                                hub (canvas-server)
  canvas-fuse --mirror / canvas-edge                    workspace runtime
   local cache + base ledger + write-back queue  ──REST──▶  stored (workspace:home) + change log
                                                 ◀─socket─  synapsd (single writer) ◀ watcher
```

- **Hub-and-spoke, spoke-driven.** Devices only talk to the hub and open every
  connection themselves; the hub is passive (REST + a `backend.changed` nudge).
  NAT-safe, offline-safe, no peer mesh.
- **Three tiers of local presence:** thin (PWA / desktop cache), on-demand
  (canvas-fuse live mount), **mirror** (pinned folders offline, the rest on
  demand, write-back). A full local replica (synapsd + stored) is the later
  database-plane tier.

## Clients

| client | where | what it gives |
|---|---|---|
| `canvas-fuse mount -w <ws> <root> --mirror` (0.8.0+) | Linux | a mount at `<root>/<ws>`: everything visible, pinned folders offline, the rest on demand, write-back queue, `Trees/` and `Trash/` |
| `canvas-edge` (`bin/canvas-edge`, this package) | any OS with Node | a plain folder at `<root>/<ws>` kept fully in sync (state under `<folder>/.workspace/`), built on canvas-stored's `Mirror` engine |
| `canvas mirror …` (CLI 2.3.0+) | any | picks the client (`--client fuse|daemon`), writes `~/.canvas/config/mirrors.json`, supervises with pm2 |

Both clients read the hub credentials from `~/.canvas/config/remotes.json` (the
device token's own device id is the identity they report under) and speak the
protocol in `docs/sync-protocol.md`. canvas-edge exposes a control socket at
`~/.canvas/run/edge.sock` (`GET /status`, `POST /reload`, `POST /mirrors/:id/resync`).

## What the hub guarantees

- A pushed file takes the **same path as a file dropped into the folder**:
  the watcher-shaped succession, so an edit keeps the document's curated
  placements, hooks and rules fire as for a user drop, and the change log
  records who did it (`X-Canvas-Origin`).
- Every mutation on a backend lands in a **durable change log** (canvas-stored
  `changes` sub-db, same transaction as the index), coalesced per key. Mirrors
  tail it with a cursor; a cursor older than the retained window gets `410`
  and rebuilds from the listing.
- **Preconditions** (`If-Match`, `If-None-Match: *`) are checked against the
  index under a per-key lock right before the swap; a mirror can never
  overwrite a change it has not seen.
- **Deletes orphan, never destroy** the document. **Renames keep the document
  id.** Overwrites displace the previous owner of the key explicitly.
- Keys the index would ignore (dotfiles, the workspace's own `.workspace/`)
  are refused rather than written invisibly.

## Conflicts

Both sides changed the same key since the device last synced → the **hub's
version keeps the filename**; the device's version goes to the **conflict
inbox** (a document in `workspace:data`, tagged `custom/sync/conflict`,
`derived-from` the document at the key) and the device pulls the hub version
into place. Nothing is lost, nothing is overwritten.

The user resolves from *Workspace settings › Sync* (or the CLI):

| keep | bytes | curation (placements, tags, asserted relations) |
|---|---|---|
| hub | incoming version destroyed | untouched |
| incoming | incoming bytes replace the key; the hub's document is orphaned | moved to the survivor |
| both | incoming bytes land as `name (conflict from <device> <date>).ext` | copied onto the copy; the original keeps its own |

A mirror configured with `conflicts: rename` skips the prompt: it writes its
version straight to the conflict-copy name (Dropbox behaviour) and the hub just
marks it.

## Devices

A mirror reports `{ cursor, pending, failed, conflicts, state, lastSync }` to
`POST /workspaces/:id/mirrors/:deviceId/status`; *Settings › Devices* and the
workspace's *Sync* tab show each device's lag (`head − cursor`). Revoking a
device (`DELETE /auth/devices/:id`) revokes its tokens; the daemon stops on the
next `401`.

## Landmines (read before touching)

- Hooks fire for hub writes from devices exactly as for user drops. A rule that
  moves a file out of `workspace:home` shows up on every device as a delete
  (recoverable from the device's trash).
- The precondition is evaluated against the *index*; a file edited on the hub's
  disk inside the watcher's settle window is a race that surfaces as a conflict
  on the next reconcile, not as data loss.
- `data.relations` on file documents is write-through; the stored index carries
  it forward on re-index (`#buildDocument`) — do not reintroduce `data: {}`.
- Whole-file `PUT` up to 20 GiB, no chunk resume; `X-Canvas-Sha256` guarantees
  a partial upload is never committed.
