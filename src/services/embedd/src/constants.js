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
 * ORIGINAL Lance table, so making the model configurable does not orphan a
 * single existing vector. Any other model gets a model-keyed table.
 *
 * HISTORICAL, not the current defaults: router.DEFAULT_SPACES has since moved
 * (image → CLIP ViT-B/32 @512), so even a fresh no-config workspace now runs a
 * non-baseline image model in a model-keyed table. These entries must never
 * change — they name what pre-config workspaces actually built.
 */
export const BASELINE_SPACES = {
    text: { model: 'bge-small-en-v1.5', dim: 384, table: 'vec_text' },
    image: {
        model: 'Xenova/siglip-base-patch16-224', dim: 768, table: 'vec_image',
        // Cross-modal kNN must stay an exact scan — see synapsd's spaces default.
        annIndex: false,
    },
};

/**
 * Strip trailing slashes without a regex.
 *
 * `/\/+$/` backtracks polynomially — on a string of n slashes the engine retries
 * `\/+` from every position and fails `$` each time, which is O(n²). That was
 * harmless while base URLs came from a config file an operator wrote, but they
 * are user-supplied now (workspace/user embedding config), so a pathological
 * value would burn CPU on every provider construction. Linear scan, no
 * backtracking. (CodeQL js/polynomial-redos.)
 */
export function trimTrailingSlashes(value) {
    const s = String(value ?? '');
    let end = s.length;
    while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) { end--; }
    return s.slice(0, end);
}

/** Slug used in model-keyed table/ledger names. Mirrors synapsd's own slugging. */
export function modelSlug(model) {
    return String(model || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

/**
 * Embedding ledger keys — both under `internal/embed/`, both keyed by
 * (space, model): presence ("this doc has vectors") and seen ("the embedder has
 * processed this doc", including deliberate skips). Keying them by model is what
 * makes "switch model, then switch back" free instead of a full re-embed.
 *
 * The model segment is ALWAYS the leaf — a namespace must never also be a key.
 * synapsd's listBitmaps() range-scans strictly below `prefix + '/'`, so a bare
 * `.../vectors/text` sitting above `.../vectors/text/<slug>` would be invisible
 * to a prefix query of its own namespace. That was the defect in the legacy
 * `internal/lance/vectors` key: it was the text presence bitmap AND the parent
 * path of the image one, so listing it returned image and omitted text.
 */
export function presenceKey(space, model) { return `internal/embed/vectors/${space}/${modelSlug(model)}`; }
export function seenKey(space, model) { return `internal/embed/seen/${space}/${modelSlug(model)}`; }

export default { COMMENT_CHUNK_ID, TEXT_SPACE, BASELINE_SPACES, modelSlug, presenceKey, seenKey };
