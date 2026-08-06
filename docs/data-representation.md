# Data representation over WebDAV and canvas-fuse

Status: implemented. Decisions settled 2026-08-05; phases landed 2026-08-05/06.

One layout, one set of verbs, served by two wires (`src/transports/webdav/`,
`src/ui/fuse/`). The point is not to make a filesystem out of the index — it is
to make the *representable* subset of filesystem semantics map onto index
operations that are always safe, and to make the non-representable ones
(`delete` vs `remove`, "from which backend?") impossible to trigger by accident.

## 0. The insight this rests on

**Content addressing turns the unrepresentable "move" into a composition of two
representable operations.**

synapsd dedups an id-less `put` by checksum (`index.js`: "Only when no id
matches do we fall back to content-addressed (checksum) dedup"), and `stored` is
content-addressed throughout. So when a file manager performs a move as
*copy-then-delete* — which is exactly what Finder and Explorer do across
directories — the copy resolves to the **same document id**, links it into the
destination path, and the following delete unlinks it from the source. The net
effect is already a correct re-tag. No client sniffing, no heuristics.

Hence the invariant the whole design hangs on:

> A document's identity is its content, not its location. Linking is cheap and
> idempotent; unlinking is non-destructive; only an explicit action on a
> dedicated folder may destroy.

## 1. Layout (canonical for both wires)

```
<workspace>/
├── Home/                        1:1 with the home drive, minus internals
├── Contexts/
│   └── <contextId>/            FLAT: the context's documents, as themselves
│       ├── note.md
│       ├── reddit.url
│       └── .by-schema/         derived, read-only grouping
│           ├── Notes/ Tabs/ Files/ …   one folder per data/schema/*
├── Trees/
│   └── <treeName>/
│       └── <tree-path>/…       the tree's own hierarchy
│           ├── <child paths>/
│           └── <documents as flat files>
└── Trash/                       presented at the root; physically /.trash
                                 in the default `directory` tree
```

Both wires serve this today. The per-schema folders under `Contexts/` are
derived from `SchemaRegistry` at runtime, not a hardcoded list — a new schema
gets a folder with no code change.

**Trash placement (decided).** A workspace is the "drive", so trash belongs at
the workspace root as a visible `Trash/` — drag-to-trash needs a visible target.
Physically it is `/.trash` in the default `directory` tree: dot-prefixed so it
stays hidden from ordinary tree listings and out of `cp -r` of `Trees/directory/`,
while the root presents it under the name users expect. One physical home, one
presented name, no collision with a user-created tree path called `Trash`.

### Synthetic groupings are dotted; real placements are plain

One rule for the whole mount: **location never infers meaning.** A file is what
its name and bytes say it is, wherever you drop it, and any view that is a
*query* rather than a place is dotted and read-only.

`Contexts/<id>/` was originally one folder per schema (`Notes/`, `Tabs/`, …).
That made those folders saved queries wearing a folder's clothes, and a
filesystem notices:

- `mkdir` had to be refused — you cannot make a folder inside a folder;
- copying `Notes/x.md` into `Files/` **reported success and then listed
  nothing** (measured, not theorised: the destination filters by schema, and the
  document's schema had not changed);
- the same `.md` bytes were a note under `Contexts/` but a file under
  `Trees/**`, so the rule you had to hold in your head depended on which subtree
  you were standing in.

Grouping now lives in `.by-schema/` — derived, read-only, dotted, and out of
`cp -r`'s way. The same argument already applied under `Trees/**`, where a tree
path IS the user's hierarchy and schema folders would collide with it, break
round-tripping and restate what the filename already says.

What the flat shape buys beyond consistency: a context-bound browser becomes
addressable from a file manager. `rm reddit.url` closes that tab, writing a
`.url` opens one, editing one navigates it — the CLI could always do this, but
now anything that can write a file can.

### One mount is one workspace

canvas-fuse mounts a single workspace; contexts are addressed inside it, never
across workspaces. `canvas-fuse mount <workspace> <dir>` gives the layout above;
`<workspace>/Contexts/<id>` roots at one context. `-w` / `-c` are the flag forms
(see its README).

## 2. A file is a file

**`.md` does not create a note.** Markdown is a general document format, not a
canvas concept; markdown-as-note is a *rendering* decision and belongs in the
UI. (Under `Contexts/**` the folder declares the schema instead — see Phase 5.)

- **New** `*.md` (and everything else without a canvas-native meaning) →
  `data/schema/file`, bytes persisted as a blob.
- `*.url` and `*.todo.json` keep their mapping. They are not general formats —
  `.url` is what a browser produces when you drag a link out of the address bar,
  so dropping one into a canvas becoming a Tab is the *desired* behaviour, and
  `.todo.json` only ever comes from our own renderer.
- **Editing an existing note over the wire still updates the note.**
  `applyBodyToDoc()` applies a body in the document's OWN schema, so only *new*
  files take the file path. This asymmetry is deliberate and covered by a test,
  because it is the kind of thing a later refactor quietly breaks.

**Default blob location: the local blob store.** `Workspace.persistBlob()` →
`stored://workspace:data/<key>` with checksum, size, mime and inline-extracted
metadata. Per-backend placement policy comes later (see TODO.md, "Storage
policies"); until then this default is the whole rule.

The document shape is the one every upload surface already inserts
(`ui/web/src/components/toolbox/add/useFileFields.ts` → `buildFileDocument`):
`schema: data/schema/file`, `checksumArray: ['sha256/…']`,
`locations: [{ url, metadata: { filename } }]`, `metadata: { contentType, size }`.

(This exposed a bug — uploaded files surfaced as content hashes — fixed by the
resolver in §2b.)

## 2b. What a file is called — **DECIDED + LANDED 2026-08-05**

The same bytes may be called something different at every location (an IMAP
attachment, a copy on a NAS, the upload name). Those are facts about *copies*.
The document needs one name, resolved deterministically:

1. **`metadata.filename`** — the document's own name, written by a rename
   through any surface. Absent until someone renames.
2. `data.filename` — the same idea for JSON abstractions (note/todo/tab).
3. The name on the **canvas-owned** copy (`stored://workspace:*`), set at ingest.
4. Any location name, by a **stable sort** (url) — never array order.
5. The URL basename, but only for schemes whose path really is a name; a
   `stored://` key is a content hash and never yields one.
6. A schema-derived fallback (`note-123.md`).

**Position must never decide.** `locations` is append-ordered
(`mergeDocumentLocations`) and rebuilt per backend scan, and mirror/device
entries carry `metadata.backend` rather than a filename — so the old
`locations[0]` rule let a file rename itself to a **content hash** the moment a
mirror landed in front of it.

**A rename is a statement about the document, not about one copy** — hence
document level, not a `primary: true` flag on a location (the flagged copy can
vanish with its backend). Every location keeps whatever that backend really
calls the bytes, and they all stay searchable via `locationUrls`.

Consequence, accepted: one display name per document, so the mounts behave like
**hard links** — a document filed in three paths shows one name, and renaming in
any of them renames everywhere. Per-placement names would need per-placement
metadata, which bitmaps cannot carry; out of scope unless it hurts in practice.

Implementation: `displayFilename()` / `renamedRecord()` in
`transports/webdav/vfs-shared.js`, mirrored in the web UI's
`lib/document-display.ts`; `core/File.js` indexes `metadata.filename` for FTS
(additive — documents without it index exactly as before, no reindex needed).

## 3. Verb table

| FS action | `Home/` | `Contexts/**` | `Trees/**` | `Trash/` |
|---|---|---|---|---|
| create / write | real `write(2)`, index reconciles | `put` → doc, linked into the context | `put` → doc, linked into this path | ✗ 403 |
| read | real bytes | resolve doc content | same | same |
| rename in dir | real rename | update filename, same doc | same | ✗ |
| **move across dirs** | real rename | **re-tag** by doc id | **re-tag** by doc id | out = **restore** |
| **delete** | real `unlink(2)`, no trash | **detach only** | unlink from this path; if that was the last reference, link into `/.trash` | ✗ |
| move *into* `Trash/` | n/a | unlink from all paths + trash | same | n/a |
| empty trash | n/a | n/a | n/a | **destroy** (manual only) |

**`Contexts/**` detaches, never trashes (decided).** A context is a *view*;
removing something from a view is not deletion, and a context's documents are
reachable through their tree paths regardless. Trash-if-orphaned applies to
`Trees/**` only, where the path really is the document's home.

Both wires already implement the first clause of delete: `TreeFS.del()` calls
`Workspace.unlink()`, and canvas-fuse's `unlink`/`unlink_ws` call the REST
`remove` endpoints with the comment "`rm` detaches … never destroys". The
missing piece is the orphan → `/.trash` step.

`Workspace` already has both verbs (`unlink()` vs `delete()` with
`#collectDeletionArtifacts` / `#cascadeManagedBlobDeletion`), and REST already
exposes `/remove`, `/destroy` and `/purge`. Nothing new is needed at the bottom.

### Why "trash only when orphaned"

Unlink alone is already safe and reversible. The single failure mode is the
*last* reference: the document becomes unreachable except in whole-workspace
scope. The rule buys exactly one invariant, and keeps `Trash/` small enough to
be usable:

> No document is ever made unreachable by a filesystem delete.

The orphan test is a bitmap operation we already have — `listTreeDocuments`'s
`linked` filter is built on `#membershipBitmapExcludingTree()`, the same union
that powers the web UI's "Unfiled only". It needs generalizing to "membership
anywhere", not inventing.

### Untrash is automatic

Because a copy-then-delete move can arrive in either order, linking a document
into any real path **drops its `/.trash` tick**. Delete-then-copy therefore
self-heals instead of leaving a ghost in the trash.

### Empty Trash is the only destroy, and it is manual

No age-based auto-purge — destruction on a timer, with no UI yet showing what is
in there, is not a trade worth making. Emptying purges from the index and from
**canvas-owned** backends (`stored://`), where destroy really means *drop the
last reference* to a content-addressed blob — other documents sharing a checksum
keep it alive, which `#cascadeManagedBlobDeletion` already handles. Foreign
backends (IMAP, a mounted NAS) are never touched.

This is explicitly an interim rule: the real answer is per-backend storage
policy, which exists neither in `stored` nor in `Workspace`/the UI. Tracked in
TODO.md under "Storage policies".

### `Home/` has no trash, deliberately

`Home/` is a real filesystem; delete is `unlink(2)` and the index reconciles via
the existing home scanner — no round trip through the document layer. File
managers already warn "this item will be permanently deleted" on network mounts
instead of using their local trash, which is honest and correct here. Two delete
semantics under one mount is fine because the boundary is a visible top-level
folder.

## 4. Phases

### Phase 1 — server: the Trash primitive — **LANDED 2026-08-05**

*All of it server-side on purpose. Implementing this rule twice, once in
`TreeFS.js` and once in Rust, is how it drifts — cf. the workspace-not-active
response that existed as a 400, a 404 and a 500 simultaneously.*

- `Workspace.TRASH_PATH = '/.trash'` in the default `directory` tree.
- **No synapsd change was needed.** `listDocumentTreeMemberships()` already
  answers "which paths of which trees hold this document" (it backs the Synapses
  tab / `GET /documents/:docId/memberships`). `Workspace.listDocumentPlacements()`
  runs it across every tree; that one primitive is both the orphan test and the
  restore provenance.
- **The orphan test is not "has no memberships".** Every insert ticks the default
  context tree's root and `unlink` refuses to remove it, so a naive membership
  test reports every document as filed forever. `#isFiled()` therefore ignores a
  `/` membership in a CONTEXT tree — but counts it in a directory tree, where `/`
  is a real folder nothing ticks implicitly.
- `Workspace.unlink`/`unlinkMany(..., { trashIfOrphaned: true })` — snapshot
  placements first (afterwards the paths a restore needs are gone), unlink, then
  file into `TRASH_PATH` if the document is now unfiled. An unlink that orphans
  nothing (already-detached document) does **not** trash: it would arrive with no
  provenance and a bulk remove would sweep unrelated documents in.
- Untrash-on-link in `put`/`link`, via an in-memory id set so the write path
  costs a `Set.has`.
- Provenance in `db.internalStore` under `workspace/trash/<id>` — no document
  mutation, no checksum churn. Restore re-links the recorded path set and
  recreates paths deleted meanwhile. A restore with nothing to restore to leaves
  the document IN the trash (taking it out would strand it: filed nowhere and no
  longer listed).
- REST: `GET|DELETE /workspaces/:id/trash`, `POST /workspaces/:id/trash/restore`,
  plus `?trashIfOrphaned=true` on `DELETE /documents/remove` — the endpoint
  canvas-fuse already calls. Off by default: the plain API keeps detaching.
- Tests: `tests/core/workspace/trash.test.js` (9). Verified end-to-end over REST
  against a running server too, which is what caught the already-detached and
  failed-restore cases.

### Phase 2 — WebDAV — **LANDED 2026-08-05**

- **One resolver for both the request path and a MOVE Destination**
  (`WebDAVHandler#_resolveVirtual`). That is what lets a move cross roots without
  the two sides disagreeing about what a path means; the old `_vMove` had its own
  regex and could only move within one virtual tree.
- **`MOVE` is a doc-id re-tag.** Every virtual FS answers `docAt` / `linkDoc` /
  `unlinkDoc`, so a move is link-there + unlink-here — in that order, so a
  failure leaves the document findable in both places rather than neither. A 4GB
  blob now moves as cheaply as a note (the old code buffered the whole body).
  A rename in place is the same call: `linkDoc` updates `data.filename` when the
  destination basename differs, keeping id, content and checksums.
- **`Trash/` is a real root** (`TrashFS`), flat by design. `MOVE` onto it unfiles
  from *every* placement (the explicit "remove it everywhere" gesture, unlike a
  plain delete); `MOVE` out restores — the re-filing itself un-trashes, since
  Workspace drops the trash tick on any link to a real path. `DELETE` inside it
  destroys; `PUT` into it is 403.
- **`DELETE` under a tree carries `trashIfOrphaned`**; contexts detach only.
- **Client sidecars** (`.DS_Store`, `._*`, `desktop.ini`, lock/`~$` files) are
  accepted and dropped rather than 403'd — a `cp -r` from a Mac must not look
  failed — and never become documents.
- Tests: `tests/transports/webdav/trees-trash.test.js` (8), driving the real
  handler against a real workspace. Also verified over HTTP against a running
  server with a throwaway workspace: PUT → MOVE → DELETE → Trash → MOVE out →
  drag-to-trash → permanent delete, plus the sidecar and 403 cases.

Two bugs surfaced on the way, both pre-existing and both fixed:

- **`DirectoryTree.list()` could never return a document.**
  `getDocumentsByIdArray` always answers with an envelope (`{ data, count,
  error }`), and `list()` guarded with `Array.isArray(docs) ? … : []` — so it
  returned `[]` every time. WebDAV listings of a directory tree showed folders
  but never files, `TreeFS#findDoc` never found an existing document (so a
  re-PUT forked a new one instead of updating), and deleting a document 404'd.
  Fixed in synapsd with a regression test.
- **`docName()` showed uploaded files as content hashes** — it fell through to
  the location KEY (a hash) instead of `locations[].metadata.filename`, which is
  where every upload surface already puts the real name.

### Phase 2b — WebDAV completions — **PARTLY LANDED 2026-08-05**

Landed:
- **COPY** — dispatched for the index-backed roots (it was falling through to
  405). It is MOVE without the unlink, which is what a document already
  supports: no bytes are duplicated, the document gains a placement.
- **Folder MOVE/rename** — `docAt()` answers null for a collection, so folder
  moves used to 404. A folder move is a *tree* operation (`movePath`/`copyPath`),
  and the documents filed under it come along untouched. Within one tree only:
  across trees the nodes have nothing in common, which is an honest 502.
- **The trash path no longer shows up inside its own tree.** It has its own DAV
  root; listing it under `Trees/directory/` too would be a second door into the
  same folder, one that bypasses the trash semantics. (The web UI still shows
  `.trash` in its tree view — see below.)

**The file-write path — LANDED 2026-08-05.** "A file is a file" (§2) is real:

- `inferDocFromFile()` now answers only for `.todo.json` / `.url`; everything
  else — markdown included — becomes a **File document** whose bytes go to the
  local blob store via `persistBlob`.
- `applyBodyToDoc()` is its counterpart for documents that already exist:
  saving over a note edits the note. Editing through a mount must never change
  what a document *is*.
- Re-writing a file keeps the document id and placements and moves the checksum.
- `Home/ ↔ Trees/` both ways: ingest on the way in (`_ingestFromHome`),
  materialize on the way out (`_materializeToHome`). A MOVE into Home unfiles
  with the normal rule, so a last placement lands in the trash and stays
  recoverable — and if the home backend indexes the new file, content addressing
  resolves it back to the same document, which un-trashes it.
- Re-ingesting identical bytes resolves to the **same document** with a second
  placement, not a duplicate — the premise in §0, now covered by a test.

Two bugs found and fixed while building it:
- **A rename in place undid itself.** MOVE is link-there + unlink-here, and when
  "there" and "here" are the same folder the unlink removed the document from
  the folder it had just been renamed in — i.e. every F2 in a file manager.
- **In-folder COPY silently renamed the original.** A duplicate resolves to the
  same document by checksum, and a document has one name, so "duplicate here"
  cannot mean anything: it now answers 409 instead of quietly doing the wrong
  thing.

**Web UI parity — LANDED 2026-08-05.** The mounts and the UI now agree about
what a delete does:

- **Settings → Trash** (`components/workspace/trash-panel.tsx`): what is in the
  trash, where each document came from and when, per-item Restore and permanent
  delete, and a two-click Empty. Restore is disabled with a reason when nothing
  was recorded to restore to, rather than failing on click.
- The UI's **remove** action now sends `trashIfOrphaned` — but only the two
  user-initiated handlers. The move/drag paths deliberately do not: they file at
  the destination first, so the source unlink orphans nothing.
- `.trash` is pruned from the tree in `getCachedWorkspaceTreeByName`, the one
  seam every tree consumer passes through. Pruned at the ROOT only — a user
  folder called `.trash` deeper in a tree is theirs to see.

### Phase 3 — canvas-fuse — **SEMANTICS LANDED 2026-08-05, layout still open**

Done — the parts that change what an operation MEANS:

- **`rm` carries the trash rule.** `remove_tree_document` takes
  `trash_if_orphaned`; the user-initiated unlink passes `true`, so the server
  applies the same rule as WebDAV — canvas-fuse reimplements nothing. The
  overwrite-rename path (an editor's atomic save) passes `false` on purpose: the
  source document was superseded by the copy, not removed by the user, and it
  must not land in the trash as if it had been.
  Context mode still only detaches, per the decision that a context is a view.
- **Cross-directory moves are re-tags.** Both `mv` between folders and folder
  moves used to return `EXDEV`, so the kernel fell back to copy+unlink and
  streamed every byte through the mount. A file now links at the destination and
  unlinks at the source (link first — a failure leaves it in both places, not
  neither); a folder move is a tree `movePath`, carrying its documents with it.
  Works across trees too, since both halves are path-scoped.
- `Tree::move_tree_file` / `move_tree_path_node` reindex the affected trees, so
  the local view's path index follows the document — a stale path there would
  send the next edit to the folder the document just left.

Layout consolidated (**v0.5.0**):

- A workspace mount now has the WebDAV shape: trees moved under **`Trees/`**,
  and **`Trash/`** is a root of its own (flat, refreshed each reconcile).
- **`--root <selector>`** is the one way to say what a mount is rooted at:
  `<workspace>`, `Contexts`, or `Contexts/<id>`. `-w`/`-c` still work as
  deprecated aliases, so existing scripts keep running.
- `rm` inside `Trash/` destroys, as in a file manager. It has to be special:
  detaching there would be a silent no-op, because the document is already
  orphaned and the server would file it straight back.

**A mount is one workspace** — contexts are addressed inside it, never across
workspaces (the contexts API is user-wide, so the worker filters by the mount's
workspace id). The selector says which:

```
canvas-fuse mount universe ~/MyWorkspace                 # Trees/ + Trash/
canvas-fuse mount universe/Contexts ~/ctx                # that workspace's contexts
canvas-fuse mount universe/Contexts/foo ~/MyFooContext   # one context, rooted
```

`-w` / `-c` are the flag forms of the same thing and now combine (`-w universe
-c foo`); a selector naming two different workspaces is an error rather than a
silent pick.

**`Home/` in canvas-fuse — LANDED 2026-08-06.** The drive is passed straight
through: directories are listed the first time something looks into them (a home
drive can be enormous, so it is never walked at mount), reads take a byte window
through the Range support above, and writes replace the whole file on close.
`rm`/`mkdir`/`rmdir` are the filesystem's own — no trash, no detach.

Three bugs found by driving a real mount, none of which a unit test would have
caught:

- **`PUT /home/*` rejected every binary body with 415.** Fastify needs a
  content-type parser for `application/octet-stream`, and the route had none —
  so uploads from any filesystem client were impossible. Registered
  plugin-scoped, streaming (a large file never buffers).
- **A shell's flush-before-write finalized the create.** `echo > file` flushes
  once before writing; that published the file and dropped the write state, so
  the following `write(2)` had nowhere to land (EACCES, 0-byte file on the
  server). Home creates now defer like document creates, and only the FINAL
  flush retires the overlay.
- **The published node must ADOPT the overlay's ino.** The kernel already handed
  that ino to the process from `create()`; allocating a fresh one left the
  cached dentry pointing at nothing, so a file read back as ENOENT until the
  directory was listed again. `adopt_tree_file()` had solved this for documents;
  home files now do the same.

### Byte ranges — **LANDED 2026-08-06**

Neither wire honoured `Range`: WebDAV's `_get` and `GET /home/*?download` both
streamed whole files. So seeking in a large file re-read it from the start, and
changing one byte of a 1 GB file cost a full download and a full upload.

`GET` now serves single byte ranges on **both** kinds of file — real files under
`Home/` and blob-backed documents — with `Accept-Ranges`, 206 + `Content-Range`,
416 for a window past the end, and 200 for a multi-range request (legal, and
multipart/byteranges buys nothing for players and editors).

The document half cost almost nothing: `stored` already had
`getRangeStreamByUrl` and `WorkspaceStoredIndex.resolve()` already returned
`{ data, ranged }` — nothing was calling it. 206 is answered only when `ranged`
is true; a backend that cannot seek returns the whole body, and claiming 206
there would be a lie the client cannot detect.

### Phase 4 — `Home/` — **LANDED 2026-08-05**

Straight-through FS ops, no document layer, no trash. The work was verifying
that the index keeps up with a drive that changes behind its back — and it did
not:

- **A deleted home file in any SUBFOLDER never reconciled.** `#purgeOrphanedPaths`
  listed the backend's mirror root with `db.list({ directory })`, which is not
  recursive, so it only ever saw files sitting directly in the drive root.
  Everything nested — i.e. almost every real file — kept a location pointing at
  bytes that were gone: a ghost document that still lists, still matches
  searches, and fails on read. Now lists the subtree via `listTreeDocuments`.
  The live chokidar path was never affected (it reconciles by checksum), so this
  hit exactly the 2-device case: files removed while the server was down, or a
  mount with `watch:false`.
- **The test double hid it.** `WorkspaceStoredIndex.test.js` stubbed `list()`
  with a loose `startsWith` prefix match — MORE permissive than the real db, so
  the production call looked correct under test. Both stubs now model the real
  recursive semantics.

Confirmed behaviour (`tests/core/workspace/home-reconcile.test.js`): a new file
becomes a document mirrored in the backends tree; deleting it drops the location,
sets `orphanedAt`, unticks the mirror path and **keeps curated placements**; the
same bytes returning re-bind to the same document; a rename keeps one document;
workspace internals and dotfiles are never indexed.

Also added: `Workspace.syncBackend(driver, address, { background: false })` — a
caller that needs to act on the reconcile can now await it.

### Phase 5 — CRUD on `Contexts/**` — **LANDED 2026-08-06**

`VirtualNamedContextFS` was read-only; it now answers the same verbs as
`TreeFS`, and `VirtualContextsFS` delegates them.

It also went **flat** (see §1). The first cut kept the schema folders and made
the folder declare the schema — coherent, but it needed a second mental model
for one subtree, and it produced a copy that succeeded into nothing. Now the
naming rule is the mount's single rule: `.url` and `.todo.json` carry a canvas
meaning, everything else is a file, everywhere.

Deleting **detaches from the view only** — never trashes, never destroys.
`mkcol` is refused (a context is flat), and `.by-schema/` refuses writes.

Tests: `tests/transports/webdav/context-writes.test.js` (7), against a real
workspace with a Context stand-in (the Context class is permissions + events
over `workspace.put/unlink`; what is under test is what the VFS asks it for) —
including the browser case: editing a `.url` navigates the tab, removing it
closes it.

**Known divergence:** canvas-fuse's context mode still materializes the old
schema folders (`render.rs`'s `SCHEMA_DIRS`, the NameStore keyed by
`(context, dir, doc)`, `WRITABLE_DIRS`). Until it is moved over, the two wires
disagree about the shape of `Contexts/` — the one place they currently do.

### Phase 6 — the contract, as one table — **LANDED 2026-08-06**

`tests/transports/webdav/conformance.test.js` states the filesystem contract in
terms of **index state after each gesture** — not HTTP, not FUSE — so it reads
as the specification both wires are held to: create, edit, copy, move, rename,
delete-with-another-placement, delete-of-last-placement, restore, drag-to-trash,
empty, folder move, Home in/out, and a byte range. canvas-fuse exercises the
same rules through its tree state (`src/ui/fuse/tests/wsview.rs`); the REST
calls underneath are the ones asserted here.

Writing it surfaced one semantic worth stating out loud, now asserted: a
document has **one name**, so renaming it in one folder renames it in every
folder it is filed into — hard-link semantics, the consequence accepted in §2b.

## 5. Decisions (2026-08-05)

1. **Trash location** — visible `Trash/` at the workspace root, physically
   `/.trash` in the default `directory` tree.
2. **Retention** — manual emptying only. No auto-purge.
3. **Contexts** — detach only; trash-if-orphaned is a `Trees/**` rule.
4. **Destroy scope** — index + `stored://` for now; foreign backends untouched.
   Interim: the real answer is fine-grained storage policies (TODO.md).
5. **`.md` is a file, not a note** — markdown-as-note moves to the UI; existing
   notes still update in place on edit.
6. **Default blob location** — the local blob store (`stored://workspace:data`),
   until placement policy exists.
7. **`MOVE`** — doc-id re-tag where possible, streaming only where bytes must
   actually move.
