# Data representation over WebDAV and canvas-fuse

Status: plan, decisions settled 2026-08-05.

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
│   └── <contextId>/
│       ├── Notes/    *.md
│       ├── Tabs/     *.url
│       ├── Todos/    *.todo.json
│       ├── Files/    real bytes
│       └── …               one folder per data/schema/*, from SchemaRegistry
├── Trees/
│   └── <treeName>/
│       └── <tree-path>/…       the tree's own hierarchy
│           ├── <child paths>/
│           └── <documents as flat files>
└── Trash/                       presented at the root; physically /.trash
                                 in the default `directory` tree
```

Already true today: WebDAV's root is exactly `Home`/`Contexts`/`Trees`
(`server.js:44`), and `VirtualNamedContextFS` derives its per-schema folders
from `SchemaRegistry` at runtime rather than a hardcoded list. canvas-fuse
hardcodes the same folder set in context mode and omits it in workspace mode;
consolidating means adopting the WebDAV shape, not inventing one.

**Trash placement (decided).** A workspace is the "drive", so trash belongs at
the workspace root as a visible `Trash/` — drag-to-trash needs a visible target.
Physically it is `/.trash` in the default `directory` tree: dot-prefixed so it
stays hidden from ordinary tree listings and out of `cp -r` of `Trees/directory/`,
while the root presents it under the name users expect. One physical home, one
presented name, no collision with a user-created tree path called `Trash`.

### Schema folders exist only under `Contexts/`

A context view is a flat result set — schema is the only structure available, so
the folders are load-bearing. A tree path *is* the user's hierarchy, so
inserting `Notes/`/`Files/` there:

- collides with user-created tree paths of the same name (a tree path can hold
  child paths **and** documents), requiring an escaping rule forever;
- breaks `cp -r` round-tripping, which is the stated purpose of the workspace
  mount (write `wiki/*.md`, read back `wiki/Notes/*.md`);
- restates information already in the filename;
- costs a `readdir`/`getattr` level on the protocol where that hurts most.

If grouping is wanted under a tree path, it goes in a dotted sibling
(`.by-schema/Notes/…`): hidden by default, immune to collisions since tree paths
cannot start with `.`.

### `-c` / `-w` become views, not layouts

canvas-fuse's two mount modes collapse into one tree plus a `--root` selector
(`--root Contexts/work` reproduces today's single-context rooting).

## 2. A file is a file

**`.md` no longer creates a note.** `inferDocFromFile()` currently maps
`*.md` → `data/schema/note`, `*.todo.json` → `data/schema/task`,
`*.url` → `data/schema/tab`. The first of those is wrong: markdown is a general
document format, not a canvas concept. Markdown-as-note is a *rendering*
decision and belongs in the UI.

- **New** `*.md` (and everything else without a canvas-native meaning) →
  `data/schema/file`, bytes persisted as a blob.
- `*.url` and `*.todo.json` keep their mapping. They are not general formats —
  `.url` is what a browser produces when you drag a link out of the address bar,
  so dropping one into a canvas becoming a Tab is the *desired* behaviour, and
  `.todo.json` only ever comes from our own renderer.
- **Editing an existing note over the wire still updates the note.** `TreeFS.put`
  looks up the existing document by filename and spreads it
  (`record = existing ? { ...existing, data } : …`), so schema is preserved on
  update. Only *new* files take the file path. This asymmetry is correct and
  must be covered by a test, because it is the kind of thing a later refactor
  quietly breaks.

**Default blob location: the local blob store.** `Workspace.persistBlob()` →
`stored://workspace:data/<key>` with checksum, size, mime and inline-extracted
metadata. Per-backend placement policy comes later (see TODO.md, "Storage
policies"); until then this default is the whole rule.

The document shape is the one every upload surface already inserts
(`ui/web/src/components/toolbox/add/useFileFields.ts` → `buildFileDocument`):
`schema: data/schema/file`, `checksumArray: ['sha256/…']`,
`locations: [{ url, metadata: { filename } }]`, `metadata: { contentType, size }`.

**Bug this exposes:** `docName()` in `vfs-shared.js` derives a filename from
`data.filename`, then falls back to `locationBasename(doc)` — the basename of the
location *key*. For a blob that key is a content hash, so a File document
uploaded through the UI currently surfaces over WebDAV as a hash. `docName()`
must prefer `locations[0].metadata.filename`, which is where every upload
surface already puts the real name.

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

### Phase 3 — canvas-fuse

1. One layout (§1); `-c`/`-w` reduced to `--root`.
2. Cross-directory `rename` implemented as a re-tag. Today context mode returns
   `EXDEV`, which makes `mv` fall back to copy+unlink: correct thanks to content
   addressing, but it streams every byte through the mount. Needed for
   drag-to-trash to be one atomic operation.
3. `unlink` keeps calling the same REST endpoints, inheriting `trashIfOrphaned`
   from the server rather than reimplementing it.
4. `Trash/` in the tree.

### Phase 4 — `Home/`

Straight-through FS ops, no document layer, no trash; verify the home
scanner/watcher reconciles deletes and renames. Internals stay hidden via the
existing `internalPathMatcher`.

### Phase 5 — CRUD on `Contexts/**`

`VirtualNamedContextFS` is read-only today, so `Contexts/**` has no write path at
all. Make it writable:

- `put` into a schema folder → document of that folder's schema, linked into the
  context. Unknown/`Files/` → `data/schema/file` + `persistBlob` (§2).
- `del` → detach from the context (§3).
- Per schema, the round-trip contract: render → parse → identical document. Each
  schema is a small independent unit with an obvious test. `.md`/`.url`/
  `.todo.json` are covered by §2; the rest render as JSON and stay read-only
  until someone needs them writable.

### Phase 6 — one conformance suite, both wires

A single table of cases (create, read, rename, cross-dir move, delete-with-refs,
delete-last-ref, context-delete-does-not-trash, move-to-trash, restore, empty)
run against WebDAV **and** a mounted canvas-fuse, asserting identical index state
after each. Without it the two wires diverge quietly.

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
