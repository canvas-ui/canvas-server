---
name: project_locations_device_bitmaps
description: "locations[] flat-URL convention + device/id presence bitmap derived from file:// locations"
metadata: 
  node_type: memory
  type: project
  originSessionId: bd252427-cb4b-4501-a3b4-92adda816492
---

synapsd `locations[]` convention (refined 2026-06-02):

- Location entry is flat `{ url, metadata? }`. The URL is the single source of truth for "where". **No top-level `deviceId`/`backend` field** — deviceId is the URL authority: `file://<deviceId>/<path>` (built by `deviceFileUrl`). Clients compare their own id against the authority to prefer a device-local copy. Dropped the redundant `metadata.deviceId` from Dotfile and the per-install `metadata.deviceId` from Application.
- `metadata` holds only non-derivable hints (Application install `status`, source `type`, S3 region, SMB auth refs).

Device-presence bitmap (`device/id/<id>`):
- **DB (synapsd) concern, not app** — derived in `SynapsD.#indexDocument` via `#deviceFeaturesFromLocations`, because `locations[]` is the universal field (every doc) whereas links/installs are abstraction-specific. Runs in every write path (put/putMany/batch/update) since `documents.put` always precedes `#indexDocument`.
- **Conservative scope**: only `file://` locations tick `device/id/<authority>`. Skipped: `{WORKSPACE_ROOT}`/`{VAR}` placeholders (workspace-relative, not a device), and all non-file schemes (`stored://`, `s3://`, `http(s)://`, `imap://`) whose authority is a backend/bucket/host — minting `device/id/<bucket>` would corrupt the device namespace.
- This is **additive**, matching existing feature-bitmap semantics. The app's writing-device tag (`mergeDeviceFeatureTags(features, request.client)` in route handlers) still fires and is unioned.

Result: "what's on device X" = single bitmap intersection on `device/id/X`, no per-doc location scan.

**Untick-on-removal IMPLEMENTED** (`SynapsD.#removeStaleDeviceMembership`): when a write shrinks a doc's locations (agent prunes a stale path, device loses the file, dedup re-ingest), the dropped copy's `device/id/<id>` bitmap is removed. Wired into all three paths with a pre-existing doc: putMany (`existingDocument` vs `parsed`), single put dedup (`storedDocument` vs `parsedDocument`), and #updateOne (capture `previousLocations` before `update()` mutates in place). `#linkOne` and the directory-batch/re-index paths need none. Guard: a tag the caller re-asserts this write (`assertedFeatures`, e.g. writing-client tag) is never unticked. Required this powers the must-have **dedup/cleanup** feature.

Critical detail: device tags MUST be run through `normalizeBitmapKey` (lowercase + sanitize) in both derivation and the asserted-set, because the bitmap layer normalizes keys — raw-case comparison silently mis-fires the guard.

Tested: insert→update drop, dedup re-ingest shrink, asserted-guard keep, no-assert drop — all correct. 16/16 suite passes.

Alias canonicalization deferred to app layer (settled): a `file://user@host/...` authority normalizes to `device/id/user_host`, not the canonical deviceId. Needs the device registry, so handled cleanly app-side. `deviceFileUrl` emits raw deviceId so this only bites hand-crafted URLs.

## Two pre-existing bugs found during this work

1. **FIXED — `metadata: z.object().optional()`** in Document/Note/Device/Dotfile/Todo/Tab (+ Document `data: z.object().passthrough()`). `z.object()` with no shape arg gives zod v3 `shape=undefined` → `Object.keys(undefined)` TypeError on **any reparse of a stored doc** (metadata is populated by then). Survived create (metadata undefined at validate-time). `#safeParseDocuments` **swallowed** it, so `list`/`search` silently dropped these doc types on reparse; tests passed only because empty-result branches masked it. Fixed to `z.object({}).passthrough()` (passthrough so stored `features`/`contextUUIDs` survive reparse).

2. **FIXED — `fromData` stripped top-level fields.** Only **`Dotfile`** and **`Application`** had it (earlier over-listing of Contact/Link/Folder was wrong — those pass full `data`). They did `new X(this.validateData(data))`; `validateData` parses against the data-schema which omits top-level `id`/`locations`/`checksumArray`/timestamps, so they were **stripped** → constructed instance lost its `id` → `#getById` returned `id:null` → update/timeline ops failed. Fix: `return new X({ ...data, data: transformed.data })` — keep `validateData` for throw-on-invalid + `data` normalization (Dotfile `$HOME` link paths, Application install paths), but construct from the full object with only `data` replaced. Verified: full Dotfile lifecycle (insert → reparse keeps id+locations+normalized links → update-drop unticks → list returns it) works.

Related: [[project_device_addressing]], [[project_storage_url_scheme]], [[project_locations_migration]], [[project_layerindex_naming]].
