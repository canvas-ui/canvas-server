'use strict';

import { DEFAULT_RULES } from './router.js';

/**
 * embedd configuration — providers and routing rules as DATA.
 *
 * Before this, the provider set was three hardcoded constructors and the routing
 * table was a const in router.js, so pointing embedd at a remote/GPU inference
 * host meant editing source. Now both are config: a provider is `{ type, ...opts }`
 * under a caller-chosen id, and a rule names a provider by that id.
 *
 * Config shape (all optional — omit everything and you get today's behaviour):
 * ```json
 * {
 *   "providers": {
 *     "gpu-text":  { "type": "openai", "baseUrl": "http://gpu.local:8000/v1",
 *                    "apiKey": "…", "timeoutMs": 120000 },
 *     "gpu-image": { "type": "openai", "baseUrl": "http://gpu.local:7997",
 *                    "imageInput": "data-uri" }
 *   },
 *   "rules": [
 *     { "space": "text", "provider": "gpu-text", "model": "Qwen/Qwen3-Embedding-0.6B",
 *       "dim": 1024, "chunk": true, "match": { "schema": "data/abstraction/note" } },
 *     { "space": "image", "provider": "gpu-image", "model": "google/siglip-base-patch16-224",
 *       "dim": 768, "chunk": false, "match": { "contentType": "image/*" } }
 *   ]
 * }
 * ```
 *
 * The three built-in providers (`onnx`, `ollama`, `clip`) always exist and need
 * no declaration; declaring one with the same id overrides its options. Rules
 * are matched top-down, first match wins — exactly as before.
 *
 * Misconfiguration throws. A typo'd provider id would otherwise degrade dense
 * search silently, which is far worse than a loud boot failure; the config file
 * is optional, so nothing throws unless someone actually wrote one.
 */

/** Provider implementations the factory knows how to build. */
export const PROVIDER_TYPES = new Set(['onnx', 'ollama', 'clip', 'openai']);

/**
 * Providers that exist without being declared. Their options come from the
 * top-level server settings (cache dirs, ollama host) unless the config
 * overrides them by re-declaring the same id.
 */
export function builtinProviders({ onnxCacheDir = null, clipCacheDir = null, ollamaHost = null } = {}) {
    return {
        onnx: { type: 'onnx', cacheDir: onnxCacheDir },
        ollama: { type: 'ollama', host: ollamaHost },
        clip: { type: 'clip', cacheDir: clipCacheDir || onnxCacheDir },
    };
}

/**
 * Turn a JSON-expressible matcher into something `router.test()` accepts. JSON
 * has no RegExp literal, so three spellings are supported:
 *   "data/abstraction/note"  → exact string match
 *   "image/*"                → prefix match  (compiles to /^image\//)
 *   "/^text\\/(plain|md)$/i" → explicit regex, optional trailing flags
 * A RegExp passed in from JS is returned untouched.
 */
export function toMatcher(value) {
    if (value instanceof RegExp) { return value; }
    if (typeof value !== 'string' || value.length === 0) { return value; }

    const explicit = value.match(/^\/(.+)\/([gimsuy]*)$/);
    if (explicit) { return new RegExp(explicit[1], explicit[2]); }

    if (value.endsWith('/*')) {
        return new RegExp(`^${escapeRegex(value.slice(0, -2))}/`);
    }
    return value;
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function normalizeProviders(declared, defaults) {
    const out = { ...defaults };
    if (declared == null) { return out; }
    if (typeof declared !== 'object' || Array.isArray(declared)) {
        throw new Error('embedd config: `providers` must be an object keyed by provider id');
    }
    for (const [id, raw] of Object.entries(declared)) {
        if (!raw || typeof raw !== 'object') {
            throw new Error(`embedd config: provider '${id}' must be an object`);
        }
        // Re-declaring a built-in id merges over its defaults, so overriding just
        // `host` on `ollama` doesn't drop the rest.
        const base = out[id] || {};
        const type = raw.type || base.type;
        if (!type) { throw new Error(`embedd config: provider '${id}' has no \`type\``); }
        if (!PROVIDER_TYPES.has(type)) {
            throw new Error(`embedd config: provider '${id}' has unknown type '${type}' (known: ${[...PROVIDER_TYPES].join(', ')})`);
        }
        out[id] = { ...base, ...raw, type };
    }
    return out;
}

function normalizeRule(raw, i, providerIds) {
    if (!raw || typeof raw !== 'object') {
        throw new Error(`embedd config: rules[${i}] must be an object`);
    }
    const { space, provider, model, dim } = raw;
    if (!space) { throw new Error(`embedd config: rules[${i}] has no \`space\``); }
    if (!provider) { throw new Error(`embedd config: rules[${i}] (space '${space}') has no \`provider\``); }
    if (!providerIds.has(provider)) {
        throw new Error(`embedd config: rules[${i}] (space '${space}') references undeclared provider '${provider}' (declared: ${[...providerIds].join(', ')})`);
    }
    if (!model) { throw new Error(`embedd config: rules[${i}] (space '${space}') has no \`model\``); }
    if (!Number.isInteger(dim) || dim <= 0) {
        throw new Error(`embedd config: rules[${i}] (space '${space}') needs a positive integer \`dim\` (it sizes the Lance table and cannot be guessed)`);
    }

    const match = {};
    for (const [key, value] of Object.entries(raw.match || {})) {
        match[key] = key === 'modality' ? value : toMatcher(value);
    }
    return { ...raw, match };
}

/**
 * Normalize + validate raw config into `{ providers, rules }`. Defaults
 * reproduce the pre-config behaviour exactly.
 *
 * @param {object} [options]
 * @param {object} [options.providers]  declared providers, keyed by id
 * @param {Array}  [options.rules]      routing rules (defaults to DEFAULT_RULES)
 * @param {string} [options.onnxCacheDir]
 * @param {string} [options.clipCacheDir]
 * @param {string} [options.ollamaHost]
 */
export function normalizeConfig(options = {}) {
    const providers = normalizeProviders(options.providers, builtinProviders(options));
    const providerIds = new Set(Object.keys(providers));

    const rawRules = Array.isArray(options.rules) && options.rules.length ? options.rules : DEFAULT_RULES;
    const rules = rawRules.map((r, i) => normalizeRule(r, i, providerIds));
    if (rules.length === 0) { throw new Error('embedd config: `rules` is empty — nothing would ever embed'); }

    return { providers, rules };
}

export default { normalizeConfig, toMatcher, builtinProviders, PROVIDER_TYPES };
