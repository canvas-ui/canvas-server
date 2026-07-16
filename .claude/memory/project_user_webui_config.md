---
name: project_user_webui_config
description: Per-user webui.json config store (/users/me/config/:name) + home canvas pinning; CanvasGrid rowHeight containerPadding fix
metadata:
  node_type: memory
  type: project
  originSessionId: e81ed646-504f-418f-956a-3ff78e7246fd
---

Built 2026-07-15. **Home canvas pinning** + the first **per-user config store** on the server.

**New seam: per-user client config.** `<userHome>/<email>/config/<name>.json`, following the existing
`tokens.json` (`transports/auth/service.js`) / `devices.json` (`core/device/Registry.js`) pattern -
plain fs + JSON, NOT Conf/jim (jim indexes live in `server/db/*.json` and are server-global).
- `core/user/ConfigStore.js` - `UserConfigStore.read/write(userId, name, obj)`. Name is
  **whitelisted** (`ALLOWED_CONFIGS = {'webui'}`) because it lands in a filesystem path - an open
  param is a traversal vector AND would expose `tokens.json`. 256KB cap. Atomic write-then-rename
  (the whole doc is rewritten per change; a torn write loses every pin).
- `transports/routes/users.js` → mounted `/rest/v2/users` (first ever `users` route; `admin/users`
  is separate). `GET|PUT /me/config/:name`. **Whole-document replace**, no server merge: the client
  owns the shape and read-modify-writes so sibling keys survive. Scoped to `request.user.id` only.
- Wired in `Server.js` (`#userConfig`) + `transports/index.js` (decorate `userConfig`).
- Server never introspects the blob - deliberately schema-less, same stance as canvas
  `metadata` ([[project_canvas_widgets]]).

**Why server-side, not localStorage:** canvas `metadata.ui` is SHARED by everyone viewing that
canvas; this is the *user's own* state and follows them across devices. Existing localStorage keys
(`toolbox:session:filters`, `doclist:view`, panel width) stay device-local.

**webui.json shape:** `{ home: { pinnedCanvases: [{ id, workspaceName, treeName, path, layerId?,
label? }] } }`. Pin stores an **address, not a snapshot** - re-resolved against the live tree on
mount, so canvas edits show up without rewriting the pin; cost is a renamed/deleted canvas → a
"no longer available" tile with a remove button. Uniqueness = workspace+tree+path (NOT layerId).

**Web:** `services/user-config.ts`, `components/home/pins-context.tsx` (`CanvasPinsProvider` mounted
in App.tsx beside NotificationsProvider; provider+hook in one file = same react-refresh warning
`notifications-context.tsx` already has), `components/home/PinnedCanvasTile.tsx`, `pages/home/`.
Pin button lives in `DefaultCanvas` canvas header (`isCanvasPinned`/`onTogglePinCanvas`); hidden for
folders and layer views. `findTreeNodeByPath` moved MenuTreeView → `services/workspace.ts` (shared).

**Tiles render `<CanvasGrid readOnly>`** - home is a dashboard, not an editor (also drops the
add-widget/Save toolbar). Layout invariant (user-stated): **home never scrolls; each canvas scrolls
itself.** Grid is `h-full` + `auto-rows-fr` +
`grid-cols-[repeat(auto-fit,minmax(min(640px,100%),1fr))]`, p-4 gutter on all sides.
- **`h-full`, NEVER `min-h-full`** - with only a min-height the grid's block size stays *indefinite*,
  so `fr` rows stop distributing and **each row resolves to the FULL height** (measured: 2 rows =
  `811px 811px` in an 812px box → 827px of page overflow). One row masks it by coincidence.
- **640px column floor = CanvasGrid's `NARROW_WIDTH`**, below which a canvas collapses to its stacked
  mobile layout. auto-fit (not a breakpoint) also lets a lone canvas span full width. `min(640px,
  100%)` stops the column overflowing a phone.
- **HomeFab owns an `h-full` in-flow box** (it centres quick-add cards in it). As a *sibling* of page
  content it stacks a 2nd page height → phantom scrollbar. It must be an `absolute inset-0
  pointer-events-none` overlay, and its card row only mounts when a card is open (an empty row would
  eat clicks on the canvases).

**Two pre-existing CanvasGrid bugs fixed** (affect workspace + public shares too, not just home):
1. `rowHeightForContainer` budgeted only `(extent-1)` inter-row margins, ignoring react-grid-layout's
   `containerPadding` (defaults to `margin`) = a gutter above the first row AND below the last → every
   grid overflowed its host by ~24px, silently clipped. Now `(extent+1)*marginY`; gridH == hostH.
2. Host was `overflow-hidden` when wide → rows only scale to a 32px floor, so a short host clipped the
   canvas unreachably. Now **`overflow-y-auto overflow-x-hidden`**. `overflow-x-hidden` is
   load-bearing: an unset overflow-x computes to `auto` once overflow-y is set, and that x-scrollbar
   steals 16px of clientHeight → grid no longer fits → a y-scrollbar on *every* canvas.

Related: [[project_canvas_widgets]], [[project_canvas_live_filters]], [[project_ui_color_language]],
[[feedback_url_design]].
