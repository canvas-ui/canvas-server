---
name: project_cli_add_vs_insert
description: "CLI verb scheme: ws add/upload = upload bytes (stored://, embeddable); ws index = index in place (file://device, not embeddable)"
metadata:
  type: project
---

CLI verb scheme (finalized 2026-07-02):
- **`ws add <path>`** = friendly default -> UPLOADS bytes (stored://workspace:data, embeddable). Also `add note|link|url` = create.
- **`ws upload <path>`** = explicit upload (same logic as add).
- **`ws index <path>`** = index IN PLACE -> `file://<deviceId>` pointer; bytes stay on device, NOT embeddable.

Shared logic: `workspace/lib/fileingest.js` `ingestPath(ctx, {mode, adapter, useTargets})`. Context module has the same 3 verbs via `contextAdapter`; context is CONSERVATIVE - inserts go to the context's current focused path only, NO path/tree targeting flags (`useTargets:false`).

`--timeline <name>` flag routes content-derived dates (EXIF capturedAt) to a named timeline (default 'content'; crud:* = lifecycle only).

Embedding: only `stored://` (server-resident) bytes embed; `data/abstraction/file` embeds ONLY from bytes (text/* -> utf8, image/* -> CLIP), never from the location-URL string. See [[project_embedd_service]].
