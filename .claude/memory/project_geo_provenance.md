---
name: project_geo_provenance
description: metadata.geo provenance (source/accuracy) + manual>exif>device precedence; opt-in device geotag toggle on note/todo create
metadata: 
  node_type: memory
  type: project
  originSessionId: e81ed646-504f-418f-956a-3ff78e7246fd
---

IMPLEMENTED 2026-07-15, runtime-verified against live server, NOT committed. Touches submodules `stored`, `synapsd`, `ui/web` + main repo.

**Shape**: `metadata.geo = { lat, lon, alt?, accuracy?, source? }`. `source` ∈ `device|exif|manual`; `accuracy` = horizontal error radius in **metres** (EXIF `GPSHPositioningError`, or Geolocation `coords.accuracy`). Client type `DocumentGeo`/`GeoSource` in `ui/web/src/types/workspace.ts`.

**Precedence — `manual > exif > device`** (rank, NOT write order → re-upserts idempotent). Why: EXIF = where the shot was TAKEN, device = where the client was when it UPLOADED (import a Tatras photo from your couch → device geo is wrong). Manual on top so re-indexing never reverts a hand-fixed pin. Unsourced legacy geo ranks 0 (a real EXIF read upgrades it; nothing else does).

**Owner**: `src/core/workspace/lib/geo.js` — `pickGeo(existing, incoming, {incomingSource})`, `normalizeGeo`, `isValidGeo`, `GEO_SOURCES`. Single source of truth; both merge sites import it.

**The 3 merge sites that used to disagree** (this was the real bug — precedence was decided by accident):
1. `WorkspaceStoredIndex.#buildDocument` — was an *unconditional* per-key overwrite of geo/exif/dimensions/media; EXIF silently ate client geo. Now: exif/dimensions/media still overwrite (bytes-derived, immutable), geo goes through `pickGeo`. Runs even without `extracted` so sentinel geo gets dropped.
2. `Workspace.#enrichImageDocMetadata` (embed-time seam) — guard was `if (meta.exif || meta.geo || meta.dimensions) return null`, i.e. client geo won AND a doc with only `dimensions` never got its GPS. Now bails only on `meta.exif || meta.dimensions` (proof extraction already ran); a bare `geo` still extracts and `pickGeo` decides. Patches only when the winner actually changes (metadata patches shallow-merge top-level → geo replaced wholesale).
3. `stored/src/index.js:~195` `custom: {...metadata, ...extracted}` — extracted-wins, left as-is: latent only, since the sole caller `persistBlob` passes no metadata. Canvas policy deliberately does NOT live in generic `stored`.

**Null Island fix (root cause of the "photo in the middle of the ocean")**: `Number(null) === 0` and `Number.isFinite(0) === true`, so `geo:{lat:null,lon:null,alt:null}` was **indexed at (0,0)** and answered bbox queries covering it. Guard added in synapsd `#indexDocumentGeo` (range check + reject exact 0,0) — the last gate before the S2 index, covers every write path incl. direct API insert; the `else if` branch self-heals already-indexed sentinels on re-put. Same rule in `geo.js isValidGeo` + client `readDocGeo`. **NOTE: `alt` is inert — nothing reads it** (index reads lat/lon only); alt:0 can never move a pin.

**Off pins on real photos are NOT a bug**: exifr's `latitude`/`longitude` already apply N/S/E/W ref signs. Bad fixes are genuine (construction sites/urban canyon, cached A-GPS fix stamped on the shot). `accuracy` now makes that legible.

**Client geotag (opt-in, default OFF)**: `ui/web/src/hooks/useGeotag.ts` + `components/toolbox/add/GeotagToggle.tsx`. Composed INSIDE `useNoteFields`/`useTodoFields` (the shared payload source of truth) → exposed as `f.geotag`, rendered in all 4 containers (NoteForm, TodoForm, NoteCardBody, TodoCardBody). `save()` awaits `geotag.capture()` → null unless opted in, never rejects (a missing fix must not block the save). Toggle-on warms a fix immediately (OS prompt fires while the user looks at the toggle, proves permission, shows accuracy); `capture()` re-reads fresh and falls back to the warm fix.

**Two PWA gotchas baked in**: (1) geolocation is a **secure-context** API — over plain http on a LAN IP (`http://192.168.x.x:8001`) it fails; hook checks `window.isSecureContext` and greys out with an honest reason, so **test on https/localhost, not the LAN IP**. (2) **Safari/iOS does not expose geolocation to the Permissions API** — `permissions.query` failure must stay on `'prompt'` (toggle live, OS prompt on tap), never grey out, or every iOS PWA user loses geotagging.

**Backend was already ready**: Note/Todo schemas are `z.object({}).passthrough()` and `#indexDocumentGeo` is schema-agnostic → any doc type with `metadata.geo` is S2-indexed and answers `geo:bbox:` today. Only the UI was missing.

**Verified live** (universe ws, docs since deleted): device note → Tatras bbox hit, Bratislava/Null-Island miss; sentinel note → NOT indexed anywhere (planet-wide bbox = 0); forged GPS jpg (exiftool) + conflicting device geo → upgraded to `source:exif` w/ accuracy 65, alt 2043, capturedAt on `content` timeline; **same jpg + `source:'manual'` → manual survived while exif/dimensions were still written** (the test that distinguishes precedence from clobber — old code would have reverted it). Unit tests: 18/18 in scratchpad `geo.test.mjs`.

**API gotcha for future testing**: documents list filter wire param is **`filters`** (repeated), not `filterArray` (that's only the client-side variable name). Delete takes a **JSON array body**, not a query param. File docs require `checksumArray: ["sha256/<blob.checksum>"]`.

**Deferred**: no UI to SET `source:'manual'` yet (drag-a-pin on the map → the reason manual outranks exif); no backfill of pre-existing sentinel geo already in the S2 index (self-heals only on re-put); `data/media/has-gps` feature still watch-path-only (see [[project_blob_metadata_extraction]] gaps).

Related: [[project_blob_metadata_extraction]], [[project_s2_geo_and_todo]], [[project_toolbox_experimental]], [[project_context_binding]].
