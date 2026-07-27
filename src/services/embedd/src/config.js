'use strict';

import { DEFAULT_RULES, DEFAULT_SPACES } from './router.js';

/**
 * embedd configuration — providers, per-space backends and routing as DATA.
 *
 * Three parts, deliberately separated by who owns them:
 *
 *   providers{} — connection details for an inference backend (`{ type, ...opts }`
 *                 under a caller-chosen id). Built-ins `onnx`/`ollama`/`clip`
 *                 always exist; re-declaring an id merges over its options.
 *   spaces{}    — which provider+model fills each modality. THE configurable
 *                 surface: server defaults, overridable per user.
 *   rules[]     — routing (`{ space, match }`): which content lands in which
 *                 space. Structural and near-constant — a user picking an
 *                 embedding backend should never restate that photos are images.
 *
 * ```json
 * {
 *   "providers": { "gpu": { "type": "openai", "baseUrl": "http://gpu.local:8000/v1" } },
 *   "spaces": {
 *     "text":  { "provider": "gpu", "model": "Qwen/Qwen3-Embedding-0.6B", "dim": 1024, "chunk": true },
 *     "image": { "provider": "clip", "model": "Xenova/siglip-base-patch16-224", "dim": 768 }
 *   }
 * }
 * ```
 *
 * Misconfiguration throws. A typo'd provider id would otherwise degrade dense
 * search silently, which is far worse than a loud failure; every part is
 * optional, so nothing throws unless someone actually wrote config.
 */

/** Provider implementations the factory knows how to build. */
export const PROVIDER_TYPES = new Set(['onnx', 'ollama', 'clip', 'openai']);

/** Keys that describe a space's BACKEND rather than its routing. */
const SPACE_KEYS = ['provider', 'model', 'dim', 'chunk', 'maxLength', 'dimensions', 'annIndex'];

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

function normalizeSpace(space, raw, providerIds) {
    if (!raw || typeof raw !== 'object') {
        throw new Error(`embedd config: space '${space}' must be an object`);
    }
    const { provider, model, dim } = raw;
    if (!provider) { throw new Error(`embedd config: space '${space}' has no \`provider\``); }
    if (!providerIds.has(provider)) {
        throw new Error(`embedd config: space '${space}' references undeclared provider '${provider}' (declared: ${[...providerIds].join(', ')})`);
    }
    if (!model) { throw new Error(`embedd config: space '${space}' has no \`model\``); }
    if (!Number.isInteger(dim) || dim <= 0) {
        throw new Error(`embedd config: space '${space}' needs a positive integer \`dim\` (it sizes the Lance table and cannot be guessed)`);
    }
    const out = {};
    for (const key of SPACE_KEYS) {
        if (raw[key] !== undefined) { out[key] = raw[key]; }
    }
    return out;
}

function normalizeRule(raw, i) {
    if (!raw || typeof raw !== 'object') {
        throw new Error(`embedd config: rules[${i}] must be an object`);
    }
    if (!raw.space) { throw new Error(`embedd config: rules[${i}] has no \`space\``); }
    const match = {};
    for (const [key, value] of Object.entries(raw.match || {})) {
        match[key] = key === 'modality' ? value : toMatcher(value);
    }
    return { space: raw.space, match };
}

/**
 * Split the pre-split config shape, where each rule carried its own
 * provider/model/dim. Kept so a config written against the first cut (and the
 * shipped example) still loads: the first rule to describe a space defines that
 * space's backend, and the rules keep only their routing half.
 */
function splitLegacyRules(rules) {
    const derived = {};
    for (const rule of rules) {
        if (!rule || typeof rule !== 'object' || !rule.space) { continue; }
        if (rule.provider === undefined && rule.model === undefined) { continue; }
        if (derived[rule.space]) { continue; }   // first rule to describe a space wins
        const cfg = {};
        for (const key of SPACE_KEYS) {
            if (rule[key] !== undefined) { cfg[key] = rule[key]; }
        }
        derived[rule.space] = cfg;
    }
    return derived;
}

/**
 * Normalize + validate raw config into `{ providers, spaces, rules }`. Defaults
 * reproduce the built-in CPU-local behaviour exactly.
 *
 * @param {object} [options]
 * @param {object} [options.providers]  declared providers, keyed by id
 * @param {object} [options.spaces]     per-space backends, keyed by space name
 * @param {Array}  [options.rules]      routing rules (defaults to DEFAULT_RULES)
 * @param {string} [options.onnxCacheDir]
 * @param {string} [options.clipCacheDir]
 * @param {string} [options.ollamaHost]
 */
export function normalizeConfig(options = {}) {
    const providers = normalizeProviders(options.providers, builtinProviders(options));
    const providerIds = new Set(Object.keys(providers));

    const rawRules = Array.isArray(options.rules) && options.rules.length ? options.rules : DEFAULT_RULES;
    // Precedence per space: explicit `spaces` > a legacy rule describing it >
    // the built-in default. Whole-space replacement, not a per-key merge —
    // declaring a space declares it fully. (Partial per-space overrides are the
    // resolver's job, which merges the layers before calling in here.)
    const rawSpaces = { ...DEFAULT_SPACES, ...splitLegacyRules(rawRules), ...(options.spaces || {}) };

    const spaces = {};
    for (const [space, raw] of Object.entries(rawSpaces)) {
        spaces[space] = normalizeSpace(space, raw, providerIds);
    }

    const rules = rawRules.map(normalizeRule);
    if (rules.length === 0) { throw new Error('embedd config: `rules` is empty — nothing would ever embed'); }
    for (const rule of rules) {
        if (!spaces[rule.space]) {
            throw new Error(`embedd config: rule routes to space '${rule.space}', which has no configured backend (declared spaces: ${Object.keys(spaces).join(', ') || 'none'})`);
        }
    }

    return { providers, spaces, rules };
}

/**
 * Merge configuration layers, lowest precedence first —
 * `mergeConfigLayers(serverDefault, userConfig)`.
 *
 * Providers merge by id and spaces merge KEY-WISE, so a user who only wants a
 * different text model sends `{ spaces: { text: { model, dim } } }` and inherits
 * the provider underneath. (normalizeConfig replaces whole spaces; that is the
 * right call for a single hand-written file, and this is the right call for
 * layering. The merged result still has to validate, so a half-specified space
 * fails loudly rather than embedding with a mismatched dim.)
 *
 * Routing rules do NOT merge — a layer that declares them replaces them
 * wholesale. Interleaving ordered match rules from two sources produces routing
 * nobody wrote or can predict.
 */
export function mergeConfigLayers(...layers) {
    const out = { providers: {}, spaces: {} };
    let rules = null;
    for (const layer of layers) {
        if (!layer || typeof layer !== 'object') { continue; }
        for (const [id, spec] of Object.entries(layer.providers || {})) {
            if (!spec || typeof spec !== 'object') { continue; }
            out.providers[id] = { ...(out.providers[id] || {}), ...spec };
        }
        // Within a layer, an explicit `spaces` entry beats a backend described
        // inline on a legacy rule; across layers, later still wins.
        const layerSpaces = { ...splitLegacyRules(layer.rules || []), ...(layer.spaces || {}) };
        for (const [space, cfg] of Object.entries(layerSpaces)) {
            if (!cfg || typeof cfg !== 'object') { continue; }
            out.spaces[space] = { ...(out.spaces[space] || {}), ...cfg };
        }
        if (Array.isArray(layer.rules) && layer.rules.length) { rules = layer.rules; }
    }
    if (rules) { out.rules = rules; }
    return out;
}

/**
 * Strip secrets from a config for anything that leaves the server. API keys are
 * write-only over the API: a GET reports whether one is set, never its value.
 */
export function redactConfig(config) {
    const providers = {};
    for (const [id, spec] of Object.entries(config?.providers || {})) {
        const { apiKey, headers, ...rest } = spec || {};
        providers[id] = {
            ...rest,
            ...(apiKey ? { apiKeySet: true } : {}),
            ...(headers ? { headerNames: Object.keys(headers) } : {}),
        };
    }
    return { ...config, providers };
}

export default { normalizeConfig, mergeConfigLayers, redactConfig, toMatcher, builtinProviders, PROVIDER_TYPES };
