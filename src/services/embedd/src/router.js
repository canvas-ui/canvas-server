'use strict';

/**
 * Embedding router — maps an input descriptor (schema + contentType + modality)
 * to an embedding *space* and the provider/model that fills it.
 *
 * A "space" is one synapsd vector table (e.g. `text` -> vec_text 384,
 * `image` -> vec_image 512). Rules are matched top-down; the first match wins.
 * Everything is config, so adding a modality is data, not code.
 *
 * Rule shape:
 *   {
 *     space, provider, model, dim,
 *     chunk?: boolean,          // text: chunk before embedding (default true for text)
 *     maxLength?: number,       // onnx tokenizer window
 *     match: { schema?: string|RegExp, contentType?: string|RegExp, modality?: 'text'|'image' }
 *   }
 */

export const DEFAULT_RULES = [
    // JSON note abstraction — the text the server can read straight from the doc.
    {
        space: 'text', provider: 'onnx', model: 'bge-small-en-v1.5', dim: 384,
        chunk: true, maxLength: 512,
        match: { schema: 'data/abstraction/note' },
    },
    // Any server-resident plain-text blob.
    {
        space: 'text', provider: 'onnx', model: 'bge-small-en-v1.5', dim: 384,
        chunk: true, maxLength: 512,
        match: { contentType: /^text\// },
    },
    // Images — provider left as onnx (embedImage) but unimplemented until a CLIP
    // model is wired; present so the space/dim contract is declared.
    {
        space: 'image', provider: 'onnx', model: 'clip-vit-base-patch32', dim: 512,
        chunk: false,
        match: { contentType: /^image\// },
    },
];

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
    #bySpace = new Map();

    constructor({ rules } = {}) {
        this.#rules = Array.isArray(rules) && rules.length ? rules : DEFAULT_RULES;
        // First rule per space defines that space's canonical provider/model
        // (used for query embedding, which has no per-doc contentType).
        for (const r of this.#rules) {
            if (!this.#bySpace.has(r.space)) { this.#bySpace.set(r.space, r); }
        }
    }

    /** Route a document/blob input to a rule, or null to skip embedding. */
    route(input) {
        if (!input) { return null; }
        for (const rule of this.#rules) {
            if (matches(rule, input)) { return rule; }
        }
        return null;
    }

    /** Rule that governs a space (for embedding queries into that space). */
    spaceRule(space) {
        return this.#bySpace.get(space) || null;
    }

    /**
     * Candidate schema keys for a space's unembedded-gap ledger. Since there is
     * no contentType index, gap discovery is schema-level; embedd then post-filters
     * by contentType in resolveInput. Collected from rules that name a schema, plus
     * `data/abstraction/file` for any contentType-matched rule (files carry bytes).
     */
    candidateSchemas(space) {
        const set = new Set();
        for (const r of this.#rules) {
            if (r.space !== space) { continue; }
            if (typeof r.match?.schema === 'string') { set.add(r.match.schema); }
            if (r.match?.contentType) { set.add('data/abstraction/file'); }
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

    get spaces() { return [...this.#bySpace.keys()]; }
    get rules() { return this.#rules; }
}
