# Durable workspaces: Augmentd reference design

Status: proposed architecture, based on the checked-out repositories. This document does not enable replication, deploy a service, or establish a durability guarantee for the current implementation.

## Decision

Use one authoritative workspace runtime on the remote server, ordinary full file replicas on the NAS and laptop, and an on-demand filesystem on the GPU workstation. Reuse the existing file sync protocol and `canvas-stored` mirror engine. Add explicit durability policy, immutable version retention, replica receipts, and a persistent workspace job subsystem before relying on automated ingestion for irreplaceable records.

The NAS should run a small Docker file service built from the existing `canvas-edge` mirror runtime and `canvas-stored`. It needs a local sync ledger, but no synapsd index, inference service, agents, or full canvas-server. A separate storage daemon/product is unnecessary for the first implementation.

## Paths and ownership

| Participant | Role | Data root | State |
| --- | --- | --- | --- |
| Remote canvas-server | Authority and full replica | `workspaces/Augmentd` using the home layout | Main index, configuration, job journal and storage metadata under `.workspace/` |
| Synology | Full durable replica | Native NAS directory exported as `smb://172.16.2.200/work/Augmentd` | Local mirror ledger and retained versions in a persistent private volume |
| Main laptop | Full writable replica | `~/Workspaces/Augmentd` | Small local sync ledger; no main database |
| GPU workstation | On-demand writable cache | `~/Workspaces/Augmentd` | Local metadata, bounded content cache and durable pending writes |

`workspace:home` is the canonical **physical file namespace**. Every full replica has the same relative paths and bytes after convergence. A file at:

```text
workspace:home/Accounting/2026/09/Expenditures/invoice.pdf
```

must appear at:

```text
server:  workspaces/Augmentd/Accounting/2026/09/Expenditures/invoice.pdf
NAS:     <native Augmentd root>/Accounting/2026/09/Expenditures/invoice.pdf
laptop:  ~/Workspaces/Augmentd/Accounting/2026/09/Expenditures/invoice.pdf
GPU:     ~/Workspaces/Augmentd/Accounting/2026/09/Expenditures/invoice.pdf
```

The GPU path is visible without requiring resident bytes. `Accountingh/2026/08` in the original example is treated as a typo; a literal 1:1 replica cannot change either the directory name or month. Accounting period selection is a separate rule, with an explicit timezone and date source; receipt month is not automatically invoice month.

“Data only” excludes replication of the live server database and generated context trees. It still requires private device bookkeeping. Server-managed originals, email sources and retained versions also need replication as protected objects outside the visible file tree. Otherwise a mirror of `workspace:home` would omit documents stored only in `workspace:data`.

Scope must be explicit: all regular user files, including business dotfiles; no silent default exclusions. Internal state, temporary files and generated derivatives have separate policies. Empty directory replication needs namespace records because the existing object feed describes files. Unsupported names, symlinks, special files and oversized files must be reported during import, never silently counted as replicated. Permissions, owners and extended attributes are outside the initial data-only contract; preserve bytes, names, hierarchy and useful timestamps. Detect case/Unicode collisions before applying anything.

## Existing foundations and gaps

| Code | Reuse | Gap for this use case |
| --- | --- | --- |
| [Existing sync design](sync.md), [wire protocol](sync-protocol.md) | Hub authority, conditional mutations, change feed, conflict handling | Device lag is not proof of durable storage for a revision; existing exclusions and file-size limits need an import audit |
| `canvas-stored/src/sync/Mirror.js`, `Ledger.js`, `JobQueue.js` | Three-way reconciliation, persistent jobs, retry/recovery, ordinary directories | Jobs coalesce current intent; this is not an immutable revision journal or a workspace workflow queue |
| `canvas/runtimes/edge/src/mirror-runtime.js` | NAS/laptop full folder sync | Currently stores state inside `.workspace`; add external persistent state configuration, container packaging and replica receipts |
| `canvas-fuse/src/mirror/cache.rs` | Disk cache, content hashes, LRU, pins and protected digests | Current downloads use the hub; add verified NAS reads and an exact home-root mount mode (current workspace view adds `Home/`) |
| `canvas-stored/src/backends/file/index.js` | Local and OS-mounted filesystem access | `commit()` removes the destination before link/copy; hardlinks can share mutable inodes; all replacement paths need crash-safe staging |
| `canvas-stored/src/index.js` | Content identity, object mutations and change log | `removeObject()` deletes backend bytes; surviving metadata does not retain those bytes. Filesystem placement and index update require recovery across their boundary |
| `canvas-server/src/core/workspace/lib/WorkspaceStoredIndex.js` | Server mutation locks and indexing bridge | Direct filesystem edits bypass API locks; reconcile conservatively and preserve previous immutable bytes |
| `canvas-server/src/core/workspace/services/imap/` | Raw message/attachment persistence and batch ingestion | Attachment indexing exceptions are caught and logged; a batch can complete without all attachment links. Current fetch payload identifies folder/UID but omits UIDVALIDITY |
| `canvas-server/src/core/workspace/services/hook/index.js` | Rules, hooks, provenance, review actions, cascade limits | Event dispatch runs hook promises; critical work needs a durable outbox and replayable jobs |

These are source observations, not a completed fault-injection audit. The current README assurances should not be interpreted as a guarantee against document loss.

## NAS service and mounted shares

Preferred deployment: bind the actual NAS folder into an unprivileged file-sync container; persist its state on NAS-local storage outside the user file root. Resolve the native Synology volume path at deployment rather than guessing it from the SMB URL. Use a workspace-scoped device credential and outbound authenticated TLS connections to the hub. Restart automatically, expose health and backlog, and keep state through container replacement.

The existing `file` backend can use an OS-mounted SMB directory. Direct `smb://` access is not implemented in the backend registry; represent it as an SMB source requiring an OS mount initially, with a native driver as a later option. Do not interpret an SMB URL as a local path. Keep LMDB and the sync ledger off SMB. Mounted-share mode requires polling/reconciliation, mount identity checks, and bounded I/O retries.

Record a persistent replica/root identity. A disappeared mount, replaced share, permission failure, incomplete listing or unavailable root means **offline**, never “all files deleted.” Do not create an empty fallback root or advance reconciliation after a partial scan. Revalidate root identity before mutation. Freeze destructive operations on unexpected bulk disappearance until a successful scan establishes what happened.

Run only one sync owner for a given NAS root: either the NAS container or a host using the mounted share. Mounting the same share from the laptop does not make it another independent durable copy. NAS SMB edits are supported as changes to its full replica; preserve divergent bytes as conflicts and periodically reconcile because watchers are hints.

## Durability contract

Track both namespace revisions and immutable content. A checksum identifies bytes; it is not a file identity, an occurrence of an email, or an acknowledgement of a path revision. Assign an operation ID and monotonic namespace revision, with the existing SHA-256 as content identity. Use an incarnation/revision precondition in addition to the digest to distinguish delete-and-recreate and same-content edits. Legacy digest-only clients cannot claim the stronger accounting profile.

Expose independent states:

- **Saved here:** committed to this device's durable write journal and storage.
- **Saved on server:** hub committed bytes and recoverable namespace intent.
- **Protected:** the configured independent durable replicas acknowledged the exact content/revision.
- **Fully synchronized:** every required full replica applied the current namespace, with no unresolved skips or conflicts.

For Augmentd, propose server + NAS as the protection requirement, laptop as an eventually complete replica, and GPU as a cache excluded from replica counts. An offline laptop must not block ingestion. An offline NAS permits server ingestion but leaves documents visibly awaiting protection and blocks the invoice's final mailbox action. There is no honest zero-loss guarantee while a new document exists on only one machine; the interface must show that exposure.

Persist per-replica receipts containing workspace ID, replica ID, storage epoch, operation/revision, key or protected-object ID, digest, byte count, durable commit time and verification time. A receipt is issued only after verified bytes and recoverable local state are committed. Ignore duplicate receipts; reject stale epochs and unrelated revisions. A feed cursor or successful HTTP transfer is insufficient. Renew confidence with periodic checksums and report missing/corrupt objects for repair. These receipts assume trusted replicas and correctly functioning storage hardware.

The existing coalesced change feed remains useful for current-state convergence. Add an immutable revision/outbox journal for version retention, critical work and protection accounting. A revision overwritten before the NAS catches up must still be transferable from retained immutable storage. Rebuild current replicas from a consistent listing generation plus its feed watermark; retain the prior merge base and local pending edits across cursor expiry. Absence in a partial or newly initialized scan is not a deletion instruction.

### Commit and recovery

For every write path (API, file watcher, mirror, hook and worker):

1. Stream into a unique temporary file on the destination filesystem and compute/verify its digest. Never expose partially copied bytes at the final name.
2. Flush the file and durably retain immutable bytes. Do not hardlink an immutable retained version to a user-editable inode; use an independent copy or copy-on-write operation with tested semantics.
3. Persist a mutation intent referencing those bytes and the expected old revision. Serialize competing namespace mutations, recheck the precondition, and preserve the prior version before replacement/deletion.
4. Atomically replace the visible file, flush affected directories where supported, and commit namespace/index metadata plus its outbox event. Filesystem and database are not one transaction: replay the intent after crashes, reconciling actual bytes before declaring success.
5. Acknowledge the committed revision; asynchronous index enrichment and worker dispatch can recover from the outbox. Never infer completion solely from a watcher event.

Test filesystem flush behavior on the actual deployment. Direct edits in ordinary folders cannot have application-level write acknowledgement semantics: ingest a stable verified copy and label protection only afterward. Retaining every intermediate edit before the daemon observes it would require a different write surface; protect previously acknowledged revisions instead.

Replica pull/install, conflict preservation and rename/delete use equivalent durable intents. Pending local edits remain protected even if the visible path is replaced or the client restarts. Admission control must stop new writes with a clear error when there is no safe staging space; never evict unacknowledged bytes to make room.

### Replication and backup

A 1:1 current tree propagates deletions and damaging edits. Retain previous bytes separately on the server and NAS, with tombstones and recoverable path history. Conflict resolution must not immediately purge the losing version. Initial accounting policy: no automatic purging until retention is explicitly configured; monitor capacity and backpressure. The appropriate retention period is a separate business decision, not inferred from “15 years.”

Use an independently administered versioned backup/snapshot destination whose history the normal sync credential cannot erase. Protect server configuration, curated metadata, job state and credentials through a consistent encrypted backup; do not mirror an open database directory. Restore must recover more than searchable files: classifications, provenance, automation state and device identities matter. Search/inference derivatives can be rebuilt where their source data is preserved.

## GPU cache and fast local reads

Extend FUSE's mirror mode to mount the home namespace directly at `~/Workspaces/Augmentd`; keep context views elsewhere. Use a configurable disk budget and optional pins, with LRU eviction only for clean, closed, unpinned content that has a durable remote copy. Dirty writes, in-flight uploads, unresolved conflicts and retained local recovery data are non-evictable. Local `fsync` means durable on this machine, not “uploaded to NAS.” Expose remote protection separately.

Read order: local content cache, authorized NAS service on the LAN, then hub. The hub supplies authoritative path revision and expected digest; the NAS supplies bytes for that digest through a scoped read endpoint. Validate the entire received content before publishing it in cache. A stale NAS or changing SMB file must fail verification and trigger retry/fallback, not satisfy a request for a different version. Initially, a configured read-only mounted-NAS source can provide the same verified fallback; automatic LAN discovery is unnecessary.

Do not introduce peer write arbitration: all clients submit conditional namespace changes to the hub. NAS reads optimize bytes only. With the hub unavailable, use the last known namespace and label it stale; cached/NAS-resident bytes can be read, writes queue locally, and uncached unreachable content returns a clear availability error. A namespace refresh on reconnect resolves pending writes through the existing conflict model.

## Workspace processes and workers

Define the process boundary now, then migrate services incrementally:

```text
canvas-server supervisor / authentication / transport routing
  └─ workspace process: Augmentd
       ├─ sole owner of workspace DB, namespace mutations and job journal
       ├─ IMAP worker process (long-lived account subscription)
       ├─ rule/hook worker processes (bounded job execution)
       └─ agent worker processes → canvas-agentd / canvas-inferd as appropriate

NAS and laptop file-sync services are independent device processes.
```

Children communicate through versioned RPC and scoped content streams, never through shared open database handles or serialized JavaScript Workspace objects. Workers submit commands; the workspace owner validates authority and commits mutations. Initially the owner can run in-process behind the same RPC-shaped interface; worker execution should use child processes. The supervisor routes by workspace ID, owns lifecycle/restart policy, and ensures one active workspace owner. IMAP-enabled workspaces remain active even without a connected UI.

Separate the long-lived IMAP listener from finite jobs. Persist a connector checkpoint only after raw messages and an ingest job are durably accepted; that checkpoint does not imply the invoice is classified, replicated or archived.

Job records need `jobId`, workspace, type/version, idempotency key, immutable input refs, causal event, rule/config version, status, attempts, next-run time, lease owner/expiry, fencing generation, step results, error and timestamps. States include queued, running, retry-wait, waiting-for-replica, needs-review, succeeded and failed. Acquire/renew leases transactionally; expired leases requeue work. Workspace commits reject stale fencing generations. External operations still need their own reconciliation because IMAP cannot enforce our fencing token.

Deliver at least once, make each step idempotent, and record observable effects. Never promise distributed exactly-once execution. A transactional outbox bridges namespace changes to jobs; dispatch acknowledgement and job deduplication must survive restart. Critical ingest jobs dedupe by source occurrence and workflow version, not the mirror queue's “latest operation for this path” semantics. Retain retries and failures for inspection, with backoff, timeouts, cancellation, per-account concurrency, resource limits and orderly shutdown. One unavailable connector must not block all workspace jobs.

Rules and agents propose classifications and file commands against an expected revision. Deterministic validation enforces destinations and retention. Preserve current review controls and cascade limits; stamp causation so the resulting move does not endlessly retrigger the same rule. Store model/rule output so a retry does not silently recategorize an already committed invoice.

## Invoice workflow

Suggested default: retain the original email and every original attachment, classify the PDFs, materialize them under home, wait for server + NAS protection, then move the source email. This reverses the example's mailbox-first ordering so a failed file operation cannot leave an apparently completed email.

1. The IMAP listener captures account ID, mailbox, UIDVALIDITY and UID. Durably spool raw MIME and create an ingest job before advancing its acquisition checkpoint. Use that tuple as source occurrence identity; retain Message-ID and raw hash as secondary reconciliation evidence. UIDVALIDITY changes require rescan/reconciliation, not reuse of an old UID cursor.
2. Parse from the spool with bounded memory, assign each attachment a MIME-part identity and digest, retain originals and record email-to-attachment provenance. Content deduplication must not collapse distinct receipt occurrences. All expected attachment indexing/linking steps must complete or remain retryable; logging an error is not success.
3. Classify and validate. Preserve uncertain or unreadable material in `Accounting/Incoming/NeedsReview` and record why it needs review. Validate expense category and accounting period; do not use an arbitrary date supplied by a model without the configured rule. Never overwrite another invoice based on its original filename.
4. Persist the chosen plan, including exact names, digests and destination keys. Use a stable invoice/occurrence suffix where names collide, and conditional create. A retry adopts its previously committed matching operation, rather than allocating another filename. Several PDFs in one email have independent child outcomes; the parent cannot succeed until every required attachment is handled.
5. Publish the PDF as a real file at `workspace:home/Accounting/2026/09/Expenditures/<name>.pdf` through the workspace mutation API. This is a physical placement, not merely a link into a virtual tree. Keep the immutable original even if the visible file later moves.
6. Wait for verified server + NAS receipts for the filed PDF and retained email/attachment originals. Laptop delivery proceeds independently. NAS downtime leaves the job in `waiting-for-replica`, visible and resumable, without blocking ingestion of later messages.
7. Move the email to `INBOX.Invoices.2026` using the mailbox's discovered hierarchy delimiter. Persist the mailbox action intent first. Reconcile source and destination after timeout/restart; store destination UID/UIDVALIDITY when available. Prefer a server-supported move; a copy/delete fallback must verify the destination before deleting the specific source and must not expunge unrelated messages. Ambiguity becomes retry/review, never another blind destructive attempt.
8. Mark the workflow complete with provenance, paths, replica receipts and mailbox result. A mailbox action failure retries only that step. A user moving the email independently must not cause the PDF to be created again.

No atomic transaction spans IMAP, filesystem, database and replicas. The durable step log and reconciliation of effects provide recovery between each pair of steps. Raw MIME retention also makes recovery possible if an email disappears externally before classification completes.

## Implementation sequence and acceptance gates

1. **Storage safety (`canvas-stored`, server bridge):** atomic staged replacements on every path, immutable retention, recovery intents, serialized revision checks, tombstones, explicit namespace scope. Gate: injected crashes/disk-full errors at every commit boundary preserve old or new verified bytes; concurrent writes cannot silently replace unseen revisions.
2. **Replica policy (`canvas-stored`, `canvas-server`, protocol package):** durable receipts, storage epochs, protected-object replication and protection API/UI. Gate: NAS outage, stale receipts, full disk, checksum mismatch, rapid overwrites and cursor expiry never produce a false protected state. Rescan retains local offline edits and does not manufacture deletions.
3. **NAS/laptop runtime (`canvas/runtimes/edge`):** external state directory, container packaging, root identity, clean shutdown and full-tree reconciliation. Gate: SMB disconnect/reconnect, container replacement and NAS root substitution cause no mass delete or loss of queued edits. Test both native NAS storage and mounted SMB.
4. **Workspace jobs (`canvas-server`):** owner/worker RPC contract, durable outbox, leased queue, child-process supervisor and status/retry surface. Gate: killing a worker or workspace at every step yields a recoverable job; stale workers cannot commit. Reuse service interfaces while moving workspaces into separate processes.
5. **Invoice pipeline (`canvas-server`):** durable MIME capture, reliable attachment outcomes, classification plan, physical placement, protection barrier and reconcilable mailbox move. Gate: duplicate delivery, UIDVALIDITY reset, missing attachment, filename collision, uncertain classification and lost move response preserve originals without duplicate final placements.
6. **GPU access (`canvas-fuse`, NAS read endpoint):** home-root mount and verified NAS fallback. Gate: stale NAS bytes never pass digest validation, dirty/open/pinned data survives cache pressure and restart, and cold reads work over LAN without fetching file bytes from the remote hub.
7. **Historical migration and restore:** inventory all 15 years before enabling destructive sync. Import with deletion propagation disabled, manifest every path/hash/size and surface exceptions. Verify server + NAS and the full laptop replica against the import manifest, then test a clean restore of files and server metadata. Keep source archives until verification and restore succeed; enable invoice mailbox actions only after these gates pass.

Operational status should show per-replica last contact, pending bytes, oldest unprotected document, verification age, conflicts/skips and free space, plus workflow stage and actionable failures. “Connected” and “caught up to cursor” must never substitute for “this document is protected.”

Deployment inputs still needed later: actual NAS native path/CPU/container support, remote workspace root and identity, GPU OS and cache budget, IMAP credentials and mailbox capabilities, accounting-period rule, and retention capacity/policy. These do not block the architecture; they must be resolved before deployment.
