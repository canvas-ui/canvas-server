---
name: project_media_streaming
description: "Media streaming: HTTP Range/206 on /content + short-lived media-cookie auth so <video>/<audio> stream & seek directly (no full-blob download)"
metadata: 
  node_type: memory
  type: project
  originSessionId: e81ed646-504f-418f-956a-3ff78e7246fd
---

Video/audio streaming implemented 2026-07 (server restart required — core+transport files, not just web bundle). Replaces the old full-blob-download playback (fetch → res.blob() → object URL) which OOM'd/stalled on large files (e.g. a 280MB mp4).

**Server — HTTP Range (206):**
- `src/transports/lib/http-range.js` (new): `parseByteRange(header, total)` → `{start,end}` (inclusive end) | `'unsatisfiable'` (→416) | null. Shared by both content routes.
- `/content` routes (`transports/routes/workspaces/documents.js` + `transports/routes/pub/canvases.js`): advertise `Accept-Ranges: bytes` when rangeable (non-attachment + known `metadata.size`), respond **206** with `Content-Range`/`Content-Length` ONLY when the resolver actually served the window (`resolved.ranged`) — else full 200 (no length mismatch). 416 on unsatisfiable. Attachments always served whole.
- Resolve plumbing threads `options.range`: `Workspace.resolveDocument` → returns `{stream|buffer, url, ranged}`; `WorkspaceStoredIndex.resolve` → returns `{data, ranged}` (file://{WORKSPACE_ROOT} via `createReadStream(abs,{start,end})`; stored:// via new `Stored.getRangeStreamByUrl`). Backends gained optional `getRange(key,{start,end})`: **cacache** reads the content-addressed blob file directly (`import contentPath from 'cacache/lib/content/path.js'` — internal deep import, cacache 20.x, no exports-map; layout content-v2 stable) + `createReadStream({start,end})`; **file** backend via `createReadStream`. Backends without getRange (http/s3, not supported yet) → full stream, `ranged:false`. Remote backends cache in cacache locally so reads are local; future first-request backend proxy would be `ranged:false`.

**Server — auth (media can't send Authorization header):**
- Short-lived signed **cookie** (NOT token-in-URL, NOT service worker). `POST /:id/documents/:docId/content-ticket` (bearer-authed) → `fastify.jwt.sign({scope:'media',ws,sub},{expiresIn:'3600s'})` set as `cvs_media` cookie: `HttpOnly; SameSite=Strict; Path=<…/documents>` (derived from request.url, prefix-agnostic); `Secure` when https. TTL 3600s = viewing session (avoids mid-playback 401 on seek/resume).
- `/content` auth = custom `authenticateContent`: try bearer (`fastify.authenticate`, throws→caught), else verify `cvs_media` cookie (`fastify.jwt.verify`, check scope+ws). Workspace ACL still enforced via getWorkspaceInstance(request.user). CSRF-safe: GET-only/read-only + SameSite=Strict + path-scoped.
- Same-origin by default (`API_URL = ${origin}/rest/v2`) so cookie flows to `<video src>`.

**Server — MIME fallback:** `src/transports/lib/mime.js` `resolveContentType(storedType, filename)` — generic/missing/octet-stream `contentType` → extension-derived MIME (mirrors web `types.ts` EXT_MIME). So a direct `<video>` stream gets a real Content-Type even when the doc lacks one. Root cause of the earlier "mp4 preview broken": `classifyMime` only checked contentType → octet-stream routed to BinaryFallback; fixed client-side too (see below).

**Client:**
- `services/workspace.ts`: `documentStreamUrl()` (direct /content URL) + `requestContentTicket()` (POST, `credentials:'include'`).
- `renderers/public-share.tsx` `useDocumentContent`: added `streamUrl` (pub mirror URL for shares / authed direct URL) + `mintTicket` (no-op for public).
- `renderers/useDocumentBlobUrl.ts`: new `useDocumentStreamSrc(ws, docId)` — mints ticket then returns direct src. `VideoRenderer`/`AudioRenderer` use it (`playsInline`+`preload=metadata`), + shared `DownloadButton` (authed blob download w/ `download=1`). PDF/image still blob (`typeHint` retype for generic-MIME blobs kept for PDF).
- `renderers/types.ts`: `classifyMime` now falls back to filename extension (`.mp4`→video etc.) when contentType missing/octet; `mimeFromFilename`/`extOf` exported.

Related: [[project_cli_add_vs_insert]] (uploads→stored:// cacache), [[project_workspace_data_backends]] (workspace:home=file, workspace:data=cacache), [[project_blob_metadata_extraction]].
