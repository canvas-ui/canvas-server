'use strict';

import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import debugInstance from 'debug';
const debug = debugInstance('canvas:embedd:clip');

/**
 * CLIP/SigLIP provider — joint image+text embedding space (search "red car",
 * match photos). The model runs in a FORKED CHILD PROCESS (clip-worker.js): it
 * needs onnxruntime-node 1.24.3, but fastembed (text) pins 1.21.0, and two
 * native onnxruntime versions can't share one process. This class is a thin IPC
 * client — it spawns the worker lazily, correlates replies by id, and respawns
 * if the worker dies.
 *
 * Provider contract (matches OnnxProvider): embedImage/embedText → { vectors, dim };
 * embedQuery → { vector, dim }. Model/dtype are configured via env in the worker
 * (CANVAS_CLIP_MODEL, CANVAS_CLIP_DTYPE); default SigLIP 768-d.
 */

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'clip-worker.js');

export default class ClipProvider {

    id = 'clip';
    #cacheDir;
    #child = null;
    #pending = new Map();   // requestId -> { resolve, reject }
    #seq = 1;

    constructor({ cacheDir = null } = {}) {
        this.#cacheDir = cacheDir;
    }

    #ensureWorker() {
        if (this.#child) { return this.#child; }
        const env = { ...process.env };
        if (this.#cacheDir) { env.CANVAS_CLIP_CACHE = this.#cacheDir; }
        // 'advanced' (v8 structured clone) so image Buffers/TypedArrays cross the
        // IPC boundary intact instead of being JSON-mangled.
        const child = fork(WORKER_PATH, [], { env, serialization: 'advanced' });
        child.on('message', (m) => {
            if (m && m.ready) { debug('clip worker ready'); return; }
            const p = this.#pending.get(m.id);
            if (!p) { return; }
            this.#pending.delete(m.id);
            if (m.error) { p.reject(new Error(m.error)); } else { p.resolve(m); }
        });
        const failAll = (reason) => {
            for (const p of this.#pending.values()) { p.reject(new Error(reason)); }
            this.#pending.clear();
            this.#child = null;
        };
        child.on('exit', (code) => { debug(`clip worker exited (code ${code})`); failAll('clip worker exited'); });
        child.on('error', (e) => { debug(`clip worker error: ${e.message}`); failAll(e.message); });
        this.#child = child;
        return child;
    }

    #request(kind, payload) {
        const child = this.#ensureWorker();
        const id = this.#seq++;
        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
            child.send({ id, kind, payload });
        });
    }

    async embedImage(images) {
        if (!Array.isArray(images) || images.length === 0) { return { vectors: [], dim: 0 }; }
        const r = await this.#request('image', images);
        return { vectors: r.vectors, dim: r.dim };
    }

    async embedText(texts) {
        if (!Array.isArray(texts) || texts.length === 0) { return { vectors: [], dim: 0 }; }
        const r = await this.#request('text', texts);
        return { vectors: r.vectors, dim: r.dim };
    }

    async embedQuery(text, _opts = {}) {
        const { vectors, dim } = await this.embedText([text]);
        return { vector: vectors[0] || null, dim };
    }

    status() {
        return { id: this.id, cacheDir: this.#cacheDir, worker: !!this.#child, pending: this.#pending.size };
    }

    async stop() {
        if (this.#child) { try { this.#child.kill(); } catch (_) { /* ignore */ } this.#child = null; }
        for (const p of this.#pending.values()) { p.reject(new Error('clip provider stopped')); }
        this.#pending.clear();
    }
}
