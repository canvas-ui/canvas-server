# Copy documents between workspaces

The web UI's **Copy to workspace…** action is available from the document
context menu and the bulk selection toolbar. Choose a destination workspace
and one or more paths in its context or directory tree.

Files are streamed server-side into the destination's `workspace:data` store.
The new record preserves content, tags, comment, extracted metadata (including
GPS), and content timelines. Its filename is preserved even when the source
lives under `workspace:home`. Notes, links, tasks, messages and drawings copy
their inline content; stored email attachments are transferred too.

Source document IDs, relations, sharing permissions, virtual memberships and
physical location URLs are not copied. The source is never removed or changed.
Destination insertion follows the normal indexing and automation path, so
workspace rules decide any subsequent backend placement. Normal destination
content deduplication applies. Internal/configuration schemas are not portable
and are rejected.

Both workspaces must be active. The caller needs read access to the source and
write access to the destination; resource-bound tokens are rejected. Backend
trees cannot be selected as virtual destinations.

The API processes one item per `POST /workspaces/:id/documents/copy-to-workspace`:
`{ documentId, destination, context: [paths], treeType, treeNameOrTreeId, operationId }`.
Each completed operation stores a receipt under the destination's
`var/workspace-copies` directory. Repeating the same operation ID returns the
existing result, including after a lost HTTP response. Concurrent retries are
serialized. An ID reused for a different request is rejected.

The UI saves its remaining queue in browser storage. Closing the panel pauses
after the current item; reopening the action offers Resume. Offline or failed
copies stop at the current item, which Resume retries. Browser storage must be
available to retain the queue across reloads. This is a sequential resumable
copy, not an unattended whole-batch background job; partial file transfers
restart from the beginning. No relationships are inspected or reconstructed.
