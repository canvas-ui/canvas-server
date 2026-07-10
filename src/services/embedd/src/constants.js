'use strict';

/**
 * Shared embedd constants.
 */

// Reserved chunkId for a document's user-authored comment chunk. chunkText only
// ever emits ordinals >= 0 for content, so -1 never collides — it keeps the
// comment's provenance at the vector layer (weightable in fusion, always present
// for any commented doc regardless of its schema's embeddability).
export const COMMENT_CHUNK_ID = -1;

// The vector space the comment always embeds into (short free-text → text model).
export const TEXT_SPACE = 'text';

export default { COMMENT_CHUNK_ID, TEXT_SPACE };
