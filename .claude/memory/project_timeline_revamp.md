---
name: project-timeline-revamp
description: "Timeline toolbox revamp - histogram endpoint (density rail), quick-filter matrix incl. future tokens, calendar picker, unified one-spec-all-timelines filters"
metadata: 
  node_type: memory
  type: project
  originSessionId: f7c88bd6-fbe2-44d1-892f-13caf56c6dc6
---

Timeline toolbox revamp (2026-07-16), all landed and verified:

**Backend**: `TimelineIndex.histogram(names, buckets, filterBitmap)` (synapsd Timeline.js) - per-bucket overlap counts, skips non-existent scale tiers via `#existingScales`. `Workspace.timelineHistogram()` resolves candidates through the same path as `list()` (canvas folding + `resolveCandidates`) so rail counts match the document list. Route: `POST /workspaces/:id/timelines/histogram` (body: names[] max 16, buckets[] max 200 {start,end}, plus documents-style scoping: context/treeNameOrTreeId/treeType/allOf/anyOf/noneOf/filters/scope/applyCanvasSpec). Jest tests in synapsd tests/timeline-histogram.test.js.

**UI** (`components/toolbox/panels/TimelineTab.tsx`, extracted from ToolsPanel):
- Quick filters = Last/This/Next x Day/Week/Month/Year matrix + collapsed "Deep time" (decade/century/millennium). All 21 server CRUD_TIMEFRAMES tokens incl. future (tomorrow/nextWeek/... = the todo unlock, t:tasks:tomorrow).
- Calendar range picker toggle (Zap/CalendarDays segmented) - click start, click end, future dates OK.
- Density rail: rows carry stacked per-timeline color bars (log-scaled width) from the histogram endpoint; buckets = visible rows (week/month = ISO day ranges, year+ = year strings for BCE safety); scoped by current features+geo with applyCanvasSpec:false.
- `buildDatetimeFilters` (types/workspace.ts): one spec (quick token or customRange) applies uniformly to ALL selected timelines - old crud-only gating removed (server resolves tokens on any timeline name since Todo v2.1).
- `lib/timeline-meta.ts` timelineColor(): crud:created green, updated blue, deleted amber, content purple, tasks rose, domain names hashed hue. "Apply to" toggles double as the rail legend.

**Multi-range**: `customRanges: TimelineRange[]` is canonical (legacy `customRange` read-only fallback via `getTimelineRanges()`); each range emits its own `t:<name>:<start..end>` token, OR'd by the anyOf sigil (backend already supported this). Rail: non-contiguous row selections become disjoint ranges (contiguous-run grouping). Calendar: plain click = two-click range (replaces), ctrl/cmd+click = toggle single day (adds single-day range or carves a day out of a range, splitting it) - "deselect weekends" works.

**Gotchas**: unchecked toggle tracks must use Tailwind classes (bg-zinc-300 dark:bg-zinc-600), NOT `var(--muted)` inline - the CSS var is an HSL tuple, invalid as backgroundColor → invisible track. Web UI is a PWA: after `npm run build` the service worker serves the old precached bundle until a hard reload/SW update - "build didn't change anything" is usually this.

**Deferred**: full "timeline map" (zoomable vertical ruler, one rule per timeline in wide view, doc-type markers, morphing into calendar at high zoom) - needs dedicated design session per user.

**Datasets (agreed design, NOT implemented)**: `data/dataset/<name>` protected prefix; stamped at ingest (hooks rules or explicit app choice); dataset is provenance, path-INDEPENDENT (wikipedia article stays data/dataset/wikipedia anywhere in tree); default polarity excluded-unless-opted-in via root layer stored `!data/dataset/*` filter, subtree layer lifts it; Datasets group in Features tab tri-state. User will spec further. Related: [[project-workspace-hooks]], [[project-context-binding]].
