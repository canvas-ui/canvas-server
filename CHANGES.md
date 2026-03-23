# Changes

## SynapsD
- Added dataset-aware document storage and queries.
- Introduced a dedicated `incoming` dataset for worker-driven ingestion.
- Kept main dataset behavior as the default.
- Added dataset-specific trees and `getJsonTreeForDataset(dataset)`.
- Added SynapsD tests covering dataset isolation and the incoming tree.

## canvas-server
- Added dataset helpers for:
  - `incoming` as the internal dataset name
  - `/.incoming` as the mounted UI path
- Updated workspace document operations to accept and route by dataset.
- Mapped `/.incoming/...` paths to the `incoming` dataset automatically.
- Mounted the incoming dataset into the workspace tree under:
  - `/.incoming/email/<account>`
  - `/.incoming/chat/<provider>/<channel>`
  - `/.incoming/files/<connector>`
- Blocked direct tree mutations on the virtual `/.incoming` mount.
- Updated home indexing to allow targeting the incoming dataset.

## Verification
- SynapsD dataset tests passed:
  - `npm test -- dataset.test.js`
- Workspace route module imports passed in a Node smoke test.

## Git
- SynapsD changes were committed and pushed in the `src/services/synapsd` submodule branch:
  - `cursor/document-ingestion-design-20d1`
- canvas-server changes were committed and pushed in the main repo branch:
  - `cursor/document-ingestion-design-20d1`
