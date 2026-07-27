'use strict';

import debugInstance from 'debug';
const debug = debugInstance('canvas:embedd:openai');

/**
 * OpenAI-compatible embeddings provider — `POST {baseUrl}/v1/embeddings`.
 *
 * This is the remote/GPU path. The same dialect is spoken by every practical
 * inference server, so one provider covers all of them:
 *   - vLLM              (`--task embed`, OpenAI-compatible server)
 *   - HF TEI            (text-embeddings-inference)
 *   - infinity          (michaelfeil/infinity — also does CLIP/image embedding)
 *   - LM Studio / llama.cpp server
 *   - OpenAI itself
 *   - an EmbedAnything sidecar exposing the same route
 * Weights and model lifecycle live on the inference host; embedd stays a thin
 * router + queue, which is the whole point of pointing it at the GPU box.
 *
 * ── Image embedding ──────────────────────────────────────────────────────────
 * There is no single blessed spelling for image embeddings, so the wire shape is
 * configurable rather than guessed:
 *
 *   imageInput: 'data-uri'  (default)
 *     { model, input: ["data:image/jpeg;base64,…", …] }
 *     — infinity's CLIP endpoint and TEI-style servers that accept image inputs
 *       in the ordinary `input` array.
 *
 *   imageInput: 'messages'
 *     { model, messages: [{ role: "user", content: [{ type: "image_url",
 *       image_url: { url: "data:image/jpeg;base64,…" } }] }] }
 *     — vLLM's multimodal embedding shape (VLM2Vec-style pooling models). One
 *       request per image, since the shape carries a single conversation.
 *
 * A server that does neither should be routed to the local `clip` provider
 * instead — an unsupported mode raises rather than silently storing nothing.
 *
 * Provider contract (matches the other providers):
 *   embedText(texts, rule)          → { vectors, dim }
 *   embedQuery(text, rule)          → { vector,  dim }
 *   embedImage(images, rule, meta)  → { vectors, dim }
 */

const IMAGE_INPUT_MODES = new Set(['data-uri', 'messages']);

/** Magic-byte sniff, used only when the caller couldn't supply a contentType. */
function sniffImageMime(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) { return 'image/jpeg'; }
    if (buf[0] === 0xff && buf[1] === 0xd8) { return 'image/jpeg'; }
    if (buf.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') { return 'image/png'; }
    if (buf.toString('latin1', 0, 3) === 'GIF') { return 'image/gif'; }
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') { return 'image/webp'; }
    return 'image/jpeg';
}

function dataUri(buf, contentType) {
    const mime = contentType && /^image\//.test(contentType) ? contentType : sniffImageMime(buf);
    return `data:${mime};base64,${buf.toString('base64')}`;
}

export default class OpenAIProvider {

    id = 'openai';
    #baseUrl;
    #apiKey;
    #headers;
    #imageInput;
    #timeoutMs;

    /**
     * @param {object} options
     * @param {string} options.baseUrl      e.g. http://gpu.local:8000/v1 (the /v1 is optional)
     * @param {string} [options.apiKey]     sent as `Authorization: Bearer …` when set
     * @param {object} [options.headers]    extra headers (proxy auth, tenant routing, …)
     * @param {string} [options.imageInput] 'data-uri' (default) | 'messages'
     * @param {number} [options.timeoutMs]  per-request timeout (default 120s)
     * @param {string} [options.id]         instance id, for status/debug output
     */
    constructor({ baseUrl, apiKey = null, headers = null, imageInput = 'data-uri', timeoutMs = null, id = null } = {}) {
        if (!baseUrl) { throw new Error('OpenAIProvider: baseUrl required'); }
        if (!IMAGE_INPUT_MODES.has(imageInput)) {
            throw new Error(`OpenAIProvider: unknown imageInput '${imageInput}' (known: ${[...IMAGE_INPUT_MODES].join(', ')})`);
        }
        if (id) { this.id = id; }
        this.#baseUrl = String(baseUrl).replace(/\/+$/, '');
        this.#apiKey = apiKey;
        this.#headers = headers || {};
        this.#imageInput = imageInput;
        this.#timeoutMs = Math.max(1000, Number(timeoutMs) || 120000);
    }

    // Accept both `http://host:8000` and `http://host:8000/v1` — mirrors the
    // voice service's audioApiUrl so operators can paste either form.
    #url(endpoint) {
        return /\/v\d+$/.test(this.#baseUrl) ? `${this.#baseUrl}/${endpoint}` : `${this.#baseUrl}/v1/${endpoint}`;
    }

    async #post(endpoint, body) {
        const headers = { 'content-type': 'application/json', ...this.#headers };
        if (this.#apiKey) { headers.authorization = `Bearer ${this.#apiKey}`; }
        let res;
        try {
            res = await fetch(this.#url(endpoint), {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(this.#timeoutMs),
            });
        } catch (e) {
            // A hung remote must not leave the queue's batch promise unsettled —
            // AbortSignal.timeout surfaces here as a TimeoutError.
            throw new Error(`${this.id} ${endpoint} request failed: ${e.message}`, { cause: e });
        }
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`${this.id} ${endpoint} ${res.status}: ${text.slice(0, 200)}`);
        }
        return res.json();
    }

    /**
     * Pull vectors out of an OpenAI embeddings response. `data[].index` is
     * ordered per spec, but sorting defensively costs nothing and protects
     * against servers that parallelize the batch and reply out of order — a
     * silent mis-pairing there would attach every vector to the wrong document.
     */
    #vectorsFrom(json, expected) {
        const data = json?.data;
        if (!Array.isArray(data) || data.length === 0) {
            throw new Error(`${this.id}: response carried no embeddings`);
        }
        const sorted = [...data].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
        const vectors = sorted.map((d) => d?.embedding).filter((v) => Array.isArray(v));
        if (expected != null && vectors.length !== expected) {
            throw new Error(`${this.id}: expected ${expected} embedding(s), got ${vectors.length}`);
        }
        return vectors;
    }

    #body(model, extra) {
        if (!model) { throw new Error(`${this.id}: model required (set it on the routing rule)`); }
        // Explicit float encoding: some servers default to base64 when the field
        // is absent, which would decode into garbage vectors downstream.
        return { model, encoding_format: 'float', ...extra };
    }

    async embedText(texts, { model, dimensions = null } = {}) {
        if (!Array.isArray(texts) || texts.length === 0) { return { vectors: [], dim: 0 }; }
        const body = this.#body(model, { input: texts });
        // Matryoshka truncation — opt-in per rule, since servers that don't
        // support it reject or ignore the field.
        if (Number.isInteger(dimensions) && dimensions > 0) { body.dimensions = dimensions; }
        const json = await this.#post('embeddings', body);
        const vectors = this.#vectorsFrom(json, texts.length);
        return { vectors, dim: vectors[0]?.length || 0 };
    }

    async embedQuery(text, rule = {}) {
        if (typeof text !== 'string' || text.length === 0) { return { vector: null, dim: 0 }; }
        const { vectors, dim } = await this.embedText([text], rule);
        return { vector: vectors[0] || null, dim };
    }

    /**
     * @param {Buffer[]} images
     * @param {object} rule    routing rule (supplies `model`)
     * @param {{contentTypes?: (string|null)[]}} [meta] per-image mime, for the data URI
     */
    async embedImage(images, { model } = {}, meta = {}) {
        if (!Array.isArray(images) || images.length === 0) { return { vectors: [], dim: 0 }; }
        const contentTypes = Array.isArray(meta?.contentTypes) ? meta.contentTypes : [];
        const uris = images.map((buf, i) => dataUri(buf, contentTypes[i]));

        if (this.#imageInput === 'data-uri') {
            const json = await this.#post('embeddings', this.#body(model, { input: uris }));
            const vectors = this.#vectorsFrom(json, uris.length);
            return { vectors, dim: vectors[0]?.length || 0 };
        }

        // 'messages': one conversation per image, so the batch is N requests.
        // Kept sequential — the batching win is on the inference host's side and
        // firing a whole photo batch at once is exactly the stampede this
        // refactor exists to avoid.
        const vectors = [];
        for (const url of uris) {
            const json = await this.#post('embeddings', this.#body(model, {
                messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }],
            }));
            vectors.push(...this.#vectorsFrom(json, 1));
        }
        return { vectors, dim: vectors[0]?.length || 0 };
    }

    async status() {
        let reachable = false;
        let models = null;
        try {
            const headers = { ...this.#headers };
            if (this.#apiKey) { headers.authorization = `Bearer ${this.#apiKey}`; }
            const res = await fetch(this.#url('models'), { headers, signal: AbortSignal.timeout(5000) });
            reachable = res.ok;
            if (res.ok) {
                const json = await res.json().catch(() => null);
                models = Array.isArray(json?.data) ? json.data.map((m) => m?.id).filter(Boolean) : null;
            }
        } catch (e) {
            debug(`${this.id} ping failed: ${e.message}`);
        }
        return {
            id: this.id,
            type: 'openai',
            baseUrl: this.#baseUrl,
            imageInput: this.#imageInput,
            reachable,
            ...(models ? { models } : {}),
        };
    }

    async stop() { /* stateless HTTP client */ }
}
