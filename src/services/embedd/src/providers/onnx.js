'use strict';

import { Worker } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import debugInstance from 'debug';
const debug = debugInstance('canvas:embedd:onnx');

// Friendly model name -> fastembed model id (its on-disk cache dir name).
const MODEL_IDS = {
    'bge-small-en-v1.5': 'fast-bge-small-en-v1.5',
    'bge-base-en-v1.5': 'fast-bge-base-en-v1.5',
    'all-minilm-l6-v2': 'fast-all-MiniLM-L6-v2',
};

/**
 * A single fastembed model hosted in one worker thread. Promise-based
 * request/reply, correlated by jobId. Spawned lazily on first use.
 *
 * Lifted from synapsd/src/semantic/Embedder.js — this is the ONNX runtime the
 * embedd service reuses, one instance per distinct model.
 */
class ModelWorker {

    #worker = null;
    #readyPromise = null;
    #pending = new Map();
    #nextJobId = 1;
    #dim;

    constructor({ model, dim, maxLength, cacheDir } = {}) {
        this.model = model || 'bge-small-en-v1.5';
        this.#dim = dim || 384;
        this.maxLength = maxLength || 512;
        this.cacheDir = cacheDir || null;
    }

    get dim() { return this.#dim; }
    get spawned() { return !!this.#worker; }

    modelCached() {
        try {
            const id = MODEL_IDS[this.model] || this.model;
            return this.cacheDir ? fs.existsSync(path.join(this.cacheDir, id)) : false;
        } catch (_) { return false; }
    }

    status() {
        return {
            model: this.model,
            dim: this.#dim,
            cacheDir: this.cacheDir,
            modelCached: this.modelCached(),
            workerSpawned: this.spawned,
        };
    }

    async ready() {
        if (this.#readyPromise) { return this.#readyPromise; }

        this.#readyPromise = new Promise((resolve, reject) => {
            try {
                this.#worker = new Worker(new URL('./onnx.worker.js', import.meta.url));
            } catch (e) {
                reject(e);
                return;
            }

            this.#worker.on('message', (msg) => {
                if (msg?.type === 'ready') {
                    if (msg.dim) { this.#dim = msg.dim; }
                    debug(`ONNX model ready (model=${this.model}, dim=${this.#dim})`);
                    resolve(this);
                    return;
                }
                if (msg?.type === 'initError') {
                    reject(new Error(`ONNX init failed: ${msg.error}`));
                    return;
                }
                const entry = this.#pending.get(msg.jobId);
                if (!entry) { return; }
                this.#pending.delete(msg.jobId);
                if (msg.error) { entry.reject(new Error(msg.error)); }
                else { entry.resolve(msg.vectors); }
            });

            this.#worker.on('error', (err) => {
                debug(`ONNX worker error: ${err.message}`);
                for (const [, entry] of this.#pending) { entry.reject(err); }
                this.#pending.clear();
                reject(err);
            });

            this.#worker.postMessage({
                type: 'init',
                model: this.model,
                cacheDir: this.cacheDir,
                maxLength: this.maxLength,
            });
        });

        return this.#readyPromise;
    }

    #send(texts, mode) {
        return new Promise((resolve, reject) => {
            const jobId = this.#nextJobId++;
            this.#pending.set(jobId, { resolve, reject });
            this.#worker.postMessage({ type: 'embed', jobId, texts, mode });
        });
    }

    async embedPassages(texts) {
        if (!Array.isArray(texts) || texts.length === 0) { return []; }
        await this.ready();
        return this.#send(texts, 'passage');
    }

    async embedQuery(text) {
        if (typeof text !== 'string' || text.length === 0) { return null; }
        await this.ready();
        const [vec] = await this.#send([text], 'query');
        return vec || null;
    }

    async stop() {
        if (this.#worker) {
            await this.#worker.terminate();
            this.#worker = null;
            this.#readyPromise = null;
        }
    }
}

/**
 * ONNX provider — local fastembed models via worker threads. Holds one
 * ModelWorker per distinct model id so multiple embedding spaces (e.g. two text
 * models, or text + a future image/CLIP model) coexist without cross-talk.
 *
 * Provider contract: embedText / embedQuery / embedImage return
 * `{ vectors, dim }`. embedImage is not yet implemented (route images to a
 * provider that supports them, or wire a CLIP ONNX model here later).
 */
export default class OnnxProvider {

    id = 'onnx';
    #workers = new Map();   // modelId -> ModelWorker
    #cacheDir;

    constructor({ cacheDir } = {}) {
        this.#cacheDir = cacheDir || null;
    }

    #worker({ model, dim, maxLength }) {
        let w = this.#workers.get(model);
        if (!w) {
            w = new ModelWorker({ model, dim, maxLength, cacheDir: this.#cacheDir });
            this.#workers.set(model, w);
        }
        return w;
    }

    async embedText(texts, { model, dim, maxLength } = {}) {
        const w = this.#worker({ model, dim, maxLength });
        const vectors = await w.embedPassages(texts);
        return { vectors, dim: w.dim };
    }

    async embedQuery(text, { model, dim, maxLength } = {}) {
        const w = this.#worker({ model, dim, maxLength });
        const vector = await w.embedQuery(text);
        return { vector, dim: w.dim };
    }

    // eslint-disable-next-line no-unused-vars
    async embedImage(images, opts = {}) {
        throw new Error('OnnxProvider.embedImage not implemented (no CLIP model wired yet)');
    }

    status() {
        return {
            id: this.id,
            cacheDir: this.#cacheDir,
            models: [...this.#workers.values()].map(w => w.status()),
        };
    }

    async stop() {
        await Promise.all([...this.#workers.values()].map(w => w.stop().catch(() => {})));
        this.#workers.clear();
    }
}
