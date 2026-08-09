'use strict';

import debugInstance from 'debug';
const debug = debugInstance('canvas:inferd:ollama');
import { trimTrailingSlashes } from '../constants.js';

const DEFAULT_HOST = 'http://127.0.0.1:11434';

/**
 * Ollama provider — embeddings via a running Ollama daemon's HTTP API. No local
 * weights in-process; the model lives in Ollama. Batch text embedding through
 * POST /api/embed ({ model, input }). Good for text models (e.g.
 * nomic-embed-text, mxbai-embed-large); image embedding is left unimplemented
 * until a vision-embedding model/endpoint is settled on.
 *
 * Ollama itself ships unauthenticated, but it is routinely put behind a reverse
 * proxy that demands a bearer token or a custom header, so `apiKey`/`headers`
 * are honoured on every request — without them such a host is simply
 * unreachable, with no way to configure around it.
 *
 * Note this speaks Ollama's NATIVE API (`/api/embed`), not the OpenAI-compatible
 * `/v1` surface Ollama also exposes. Point `host` at the daemon root; a `/v1`
 * suffix belongs to the `openai` provider type instead.
 *
 * Provider contract mirrors OnnxProvider: embedText / embedQuery return
 * `{ vectors|vector, dim }`.
 */
export default class OllamaProvider {

    id = 'ollama';
    #host;
    #apiKey;
    #headers;

    constructor({ host, apiKey = null, headers = null, id } = {}) {
        if (id) { this.id = id; }
        this.#host = trimTrailingSlashes(host || process.env.OLLAMA_HOST || DEFAULT_HOST);
        this.#apiKey = apiKey;
        this.#headers = headers || {};
    }

    #requestHeaders(extra = {}) {
        const headers = { ...this.#headers, ...extra };
        if (this.#apiKey) { headers.authorization = `Bearer ${this.#apiKey}`; }
        return headers;
    }

    async #embed(model, input) {
        if (!model) { throw new Error('OllamaProvider: model required'); }
        const res = await fetch(`${this.#host}/api/embed`, {
            method: 'POST',
            headers: this.#requestHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ model, input }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Ollama /api/embed ${res.status}: ${body.slice(0, 200)}`);
        }
        const json = await res.json();
        const embeddings = json?.embeddings;
        if (!Array.isArray(embeddings) || embeddings.length === 0) {
            throw new Error('Ollama /api/embed returned no embeddings');
        }
        return embeddings;
    }

    async embedText(texts, { model } = {}) {
        if (!Array.isArray(texts) || texts.length === 0) { return { vectors: [], dim: 0 }; }
        const vectors = await this.#embed(model, texts);
        return { vectors, dim: vectors[0]?.length || 0 };
    }

    async embedQuery(text, { model } = {}) {
        if (typeof text !== 'string' || text.length === 0) { return { vector: null, dim: 0 }; }
        const [vector] = await this.#embed(model, text);
        return { vector: vector || null, dim: vector?.length || 0 };
    }

    // eslint-disable-next-line no-unused-vars
    async embedImage(images, opts = {}) {
        throw new Error('OllamaProvider.embedImage not implemented');
    }

    async #ping() {
        try {
            const res = await fetch(`${this.#host}/api/tags`, { method: 'GET', headers: this.#requestHeaders() });
            return res.ok;
        } catch (e) {
            debug(`ping failed: ${e.message}`);
            return false;
        }
    }

    async status() {
        return { id: this.id, type: 'ollama', host: this.#host, authenticated: Boolean(this.#apiKey), reachable: await this.#ping() };
    }

    async stop() { /* stateless HTTP client */ }
}
