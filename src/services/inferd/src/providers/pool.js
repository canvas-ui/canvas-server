'use strict';

import debugInstance from 'debug';
const debug = debugInstance('canvas:inferd:pool');
import { createProvider } from './index.js';

/**
 * Provider pool — one instance per distinct backend configuration, shared by
 * every user that resolves to it.
 *
 * Per-user configuration must NOT become per-user model processes. Two users
 * pointing at the same Ollama host share one client; everyone still shares the
 * single ONNX worker-thread pool and the single forked CLIP child, which is the
 * property inferd was built on ("one model runtime for all workspaces"). The
 * pool key is the resolved options, not the id the user happened to give it, so
 * sharing survives people naming the same endpoint differently.
 *
 * Nothing is evicted while the service runs. The pool is bounded by the number
 * of DISTINCT backend configurations, not by users, and an unused provider costs
 * an object — models load lazily on first use and remote providers open no
 * socket until called. Eviction would buy nothing and risks tearing down a model
 * runtime another user is mid-batch on.
 */
export default class ProviderPool {

    #instances = new Map();   // key -> { provider, ids:Set }

    /** Stable identity for a provider spec — key order must not matter. */
    static key(spec) {
        const entries = Object.keys(spec || {})
            .filter((k) => spec[k] !== undefined)
            .sort()
            .map((k) => [k, spec[k]]);
        return JSON.stringify(entries);
    }

    /**
     * Instance for a spec, created on first request.
     * @param {string} id   the id this caller knows it by (first one wins for
     *                      status/error output; all are recorded for debugging)
     * @param {object} spec normalized `{ type, ...opts }`
     */
    get(id, spec) {
        const key = ProviderPool.key(spec);
        const existing = this.#instances.get(key);
        if (existing) { existing.ids.add(id); return existing.provider; }

        const provider = createProvider(id, spec);
        this.#instances.set(key, { provider, ids: new Set([id]) });
        debug(`pooled provider '${id}' (${spec.type}) — ${this.#instances.size} distinct backend(s)`);
        return provider;
    }

    /** Resolve a whole `{ id: spec }` map to `{ id: instance }`, sharing instances. */
    resolve(providers = {}) {
        const map = new Map();
        for (const [id, spec] of Object.entries(providers)) {
            map.set(id, this.get(id, spec));
        }
        return map;
    }

    get size() { return this.#instances.size; }

    async status() {
        const out = {};
        for (const { provider, ids } of this.#instances.values()) {
            const id = provider.id;
            try { out[id] = { ...(await provider.status()), aliases: [...ids] }; }
            catch (e) { out[id] = { id, error: e.message }; }
        }
        return out;
    }

    async stopAll() {
        await Promise.all([...this.#instances.values()].map(({ provider }) => provider.stop().catch(() => {})));
        this.#instances.clear();
    }
}
