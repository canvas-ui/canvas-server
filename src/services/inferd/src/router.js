'use strict';

/**
 * Embedding router — maps an input descriptor (schema + contentType + modality)
 * to an embedding *space*, and holds the per-space backend that fills it.
 *
 * Two separate concerns, deliberately split:
 *
 *   rules[]  — ROUTING. "image/* goes to the image space." Structural, built-in,
 *              rarely touched: a user configuring their embedding backend should
 *              never have to restate that photos are images.
 *   spaces{} — BACKENDS. "the image space is filled by SigLIP on the GPU box."
 *              This is the configurable surface (server default ← per user).
 *
 * A "space" is one synapsd vector table (e.g. `text` -> vec_text 384,
 * `image` -> vec_image 512). Rules are matched top-down; the first match wins.
 * Adding a modality is data, not code.
 *
 * Space shape:
 *   { provider, model, dim,
 *     chunk?: boolean,        // text: chunk before embedding (default true for text)
 *     maxLength?: number,     // onnx tokenizer window
 *     dimensions?: number,    // openai: opt-in Matryoshka truncation
 *     annIndex?: boolean }
 *
 * Rule shape:
 *   { space, match: { schema?: string|RegExp, contentType?: string|RegExp,
 *                     modality?: 'text'|'image' } }
 */

/** Routing: which content lands in which space. Structural, not a user choice. */
export const DEFAULT_RULES = [
    // JSON note abstraction — the text the server can read straight from the doc.
    { space: 'text', match: { schema: 'data/schema/note' } },
    // Email abstraction — subject+body via Email.vectorEmbeddingFields
    // (generateEmbeddingsData). Without this rule emails were routed null and
    // permanently marked seen-with-zero-vectors.
    { space: 'text', match: { schema: 'data/schema/message/email' } },
    // Any server-resident plain-text blob.
    { space: 'text', match: { contentType: /^text\// } },
    // Images — CLIP/SigLIP joint space. The provider fills it from images
    // (embedImage) at index time and from the query text (embedQuery, same
    // encoder family) at search time, so "red car" matches photos.
    { space: 'image', match: { contentType: /^image\// } },
];

/** Backends: which model fills each space. The configurable half. */
export const DEFAULT_SPACES = {
    text: { provider: 'onnx', model: 'bge-small-en-v1.5', dim: 384, chunk: true, maxLength: 512 },
    // CLIP ViT-B/32 (512-d) — retrieves noticeably better than the previous
    // SigLIP default. NOTE: deliberately NOT the baseline model
    // (constants.BASELINE_SPACES stays SigLIP@768/vec_image), so this space
    // resolves to a model-keyed table: pre-existing workspaces keep their SigLIP
    // vectors intact in vec_image and need a reindex to fill the new space.
    image: { provider: 'clip', model: 'Xenova/clip-vit-base-patch32', dim: 512, chunk: false },
};

function matches(rule, input) {
    const m = rule.match || {};
    if (m.modality && m.modality !== input.modality) { return false; }
    if (m.schema !== undefined && !test(m.schema, input.schema)) { return false; }
    if (m.contentType !== undefined && !test(m.contentType, input.contentType)) { return false; }
    // A rule with no matchers is a catch-all.
    return true;
}

function test(matcher, value) {
    if (value == null) { return false; }
    if (matcher instanceof RegExp) { return matcher.test(String(value)); }
    return String(matcher) === String(value);
}

export default class Router {

    #rules;
    #spaces;

    constructor({ rules, spaces } = {}) {
        this.#rules = Array.isArray(rules) && rules.length ? rules : DEFAULT_RULES;
        this.#spaces = spaces && Object.keys(spaces).length ? spaces : DEFAULT_SPACES;
    }

    /**
     * Route a document/blob input to its space's backend, or null to skip.
     * Returns the space config with `space` folded in, so callers keep treating
     * the result as one flat rule (provider/model/dim/chunk + space).
     */
    route(input) {
        if (!input) { return null; }
        for (const rule of this.#rules) {
            if (!matches(rule, input)) { continue; }
            // A rule pointing at a space with no configured backend is a skip,
            // not an error: it routes nowhere until someone configures it.
            const space = this.#spaces[rule.space];
            return space ? { ...space, space: rule.space } : null;
        }
        return null;
    }

    /** Backend that governs a space (for embedding queries into that space). */
    spaceRule(space) {
        const cfg = this.#spaces[space];
        return cfg ? { ...cfg, space } : null;
    }

    /**
     * Candidate schema keys for a space's unembedded-gap ledger. Since there is
     * no contentType index, gap discovery is schema-level; inferd then post-filters
     * by contentType in resolveInput. Collected from rules that name a schema, plus
     * `data/schema/file` for any contentType-matched rule (files carry bytes).
     */
    candidateSchemas(space) {
        const set = new Set();
        for (const r of this.#rules) {
            if (r.space !== space) { continue; }
            if (typeof r.match?.schema === 'string') { set.add(r.match.schema); }
            if (r.match?.contentType) { set.add('data/schema/file'); }
        }
        return [...set];
    }

    /**
     * Spaces whose candidate schemas include `schema`. A doc must be marked
     * "seen" in ALL of these once processed — otherwise it lingers in the gap of
     * a space it didn't resolve into (files are candidates for both text+image
     * but resolve to exactly one), causing reconcile to re-fetch it forever.
     */
    candidateSpaces(schema) {
        return this.spaces.filter(sp => this.candidateSchemas(sp).includes(schema));
    }

    /** Spaces that have a configured backend AND at least one rule routing to them. */
    get spaces() {
        const routed = new Set(this.#rules.map((r) => r.space));
        return Object.keys(this.#spaces).filter((s) => routed.has(s));
    }

    get spaceConfigs() { return this.#spaces; }
    get rules() { return this.#rules; }
}
