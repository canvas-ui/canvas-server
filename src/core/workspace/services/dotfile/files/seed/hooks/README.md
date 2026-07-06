# Workspace hooks

Hooks are plain ES modules that run in-process when a workspace event fires.

## Layout

- `{event}.js` - a single handler for an event (e.g. `document.inserted.js`).
- `{event}/*.js` - several independent handlers for the same event. Every `.js`
  file in the directory runs; this is the preferred layout once you have more
  than one handler per event.
- `lib/` - shared modules, never auto-run.

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

## Enable / disable

A leading underscore disables a hook (`_youtube.js` is off, `youtube.js` is on).
The settings UI toggle just renames the file. Disabled hooks ship as examples.

## Debounce

`export const debounce = 2000;` coalesces a burst of events into a single run
that receives all of them in `payloads`. Use it so a categorizer fires once per
sync instead of once per document when the app inserts singletons.

## Editing

Edit hooks from the workspace settings UI or by `git push` to the workspace
repo. Saving from the UI commits the change; a push redeploys and hot-reloads.
