---
name: project_toolbox_experimental
description: "Toolbox revamp: top bar (Filters/Agents/Notifications), resizable+wide panel, Filters sub-tabs Features/Timeline/Map (client-side rect+polygon geo filter over fetched set, type-icon pins)"
metadata:
  node_type: memory
  type: project
  originSessionId: e81ed646-504f-418f-956a-3ff78e7246fd
---

Web UI toolbox (`src/ui/web/src/components/toolbox/`) revamp, 2026-07 (NOT committed — user scripts manage commits).

**Top bar** (`ToolboxPanel.tsx`): T1 tabs are now **Filters** (view id still `'tools'`), **Agents**, **Notifications** — dropped Home from the bar (HomePanel still renders if `t1View==='home'`, e.g. HomeFab). Icons: SlidersHorizontal/Brain/Bell; labels show ≥sm. T1View gained `'notifications'` → `panels/NotificationsPanel.tsx` (placeholder, "more prominent once wired in").

**Resizable + wide toggle** (`ToolboxPanel.tsx`): desktop-only inline `style={{ width }}` (mobile keeps `w-full`, gated by `useIsMobile`). Left-edge drag handle (delta inverted — panel docks right). Width persisted `localStorage['toolbox:width']`, clamp [340, innerWidth*0.7]. Maximize2/Minimize2 button toggles between DEFAULT_WIDTH(420) and ~half-screen (innerWidth/2).

**Filters sub-tabs** (`ToolsPanel.tsx`, header relabeled "Filters"): order now **Features (default)** → Timeline → Map. `ToolsTab = 'features'|'timeline'|'map'`; initialState `toolsTab: 'features'` (was 'timeline'). Also from prior work: FeaturesTab has a prominent icon-led "Document types" picker (data/abstraction/* pulled to top; see [[project_canvas_widgets]]).

**Map tab = client-side interactive filter** (`panels/MapTab.tsx`, **leaflet 1.9.4**, REWRITTEN 2026-07): NOT a backend query anymore — refines the ALREADY-fetched result set in the browser (user: "never fetch ALL documents outside our filter set"). Shows every geo-tagged doc in the current results as a **type-icon pin** (reuses [[project_ui_color_language]] schema icons via new `src/lib/schema-meta.ts`; pin = lucide glyph rendered with `renderToStaticMarkup` into an `L.divIcon`, cached per schema/inside). Draw **rectangle** (pointer-drag, mouse+touch) OR **polygon** (leaflet `map.on('click')` drops vertices — works on tap; Finish/Cancel; dragging stays ON so pan≠vertex). Pins recolor in/out of selection (violet `#8b5cf6` vs slate `#94a3b8`, out dimmed); readout "N of M located · K in area". Map wrapper has `isolate` so leaflet's internal z-index (controls 1000, panes 200-700) can't paint over app modals. Backend still has NO polygon coverer (see [[project_s2_geo_and_todo]]) — irrelevant now since filtering is client-side (arbitrary polygon OK).

**Map pins** — clustered via **leaflet.markercluster** (added to src/ui/web deps, hoisted to root node_modules; `L.markerClusterGroup` + `MarkerCluster.css`/`MarkerCluster.Default.css`): overlapping/nearby pins collapse to a violet numbered circle (custom `iconCreateFunction`→count badge), split on zoom, spiderfy at max zoom — fixes "hover shows only one of N stacked docs". Bulk `addLayers(markers)`. Pin click → opens the **shared** ObjectPropertiesModal via new global `DocumentModalProvider` (`src/components/shell/document-modal-context.tsx`, mirrors SideViewProvider, mounted in AppShell) — NOT a map-local modal; suppressed while drawing. `mapWorkspaceId` published alongside `mapDocuments` so the modal can fetch bytes. **Null-geo guard** in `readDocGeo` (`utils/geo.ts`): `{lat:null,lon:null}` → `Number(null)=0` was placing docs on Null Island (0,0); now rejects null/undefined/''/non-finite AND exact (0,0).

**Map data flow** (ephemeral, NOT in `filters`, NOT saved, cleared on nav): toolbox-context added `state.geoSelection: GeoSelection|null` + `state.mapDocuments: WorkspaceDocument[]` + `setGeoSelection`/`setMapDocuments` (SET_NAVIGATION resets geoSelection). Pages (workspace + context index) publish their fetched `documents` via `setMapDocuments(documents)` (cleared on unmount) and pass `shownDocuments = geoSelection ? documents.filter(docInGeoSelection) : documents` to DefaultCanvas → real-time content refresh as you draw. `GeoSelection = {kind:'rect',bbox} | {kind:'polygon',points}` in types/workspace.ts; predicate `docInGeoSelection`/`pointInGeoSelection`/`readDocGeo` in `src/utils/geo.ts` (ray-cast point-in-polygon; reads `metadata.geo.{lat,lon}`, any doc type). Non-located docs excluded while a selection is active.

**Content-area Map VIEW REMOVED** (`document-list.tsx`): the 4th view-switch mode `'map'` + `DocumentMap.tsx` deleted (user: "non/barely-usable"). storedView union back to card|table|tile.

**UPDATE (superseded):** the once-dormant geo `bbox` plumbing was revived - `geo:bbox` is now a STORABLE filter on canvas + context (see [[project_context_binding]]); MapTab rectangle feeds `buildGeoFilters`. Polygon stays client-side ephemeral (no backend coverer).

**Toolbox = standalone right-pinned card** (later change): moved `<ToolboxPanel />` OUT of `ContentArea` to be the LAST sibling in `AppShell` flex row (after `<AddPanel />`), so it's ALWAYS the right-most element — nothing renders to its right. ToolboxPanel is now self-contained (own mobile scrim + `fixed inset-2` drawer, desktop `relative shrink-0 rounded-xl shadow-elevation-3` card — same chrome as the + AddPanel), no longer relying on ContentArea's MOBILE_DRAWER wrapper. Sub-tab header (zinc-900 "Filters" bar) REMOVED — selected sub-tab now uses M2 style (`-mb-px border-b-2 border-foreground font-semibold`); Clear/Save moved to a contextual action row below the tab bar (shown only when hasActiveFilters||canSave).

**Also fixed this session** (see [[project_canvas_widgets]]): stale-localStorage `filters.sort` undefined crash (loadSessionFilters deep-merges DEFAULT_TOOLBOX_FILTERS); ToolboxFab "·|" mark (dot bottom-left, items-end); Todo priority→selectbox; content-area URL is now an editable address-bar (DefaultCanvas `UrlBar` + `onUrlSubmit`→navigate).
