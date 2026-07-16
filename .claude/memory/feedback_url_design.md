---
name: URL design — mirror REST API
description: UI URLs should mirror REST API paths — simple, human-readable, no type-specific query cruft
type: feedback
originSessionId: 9c435248-6639-43ec-a61e-4df211f66c34
---
UI URLs should be simple, human-readable, and mirror the REST API path scheme. A developer seeing `/foo/bar/baz/baf` in the browser should be able to hit the same path on the API to fetch the same data — no diving into docs.

**Why:** Canvas project will index a wide variety of data types (files, tabs, notes, emails, applications, dotfiles, agents, more). Encoding leaf type / id / hints in URL query params (`?nodeType=canvas&canvasId=...`) doesn't scale and creates an impedance mismatch between UI and API.

**How to apply:**
- Path is the source of truth. The backend should figure out leaf semantics from the path itself (already does for canvas via `Workspace.list/search` querySpec composition).
- Don't add UI-only URL params just to render a chip or show/hide a button. Derive UI hints from already-loaded data (tree, leaf node payload).
- Server may have to do extra work to keep URLs clean — that's the right tradeoff.
- When introducing a new data type, the URL pattern stays the same: just a path. Type-specific behavior lives in the leaf node + server logic.
