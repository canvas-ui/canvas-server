# Durable workspaces: Augmentd reference design

Status: agreed design, 2026-09-13. Supersedes the earlier proposal (fencing
generations, storage epochs, per-object receipts, NAS-side version retention
were all dropped as over-specified for a single-owner, few-node deployment).
Guiding rule: **no more machinery than rclone bisync**. Writes are consistent
on the primary; everything else is eventually consistent.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | One **primary** per workspace: the node that runs the workspace DB. All mutations go through it. | Single writer, no peer arbitration |
| 2 | Every document carries a monotonic **`version`**, bumped only by the primary. | Precondition, stale-edit detection, replica accounting: one field, three jobs |
| 3 | Replicas are **canvas-edge `mirror` units** with a per-mirror **direction**: `pull`, `push`, `bi`. | Same code on NAS and laptop; seeding is `bi`, steady state on a backup target is `pull` |
| 4 | The GPU workstation gets a **canvas-fuse mount supervised by edge** (`fuse` unit), one process per workspace under a common root. | On-demand namespace with LRU bytes; a plain folder cannot show files it does not hold |
| 5 | Retention: primary keeps displaced blobs for a window; NAS history is **Synology's job** (snapshots, Hyper Backup). | Canvas is not a backup product |
| 6 | Protection = "every required replica holds the current version". Shown per document and per workspace. | Cursor lag is not durability |
| 7 | The primary of a workspace can be **any edge `workspace` unit**. Augmentd: server primary. Photos: NAS primary. | Bytes and index live together; inference is already remote |
| 8 | Invoice pipeline is **out of scope** here. It needs a job store and IMAP MOVE; it consumes `version` but nothing else from this work. | Keep sync and workflow separate |

## Topology

| Node | Unit | Role for Augmentd | Path |
|---|---|---|---|
| Remote canvas-server | `workspace` (primary) | index, DB, config, full files | `workspaces/Augmentd` |
| Synology NAS | edge `mirror`, direction `pull` (`bi` during seed) | full backup replica, counts toward protection | native volume path, exported as `smb://172.16.2.200/work/Augmentd` |
| Work laptop | edge `mirror`, direction `bi` | full working replica, does not count toward protection | `~/Workspaces/Augmentd` |
| GPU workstation | edge `fuse` | on-demand cache, never counts | `~/Workspaces/Augmentd` |

`workspace:home` is the physical namespace. After convergence every full replica
has the same relative paths and bytes:

```text
primary: workspaces/Augmentd/Accounting/2026/09/Expenditures/invoice.pdf
NAS:     <volume>/work/Augmentd/Accounting/2026/09/Expenditures/invoice.pdf
laptop:  ~/Workspaces/Augmentd/Accounting/2026/09/Expenditures/invoice.pdf
GPU:     ~/Workspaces/Augmentd/Accounting/2026/09/Expenditures/invoice.pdf   (bytes on demand)
```

Scope is "data only": user files in `workspace:home`, no DB, no context trees,
no derivatives. Device bookkeeping lives outside the replicated tree (see
*Edge state directory*). Empty directories, symlinks, special files and names
the index refuses are reported by the mirror as skips, never silently counted
as replicated.

## Document version

Every synapsd document gets `version` (integer, starts at 1). The primary
increments it on **any** mutation: bytes, metadata, tags, placement, rename.
Replicas, agents, hooks and UIs never write it.

| Question | Field |
|---|---|
| Do I need to transfer bytes? | `checksum` (sha256) differs |
| Am I allowed to write? | `If-Match: d<docId>.v<version>` still holds on the primary |
| Is this replica current for this document? | replica ledger `key → (docId, version)` equals the primary's |

`If-Match` on the file-plane API accepts either the sha256 (existing clients)
or `d<docId>.v<version>`; that form is preferred because it distinguishes
same-content re-saves and rename-then-edit. The pair is the identity, not the
version alone: a **byte edit of a file is a succession** on this primary (the
bytes are content-addressed, so the key gets a new document whose counter
restarts at 1, with placements migrated), whereas notes and other by-id
documents are edited in place and their counter climbs. Deletes orphan rather
than destroy, so a delete-and-recreate at the same key continues the same
document's counter. That removes the need for any incarnation or epoch concept.

What bumps: every **row write** (content, metadata, comment, locations,
asserted relations). Tree/tag membership is bitmap-only and does not touch
the row, so it does not bump; a replica does not care about it either.

Consumers check `version` before doing anything else: the editor refuses to
overwrite a newer version, a rule retrying after a crash sees the document
moved on and stops, an agent's proposed move is rejected if the document
changed under it.

The change log keeps its cursor for catch-up; the cursor is a transport
concern only. Protection is computed from versions.

## Mirror direction

Per-mirror setting in the edge config (`mirrors.json`), rclone vocabulary:

| direction | primary → replica | replica → primary | use |
|---|---|---|---|
| `pull` | yes, including deletes | never; local edits are reported as skips | NAS backup |
| `push` | no | yes | one-shot import of a local tree |
| `bi` | yes | yes, with the existing conflict inbox | laptop, NAS during seed |

A `pull` replica never sends anything upstream. A local edit of a tracked file
is **reverted**: the edit is parked in `.workspace/conflicts/` under a
conflict-copy name, the primary's bytes are put back, and the mirror counts it
(`reverted`). A local delete of a tracked file pulls the primary's copy back. A
local-only file is left alone and reported as a skip (`local-only`). A `push`
replica is the reverse: hub-side additions and edits are reported as skips
(`remote-only`, `remote-changed`) and never applied. This makes "mass
disappearance" a non-event for a backup target, so no freeze heuristics are
needed. Landed: canvas-stored 1.8.0 `Mirror({ direction })`, edge 0.2.0,
`canvas remote mirror direction <ws> pull` (cli-mirror 0.3.0).

## Protection

The replica ledger (canvas-stored `Ledger`) already stores one base row per
key. Add `docId` and `version` to that row, written only after the bytes are
verified against the checksum and fsynced. The mirror status report
(`POST /workspaces/:id/mirrors/:deviceId/status`) gains a compact
`applied` delta: `[[docId, version], …]` since the last report, plus the
existing `skipped`.

The primary keeps `replicaVersions[docId][deviceId]`. Workspace config lists
which replicas are **required**:

```jsonc
"replicas": [
  { "device": "nas-synology",  "role": "full",  "required": true  },
  { "device": "laptop-x1",     "role": "full",  "required": false },
  { "device": "gpu-box",       "role": "cache", "required": false }
]
```

`protected(doc)` = every required replica's recorded version is at least
`doc.version`. Surfaces (landed server 2.9.0 / web 2.11.0):

- workspace Sync tab: protection card (held / not yet, oldest unprotected
  keys), per replica direction, *required* toggle, versions behind, reverted
  count, skips
- `GET /workspaces/:id/mirrors/protection` for agents and the CLI

Not in v1: a per-document badge in the file view, a periodic checksum sweep
(Synology scrubs its own volume), receipts of any other kind.

## Primary storage safety (canvas-stored)

Two changes, both small:

1. **Atomic commit.** `file` backend `commit()` is remove-then-hardlink today,
   leaving a window with no file at the destination and sharing an inode with
   the staged copy. Change to: write to `.stored-tmp/<uuid>` on the same
   filesystem, fsync, `rename(2)` over the destination. Same for `put()`.
2. **Displaced-blob retention window.** When an overwrite or delete displaces
   a blob (keyed write, remove, overwrite transfer), the file backend hardlinks
   it under `.stored-tmp/retained/<sha256>` first; a `retained` sub-db records
   when and from which keys. Swept after `CANVAS_RETENTION_DAYS` (default 30).
   `GET …/retained?key=` lists what a path used to be, `POST …/retained/<sha>/restore`
   puts it back through the ordinary keyed write. Digest-addressed, so the
   same bytes displaced from ten keys are kept once. That is the whole
   versioning story on the primary; anything longer-lived is the backup
   system's job.

## Edge: state directory, containers, units

- **State directory.** `mirror-runtime.js` hardcodes `<folder>/.workspace`.
  Add `stateDir` per mirror (default unchanged). The NAS container sets it to
  a private volume so the exported share contains user files only.
- **Dockerfile** for `runtimes/edge`, unprivileged, bind-mounts the workspace
  folder and a state volume, outbound-only to the primary, restarts on
  failure. `canvas remote mirror` gains `--runtime docker|pm2`; same config,
  same binary.
- **`fuse` unit.** Edge supervises `canvas-fuse mount -w <ws> <root>/<ws>
  --mirror` as a child process, one per workspace, listed in the same
  `mirrors.json` with `client: fuse`. canvas-fuse stays a plain executable.
  Context mirroring, if wanted, is a second fuse process on a different
  mountpoint, not a mode of the same one.
- **Several workspaces.** All of the above is per entry in `mirrors.json`;
  Augmentd plus four other workspaces are five entries.

canvas-fuse workspace mode already mounts `<ws>/Home` at the mountpoint, has
the sha256 disk cache, pins, and LRU eviction that skips dirty, open and pinned
digests. No changes to canvas-fuse are needed for v1.

## NAS deployment and seeding

1. Deploy the edge container on the Synology with the target folder
   bind-mounted at its native volume path (resolved at deploy time, never
   derived from the SMB URL) and a private state volume.
2. Create the mirror with direction `bi`, let it pull the current Augmentd
   tree from the primary.
3. Copy the existing NAS-local files into the folder. The mirror pushes them
   to the primary with the ordinary conflict rules; the primary indexes them.
4. When the Sync tab shows zero pending and zero skips, flip direction to
   `pull`. From now on edits go through the primary.
5. Configure snapshots and off-site backup on the Synology. Not canvas's job.

One sync owner per NAS root: the container. Mounting the same share from a
laptop over SMB is a read-only convenience, not a second replica.

## Photos: NAS as primary

A 300 GB photo workspace is not pushed over the WAN. It runs as an edge
`workspace` unit **on the NAS** (own synapsd + stored, bytes local), registered
on the server as a remote workspace (`photos@nas`, already supported). Its
inference endpoint points at inferd on the GPU workstation, which reads bytes
over the LAN. Embeddings and descriptions land in the NAS-side index. If a
subset should later live on the server, it is the same mirror machinery with
the roles swapped. Nothing new is introduced; the unit is the same, only the
configuration differs.

## Out of scope, kept in mind

The invoice pipeline (IMAP listener on `invoice@augmentd.eu`, PDF filed to
`Accounting/<year>/<month>/Expenditures`, email moved to
`INBOX.Invoices.<year>`) is a separate body of work. What it will need from
the workspace, none of which this design blocks:

- a persisted job store in the workspace process and a worker child process
- IMAP MOVE and UIDVALIDITY in the imap service (today: `lastUid` only,
  delete = flag + expunge, attachment failures are logged and dropped)
- the protection state above as a barrier before the mailbox move
- `version` as the precondition on every file command it issues

Order there: file the PDF first, wait for *protected*, then move the email.

## Deferred (noted 2026-09-14)

- **Storage backends UI rework.** How storage backends are managed in the
  web UI needs a rework (adding/editing path backends, their roles and
  policies in one place) before the items below get a home.
- **Retention as a workspace setting.** `CANVAS_RETENTION_DAYS` is an env var
  today; it should be a per-workspace UI option (days, off) stored in
  workspace config, with the retained-versions list and restore surfaced in
  the file view. Server routes already exist.

## Implementation sequence

| Step | Repos | Size |
|---|---|---|
| 1. `version` on documents, bumped by the primary; `If-Match: d<id>.v<n>`; exposed in REST and the change feed — **DONE** (synapsd 3.20.0, server 2.8.10) | synapsd, server, protocol | small |
| 2. Mirror `direction`; ledger rows carry `docId`/`version`; `applied` delta in status; `replicas` config; protection state + Sync tab — **DONE** (stored 1.8.0, edge 0.2.0, cli-mirror 0.3.0, server 2.9.0, web 2.11.0) | stored, edge, server, web | medium |
| 3. Atomic commit + displaced-blob retention window — **DONE** (stored 1.9.0, server 2.10.0: `CANVAS_RETENTION_DAYS`, `GET/POST …/retained`) | stored | small |
| 4. Edge `stateDir`, Dockerfile, `--runtime docker\|pm2` | edge, cli | small |
| 5. Edge `fuse` unit | edge, cli | small |
| 6. NAS seed of Augmentd, flip to `pull`, restore drill from the NAS copy | ops | – |
| 7. Photos workspace on the NAS with remote inferd | ops | – |

Steps 1–3 landed 2026-09-13. Step 4 is next.
