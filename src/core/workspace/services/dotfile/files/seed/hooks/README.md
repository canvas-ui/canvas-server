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
  - `document.inserted.batch` / `.updated.batch` — `{ ids, count, context,
    directory }`, once per bulk op (imap sync, browser-extension batch sync).
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
| `insert(doc, {context?, directory?, features?})` | Insert a document. **Emits a normal `source:'db'` event** — see loop warning below. |
| `update(id, doc, opts?)` / `remove(id, opts?)` / `deleteDocument(id)` | Update in place / unlink from paths / hard-delete. |
| `get(id)` / `list(spec)` / `find({query})` | Fetch by id / list / full-text+hybrid search. |
| `link(id, ['/path', …])` | Link a document into context paths. |
| `agent(slug, prompt, {raw?})` | Prompt one of the user's agents (auto-starts it), returns its text reply. The prompt is wrapped in a standard automation envelope (event, doc summary, "reply with the final result only") — pass `{ raw: true }` to skip it. Agents only get canvas_* tools if previously bound via `PUT /rest/v2/agents/<slug>/access`. |
| `notify(message, {channel?})` | Message the workspace owner via the messaging service. Bound channel (slack/whatsapp/…) wins; unbound users get the in-app `canvas` channel — a web-UI toast plus the toolbox notifications area. |
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
`isText/isImage/isAudio/isVideo/isPdf/isBlob/mimeMatches`, `inPath(prefix)`.
Fields: `url`, `parsedUrl`, `host`, `from`, `subject`, `mime`, `paths`,
`schema`, `doc`. All predicates are false for a null/unknown document.

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
`subject`, `mime`); an array value means OR. `from`/`subject` accept a
substring or `{equals|contains|startsWith|regex}`; `url` a substring or
`{host|prefix|contains|regex}`. Every matching rule fires (no first-match-wins).
Actions: `link`, `tag`, `agent`, `notify`, `script` (path under `git/`),
`emit`. Link paths target the context tree by default; `dir:/a/b` targets the
directory tree. The `agent` action takes an optional
`output: { note: { path, title? }, notify: true }` — the agent's reply is
saved as a note at `path` and/or sent to you (careful: the note emits a normal
`document.inserted`, so a rule matching its own note loops). Strings support
`{{doc.data.subject}}`-style templates over `{doc, payload, event, workspace,
rule}`; objects/arrays like `{{doc.locations}}` are inserted as JSON. Rules
only match `document.*` events that carry a document (batch fan-out included).

## Rules of the road

1. **Loop prevention is partial.** Events produced by hook helpers `emit`,
   `link` (rules) are marked `source:'hook'` and never re-dispatch. But
   `ctx.insert`/`ctx.update` go through the normal write path and emit ordinary
   events: **a hook that inserts a document matching its own trigger loops
   forever.** Always guard — e.g. the arxiv summarizer inserts a *note* (notes
   have no URL, so `isArxiv()` can't re-match).
2. **Stay disabled until done.** Generated skeletons and examples carry an
   inactive prefix on purpose; strip it only when TODOs are resolved. When
   experimenting, prefer a `disabled-` copy + rename over editing a live hook.
3. **Errors are swallowed.** Verify behavior via `ctx.logger` output in the
   server log, not by assuming an exception would surface.
4. **A 1s dedup window** drops identical event payloads; don't rely on
   duplicate deliveries.
5. **Full permissions, no sandbox.** Hooks and scripts run as the server
   process with the workspace owner's data. Never commit secrets to this repo;
   scripts get no env injection beyond the server's own environment.
6. **Dotfiles are never auto-indexed** — files starting with a dot are invisible
   to ingestion regardless of location. Scripts can use `.name.metadata.json`
   sidecars (see `incoming-metadata-linker`) without triggering loops.

## Enable / disable

A filename prefix marks a file inactive — the engine skips it:

- `example-*` — shipped example (everything in a fresh workspace starts this way)
- `disabled-*` — switched off (the UI toggle adds/strips this)
- `_*` — legacy disable prefix, still honoured

Enable by stripping the prefix (`example-youtube-downloader.js` →
`youtube-downloader.js`) via the settings UI toggle, or `git mv` + push.

Shipped examples (all disabled): `youtube-downloader` +
`incoming-metadata-linker` (pair), `pinterest-downloader` + `image-categorizer`
(pair), `email-linker`, `to-sort-categorizer`, `ticket-notify`,
`arxiv-summarizer`, `image-url-downloader`, `batch-tab-sorter`
(`document.inserted.batch`), plus `example-rules.json` (rename to `rules.json`
to activate). Pairs need both halves enabled.

## Editing & git access

Edit from the workspace settings UI (saves commit) or clone the repo — it is
served over HTTP with basic auth (any non-empty username; the password is a
`canvas-` API token):

```bash
git clone https://canvas@<canvas-server>/rest/v2/workspaces/<workspace-id>/git
# password: your canvas API token
```

Pushes force-checkout `hooks/` + `scripts/` into the live workspace and
hot-reload. `scripts/*` are chmod 755 on deploy; spawn them from hooks
detached (see `scripts/ytdl.sh` usage in `youtube-downloader`).
