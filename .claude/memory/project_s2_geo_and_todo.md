---
name: project_s2_geo_and_todo
description: "S2 GeoIndex (single BSI, geo: filters) + Todo v2.1 schema (status enum, tasks timeline) — implemented 2026-07-13"
metadata: 
  node_type: memory
  type: project
  originSessionId: b54c2d7d-53e8-4424-86f4-86e95b3812ef
---

Implemented 2026-07-13 in one session (NOT committed — user scripts manage commits; synapsd is a submodule).

**S2 GeoIndex** (`synapsd/src/indexes/inverted/GeoIndex.js`): single point-BSI `internal/geo/s2` over level-21 S2 cell ids (~5m cap, no-fake-precision stance). Containment = BETWEEN id-range (S2 ancestor = contiguous descendant range) → bitmap population fixed at ~65 regardless of density/zoom. Region queries via S2RegionCoverer (≤20 cells, OR of BETWEENs). Lib: **nodes2ts 4.0.2** (pure JS, BigInt-native, unsigned face-4/5 ids verified; installed in synapsd workspace). Derived from `metadata.geo.lat/lon` on put/update/delete beside `#indexDocumentTimelines` (ebm probe guards no-geo docs). Filter tokens `geo:bbox:`, `geo:near:lat,lon,r[m|km]`, `geo:cell:` through shared `#combineSigilFilters` (refactored from timeline combiner); marked coarse like temporal. Lossy candidate-set semantics — rendering reads raw `metadata.geo`. Deferred: polygon coverer (bbox covers mapbox viewport), S2 lib has no S2Polygon.

**Todo v2.1** (`schemas/abstractions/Todo.js`): VTODO/JSCalendar-aligned — `status` enum (pending/in-progress/completed/cancelled) canonical, legacy `completed` boolean kept in deterministic two-way sync (no timestamps invented at parse!); `completedAt`, `priority` 1-9 (RFC 5545); `dueDate` added to checksumFields (same-title different-day todos must not dedup-collide). dueDate → derived `{timeline:'tasks', start}` entry in constructor (doc declares, index derives; non-tasks entries preserved, tasks entry always regenerated). `tasks` registered in TimelineIndex `pointTimelines`. Maps to `data/entity/task` in future schema refactor (id strings survive per registration-facility plan).

**Filter grammar change:** named timeframes (today/thisWeek/…) now resolve on ANY timeline, not just crud:* (`parseTimelineToken` in utils/filters.js) — enables `t:tasks:today`. TODO.md note revised.

Tests: `tests/geo-index.test.js` (7), `tests/todo-tasks.test.js` (6); full suite 123/123. README: "Spatial index (S2)" section + filter grammar + reserved content-timeline conventions (`content`, `tasks`).

**Status bitmaps + tag consolidation (2026-07-13, same session):** derived `data/status/<status>` facet bitmaps via `facetBitmapKeys` (mime+status unified helper; tick current/untick stale at putMany/#putOne/#updateOne + reindexMimeBitmaps backfill), gated on `STATUS_FACET_SCHEMAS` (todo only → future `indexOptions.facetFields`). Prefix rule ("who says so?"): data/*=doc-derived facts, feature/*=engine presence flags, tag/*=user free labels (consolidated from custom/tag/*, writers only — CLI docbuilders/seed hook/hook meta; no data migration, pre-deploy), custom/<axis>/<value>=user structured. Controlled vocab must never share a namespace with user tags (tag/pending vs data/status/pending distinguishable = feature). **Latent bug fixed:** putMany id-updates never unticked stale mime keys — `existing.update(doc)` mutates in place, prev-state snapshots must happen BEFORE it (bit me too; prevFacetKeys now captured in both snapshot branches). Raw bitmap-key filters take NO sigils ('+' only for t:/geo: families).

Builds on [[project_blob_metadata_extraction]] (metadata.geo from EXIF; timeline sort machinery — BSI getValues/getSortKeys).
