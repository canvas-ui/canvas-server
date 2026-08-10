---
name: project_document_comment_field
description: "user-authored top-level `comment` field on all documents (FTS + dedicated -1 vector chunk + feature/has-comment bitmap)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 34e3a455-5c35-4ede-8627-949abaa0d4e0
---

Optional user-authored free-text `comment` on every document. Implemented across synapsd, inferd, Workspace, and web UI.

- **Storage**: top-level field on `BaseDocument` (schema/constructor/`update()`/`toJSON()` + `hasComment` getter). NOT under `data` (avoids checksum churn / per-schema strictness) — `checksumFields` is `['data']`, so comment edits never re-checksum or re-embed content. All abstractions `.extend(baseDocumentSchema)` or import base `documentSchema`, so they inherit it.
- **FTS**: `generateFtsData()` always appends the comment, even for blob docs with no `ftsSearchFields`.
- **Presence bitmap**: `feature/has-comment` (NOT `document/` — invalid prefix). Ticked/unticked from doc state in all 3 write paths (`#putOne`/`putMany`/`#updateOne`) via `#applyMembership` inside `#withDeferredMembership`. User-filterable (Features tab groups it under "Feature" via existing PREFIX_LABELS).
- **Embedding**: reserved `chunkId: -1` (`canvas-inferd/src/constants.js` COMMENT_CHUNK_ID) in the **text** space. Worker (`canvas-inferd/src/index.js` `#handle` + `#embedComment`) bundles it with content chunks when the doc routes to text, else does a standalone text upsert; tracks a `written` Set so the seen-`[]` loop never wipes the comment row. `resolveEmbeddingInput` attaches `comment` to every return shape. `getUnembeddedDocIds('text')` unions `feature/has-comment` so commented non-embeddable docs (photos/files/tabs) join the text gap.
- **Web**: edit form (`EditForm.tsx`) now opens on ALL non-public docs (`tabs.tsx` `canEdit = !isPublic`); schema fields gated on `isEditableSchema`, comment `<textarea>` universal; comment-only edits send `{id,schema,schemaVersion,comment}` (no `data`, avoids clobber). Read-only comment shown in ViewTab. `Document.comment?` type + `updateWorkspaceDocument` widened.

Two integration bugs found during live test (photo comment → search empty) and fixed:
1. **inferd worker aborted on photos**: image route calls `OnnxProvider.embedImage` which THROWS (CLIP unimplemented) — propagated out of `#handle` before the comment block ran, so photo comments were never embedded. Fixed: try/catch the primary `#embedInput`, treat failure as 0 content rows, still embed the comment into text.
2. **putMany skipped FTS reindex for comment-only edits**: `isContentChanged` gate (phase 3) was checksum-only; a comment edit doesn't change a File's checksum so FTS was never refreshed. Fixed: snapshot `prevComment` and treat a comment change as content-changed. (`#updateOne`/single-put already reindexes FTS unconditionally — only the batch `putMany` path had the gate.)

To re-embed an already-commented photo after deploying the fix: re-save the comment (fires `document.updated` → live enqueue) or run inferd reconcile (photo is in the text gap, not seen-marked since the job threw).

Tests: `synapsd/tests/comment-field.test.js` (5 tests). Live ONNX embedding of the -1 chunk verified per repo convention against running server, not in unit tests (providers private). Related: [[project_embedd_service]], [[project_synapsd_search_ranking]], [[project_cli_add_vs_insert]].
