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
| `document.inserted` | `id`, `document` (full parsed doc), `context`, `directory` |
| `document.updated` | same |
| `document.removed` / `document.deleted` (+ `.batch`) | ids |
| `tree.*`, `membership.changed`, workspace lifecycle events | varies (often id-only) |

Payloads originating from hooks are stamped `source: 'hook'` and are never
re-dispatched; a 1s window dedupes identical events.

## File layout

```
git/hooks/
  document.inserted.js          # single handler for one event
  document.inserted/*.js        # or several independent handlers
  rules.json                    # declarative rules
  rules/*.json                  # or several rule files (merged, sorted)
  lib/                          # shared modules, never auto-run
```

A leading underscore disables a file (`_foo.js`, `_rules.json`); the UI toggle
just renames it.

## JS hook context

A handler exports a default async function receiving one context object:

| Key | Meaning |
|---|---|
| `event`, `eventName`, `payload`, `payloads` | event data; `payloads` carries the whole burst for debounced hooks |
| `workspace`, `db`, `tree` | workspace instance, SynapsD, default context tree (null when inactive) |
| `classify` | document classifier, see below |
| `insert`, `update`, `remove`, `deleteDocument`, `get`, `list`, `find`, `link` | document CRUD on the workspace |
| `agent(slug, prompt, opts)` | prompt one of your agents, returns its text reply (null on failure) |
| `notify(message, { channel? })` | message the workspace owner (Slack/WhatsApp/default) |
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
| `link` | `paths`, `tags?` | link doc to context paths (`emitEvent:false`, loop-safe) |
| `tag` | `tags` | re-link doc on its own paths with feature tags |
| `agent` | `slug`, `prompt`, `options?` | prompt an agent |
| `notify` | `message`, `channel?` | message the workspace owner |
| `script` | `path`, `args?` | spawn `bash git/<path>` detached; paths outside `git/` rejected |
| `emit` | `event`, `payload?` | re-emit a workspace event (`source:'hook'`) |

String fields in `agent.prompt`, `notify.message` and `script.args` support
`{{path}}` templates over `{ doc, payload, event, workspace: { id, name } }`,
e.g. `{{doc.data.subject}}`. Missing paths render empty.

## Loop prevention — and one pitfall

- Events with `payload.source === 'hook'` are never dispatched to hooks/rules.
- `emit()` and the `emit` rule action stamp `source:'hook'`.
- `link`/`tag` rule actions use `emitEvent:false`.
- **Pitfall:** the JS-hook `insert`/`update` helpers go through `workspace.put`,
  which emits a regular `document.inserted` (`source:'db'`). A hook that
  inserts a document matching its own trigger will loop. Make the inserted doc
  un-matchable (e.g. the arxiv summarizer stores a note with no URL) or guard
  on schema/path.

## Management

- REST: `GET/PUT/DELETE /rest/v2/workspaces/:id/hooks/*`
  (`src/transports/routes/workspaces/hooks.js`) — accepts `{event}.js`,
  `{event}/{name}.js`, `lib/*.js`, `rules.json`, `rules/*.json`. Writes are
  git-committed.
- CLI: `canvas ws hooks list|get|set|edit|push|clone|delete`.
- Seeds: new workspaces receive the example hooks from
  `src/core/workspace/services/dotfile/files/seed/hooks/` (youtube downloader
  enabled; email-linker, to-sort categorizer, ticket-notify, arxiv summarizer,
  image-url downloader and `_rules.json` shipped disabled).
