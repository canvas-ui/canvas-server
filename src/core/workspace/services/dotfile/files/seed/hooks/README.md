# Workspace hooks

Hooks are plain ES modules that run **in-process inside canvas-server** when a
workspace event fires. This repo is live: a `git push` (or a save from the
settings UI) redeploys and hot-reloads immediately — there is no build step and
no restart.

> **If you are an agent (or drive one) amending this repo, read
> [Execution model](#execution-model) and [Rules of the road](#rules-of-the-road)
> first.** Hooks run with full workspace permissions; a bad loop can insert
> documents forever.

## Layout

```
hooks/
  {event}.js          single handler for an event (e.g. document.inserted.js)
  {event}/*.js        several independent handlers; every .js file runs
  lib/                shared modules, never auto-run
  rules.json          declarative match→action rules (no code)
  rules/*.json        more rule files, merged in filename order
scripts/              shell helpers spawned by hooks (chmod 755 on deploy)
```

A handler exports a default async function receiving one context object:

```js
export default async function hook(ctx) {
  const c = ctx.classify();
  if (c.isEmail() && c.from?.includes('boss@')) {
    await ctx.link(ctx.payload.id, ['/work/urgent']);
    await ctx.notify(`Mail from the boss: ${ctx.payload.document?.data?.subject}`);
  }
}
```

## Execution model

- **In-process, hot-reloaded.** Files are cached by mtime; editing a file
  reloads it on the next event. Errors are logged (debug level) and swallowed —
  a throwing hook never breaks ingestion, but it also fails silently. Log
  liberally via `ctx.logger`.
- **Imports:** `node:*` builtins and relative imports (`./`, `../lib/…`) work.
  Bare npm specifiers are NOT guaranteed to resolve — this repo lives outside
  the server's `node_modules`. Keep hooks dependency-free; shell out to
  `scripts/` for anything heavier.
- **Events:** the canonical synapsd events re-emitted on the workspace. The
  machine-readable catalog (names, payload shapes, whether a full document is
  included) is `GET /rest/v2/workspaces/<id>/hooks/meta` — same data the UI
  wizard uses. The workhorses:
  - `document.inserted` / `document.updated` — payload
    `{ id, document, context, directory }` with the **full parsed document**.
  - `document.linked` / `document.unlinked` — a document was filed into /
    removed from tree path(s); carries the **full document** plus the
    memberships that changed (unlike the id-only `document.removed`).
  - `document.inserted.batch` / `.updated.batch` — `{ ids, count, context,
    directory }`, once per bulk op (imap sync, browser-extension batch sync).
  - Every payload also carries provenance: `eventId` (unique per emit),
    `origin` (`user` | `hook` | `rule` | `agent` | …), `causedBy` (the parent
    eventId for automated writes) and `depth` (cascade depth).
- **Cascade opt-in:** by default a hook never receives events **caused by
  automation** (origin ≠ `user` — e.g. a note another hook inserted). Add
  `export const cascade = true;` to receive them. A hard depth ceiling
  (`hooks.maxDepth`, default 2) terminates any chain regardless.
- **Batch fan-out:** batch inserts are ALSO fanned out by the engine as
  per-document `document.inserted` dispatches (full doc loaded, `batch: true`
  and `batchCount` stamped), sequentially. So: per-document logic → singular
  event; whole-batch logic (one agent call for N docs) → `.batch` event. You
  never receive a document-less `document.inserted`.
- **Debounce:** `export const debounce = 2000;` coalesces a burst into one run;
  all payloads arrive in `ctx.payloads`. Use `classify(p)` per element.

## Hook context (`ctx`)

| Key | Description |
|---|---|
| `payload` / `payloads` | Event payload; `payloads` holds the whole burst under debounce. |
| `classify(target?)` | Classification of the event document (default), another payload, or a raw doc. Never throws. |
| `logger` | Server logger (`debug/info/warn/error`). Output goes to the canvas-server log. |
| `insert(doc, {context?, directory?, features?})` | Insert a document. The resulting event is stamped `origin:'hook'` (+ `causedBy`/`depth`), so it never re-triggers hooks/rules unless they opted into cascading. |
| `update(id, doc, opts?)` / `remove(id, opts?)` / `deleteDocument(id)` | Update in place / unlink from paths / hard-delete from the index (backend bytes untouched). |
| `destroy(idOrDoc)` | Delete the document **everywhere**: bytes on every deletable location (stored:// blob, workspace file, imap EXPUNGE; read-only locations degrade to a reference drop), then purge from the index. Irreversible. |
| `get(id)` / `list(spec)` / `find({query})` | Fetch by id / list / full-text+hybrid search. |
| `link(id, ['/path', …])` | Link a document into context paths. |
| `agent(slug, prompt, {raw?})` | Prompt one of the user's agents (auto-starts it), returns its text reply. The prompt is wrapped in a standard automation envelope (event, doc summary, "reply with the final result only") — pass `{ raw: true }` to skip it. Agents only get canvas_* tools if previously bound via `PUT /rest/v2/agents/<slug>/access`. |
| `notify(message, {channel?})` | Message the workspace owner via the messaging service. Bound channel (slack/whatsapp/`webhook` — POSTs `{text}` JSON to a URL you bind via `PUT /rest/v2/messaging/bindings`, Slack/Teams incoming-webhook compatible) wins; unbound users get the in-app `canvas` channel — a web-UI toast plus the toolbox notifications area. |
| `emit(name, payload)` | Emit a custom workspace event, stamped `source:'hook'` (never re-triggers hooks). |
| `event` / `workspace` / `db` / `tree` | Event envelope and escape hatches (db/tree are null while the workspace is inactive). |

## Classifier

`classify()` lets handlers read declaratively instead of matching schema
strings and regexes by hand:

```js
const c = ctx.classify();
c.isTab() && c.isYoutube()          // browser tab pointing at youtube
c.isEmail() && c.from               // normalized lowercase sender address
c.isFile() && c.mimeMatches('image/*')
c.inPath('/to-sort')                // segment-aware path prefix
```

Predicates: `isTab/isEmail/isFile/isNote/isTodo/isMessage/isSchema(name)`,
`isLink/isYoutube/isArxiv/isImageUrl/hostMatches/urlMatches`,
`isText/isImage/isAudio/isVideo/isPdf/isBlob/mimeMatches`,
`sentTo(addr)` (To+Cc), `hasAttachment(mimePattern?)`, `inPath(prefix)`.
Fields: `url`, `parsedUrl`, `host`, `from`, `to`, `subject`, `attachments`,
`mime`, `paths`, `schema`, `doc`. All predicates are false for a null/unknown
document.

## Declarative rules

Simple match→action automations go into `rules.json` (or files under `rules/`)
— the settings UI has a click-to-build editor for exactly this file:

```json
{
  "$schema": "canvas.hook-rules/v1",
  "rules": [
    {
      "id": "youtube-to-media",
      "when": { "event": "document.inserted", "schema": "tab",
                "url": { "host": "youtube.com" } },
      "then": [ { "action": "link", "paths": ["/media/youtube"],
                  "tags": ["custom/media/video"] } ]
    }
  ]
}
```

`when` keys AND together (`event` required; `schema`, `path`, `url`, `from`,
`to` — any To/Cc recipient, `subject`, `mime`, `attachment` — `true` for any,
a mime pattern like `"application/pdf"`, or `{mime, filename}`); an array
value means OR. A rule-level `"cascade": true`
opts the rule into automation-caused events (see Cascade opt-in above);
without it, rules never see documents created by other rules/hooks/agents. `from`/`subject` accept a
substring or `{equals|contains|startsWith|regex}`; `url` a substring or
`{host|prefix|contains|regex}`. Every matching rule fires (no first-match-wins).
Actions: `link`, `unlink` (remove from paths), `tag`, `delete` (purge from
index; backend bytes untouched), `destroy` (**irreversible** — delete bytes on
every deletable location, then purge), `agent`, `notify`, `script`, `emit`.
Rule `script`s run hardened: path must resolve under `git/`; env is sanitized
to `PATH`/`HOME`/`LANG` plus `CANVAS_EVENT`, `CANVAS_EVENT_ID`,
`CANVAS_WORKSPACE`, `CANVAS_WORK_DIR` (a per-run scratch dir under `var/tmp`,
also the cwd — cleaned after a successful captured run, swept after 24h
otherwise); the full JSON event envelope arrives on stdin; `timeout` (ms,
captured mode, default 60000, max 600000) is configurable per action. Link/unlink paths target the context tree by default;
`dir:/a/b` targets the directory tree. `agent` and `script` take an optional
`output` consuming the agent reply / script stdout (60s timeout, 256 KiB cap):
`{ note: { path, title? }, file: { path, backend?: 'home'|'data', append?,
insert? }, notify: true }` — save as note, write to a file under `home/`
(or the workspace:data blob store; `insert` additionally indexes it as a File
doc at that tree path), and/or message you. Inserted notes/Files carry
`origin:'rule'`, so they can't re-trigger rules that didn't opt into cascade.
Strings support
`{{doc.data.subject}}`-style templates over `{doc, payload, event, workspace,
rule}`; objects/arrays like `{{doc.locations}}` are inserted as JSON. Rules
only match `document.*` events that carry a document (batch fan-out included).

## Rules of the road

1. **Loops are cut off by construction.** Every write a hook/rule makes is
   stamped with provenance (`origin:'hook'|'rule'`, `causedBy`, `depth+1`).
   Handlers ignore automation-caused events unless they opt in (`export const
   cascade = true` / rule `"cascade": true`), and a depth ceiling
   (`hooks.maxDepth`, default 2) hard-stops any chain. Design multi-step
   pipelines deliberately: step 2 must opt into cascade, and chains longer
   than the ceiling won't run.
2. **Stay disabled until done.** Generated skeletons and examples carry an
   inactive prefix on purpose; strip it only when TODOs are resolved. When
   experimenting, prefer a `disabled-` copy + rename over editing a live hook.
3. **Errors are swallowed — but recorded.** A throwing hook/rule never breaks
   ingestion; every execution (ok / error / skipped) lands in the run log:
   the Runs tab in the settings UI, `GET /rest/v2/workspaces/<id>/hooks/runs`,
   or `{WORKSPACE_ROOT}/var/hooks/runs.jsonl` directly. Use
   `POST …/hooks/explain` (or the CLI `hooks explain <docId>`) to see which
   rules would fire for a document and why; `hooks backfill --rule <id>
   [--dry-run]` applies a rule to existing documents, `hooks replay <runId>`
   re-delivers a logged run.
4. **A 1s dedup window** drops identical event payloads; don't rely on
   duplicate deliveries.
5. **Full permissions, no sandbox.** Hooks and scripts run as the server
   process with the workspace owner's data. Never commit secrets to this repo;
   scripts get no env injection beyond the server's own environment.
6. **Dotfiles are never auto-indexed** — files starting with a dot are invisible
   to ingestion regardless of location.
7. **Register produced files through the front door.** A script that downloads
   something should print the file path; the hook then inserts the File
   document itself (see `lib/insert-file.js` and the downloader examples) —
   checksummed, located, linked, provenance-stamped. Don't drop files into
   `home/` and hope the indexer notices.

## Enable / disable

A filename prefix marks a file inactive — the engine skips it:

- `example-*` — shipped example (everything in a fresh workspace starts this way)
- `disabled-*` — switched off (the UI toggle adds/strips this)
- `_*` — legacy disable prefix, still honoured

Enable by stripping the prefix (`example-youtube-downloader.js` →
`youtube-downloader.js`) via the settings UI toggle, or `git mv` + push.

Shipped examples (all disabled): `youtube-downloader`,
`pinterest-downloader` + `image-categorizer` (pair — stage 2 exports
`cascade = true` to see stage 1's inserts), `email-linker`,
`to-sort-categorizer`, `ticket-notify`, `arxiv-summarizer`,
`image-url-downloader`, `batch-tab-sorter` (`document.inserted.batch`),
`backend-tree-sync` (`started/` full sync + `tree.path.inserted/` incremental —
mirrors a storage backend's folders, default `workspace:home`, into the
context tree; config in `lib/backend-tree-sync.js`), plus `example-rules.json`
(rename to `rules.json` to activate).

## Running by hand

The webui's **Run** button (Hooks section) runs a hook outside of its event:
`document.*` hooks get a backfill over existing documents (up to the
**Batch size** set in the toolbar, default 100), anything else — `started`,
`tree.*` — gets one run with a synthesized `{ manual: true }` envelope
(`POST /hooks/run`). Writes made from such runs carry `origin:'manual'` /
`'backfill'` and are cascade-guarded like any automation.

## Editing & git access

Edit from the workspace settings UI (saves commit) or clone the repo — it is
served over HTTP with basic auth (any non-empty username; the password is a
`canvas-` API token):

```bash
git clone https://canvas@<canvas-server>/rest/v2/workspaces/<workspace-id>/git
# password: your canvas API token
```

Pushes force-checkout `hooks/` + `scripts/` into the live workspace and
hot-reload. `scripts/*` are chmod 755 on deploy. From a JS hook, spawn a
script, capture its stdout and register produced files via
`lib/insert-file.js` (see `youtube-downloader`); rule `script` actions get the
hardened contract described above automatically.
