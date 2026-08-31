# Workspace sync — design + TODO (2026-08-31)

Supersedes the parked "Workspace sync (design notes, 2026-08-02)" section of `TODO.md`.
Facts below were verified against synapsd 3.16.0, canvas-stored 1.4.2, canvas-server 2.5.75.

## 1. Use-cases this has to serve

1. **Travel / offline.** Work on a laptop with no network for hours or days, then reconnect.
   The cloud instance must stay usable meanwhile (phone, agents, sharing).
2. **Cloud convenience.** An always-on instance that is a full, current copy — not a dumb
   backup — so contexts, agents, public shares and the phone hit it directly.
3. **Accounting data.** `workspace:home/Accounting` must exist in **several places with the
   same on-disk structure**: local workspace, cloud workspace, Google Drive, home NAS. A
   `Accounting/2026/Contracts/foo.pdf` path is the same path on every target. Losing any one
   location must lose nothing.
4. **Handoff.** "I'm leaving now, the laptop is the master until I'm back" must be one
   explicit action, never something that silently happens.
5. **Offline websites.** Browsing/tab indexing happens against the cloud instance as you go;
   a proper offline capture (singlefile-style, in the browser extension or on the server —
   upcoming feature) stores the page bytes. Those snapshots must reach the local workspace
   automatically so the pages are readable on the road. Here the **cloud is the primary**
   and the laptop is a secondary that only needs to read — the mirror of the accounting
   case, same machinery.

Concretely: `workspace:home/Accounting` → synced to `gdrive`, `homenas`, and
`https://other-canvas.tld/workspaces/myworkspace`; website snapshots → cloud primary →
laptop secondary with `required: true`.

## 2. The split: db objects vs blobs

Two independent mechanisms, two owners:

| what | owner | mechanism | shape |
|---|---|---|---|
| **db objects** (synapsd LMDB) | synapsd `replication` + a thin server/workspaced transport | primary → secondary op log, syncrepl-style (OpenLDAP `refreshAndPersist` + delta-syncrepl is the model) | one writer at a time, explicit handoff |
| **blobs** (files, managed data store) | canvas-stored `syncd` | storage policy: desired-state "object X must exist on backends [A,B,C] under the same key" | N-way, content-addressed, order-free |
| **derived** (Lance FTS, vectors, `data/* feature/* device/*` bitmaps, timelines, geo, edges, checksum index, stored index) | nobody | rebuilt locally on demand from the replicated rows | never shipped |

The db side never file-syncs live LMDB. The blob side never touches LMDB. The link between
them is the `stored://<backend>/<key>` URL in `document.locations[]`, which is
backend-name-relative and already survives workspace relocation — so if every instance has
a `workspace:home` backend and the policy keeps keys identical, the same URL resolves on
every replica.

## 3. Load-bearing facts from the code (and two corrections)

- **There is no op log, revision number, LSN or clock in synapsd today.** The only counter is
  `internal/document-id-counter`. `useVersions` is off in the LMDB env. Events
  (`membership.changed {docId, op, keys}`, `document.*`, `tree.*`) are in-process only.
- **Document ids are recycled local uint32 integers** (free-id pool `internal/gc/deleted`,
  popped densest-first, then the counter). Everything is keyed on that integer: roaring
  bitmaps, `synapses`, BSI timeline/geo planes, `edges_*`, `data.relations[].to`, Lance `id`.
  Two independent writers **cannot** allocate — this alone rules out concurrent
  multi-master without a schema-wide global-id migration. Single-writer avoids it entirely:
  the id space is replicated as-is, the counter and the free pool are just more rows.
- **Correction:** the 2026-08-02 note said "documents are immutable, every edit creates a
  new document". Not true — `update()` rewrites the row under the same id, rotates
  `checksums` keys and stamps `updatedAt` (wall clock). So replication must carry updates
  and deletes, not just inserts. Another reason for an ordered single-writer log.
- **Correction:** "bitmaps are derived, never sync them" is only true for the derived
  plane. Authoritative bitmaps with no rebuild source from `documents`: `tag/ custom/
  client/ data/dataset/` (asserted via `link()` without touching the row), `context/<tree>/
  <layerULID>` and `vfs/<tree>/<node>` (membership). Their durable backing store is the
  `synapses` sub-db (docId → layer keys), so they replicate as **logical link/unlink ops**,
  not as roaring bytes. Full refresh ships a whole LMDB snapshot (roaring portable format,
  cross-platform safe) so bitmap bytes only ever move inside a snapshot.
- **Bitmap writes are not co-transactional with row writes** (in-memory map, flushed
  post-commit). Replaying raw LMDB key/values would reproduce that skew; replaying logical
  ops through the synapsd API on the replica does not.
- **Context tree is authoritative** (`tree/<id>/meta|tree|layer/<ULID>|nodes/<ULID>` in the
  `internal` dataset). Layer/node ids are ULIDs — instance-independent, fine to ship.
- **Vectors are not re-derivable inside synapsd** — the embedder (inferd/embedd) is external.
  Treat as ephemeral anyway; a replica re-embeds through its own inferd at its own pace,
  guided by the `internal/embed/seen/*` ledger. Accept the cost; do not ship Lance.
- **stored file driver keys = relative paths mirrored 1:1 under root; gdrive keys = '/'-joined
  Drive names.** "Same on-disk structure everywhere" is therefore *already* the natural
  key model: one key, N backends. Only the hash fan-out (`aa/bb/<sha>`) applies when no key
  is given (managed `workspace:data` cacache store).
- **stored SyncQueue is in-memory, no retry, no persistence** — a job in flight at exit is
  lost. Not a base for replication; must become an LMDB-backed queue first.
- **`RemoteWorkspace` + `remote-proxy.js` already forward every REST call and relay events**
  with share-token auth and a pull-through blob cache. The secondary's write path reuses this.
- **workspace.json already has `remotes: [{url, token, enabled}]`** (edge) — the peer list
  travels with the workspace.

## 4. Replication model: primary / secondary with explicit handoff

Decided (over master-master): exactly **one primary per workspace at any time**, any number
of secondaries. Mastership is a **role recorded on both sides plus an epoch**, moved only by
a handoff both parties acknowledge. Split brain is prevented by construction, not by
conflict resolution.

### 4.1 Roles

- **primary** — the only instance that opens synapsd for writes and allocates ids. Appends
  every mutation to the op log. Serves `refresh` (snapshot) and `persist` (tail) to
  secondaries.
- **secondary** — opens synapsd normally, applies the op log through the public API
  (`insert/update/delete/link/unlink/tree.*`) with `origin: 'replication'` so hooks, derived
  indexes and events fire locally exactly as they would for a local write. Refuses local
  writes at the workspace layer. When the primary is reachable, **writes are forwarded**
  (existing `remote-proxy.js` forwarder, share token) and become visible locally when the
  op comes back through the tail — read-your-writes via a short wait on the returned CSN.
  When offline: reads work, writes return `409 WORKSPACE_SECONDARY_OFFLINE` with the
  promote hint.
- **backup** (blob-only) — a stored target that never runs synapsd. gdrive, NAS, S3. Gets
  blobs via policy and, optionally, periodic db snapshots as blobs (§4.5).

### 4.2 Identity

- `instanceId` = stable per canvas-server/workspaced install (`db/instance.json`, nanoid,
  created once). Peers key on `instanceId`; URL/tunnel is routing detail (same decision as
  TODO.md "Addressing by instance id").
- **Addressing (settled 2026-08-31).** A replicated workspace is a *local* workspace on
  every peer — same workspace id, same `name`, addressed as plain `name` (`name@localhost`
  when the address must be explicit). It is **not** a `name@host` remote entry, so
  contexts, pins and agents that reference it never notice a handoff; only the write
  forwarder's target changes. `name@<instanceId>` (host label replaced by the peer's
  instance id, `name@remote.host.tld` accepted as input and resolved to it) stays the form
  for non-replicated remote references. Existing `name@hostname-port` entries migrate to
  the instance id on first successful `hello`.
- `workspace.json`:
  ```json
  "replication": {
    "epoch": 7,
    "primary": "<instanceId>",
    "peers": [
      { "instanceId": "...", "url": "https://other-canvas.tld", "token": "secret://...", "role": "secondary", "enabled": true }
    ]
  }
  ```
  `epoch` increments on every handoff. An op log entry is addressed by **CSN = `[epoch,
  seq]`** (seq resets to 0 per epoch). A secondary's cursor is its last applied CSN;
  `contextCSN` in LDAP terms. Anything with an epoch the receiver has not seen through a
  handoff it acknowledged is refused, which is the split-brain guard.

### 4.3 Handoff (both online, atomic-ish)

`POST /workspaces/:id/replication/handoff { to: instanceId }` on the current primary:

1. Primary sets `state: 'handing-off'` — refuses new writes (503 + Retry-After), drains
   in-flight, flushes synapsd, flushes stored queue for blobs the new primary's policy
   requires locally (§5.4 "must-have-locally").
2. Primary waits until target's cursor == head CSN (pushes tail).
3. Two-phase: primary sends `handoff/prepare {epoch+1, primary: target}`; target persists it
   and answers `ready`; primary persists `role: secondary, epoch+1` then sends
   `handoff/commit`; target persists `role: primary, epoch+1` and starts accepting writes.
   Each side's persisted state is a single `workspace.json` write. If commit is lost, the
   target has `prepared` and the old primary has already demoted: on next contact either
   side finishes from the persisted phase (standard 2PC recovery, one coordinator).
4. Other secondaries learn the new primary from the next `hello` (epoch bump + primary id)
   and re-point their tail and their write forwarder.

Requires both online **by design**. A handoff is what the user does before boarding.

### 4.4 Forced promotion (offline, escape hatch — not v1)

If the user forgot to hand off: `promote --force` bumps the epoch locally and starts writing.
The old primary, on next contact, sees an epoch it never handed off → it **demotes itself
and quarantines** its own ops since the fork point into a divergence bundle
(`dumpDocuments`-style JSON + tree op list) for manual re-application. This is a fork with a
recovery path, not merge. Ship as a later tier once the base is stable; the UI must make
"you are about to fork" unmissable.

### 4.5 Snapshots (full refresh) and db backups

- Full refresh = LMDB env backup (`lmdb.backup()` / `mdb_env_copy`, consistent while running,
  already used by synapsd's `backupOnOpen`) + `workspace.json` + tree of `db/` minus
  `db/stored` and `lance/`. Streamed as a tarball over the same channel as export; the
  receiver opens it, then tails from the snapshot's CSN. First-time join and "cursor too old
  for the retained log" both use it.
- The same snapshot, written **as a blob into the managed store on a schedule** and tagged
  `custom/backup/db`, makes blob-only backup targets (NAS, gdrive) hold a full, restorable
  db copy for free through the ordinary blob policy. Restore = import.
- Op log retention: keep `N` days or until the slowest enabled peer has consumed, whichever
  is longer, with a hard cap; beyond the cap a lagging peer gets a full refresh.

### 4.6 What the op log carries

An `oplog` sub-db in synapsd's env, key `[epoch, seq]` (ordered-binary), value:
```
{ csn, ts, op, args, origin }
op ∈ insert | update | delete | link | unlink | tree.create | tree.delete | tree.rename
   | tree.path.* | tree.layer.* | tree.document.* | idpool   // free-pool / counter changes
```
Written in the **same transaction** as the row mutation (this is the one place where the
LMDB txn boundary matters — the bitmap skew does not, because the replica re-derives).
`args` are the public-API arguments, ids included (single writer ⇒ ids are global for the
lifetime of the workspace). Derived-plane writes (backfills, `rebuildL3`, reindex) are
**not** logged; every replica runs its own.

## 5. Blob sync = storage policy (canvas-stored `syncd`)

### 5.0 Starting point: hook rules ARE the storage policy v1 (settled 2026-08-31)

Placement rules — "object created lands in the default data store; if it is a photo and
(optionally) linked under `/travel/*`, move it to `workspace:home/Travel/…`" — are the
common case and are already expressible: hook rules bind `document.inserted` /
`document.linked` (carries the document + `changed` paths, `path` condition) with the
`store` action (folder/recursive/template keys). Cumbersome, but it exists and it runs on
the primary, where the data is. So:

- v1 = hook rules decide **where** an object lives (placement); the sync reconciler
  (§5.1–5.2) decides **where else** it must exist (replication). Two orthogonal layers, no
  new placement DSL before the reconciler is real.
- Storage-centric policies (a declarative `place` section next to `sync.policies[]`,
  evaluated by stored instead of the hook runtime) come later and compile down to the same
  `copy/move` primitives; the rule builder UI (storage-rules revamp) is the seed of that UI.
- Out-of-band changes on any backend (a file dropped into the Drive folder from a phone,
  a NAS share edited directly) enter through the watcher → index event → the same hook
  rules. "Gdrive as a source" is therefore not a special case; direction is a rule.

### 5.1 Policy shape (`workspace.json → services.stored.sync.policies[]`)

```json
{
  "id": "accounting-mirror",
  "source":  { "backend": "workspace:home", "match": "Accounting/**" },
  "targets": [
    { "backend": "gdrive:accounting", "key": "same" },
    { "backend": "nas:home",          "key": "same" },
    { "backend": "canvas:other-canvas.tld/myworkspace", "key": "same" }
  ],
  "mode": "mirror",          // mirror | copy-once | archive
  "deletes": "propagate",    // propagate | keep | tombstone
  "authority": "source"      // which side wins on divergence (bytes differ under same key)
}
```

- `key: "same"` is the default and *the* answer to "mirror the directory structure": file
  driver joins it under root, gdrive creates the folder chain, a remote canvas instance
  places it under its own `workspace:home` at the same key. Template keys
  (`{{YYYY}}/…`, already in the `store` hook rule) stay available for archive-style targets.
- Policies are the **desired state**; syncd's job is reconciliation: for every indexed
  object matching `source`, `locations ⊇ targets` with `synced: true`. Anything short of
  that is a job. That is what makes it restart-safe and lets a new target be back-filled
  by simply adding it to the policy.
- Backend names are workspace-global and replicate with workspace.json; **credentials do
  not** — `secret://` refs resolved per instance. An instance lacking creds for a target
  skips it (the primary or another peer that has them will fulfil the policy; every
  instance reconciles the same desired state).

### 5.2 Engine

- Durable queue: LMDB sub-db in stored's own env (`db/stored`), `append / iterate /
  mark-complete / mark-failed`, retry with backoff, counters, survives restart. Replaces the
  in-memory `SyncQueue` (TODO.md in canvas-stored already lists exactly these requirements).
- Batching (`batchSize ~500`) for scan and drain.
- Every transfer is content-addressed: stream once, verify sha256, write to target under
  `key`; `location.synced` flips per target; `object:location:add` fires as today.
- Divergence under the same key (bytes differ, e.g. edited on the NAS directly):
  `authority` decides; the loser is kept as `<name> (conflict <instanceId> <date>).<ext>`
  next to it and tagged `custom/sync/conflict` — never silently overwritten.
- Deletes: per-backend authority (`owned | mirror | foreign`, TODO.md "storage-policy
  layer"). `mirror` targets follow the source; `foreign` (a NAS share people also use
  directly) never gets deletes, only tombstone markers if asked.
- Watch on targets (gdrive `changes.list` poll, file watcher/polling on NAS mounts) feeds
  back through the existing `#handleFileEvent` path so out-of-band changes on a target
  become ordinary index events; policy then decides direction.

### 5.3 `canvas` stored driver (remote canvas instance as a blob target)

A new `type: 'remote'` driver, same shape as gdrive: `put/commit/get/stat/list/delete/
verifyRoot/scan`, keyed by path, talking to
`PUT/GET /rest/v2/workspaces/:id/backends/:backend/objects/<key>` on the peer with the
share/instance token. The peer's own stored writes the bytes into its `workspace:home`
under the same key and indexes it as a local file. This is what makes the cloud workspace
a **structurally identical** copy, not just a cache. Also the first driver that needs
credential storage — the `s3` skeleton follows the same template afterwards.

### 5.4 Interplay with db replication

- Rows arrive on a secondary before (or without) bytes. A document whose `stored://` URL
  has no local bytes yet resolves through the **pull-through cache from the primary**
  (exists today in `remote-proxy.js`) — visible immediately, local when the policy job
  lands. Mark `locations[].synced:false` on the replica until then.
- `workspace:data` (cacache, checksum-keyed, `managed`) replicates as a plain
  content-addressed set: default policy `workspace:data → every db peer`. It has no dir
  structure to mirror.
- "Must-have-locally before handoff": a handoff to a laptop should not leave it reading
  accounting PDFs through a tunnel that is about to disappear. A policy flag
  `required: true` on the target that is about to become primary makes handoff step 1 wait
  for those jobs (or warn and list what is missing).
- The stored index (`db/stored`) is **per instance, never replicated**; it is a scan of
  that instance's backends plus the queue.

## 6. Placement and transport

- Runtime home: the workspace runtime (today `Workspace` in canvas-server, tomorrow
  `canvas-workspaced`). `replication` lives next to synapsd (a `Replicator` owning the
  oplog, cursor, snapshot streaming); `syncd` lives in canvas-stored. The control plane
  contributes auth (instance tokens minted like device tokens), routing (direct URL, edge
  tunnel, unix socket via undici `socketPath`), and UI.
- Channel: the existing per-workspace socket relay (`RemoteWorkspace` socket.io client)
  gains a `replication` namespace: `hello {instanceId, epoch, cursor}` → `refresh`
  (snapshot stream) or `persist` (tail push, back-pressured). REST fallback for polling
  peers behind restrictive networks: `GET /replication/oplog?after=<csn>&limit=`.
- Tokens: `secret://` (WorkspaceCrypto) — the plaintext `remote-workspaces.json` /
  `remotes[].token` is a known hole; fix before shipping v1 to the cloud.
- Security: an instance token is clamped to one workspace, as share tokens are; oplog
  entries are validated as API calls (schema, ACL) on apply, not trusted blindly.

## 7. Accounting scenario, end to end

Setup: laptop = primary, cloud = secondary (db peer + `canvas` blob target),
`gdrive:accounting` and `nas:home` = blob-only targets with the `accounting-mirror` policy.

- Drop `Accounting/2026/Contracts/foo.pdf` into `workspace:home` on the laptop: watcher →
  index → row insert (oplog) → policy jobs for gdrive, nas, cloud. Cloud gets the row over
  the tail within ms, bytes as the job lands; gdrive/NAS get the same path.
- Phone opens the cloud instance: document is there; if bytes have not landed yet they pull
  through from the laptop while it is online, else `synced:false` is shown.
- Before travel: handoff to the laptop is already the case; before returning to the office
  desktop workflow: `handoff → cloud` from anywhere, or keep the laptop primary — the cloud
  keeps forwarding writes to it whenever it is reachable.
- Laptop dies: cloud has db (tail) and blobs (policy); NAS/gdrive have blobs + scheduled db
  snapshot blobs. Promote cloud (forced, epoch bump) — nothing to merge because the laptop
  will never speak again; if it does, it quarantines and demotes.

**Offline websites (cloud primary, laptop secondary):** the extension/server captures a page
→ `workspace:data` blob + document on the cloud primary → hook rule may file it under
`workspace:home/Web/<site>/…` → policy `workspace:data → laptop, required: true` (plus the
`Web/**` mirror) → the laptop's tail applies the row, the reconciler pulls the bytes
whenever the laptop is online. On the road the laptop reads its local copy through the
same `stored://` URL. Writes (tags, notes) while offline are not queued in v1 — they need
the forwarder, so they fail with the promote hint. Revisit with a per-op "replica-local
annotations" queue only if this hurts in practice.

## 8. Build order (each step usable on its own)

### synapsd
- [ ] `oplog` sub-db + CSN `[epoch, seq]`, written inside the row transaction for
      insert/update/delete/link/unlink/tree.*/idpool; `origin:'replication'` bypass flag so
      applying does not re-log. `getOplog(after, limit)`, `head()`, retention/trim.
- [ ] `Replicator` (primary side): snapshot stream = `lmdb.backup()` to a temp env + tar;
      tail push with back-pressure; per-peer cursor bookkeeping.
- [ ] `Applier` (secondary side): apply entries through the public API in order, one LMDB
      txn per entry (or batched), persist cursor in the same txn (`internal/replication/
      cursor`). Idempotent re-apply of the last entry after crash.
- [ ] Read-only mode for the secondary (reject non-replication writes at the API boundary).
- [ ] `dumpBitmaps` stub → not needed for this design; delete or finish as a debug tool.
- [ ] Test: two envs in one process, fuzzed op sequences, assert row-equality + derived-plane
      equality after `rebuildL3` on both.

### canvas-stored
- [ ] LMDB-backed durable job queue with retry/backoff/counters (replaces `SyncQueue`
      in-memory); keep the two-lane execution (worker for `file`, in-process for others).
- [ ] `sync.policies[]` desired-state reconciler: policy match → `locations ⊇ targets` →
      jobs; runs on add/change events and on a periodic full pass; `object:location:add` /
      `synced` semantics unchanged.
- [ ] Delete authority per backend (`owned|mirror|foreign`) + `deletes` policy modes.
- [ ] Conflict handling for same-key divergence (`authority`, `(conflict …)` sibling + tag).
- [ ] `canvas` remote driver (§5.3) — first driver with stored credentials; `s3` after.
- [ ] Batching for scan/drain.
- [ ] Eviction vocabulary (`reason:'evicted'`) so a replicated-then-evicted local copy is
      expressible (needed once the cloud secondary caches instead of mirroring everything).

### canvas-server (later canvas-workspaced)
- [ ] `db/instance.json` instance id; instance tokens (device-token shape, workspace-clamped).
- [ ] Addressing: `name@<instanceId>` for remote entries (migrate `name@hostname-port` on
      first `hello`), replicated workspaces registered as local entries on every peer.
- [ ] Hook service: skip rules for `origin:'replication'` events unless `runOnReplica`;
      `role` exposed to the rule context.
- [ ] `workspace.json → replication{}` + `services.stored.sync{}` schema, migration, and
      `secret://` for peer tokens (do the WorkspaceCrypto work here).
- [ ] Objects endpoint `PUT/GET/HEAD/DELETE /workspaces/:id/backends/:backend/objects/*`
      (server side of the `canvas` driver); reuse content/thumbnail ticket auth.
- [ ] Replication channel on the socket relay (`hello/refresh/persist`) + REST oplog poll
      fallback; wire `RemoteWorkspace` so a secondary's forwarder points at the current
      primary and re-points on epoch change.
- [ ] Secondary write forwarding + read-your-writes (wait for CSN ≤ timeout).
- [ ] Handoff endpoint + 2PC state machine + recovery on reconnect (§4.3).
- [ ] Scheduled db snapshot → blob (`custom/backup/db`) + restore-from-snapshot import path.
- [ ] Forced promotion + divergence bundle (§4.4) — after v1.
- [ ] Docs: `docs/replication.md` (roles, handoff, what to do when it says "fork").

### web
- [ ] Workspace settings › Sync: role/epoch/peers, per-peer lag (head − cursor), handoff
      button with both-online check, "required locally" flag per target.
- [ ] Storage policies UI: extend the rule builder (storage-rules revamp) with `targets[]`,
      `key: same`, mode/deletes/authority; per-target sync progress on the Backends tree.
- [ ] Document view: per-location `synced` state; conflict siblings surfaced with a diff /
      pick action.

## 9. Settled (2026-08-31) and still open

Settled:
- **Hooks, rules and (later) workflows run on the primary only** — they touch data. A rule
  may opt in with `runOnReplica: true` (local-only side effects: downloads, notifications,
  cache warming). Applying an op with `origin:'replication'` never triggers a hook unless
  the rule opted in.
- **Addressing**: replicated workspaces are local everywhere (`name` / `name@localhost`);
  `name@<instanceId>` for true remotes; handoff changes no address (§4.2).
- **Replicator lives in canvas-server** (`Replicator` next to the workspace runtime, behind
  the `workspace` mode flag later). Still the right home once canvas-workspaced exists —
  it moves with the runtime.
- **Placement = hook rules for v1; storage-centric policies later** (§5.0). "Source" backends
  (gdrive, NAS) are not special: watcher → event → rule.
- **Contexts and handoff**: verify with the two-instance recipe that a context bound to a
  replicated workspace keeps `isActive` across a handoff (the workspace is local on both
  sides, so only the forwarder re-points).

Open:
- **Op log payload size** (full rows vs `{id, csn}` + fetch, retention at wiki scale) —
  deliberately unsettled; measure once the oplog exists. Snapshot-refresh covers whatever
  retention policy we pick.
- **Offline annotations on a secondary** (tag/note a website while on the road) — v1 is
  read-only; revisit only if it hurts (§7).
