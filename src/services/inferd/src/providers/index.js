'use strict';

import OnnxProvider from './onnx.js';
import OllamaProvider from './ollama.js';
import ClipProvider from './clip.js';
import OpenAIProvider from './openai.js';

/**
 * Provider factory — turns a normalized config entry (`{ type, ...opts }`) into
 * a provider instance. Adding a backend is a line here plus the class; the
 * routing table that uses it is pure config (see config.js).
 *
 * Every provider honours the same contract:
 *   embedText(texts, rule)          → { vectors, dim }
 *   embedQuery(text, rule)          → { vector,  dim }
 *   embedImage(images, rule, meta)  → { vectors, dim }   (may throw: unsupported)
 *   status() / stop()
 */
const FACTORIES = {
    onnx: (id, o) => new OnnxProvider({ ...o, id }),
    ollama: (id, o) => new OllamaProvider({ ...o, id }),
    clip: (id, o) => new ClipProvider({ ...o, id }),
    openai: (id, o) => new OpenAIProvider({ ...o, id }),
};

export function createProvider(id, spec = {}) {
    const factory = FACTORIES[spec.type];
    if (!factory) { throw new Error(`inferd: unknown provider type '${spec.type}' for provider '${id}'`); }
    return factory(id, spec);
}

/**
 * Build the provider map from normalized config. Providers are constructed
 * eagerly (cheap — every one of them loads its model lazily on first use), so a
 * bad option surfaces at boot rather than mid-ingest.
 */
export function createProviders(providers = {}) {
    const map = new Map();
    for (const [id, spec] of Object.entries(providers)) {
        map.set(id, createProvider(id, spec));
    }
    return map;
}

export default { createProvider, createProviders };
