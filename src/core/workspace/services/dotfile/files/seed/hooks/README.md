# Workspace hooks

Hooks are plain ES modules that run in-process when a workspace event fires.

## Layout

- `{event}.js` - a single handler for an event (e.g. `document.inserted.js`).
- `{event}/*.js` - several independent handlers for the same event. Every `.js`
  file in the directory runs; this is the preferred layout once you have more
  than one handler per event.
- `lib/` - shared modules, never auto-run.
- `rules.json` + `rules/*.json` - declarative rules, no code needed (below).

A handler exports a default async function and receives one context argument.
See `_example.js` for the full set of values. Minimal shape:

```js
export default async function hook({ eventName, payload, workspace, logger,
  insert, update, remove, get, list, find, link, emit, agent }) {
  // ...
}
```

`payload.context` / `payload.directory` carry the tree path the document landed
in, so handlers can branch on location (e.g. `/to-sort`, `/.backends`).

`agent(slug, prompt)` prompts one of your agents and returns its text reply.

## Classifier

`classify()` returns a classification of the event's document so handlers read
declaratively instead of matching schema strings and regexes by hand:

```js
export default async function hook({ classify }) {
  const c = classify();
  if (c.isTab() && c.isYoutube()) { /* ... */ }
  if (c.isEmail() && c.from === 'boss@corp.com') { /* ... */ }
  if (c.isFile() && c.mimeMatches('image/*')) { /* ... */ }
  if (c.inPath('/to-sort')) { /* ... */ }
}
```

Predicates: `isTab/isEmail/isFile/isNote/isTodo/isMessage/isSchema(name)`,
`isLink/isYoutube/isArxiv/isImageUrl/hostMatches/urlMatches`,
`isText/isImage/isAudio/isVideo/isPdf/isBlob/mimeMatches`, `inPath(prefix)`.
Fields: `url`, `host`, `from`, `subject`, `mime`, `paths`.
Use `classify(p)` per element of a debounced `payloads` burst, or
`classify(doc)` on a document fetched via `get()`.

## Declarative rules

Simple match→action automations go into `rules.json` (or several files under
`rules/`), no code needed:

```json
{
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

`when` keys AND together (`event` is required; `schema`, `path`, `url`, `from`,
`subject`, `mime`); give a key an array for OR. Every matching rule fires.
Actions: `link`, `tag`, `agent`, `notify`, `script` (under `git/`), `emit`.
Strings in prompts/messages/args support `{{doc.data.subject}}` templates.
See `example-rules.json` for a full example; rename it to `rules.json` to
activate.

## Enable / disable

A filename prefix marks a hook as inactive — the engine skips it:

- `example-*` - shipped example (everything in a fresh workspace starts this way)
- `disabled-*` - a hook you switched off (the UI toggle adds/strips this)
- `_*` - legacy disable prefix, still honoured

Enable a hook by stripping the prefix (`example-youtube-downloader.js` →
`youtube-downloader.js`), via the settings UI toggle, or `git mv` + push.

Shipped examples (all disabled): `youtube-downloader` + `incoming-metadata-linker`
(pair: download videos, link the file), `pinterest-downloader` +
`image-categorizer` (pair: fetch pinned images, vision agent sorts them from
/to-sort), `email-linker`, `to-sort-categorizer`, `ticket-notify`,
`arxiv-summarizer`, `image-url-downloader`, `batch-tab-sorter` (on
`document.inserted.batch` — one run per browser-extension sync batch), plus
`example-rules.json`. Pairs need both halves enabled.

## Debounce

`export const debounce = 2000;` coalesces a burst of events into a single run
that receives all of them in `payloads`. Use it so a categorizer fires once per
sync instead of once per document when the app inserts singletons.

## Editing

Edit hooks from the workspace settings UI or by `git push` to the workspace
repo. Saving from the UI commits the change; a push redeploys and hot-reloads.

The repo (hooks/, scripts/, dotfiles) is served over HTTP:

```bash
# username: anything, password: a canvas API token
git clone https://<canvas-server>/rest/v2/workspaces/<workspace-id>/git
```
