---
name: project_schema_refactor
description: BaseDocument v3 golden standard + schema simplification decisions; Lance dim-mismatch silently drops the table
metadata: 
  node_type: memory
  type: project
  originSessionId: e81ed646-504f-418f-956a-3ff78e7246fd
---

Design decisions taken 2026-07-15 (EOW-ish refactor). All written up in `src/services/synapsd/TODO.md`
("BaseDocument v3 — the golden standard", "Schema simplification", "Vector provenance"). NOT implemented yet.

**⚠️ LANDMINE, tell the user before any embedding-model test**: `VectorIndex.initialize()`
(synapsd `indexes/lance/VectorIndex.js:92-97`) — if the on-disk vector width != configured `#dim`,
it does `dropTable` + `createEmptyTable`, **destroying every vector in that space**, announced via
`debug()` only (invisible at default log levels). A qwen-VL (1024d+) model pointed at the 384d
`vec_text` space wipes all note/email vectors on startup. **Matryoshka truncation (1024→256) is the
same code path.** User needs qwen-VL + MRL tests SOON → fix or warn first.

**Scope rule (user):** do NOT sweep the 13 abstractions — most move app-side anyway. Fix
BaseDocument as the foundation; the registry carries the rest.

**Measured** (real note doc, universe): total 1129 B → `indexOptions` **461 B = 40.8%**
(embeddingOptions alone 203 B), metadata 140, checksumArray 124, **`data` = 42 B = 3.7%**.
7M rows ⇒ ~3.2 GB identical config. Target v3 ≈ 620 B (−45%).

**BaseDocument v3 shape**: `id, schema, schemaVersion, createdAt, updatedAt, data{}, comment'',
features[], locations[], timelines[], metadata{}, checksumArray[]`. Symmetry that makes it legible:
**features=asserted, metadata=extracted, data=payload, locations=where, timelines=when** — one
question each, one writer class each.

**Removals (all verified this session):**
- `indexOptions` → registry keyed by `(schema, schemaVersion)`. schemaVersion already exists and does
  nothing — give it this job. Side-effect: per-doc indexOptions accidentally FREEZES each doc's
  identity rule at write time; registry-keyed makes checksumField changes an explicit migration.
- `embeddingOptions` → off the doc entirely (see below).
- `embeddingsArray` — zero writers (only BaseDocument + web type mirrors). Dead.
- **Versioning DROPPED (user-confirmed)**: parentId/versions/versionNumber/latestVersion + all 7
  empty-stub methods. Re-add with a real implementation.
- `metadata.contextUUIDs`/`contextPath` + addContext/removeContext — dead (always []).
- `metadata.features` → root `features[]` ([[project_declarative_features]]).
- `primaryChecksumAlgorithm` — dead twice: never read (`getPrimaryChecksum()` = `checksumArray[0]`)
  AND not in the zod shape.

**Checksums — sha256 ONLY (user-decided), keep multi-algorithm logic** (default becomes `['sha256']`;
sha256 = what cacache uses, so blob + doc identity align). **CORRECTED a live user assumption: dedup
is sha1 today for note+tab** (`checksumArray[0]='sha1/…'`), sha256 only for file/email. Switch was
**verified safe empirically**: sha256-only re-put of a tab deduped to the same id — because ALL
checksums in the array are indexed (`insertArray`, user-confirmed), so a sha256 entry already exists
for every sha1-primary doc. **That is load-bearing**: a future algorithm not previously indexed would
fork every doc on the same switch.

**Embedding config never belongs on the document.** Clincher isn't size — synapsd's own code
disclaims it: `index.js:263` "synapsd owns no embedding model"; `VectorIndex.js:29` "does not run the
embedding model". `embeddingDimensions` can't be honored even in principle (one fixed dim per Lance
table). The A/B-on-a-subset use case is the argument AGAINST per-doc config: a subset is a SET →
inferd **router rule + feature/filter selector** = zero doc writes (per-doc config would rewrite N
docs to start an experiment and N more to end it). Split: **config → router rule; provenance
(model/dim/embeddedAt) → Lance row column; document → nothing.**

**Recommended**: key Lance tables by `(space, model, dim)` (`vec_text__qwen3-0.6b__1024`) — makes the
drop hazard structurally impossible AND gives A/B + MRL sibling tables for free. MRL gotcha: a
truncated matryoshka vector must be **L2-re-normalized** or cosine is silently wrong (do it in inferd
— synapsd owns no model semantics).

**Schema simplification**: `tab` and `link` are the same doc with different field names
(`data.uri/label` vs `data.url/title`); `EditForm.tsx urlTitleKeys()` exists solely to paper over it.
**Industry standard = `url`+`title`** (WebExtensions, bookmarks, JSON Feed, Atom, OG, Pocket) AND
matches `locations[].url` (which already holds arbitrary schemes) → **Link adopts Tab's names**, which
is also the zero-risk direction: link has 0 docs, and the ~2600 tabs (only data with no rebuild
source — images/notes/todos/emails are all reingestable) never move. Inheritance ticks the ancestor
chain (precedent: `data/mime/image` + `data/mime/image/jpeg`), ids stay FLAT (doc.schema is
persisted; mime can nest because it's derived from contentType). `contact` (0 docs) → `identity`
(type: person|org|service|bot); photo-tagging + email harvesting are `rel/` relations, same mechanism
as tab→snapshot. Offline site download = a SECOND `file` doc joined by `rel/snapshot-of` — cardinality
decides it (1 url → N snapshots; locations[] are copies of the SAME checksum). Delete
`Link.data.previews[]` (zero writers, half-built version of exactly that).

**Counts** (universe, measured): tab 16, note 129, file 34, email 23, device 2, dotfile 1; **link 0,
contact 0, todo 0, application 0, message 0, document 0**. Pre-prod (user's daily driver, ~2600 docs,
mostly tabs+images) NOT measured — verify before any destructive step there.

Related: [[project_declarative_features]], [[project_embedd_service]], [[project_image_clip_search]],
[[reference_local_ollama]], [[project_geo_provenance]].
