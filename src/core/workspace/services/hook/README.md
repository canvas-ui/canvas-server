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

| Field | Meaning |
|-------|---------|
| `to` | Target backend address (required) |
| `from` | Only act when the bytes are on this backend (name or array). This is what makes the rule idempotent — after the move nothing matches, so re-runs are no-ops |
| `mode` | `move` (default) or `copy` |
| `key` | Destination key template; omit to keep the current key |
| `onConflict` | `rename` (default: `name-1.ext`), `error`, `overwrite` |

**Key tokens.** `{{YYYY}} {{YY}} {{MM}} {{DD}} {{HH}} {{mm}} {{ss}}` come from the
content's own date: **EXIF capture time first**, then the content timeline, then
the document's created stamp. A photo imported years after it was taken files
under the year it was *taken*. EXIF carries no timezone, so the timestamp is
read back as the wall clock the camera showed. `{{ext}}` (with the dot,
lowercased — from the filename, else the mime type), `{{basename}}`,
`{{filename}}`. `{{doc.*}}` interpolation still works alongside them.

**`path` matches prefixes**, so `/Fotky` covers `/Fotky/2019/07` and every other
subfolder. Bind the rule to both `document.inserted` (uploaded straight into the
folder) and `document.linked` (filed there later).
