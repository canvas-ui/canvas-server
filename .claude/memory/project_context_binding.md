---
name: project_context_binding
description: Context = server-enforced filter binding (features+filters) bound clients inherit; live preview via applyContextSpec bypass; storable geo:bbox on canvas+context
metadata: 
  node_type: memory
  type: project
  originSessionId: e81ed646-504f-418f-956a-3ff78e7246fd
---

Contexts made into real dynamic filter bindings (2026-07; server restart + web rebuild). A context = a movable view; its stored filters are applied server-side so ALL bound clients (browser ext, agents) inherit them ("filter to today on phone → bound browsers fetch today's tabs"). Mirrors the canvas plumbing ([[project_canvas_live_filters]]).

**Dead code removed:** `Context.#attributes` (field, getter, `set/append/remove/clearAttributes`, toJSON) — was serialized but NEVER restored on load, setters didn't `saveContext`, `list` ignored it. Fully deleted. (The `spec.attributes` PARAM in list/search is live — the route passes features that way — kept.)

**Two persistence gaps fixed in `Context.js` (both were serialize-but-never-restore, or not persisted at all):**
- `#features` ({allOf,anyOf,noneOf}|null) + `#filters` (token array: `t:…`, `geo:bbox:…`) — the STORED binding. Added: field defaults, **restore in constructor** (`options.features/filters`; contextOptions spreads persisted toJSON), toJSON, getters, `async setQuery({features,filters})` (persists via saveContext + emits `context.updated`).
- `#metadata` ({}) — context metadata was a **silent no-op** (updateContext ignored it, no setter) → old "save filters" for contexts never persisted. Added field/restore/toJSON/getter/setter; `updateContext` now applies `updates.metadata`.

**Apply + bypass:** `Context.#bindQuery(callerFeatures, callerFilters, applyContextSpec)` folds `#features`/`#filters` into `list`/`search` (via existing `#mergeFeatures`/`#mergeFilters`, union) UNLESS `applyContextSpec === false`. Also passes `applyCanvasQuerySpec: applyContextSpec` to workspace.list (bypass canvas fold in lockstep when a context points at a canvas leaf). Route `GET /contexts/:id/documents` gained `applyContextSpec` (bool, default true); bound clients omit it → inherit binding; web sends **false** and drives filters itself → live preview incl. removals. `updateContext` + PUT `/:id` schema accept `features`/`filters`.

**Client:** `services/context.ts` — `getContextDocuments` opts gained `applyContextSpec`/`sortBy`/`order`; `patchContext` accepts `features`/`filters`. `toolbox-context.saveFilters` (context branch) now writes `metadata.toolbox` (UI state/dirty) AND `features: filters.features` + `filters: [...buildDatetimeFilters, ...buildGeoFilters]` (binding). Context page fetch passes `applyContextSpec:false` + `tbScopeFilters` (timeline+geo) and includes them in the refetch key.

**Geo is now a STORABLE filter (canvas + context)** — MapTab **rectangle** → `setGeoBBox` → `filters.geo.bbox` → `buildGeoFilters('geo:bbox:…')` → part of `tbScopeFilters` (live preview) + persisted on save (canvas querySpec.filters / context binding filters). Enables e.g. an agent context scoped to a High-Tatras rectangle. **Polygon** stays client-side ephemeral (`geoSelection`; synapsd has no polygon coverer — see [[project_s2_geo_and_todo]]). MapTab reflects both (bbox rect + poly), Clear clears both; `hasActiveFilters` includes `geo.bbox`. Canvas save/save-as already emit `buildGeoFilters`.

Toolbox "Save changes"/"Save canvas"/"Save changes" buttons all renamed → universal **"Save filters"**.
