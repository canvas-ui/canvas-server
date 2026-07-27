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

/**
 * Baseline space identities — the (model, dim) each space had before embedding
 * config became data. A space still running its baseline model keeps the
 * ORIGINAL Lance table + bitmap keys, so making the model configurable does not
 * orphan a single existing vector. Any other model gets a model-keyed table and
 * its OWN presence/seen ledger (see `Embedd#spaceConfigs`), which is what makes
 * "switch model, then switch back" free instead of a full re-embed.
 */
export const BASELINE_SPACES = {
    text: {
        model: 'bge-small-en-v1.5', dim: 384,
        table: 'vec_text', bitmapKey: 'internal/lance/vectors',
    },
    image: {
        model: 'Xenova/siglip-base-patch16-224', dim: 768,
        table: 'vec_image', bitmapKey: 'internal/lance/vectors/image',
        // Cross-modal kNN must stay an exact scan — see synapsd's spaces default.
        annIndex: false,
    },
};

/** Slug used in model-keyed table/bitmap names. Mirrors synapsd's own slugging. */
export function modelSlug(model) {
    return String(model || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

export default { COMMENT_CHUNK_ID, TEXT_SPACE, BASELINE_SPACES, modelSlug };
