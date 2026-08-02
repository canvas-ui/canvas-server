# TODO — WebUI

Frontend work queued for its own session. The webui lives in the `canvas-web`
submodule (`src/ui/web`), so changes there are committed and pushed separately
from `canvas-server`.

---

## Embedd settings (Workspace → Settings)

**Backend is DONE and on `main`/the dev branch — this is UI-only work.** Every
endpoint below exists, is tested, and returns the shape described.

### What already landed in the UI (2026-07-27, `canvas-web` `766424b`)

- Settings → Database now shows **this workspace's own** embedding queue (the
  "· all workspaces" caveat is gone) and its Pause/Resume targets this workspace.
- A `Model → <space>` row per vector space showing `model · provider · dim`.
- `WorkspaceDbStats.embedder` gained `spaces: { [space]: { provider, model, dim } }`.

So the workspace settings page already *reports* the embedding setup. What is
missing is the ability to **change** it.

### The flow to build

Embedding config lives in the workspace's own `workspace.json`
(`services.embedd`), so it travels with a `tar`'d workspace into canvas-edge.
Resolution is layered:

```
built-in  ←  server embedd.json  ←  user default  ←  WORKSPACE (wins)
```

The swap is non-destructive by construction — a new model embeds into its own
Lance table with its own ledger, so the old one stays intact and reverting is
instant:

1. **Switch** — `PUT /rest/v2/workspaces/:id/embedd/config`
2. **Fill** — `POST /rest/v2/workspaces/:id/embedd/reindex`, optionally
   `{ scope: "ctx://work/project" }` or `dir://…` to try a model on one project
   before committing the whole workspace
3. **Revert** — `PUT …/config` back. Instant: the previous model's vectors AND
   its "already embedded" ledger were never touched.
4. **Reclaim** — `DELETE …/vector-tables/:table` once you're sure

Config changes apply **live** — no workspace restart. The route quiesces the
embedding queue, swaps the vector spaces, and resumes.

### Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/rest/v2/workspaces/:id/embedd/config` | `{ workspace, effective, inherited, spaces, invalid? }` |
| PUT | `/rest/v2/workspaces/:id/embedd/config` | → `{ movedSpaces, tables, applied }` |
| POST | `/rest/v2/workspaces/:id/embedd/reindex` | `{ space?, reindex?, scope? }` |
| GET | `/rest/v2/workspaces/:id/embedd/vector-tables` | `active:false` = superseded |
| DELETE | `/rest/v2/workspaces/:id/embedd/vector-tables/:table` | refuses the live table |
| GET/PUT | `/rest/v2/embedd/config` | per-user **defaults** (inherited by new workspaces) |
| POST | `/rest/v2/embedd/test` | `{ provider, model }` → `{ ok, dim, latencyMs }` |
| GET/PUT | `/rest/v2/embedd/defaults` | server-wide defaults; PUT is admin-only |

### Tasks

All landed 2026-07-28 in `canvas-web` — see `services/embedd.ts` (client),
`components/workspace/embedd-config-editor.tsx` (the shared editor, used by all
three surfaces) and `components/workspace/embedd-settings-panel.tsx`.

- [x] **Workspace → Settings → Embedding** section (or its own tab). Per-modality
      cards (text, image, and whatever else the router reports — do NOT hardcode
      two; a new space appears in `spaces` with no code change).
      Each card: provider type, baseUrl, model, dim, API key, plus an
      **inherited vs overridden** marker per field. `GET /config` returns
      `workspace` (overrides), `effective` (what runs) and `inherited` (the
      fallback), which is exactly what that marker needs.
      - Landed as its own tab (`/workspaces/:name/settings/embedding`). Space
        cards are keyed off `effective.spaces`, so nothing is hardcoded.
      - Split from the spec: provider *type* / *baseUrl* / *host* / *API key* sit
        on a **provider** card rather than being repeated per space, because
        that is how the config is actually shaped — a space references a provider
        by id, and two spaces routinely share one backend. Duplicating the
        connection fields per space would have let them disagree.
- [x] **Test connection** button per backend → `POST /rest/v2/embedd/test`.
      Round-trips a real embedding call, so it reports `dim` and `latencyMs`;
      surface the returned dim next to the configured one — a mismatch is the
      single most likely misconfiguration.
      - Tests the *edited* values (draft layered over what runs), so a candidate
        backend can be checked before saving. A dim mismatch is raised as a
        destructive toast naming both numbers, not a quiet readout.
- [x] **After-save prompt.** `PUT /config` returns `movedSpaces`. When non-empty
      the new table is EMPTY until refilled, so dense search silently goes thin —
      prompt to reindex right there rather than leaving it to be discovered.
- [x] **Reindex control** with an optional scope path (`ctx://` / `dir://`
      picker, ideally reusing the existing tree picker). Show enqueued count;
      the queue readout already on the page reports progress.
      - MVP caveat to surface in the UI copy: `reindex: true` + `scope` clears
        the WHOLE space (partial clear is not expressible in the bitmap ledger),
        so scoped runs are for *filling* a new model incrementally.
      - Picker reuses `LinkToCard` (`multiple={false}`); its tree tab picks the
        scheme, so the context tab yields `ctx://…` and the directory tab
        `dir://…`. The clears-the-whole-space warning only appears once both
        `reindex` and a scope are set — i.e. exactly when it applies.
- [x] **Superseded model list** — `GET …/vector-tables`, rows with
      `active: false`, each with a Reclaim (DELETE) button and a clear "this is
      what you'd revert to" framing. Deleting is the only irreversible step in
      the whole flow, so it needs a confirm.
- [x] **User defaults page** — same editor against `/rest/v2/embedd/config`,
      framed as "defaults new workspaces inherit". Lower priority than the
      workspace page: the workspace is the primary surface.
      - `/embedding`, linked from the Settings menu. Surfaces `restartRequired`
        so it is obvious this layer does *not* re-point running workspaces.
- [x] **Admin: server defaults** — `/rest/v2/embedd/defaults` (PUT admin-only),
      plus the optional host allowlist. Belongs under `/admin`; the admin menu
      lives in `components/menu/admin/AdminMenu.tsx`.
      - `/admin/embedding`. Readable by anyone (it is what you inherit) and
        read-only for non-admins rather than hidden. Because nothing resolves
        below this layer over the API, the editor also grew an **Add space**
        control — otherwise a server starting from an empty `embedd.json` has no
        space cards to edit.

### Not covered, deliberately

- **Routing rules are still read-only.** `rules[]` decides which content lands in
  which space, and a layer that declares them replaces them wholesale rather than
  merging — so a half-built rule editor would silently drop the defaults. The
  Database tab already *reports* the live routing (`Embeds → <space>`).
- **Per-provider custom headers** are preserved on save (the editor never sends
  `headers`, so the server carries them forward) but cannot be edited; only their
  names are shown. Same write-only reasoning as API keys.

### Things the UI must get right

- **API keys are write-only.** GET returns `apiKeySet: true`, never the value. A
  PUT that omits the key keeps the stored one — so the form must send the field
  *absent* when untouched, NOT an empty string, or it will blank the secret.
- **A rejected endpoint is a 400 with a reason** (`Rejected embedding endpoint —
  …`). Show it verbatim; it names the offending provider.
- **Do not hardcode `text` and `image`.** Spaces are config; audio/spatial slot
  in with no server change and the UI should follow.

---

## Other UI items

Carried over from `TODO.md` → "WebUI cosmetics":

- [ ] (deferred) Content area section should support tabs.
