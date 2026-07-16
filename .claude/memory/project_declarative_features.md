---
name: project_declarative_features
description: metadata.features is declarative and authoritative — bitmaps follow it 1:1; synapsd now ticks/unticks from the document
metadata: 
  node_type: memory
  type: project
  originSessionId: e81ed646-504f-418f-956a-3ff78e7246fd
---

**The model (user's words, 2026-07-15):** "there should be only one features array for a db object, features are distinguished by prefixes and map 1:1 to bitmaps, storing features in document object should trigger an update in the bitmaps in the db (document JSON schema is declarative, bitmaps/indexes follow)."

So: `document.metadata.features` is the SOURCE OF TRUTH. Bitmaps are derived. Storing a feature on the document IS the way to create/update its bitmap. Never duplicate a features array elsewhere to "make indexing happen" — that's a smell that the write path is broken.

**The bug (FIXED 2026-07-15, synapsd, runtime-verified, NOT committed):** `#putOne`/`putMany`/`putManyDirectoryPaths`/link-by-id ticked bitmaps ONLY from the caller's `featureBitmapArray` (body-level `features` param) + `schema`. A document's own `metadata.features` was **stored but never indexed**. Consequence: tags added by the web add-forms (which put them in `metadata.features`) were invisible to bitmap filters AND to `listWorkspaceTagSuggestions` (which reads `tag/*` bitmaps) — so tag autocomplete could only ever show `tag/chrome`, which the browser extension creates via the body-level param + `mergeDeviceFeatureTags`. Notes had this bug since forever.

**Fix**: module-level `documentFeatureKeys(doc)` in `synapsd/src/index.js` (next to `facetBitmapKeys`) → validated keys from `metadata.features`; invalid keys are **skipped + debug-logged, not thrown** (junk from older/3rd-party clients must not make every re-put a hard failure). All four write paths union it with caller features. Stale features (a removed tag) are unticked, mirroring the existing facet pattern.

**PITFALL that cost a cycle**: in `putMany`, `existing.update(doc)` **mutates `existing` in place and returns the same instance** — so any "previous state" snapshot MUST be taken BEFORE that call (the existing code does exactly this for `prevChecksums`/`prevLocations`/`prevComment`/`prevTimelineState`/`prevFacetKeys`; `prevFeatureKeys` now joins them). Computing it after silently yields an empty stale-set and the untick never fires. `#putOne` is safe (its `storedDocument` is a separate instance from `getByChecksumString`); `#updateOne` captures before `storedDocument.update()`.

**Two mechanisms, do not confuse:**
- `metadata.features` (on the doc) → stored AND now ticked. What the object card / EditForm `featuresToTags()` read back.
- body-level `features` param (insert/PUT body) → ticked, applies to EVERY doc in the call, and is NOT echoed onto the document (only `schema` appears in the doc's array). Used by the browser extension + `mergeDeviceFeatureTags` for device/client tags. Deliberately left NOT merged into the doc — device tags are location-derived and `#removeStaleDeviceMembership` owns their lifecycle; writing them onto the doc would fight that.

**Verified live**: brand-new `tag/gerlach` bitmap created from `metadata.features` alone (no body features); `allOf=tag/<x>` filter returns the doc; removing a tag via `PUT /documents` unticks it; re-adding re-ticks. synapsd 128/128 tests pass.

**API gotchas**: document update is `PUT /workspaces/:id/documents` with a `{documents:[{id,...}]}` body — there is NO `PUT /documents/:id` (404). Feature filter query param is `allOf`/`anyOf`/`noneOf` (NOT `featureArray`); token filters use `filters` (NOT `filterArray` — that's only a client-side variable name).

Related: [[project_geo_provenance]], [[project_layerindex_naming]], [[project_blob_metadata_extraction]].
