'use strict';

import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import debugInstance from 'debug';
const debug = debugInstance('canvas:embedd:clip');

/**
 * CLIP/SigLIP provider — joint image+text embedding space (search "red car",
 * match photos). The model runs in a FORKED CHILD PROCESS (clip-worker.js): it
 * needs onnxruntime-node 1.24.3, but fastembed (text) pins 1.21.0, and two
 * native onnxruntime versions can't share one process. This class is a thin IPC
 * client — it spawns workers lazily, correlates replies by id, and respawns
 * if a worker dies.
 *
 * The model is chosen PER CALL from the routing rule (`rule.model`), not per
 * provider instance: one worker child is kept per distinct model, so two spaces
 * (or the test-connection route) using different models each get their own
 * process and never cross-talk. A call without a model falls back to the
 * provider spec's `model`, then the worker env default (SigLIP 768-d).
 *
 * Provider contract (matches OnnxProvider): embedImage/embedText → { vectors, dim };
 * embedQuery → { vector, dim }. The returned `dim` is what the model REALLY
 * produced — the test route reports it so config never has to guess.
 */

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'clip-worker.js');

const DEFAULT_MODEL = 'Xenova/clip-vit-base-patch32';

export default class ClipProvider {

    id = 'clip';
    #cacheDir;
    #model;
    #dtype;
    #workers = new Map();   // model -> { child, pending: Map<id, {resolve, reject}> }
    #seq = 1;

    /**
     * @param {object} [options]
     * @param {string} [options.cacheDir]
     * @param {string} [options.model] default transformers.js model id when a
     *   call carries none. Normally the routing rule's `model` wins, so the
     *   space config, not this spec or an env var, is the source of truth.
     * @param {string} [options.dtype] fp32 (default, best retrieval quality) | q8 | …
     *   Changing dtype SHIFTS the embeddings — re-embed the image space after a
     *   switch, or stored vectors won't line up with query vectors.
     */
    constructor({ cacheDir = null, model = null, dtype = null, id = null } = {}) {
        if (id) { this.id = id; }
        this.#cacheDir = cacheDir;
        this.#model = model;
        this.#dtype = dtype;
    }

    /** The model a call resolves to — rule.model ← provider spec ← env ← default. */
    #resolveModel(model) {
        return model || this.#model || process.env.CANVAS_CLIP_MODEL || DEFAULT_MODEL;
    }

    /**
     * Whether the model's weights are already in the on-disk cache — i.e.
     * whether the next call will serve or first download. `null` = unknowable
     * (no cacheDir configured, so transformers.js uses its own default cache).
     * transformers.js caches under `<cacheDir>/<org>/<name>/…`, mirroring the
     * hub repo path.
     */
    modelCached(model) {
        if (!this.#cacheDir) { return null; }
        try { return fs.existsSync(path.join(this.#cacheDir, ...this.#resolveModel(model).split('/'))); }
        catch (_) { return null; }
    }

    #ensureWorker(model) {
        const existing = this.#workers.get(model);
        if (existing) { return existing; }
        const env = { ...process.env };
        if (this.#cacheDir) { env.CANVAS_CLIP_CACHE = this.#cacheDir; }
        // The resolved model is authoritative for this child — the worker reads
        // it as its default, so the routing rule (not an ambient env var)
        // decides what actually loads.
        env.CANVAS_CLIP_MODEL = model;
        if (this.#dtype) { env.CANVAS_CLIP_DTYPE = this.#dtype; }
        // 'advanced' (v8 structured clone) so image Buffers/TypedArrays cross the
        // IPC boundary intact instead of being JSON-mangled.
        const child = fork(WORKER_PATH, [], { env, serialization: 'advanced' });
        const entry = { child, pending: new Map() };
        child.on('message', (m) => {
            if (m && m.ready) { debug(`clip worker ready (${model})`); return; }
            const p = entry.pending.get(m.id);
            if (!p) { return; }
            entry.pending.delete(m.id);
            if (m.error) { p.reject(new Error(m.error)); } else { p.resolve(m); }
        });
        const failAll = (reason) => {
            for (const p of entry.pending.values()) { p.reject(new Error(reason)); }
            entry.pending.clear();
            if (this.#workers.get(model) === entry) { this.#workers.delete(model); }
        };
        child.on('exit', (code) => { debug(`clip worker exited (${model}, code ${code})`); failAll('clip worker exited'); });
        child.on('error', (e) => { debug(`clip worker error (${model}): ${e.message}`); failAll(e.message); });
        this.#workers.set(model, entry);
        return entry;
    }

    #request(kind, payload, model) {
        const resolved = this.#resolveModel(model);
        const entry = this.#ensureWorker(resolved);
        const id = this.#seq++;
        // The worker runs one ORT inference at a time; a wedged worker (or a
        // dropped IPC reply) would otherwise leave this promise unsettled forever
        // and hang the awaiting search/embed. Time it out and respawn a clean
        // worker so the next call recovers. A model that is not in the cache yet
        // spends the call DOWNLOADING weights (minutes, not seconds), so the
        // cold case gets a far longer leash; override with CANVAS_CLIP_TIMEOUT_MS.
        const cold = this.modelCached(resolved) === false;
        const timeoutMs = Math.max(1000, Number(process.env.CANVAS_CLIP_TIMEOUT_MS) || (cold ? 600000 : 60000));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!entry.pending.has(id)) { return; }
                entry.pending.delete(id);
                // Kill the (likely wedged) worker; #ensureWorker respawns lazily.
                try { entry.child.kill(); } catch (_) { /* ignore */ }
                if (this.#workers.get(resolved) === entry) { this.#workers.delete(resolved); }
                reject(new Error(`clip worker timeout after ${timeoutMs}ms (${kind}, ${resolved})`));
            }, timeoutMs);
            if (typeof timer.unref === 'function') { timer.unref(); }
            entry.pending.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
            entry.child.send({ id, kind, payload });
        });
    }

    async embedImage(images, { model } = {}) {
        if (!Array.isArray(images) || images.length === 0) { return { vectors: [], dim: 0 }; }
        const r = await this.#request('image', images, model);
        return { vectors: r.vectors, dim: r.dim };
    }

    async embedText(texts, { model } = {}) {
        if (!Array.isArray(texts) || texts.length === 0) { return { vectors: [], dim: 0 }; }
        const r = await this.#request('text', texts, model);
        return { vectors: r.vectors, dim: r.dim };
    }

    async embedQuery(text, { model } = {}) {
        const { vectors, dim } = await this.embedText([text], { model });
        return { vector: vectors[0] || null, dim };
    }

    status() {
        return {
            id: this.id,
            type: 'clip',
            cacheDir: this.#cacheDir,
            defaultModel: this.#resolveModel(null),
            dtype: this.#dtype || process.env.CANVAS_CLIP_DTYPE || 'fp32',
            workers: [...this.#workers.entries()].map(([model, e]) => ({ model, pending: e.pending.size })),
        };
    }

    async stop() {
        for (const [model, entry] of this.#workers) {
            try { entry.child.kill(); } catch (_) { /* ignore */ }
            for (const p of entry.pending.values()) { p.reject(new Error('clip provider stopped')); }
            entry.pending.clear();
            debug(`clip worker stopped (${model})`);
        }
        this.#workers.clear();
    }
}
