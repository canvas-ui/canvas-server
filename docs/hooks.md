# Workspace hooks

Workspace hooks are user-owned automations that run in-process when a workspace
event fires. They live in the workspace's git repo under
`{WORKSPACE_ROOT}/git/hooks` and come in two flavors:

- **JS hooks** — ES modules with full access to the workspace (arbitrary logic,
  spawning scripts, prompting agents).
- **Declarative rules** — JSON match→action rules for the common cases
  (sender/subject/url/mime/path → link/tag/agent/script/notify), designed so a
  UI rule builder can round-trip them.

Both are dispatched by `HookService`
(`src/core/workspace/services/hook/index.js`), which listens to every workspace
event via a wildcard subscription. Edits hot-reload (mtime-keyed cache); saving
from the settings UI commits to the workspace repo, a `git push` redeploys.

Note: hidden files (dotfiles) are never auto-indexed, so hook-driven scripts
use hidden `.<file>.metadata.json` sidecars to pass link targets to the
`incoming-metadata-linker` hook without triggering indexing themselves.

## Events

Hooks receive the canonical synapsd events re-emitted on the workspace
(`src/services/synapsd/src/utils/events.js`), most usefully:

| Event | Payload highlights |
|---|---|
| `document.inserted` | `id`, `document` (full parsed doc), `context`, `directory`; for batch inserts also `batch: true`, `batchCount` |
| `document.updated` | same |
| `document.inserted.batch` / `document.updated.batch` | `{ ids, count, context, directory }` — one event per bulk op (imap sync, browser-extension tab sync); fetch docs via `get(id)` + `classify(doc)` when you need them. |
| `document.linked` | `id`, `document` (full), `memberships: { context, directory, features }` — the doc was filed into tree path(s). Unlike the membership-only `document.updated` a link also emits, this one carries the document, so rules can match content ("email linked under /projects/x → triage") |
| `document.unlinked` | `id`, `document` (full), `contextArray`, `directoryArray`, `featureArray` — removed from path(s), still indexed |
| `document.removed` / `document.deleted` (+ `.batch`) | ids |
| `tree.path.inserted/moved/copied/removed/locked/unlocked` | `{ path, treeId }` |
| `tree.created/renamed/deleted`, `tree.document.*` | tree/doc ids |
| `membership.changed` | `{ changes: [{ docId, op, keys }] }` |
| `started`, `stopped`, `status.changed`, `dataBackends.changed`, `services.changed`, `links.changed` | workspace lifecycle/config |

The machine-readable catalog (names, payload shapes, whether the payload
carries a full document) is served by `GET /workspaces/:id/hooks/meta` and
defined in `src/core/workspace/services/hook/meta.js` (`HOOK_EVENTS`).

Every event payload carries provenance: `eventId` (unique per emit), `origin`
(`user` by default; `hook` / `rule` / `agent` / `backfill` / `replay` for
automated writes), `causedBy` (the triggering event's `eventId`) and `depth`
(automation cascade depth). Payloads originating from hooks are additionally
stamped `source: 'hook'`; a 1s window dedupes duplicate deliveries (keyed by
`eventId`).

### Batch fan-out

Bulk inserts (imap mail sync, browser-extension batch tab sync) are written
with a single `putMany` and emit one `document.inserted.batch` event. The hook
engine then **fans that batch out**: it loads each document and dispatches an
ordinary `document.inserted` per doc — full `document` in the payload,
`batch: true` and `batchCount` stamped — sequentially, so a 50-message sync
does not spawn 50 concurrent hook chains.

Rule of thumb:

- **Per-document logic** (link an email by sender, download an image, tag a
  tab): write a plain `document.inserted` hook or a declarative rule. It works
  identically for single and batch inserts; check `payload.batch` if you want
  to behave differently inside a bulk sync.
- **Whole-batch logic** (categorize N tabs with one agent call, one summary
  notification per sync): hook `document.inserted.batch` and work with `ids`.

The legacy singular emission with `{ ids, batch: true }` (no document) is a
compat signal for the ws bridge/embedd and is *not* dispatched to hooks or
rules — you never see a doc-less `document.inserted`.

## File layout

```
git/hooks/
  document.inserted.js          # single handler for one event
  document.inserted/*.js        # or several independent handlers
  rules.json                    # declarative rules
  rules/*.json                  # or several rule files (merged, sorted)
  lib/                          # shared modules, never auto-run
```

A filename prefix marks a file inactive — the engine skips `example-*`
(shipped examples), `disabled-*` (user-disabled; the UI toggle adds/strips
this) and legacy `_*`. Enabling = stripping the prefix
(`src/core/workspace/services/hook/naming.js`).

## JS hook context

A handler exports a default async function receiving one context object:

| Key | Meaning |
|---|---|
| `event`, `eventName`, `payload`, `payloads` | event data; `payloads` carries the whole burst for debounced hooks |
| `workspace`, `db`, `tree` | workspace instance, SynapsD, default context tree (null when inactive) |
| `classify` | document classifier, see below |
| `insert`, `update`, `remove`, `deleteDocument`, `get`, `list`, `find`, `link` | document CRUD on the workspace (`remove` = unlink from paths, `deleteDocument` = purge from index only) |
| `destroy(idOrDoc)` | delete the document everywhere: bytes on every deletable location (stored:// blob, workspace file, imap EXPUNGE — read-only locations degrade to a reference drop), then purge from the index. Irreversible |
| `agent(slug, prompt, opts)` | prompt one of your agents, returns its text reply (null on failure). Prompts are wrapped in a standard automation envelope (event, document summary, reply expectations — see `hook/agent-prompt.js`); `opts.raw: true` sends the prompt verbatim |
| `notify(message, { channel? })` | message the workspace owner — bound channel (Slack/WhatsApp/…) or, unbound, the in-app `canvas` channel (web-UI toast + toolbox notifications area, buffered server-side) |
| `emit(name, payload)` | re-emit a workspace event (stamped `source:'hook'`) |
| `logger` | debug logger |

`export const debounce = 2000;` coalesces an event burst into one run.

### Classifier

`classify()` (backed by `src/core/workspace/lib/classifier.js`) classifies the
event's document; `classify(p)` classifies one payload of a debounced burst;
`classify(doc)` classifies a doc fetched via `get()`. It never throws — with no
document every predicate is false.

- Schema: `isSchema('tab'|'data/abstraction/tab')`, `isTab`, `isEmail`,
  `isFile`, `isNote`, `isTodo`, `isMessage`
- URL: `isLink` (valid http(s) `data.url`), `isYoutube`, `isArxiv`,
  `isImageUrl`, `hostMatches('youtube.com')` (suffix-aware),
  `urlMatches(substring|RegExp)`
- Content: `isText`, `isImage`, `isAudio`, `isVideo`, `isPdf`, `isBlob`,
  `mimeMatches('image/*'|RegExp)`, `embeddingModality()`
- Location: `inPath('/to-sort')` (segment-aware prefix over the paths the doc
  landed in)
- Fields: `url`, `parsedUrl`, `host`, `from` (normalized email address),
  `subject`, `mime`, `paths`, `schema`, `doc`

## Declarative rules (canvas.hook-rules/v1)

`rules.json` / `rules/*.json` hold `{ "rules": [ ... ] }`. Rules are evaluated
against the classified document of every dispatched event; **all** matching
rules fire (no first-match-wins). A rule:

```json
{
  "id": "dc-migration-mail",
  "enabled": true,
  "description": "File DC-migration mail",
  "when": {
    "event": "document.inserted",
    "schema": "email",
    "from": "foo@bar.baz",
    "subject": { "contains": "dc migration" }
  },
  "then": [
    { "action": "link", "paths": ["/projects/dc-migration"], "tags": ["custom/tag/urgent"] }
  ]
}
```

### `when` matchers

All present keys must match (AND). Any value may be an array (OR across its
entries).

| Key | Semantics |
|---|---|
| `event` | required; exact event name |
| `schema` | short (`tab`) or full (`data/abstraction/tab`) schema id |
| `path` | prefix match against the paths the document landed in |
| `url` | string = case-insensitive substring; object = `{ host, prefix, contains, regex }` |
| `from`, `subject` | string = case-insensitive substring; object = `{ equals, contains, startsWith, regex }` |
| `mime` | exact (`application/pdf`) or glob (`image/*`) |

Rules only match events that carry the full document (`document.*`); id-only
events (`tree.*`) never match.

### `then` actions

Executed sequentially; an action error is logged and the rest continue.

| Action | Fields | Effect |
|---|---|---|
| `link` | `paths`, `tags?` | link doc to tree paths (`emitEvent:false`, loop-safe). Paths hit the context tree by default; `dir:/a/b` targets the directory tree, `ctx:/a/b` is explicit |
| `unlink` | `paths` | remove the doc from tree paths (inverse of `link`; same `dir:`/`ctx:` prefixes). The doc survives on its other paths |
| `tag` | `tags` | re-link doc on its own paths with feature tags |
| `delete` | — | purge the doc from the index. Bytes on storage backends (blobs, files, mail) stay untouched |
| `destroy` | — | **irreversible**: delete the doc's bytes on every deletable location (stored:// blob, workspace file, imap EXPUNGE; read-only locations degrade to a reference drop), then purge it from the index |
| `agent` | `slug`, `prompt`, `options?`, `output?` | prompt an agent; the reply feeds the output pipeline (below) |
| `notify` | `message`, `channel?` | message the workspace owner |
| `script` | `path`, `args?`, `output?` | run `bash git/<path>`; paths outside `git/` rejected. Without `output`: detached fire-and-forget. With `output`: stdout is captured (60s timeout, 256 KiB cap) and feeds the output pipeline |
| `emit` | `event`, `payload?` | re-emit a workspace event (`source:'hook'`) |

`agent` and `script` share an **output pipeline** — `output` may combine:

- `note: { path, title? }` — insert the text as a note at `path` (`dir:`
  prefix supported); title defaults to the rule description.
- `file: { path, backend?, append?, insert? }` — save the text to a file.
  `backend: 'home'` (default) writes `{WORKSPACE_ROOT}/home/<path>`
  (`append: true` appends — e.g. a running log); `backend: 'data'` persists
  it to the workspace:data blob store. `insert: '/a/b'` additionally indexes
  the result as a File document at that tree path.
- `notify: true | { channel }` — send the text to the workspace owner.

A note/File inserted via `output` carries `origin:'rule'`, so it only reaches
rules/hooks that opted into cascading — a rule matching its own output no
longer loops.

String fields in `agent.prompt`, `notify.message` and `script.args` support
`{{path}}` templates over `{ doc, payload, event, workspace: { id, name } }`,
e.g. `{{doc.data.subject}}`, `{{doc.data.body}}` / `{{doc.data.bodyHtml}}`
(emails). Any document path works; objects/arrays such as `{{doc.locations}}`
are inserted as JSON. Missing paths render empty.

## Loop prevention (provenance + cascade control)

Every write made from a hook/rule context (`insert`, `update`, `remove`,
`link`, `deleteDocument`, `destroy`, rule actions, agent/script `output`) is
stamped with provenance: `origin: 'hook' | 'rule'`, `causedBy: <triggering
eventId>`, `depth: <triggering depth> + 1`. Dispatch enforces two guards:

- **Cascade opt-in.** Events with an automated origin (anything but `user`)
  are not delivered to handlers by default. A JS hook opts in with
  `export const cascade = true`; a rule with `"cascade": true`. Use this
  deliberately for multi-step pipelines (insert → categorize).
- **Depth ceiling.** Events at `depth >= hooks.maxDepth` (default 2, workspace
  config `hooks.maxDepth`, env `CANVAS_HOOKS_MAX_DEPTH`) are dropped before
  reaching any handler — even cascade-opted ones. Loops terminate by
  construction; the drop is logged at warn level with origin + causedBy.

Additionally: events with `payload.source === 'hook'` (custom `emit()`s) are
never re-dispatched, and `link`/`tag` rule actions use `emitEvent:false`.

## Creating hooks (wizard)

`Create > select event > select action(s) > edit skeleton`:

- `GET /rest/v2/workspaces/:id/hooks/meta` — event catalog, action catalog
  (link / insert / move-remove / agent / notify / script / emit) and the
  classifier surface, for pickers.
- `POST /rest/v2/workspaces/:id/hooks/generate` `{ event, name, actions[] }` —
  writes an editable skeleton to `git/hooks/{event}/disabled-{name}.js`
  (disabled so unedited TODO snippets can't fire) and commits it. 409 if the
  file exists.
- The webui hooks panel (`src/ui/web/src/components/workspace/hooks-panel.tsx`)
  wraps both in a New Hook wizard; skeleton generation lives in
  `src/core/workspace/services/hook/meta.js` (`generateHookSkeleton`).

## Management

- REST: `GET/PUT/DELETE /rest/v2/workspaces/:id/hooks/*`
  (`src/transports/routes/workspaces/hooks.js`) — accepts `{event}.js`,
  `{event}/{name}.js`, `lib/*.js`, `rules.json`, `rules/*.json` (inactive
  prefixes allowed). Writes are git-committed.
- Scripts: `GET/PUT/DELETE /rest/v2/workspaces/:id/scripts/*`
  (`src/transports/routes/workspaces/scripts.js`) — same contract for
  `git/scripts/` (the helpers hooks spawn); PUT chmods `0755` and commits.
  The webui hooks panel has a Hooks | Scripts switch covering both.
- Git: the whole thing is a per-workspace git repo, served over HTTP at
  `https://canvas@<server>/rest/v2/workspaces/:id/git` (basic auth: any
  non-empty username — git requires one, so embed it in the URL — password =
  a canvas API token). `git clone` it, edit `hooks/` + `scripts/`,
  push — the server force-checkouts on receive and hooks hot-reload.
- CLI: `canvas ws hooks list|get|set|edit|push|clone|delete`.
- Seeds: every example ships disabled with an `example-` prefix — the pairs
  `youtube-downloader`+`incoming-metadata-linker` and `pinterest-downloader`+
  `image-categorizer` (vision agent sorts images out of /to-sort), plus
  `email-linker`, `to-sort-categorizer`, `ticket-notify`, `arxiv-summarizer`,
  `image-url-downloader`, `batch-tab-sorter` (`document.inserted.batch` —
  browser-extension batch sync), `api-reference` and `example-rules.json`
  (`src/core/workspace/services/dotfile/files/seed/hooks/`).
- Backfill: seeding normally happens only when the workspace git repo is first
  initialized. `DotfileManager.backfillSeed` copies examples a workspace is
  missing — non-destructively (a file whose enabled name already exists is
  skipped) — and runs lazily on the hooks REST listing and on git-enable, so
  pre-existing workspaces receive new examples the first time the hooks panel
  is opened.
