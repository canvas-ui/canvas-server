# Workspace Hooks Manager

- Hooks deployed to WORKSPACE_ROOT/git/hooks from bare.git on push
- Managed via `canvas ws <workspace> hooks <action>`
- Git remote: `/workspaces/<ws>/git`
- Hooks run in a container
- You can bind hooks to all events available for your workspace or contexts/canvases(which are based on contexts)
- Examples: Download all yt videos linked in universe://home/to-downlaod or Sort all emails based on the current context tree from work://customer-foo/project-bar

## Hook connectors

## Predefined hooks / hook templates



## Storage rules — the `store` action

Uploads land in the managed blob store (`workspace:data`): content-addressed,
deduped, opaque by design. A declarative rule moves them onto a real filesystem
once you have said where they belong, without touching the index entry — the
document keeps its id, its tags and every folder it is filed in. Only
`locations[]` changes.

```json
{
  "id": "photos-to-home",
  "when": {
    "event": ["document.inserted", "document.linked"],
    "schema": "file",
    "mime": "image/*",
    "path": "/Fotky"
  },
  "then": [
    {
      "action": "store",
      "to": "workspace:home",
      "from": "workspace:data",
      "mode": "move",
      "key": "Fotky/{{YYYY}}/{{MM}}/{{YYYY}}{{MM}}{{DD}}_{{HH}}{{mm}}{{ss}}{{ext}}",
      "onConflict": "rename"
    }
  ]
}
```

The friendlier spelling separates *where* from *what* — this is what the web
rule builder writes. "Every image filed under `/projects/canvas/UI` lands in
`workspace:home/Projects/Canvas/UI`, sub-folders kept":

```json
{
  "id": "canvas-ui-images",
  "when": { "event": ["document.inserted", "document.linked"], "schema": "file", "mime": "image/*", "path": "/projects/canvas/UI" },
  "then": [ { "action": "store", "to": "workspace:home", "folder": "Projects/Canvas/UI", "recursive": true } ]
}
```

| Field | Meaning |
|-------|---------|
| `to` | Target backend address (required) |
| `from` | Only act when the bytes are on this backend (name or array). This is what makes the rule idempotent — after the move nothing matches, so re-runs are no-ops. Omitted: any backend other than `to` |
| `mode` | `move` (default) or `copy` |
| `folder` | Directory on the target backend (template tokens allowed) |
| `recursive` | `true`: append the document's sub-path below the matched `when.path` prefix — `/projects/canvas/UI/mobile/x` → `Projects/Canvas/UI/mobile/…` (same semantics as `link`'s `recursive`) |
| `key` | File-name template. With `folder`/`recursive` it defaults to `{{basename}}{{ext}}` (original name; extension derived from the mime type when the blob key has none). Alone, it is the full destination key (legacy form); omit everything to keep the current key |
| `onConflict` | `rename` (default: `name-1.ext`), `error`, `overwrite` |

The destination is `folder / {{match.rel}} / key` joined with empty, `.`, `..`
and leading-slash segments dropped, so a rule can never escape the backend root.

**Key tokens.** `{{YYYY}} {{YY}} {{MM}} {{DD}} {{HH}} {{mm}} {{ss}}` come from the
content's own date: **EXIF capture time first**, then the content timeline, then
the document's created stamp. A photo imported years after it was taken files
under the year it was *taken*. EXIF carries no timezone, so the timestamp is
read back as the wall clock the camera showed. `{{ext}}` (with the dot,
lowercased — from the filename, else the mime type), `{{basename}}`,
`{{filename}}`, `{{title}}` (document title made filesystem-safe, falls back to
`{{basename}}`), `{{id}}`. `{{doc.*}}` interpolation still works alongside them.

**`path` matches prefixes**, so `/Fotky` covers `/Fotky/2019/07` and every other
subfolder. Bind the rule to both `document.inserted` (uploaded straight into the
folder) and `document.linked` (filed there later).

## Dedupe — the `unstore` action

The inverse of `store`: delete a document's bytes from named backends while
every other copy, and the index entry, stay. For clearing staging copies once
the content is safely somewhere else, or for pruning a backend you are retiring.

```json
{
  "action": "unstore",
  "from": "workspace:data",
  "ifOn": "workspace:home",
  "keepLast": true
}
```

| Field | Meaning |
|-------|---------|
| `from` | Backend(s) to delete the bytes from (required) |
| `ifOn` | Only when the content ALSO lives on these backends — "drop the staging copy once it is on the NAS", stated in the order it has to happen |
| `keepLast` | Default `true`: refuse to remove the object's last remaining location. Deleting the only copy is `destroy`'s job and should take saying so |
| `keepDocument` | With `keepLast:false`, keep the index entry (no locations) instead of cascading the document delete |

Both guards matter because a rule fires unattended on every matching event: a
`from` that happens to hold the only copy would otherwise be a silent data
delete. Locations that are not byte backends (`imap://`, `https://`) count as
survivors — the bytes are still reachable there.
