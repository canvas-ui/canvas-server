'use strict';

/**
 * ONNX embedding worker — hosts a fastembed model off the main thread so
 * neither bulk ingestion nor query-time embedding blocks the event loop.
 *
 * One worker hosts exactly one model (chosen at init). The inferd ONNX provider
 * spawns one worker per distinct model it needs. DB handles never cross the
 * thread boundary — this worker is pure compute.
 *
 * Protocol (parent -> worker):
 *   { type: 'init', model, cacheDir, maxLength }
 *   { type: 'embed', jobId, texts: string[], mode: 'passage' | 'query' }
 * Protocol (worker -> parent):
 *   { type: 'ready', dim }              after successful init
 *   { type: 'initError', error }
 *   { jobId, vectors: number[][] }      embed success
 *   { jobId, error }                    embed failure
 *
 * Lifted verbatim from synapsd/src/semantic/worker.js (which is being removed).
 */

import { parentPort } from 'worker_threads';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ort from 'onnxruntime-node';
import { FlagEmbedding, EmbeddingModel } from 'fastembed';

// onnxruntime pins pool threads to CPUs when the thread count is left
// implicit; in cgroup-limited environments (containers, cloud VMs with a
// restricted cpuset) pthread_setaffinity_np fails with EINVAL and ORT logs a
// noisy "error code: 22" per thread. Setting the counts explicitly disables
// affinity pinning (per ORT's own advice in that message). fastembed hardcodes
// its session options, so inject ours through the shared module instance.
// Modest default: embedding batches don't need every core, and the cap keeps
// bulk ingest from starving small instances. Override: INFERD_ONNX_THREADS.
const ONNX_THREADS = Math.max(1, Number(process.env.INFERD_ONNX_THREADS)
    || Math.min(4, os.availableParallelism?.() ?? os.cpus().length));
const originalCreate = ort.InferenceSession.create.bind(ort.InferenceSession);
ort.InferenceSession.create = (pathOrBuffer, options = {}, ...rest) => originalCreate(pathOrBuffer, {
    intraOpNumThreads: ONNX_THREADS,
    interOpNumThreads: 1,
    ...options,
}, ...rest);

// Lifecycle (init/download/ready) is logged unconditionally — a one-time model
// download is operationally important and must be visible without DEBUG=*.
const log = (msg) => console.log(`[inferd:onnx-worker] ${msg}`);

let embedder = null;

// fastembed's EmbeddingModel enum values are the canonical model ids; accept
// either the enum value or a friendly alias.
const MODEL_ALIASES = {
    'bge-small-en-v1.5': EmbeddingModel.BGESmallENV15,
    'bge-base-en-v1.5': EmbeddingModel.BGEBaseENV15,
    'all-minilm-l6-v2': EmbeddingModel.AllMiniLML6V2,
};

function resolveModel(model) {
    if (!model) { return EmbeddingModel.BGESmallENV15; }
    return MODEL_ALIASES[model] || model;
}

async function init({ model, cacheDir, maxLength }) {
    const resolved = resolveModel(model);

    // fastembed extracts to <cacheDir>/<modelId>. If absent, init() downloads
    // a tarball from GCS (one-time). Surface which path we're on, and only show
    // the progress bar when an actual download will happen.
    const modelDir = cacheDir ? path.join(String(cacheDir), resolved) : null;
    const cached = modelDir ? fs.existsSync(modelDir) : false;

    // fastembed mkdirs the cacheDir NON-recursively — a missing parent
    // (fresh server dir) fails init with ENOENT. Pre-create the full path.
    if (cacheDir) { fs.mkdirSync(String(cacheDir), { recursive: true }); }
    if (cached) {
        log(`loading cached model '${resolved}' from ${modelDir}`);
    } else {
        log(`model '${resolved}' not in cache — downloading from GCS to ${cacheDir} (one-time)`);
    }

    const t0 = Date.now();
    embedder = await FlagEmbedding.init({
        model: resolved,
        cacheDir,
        maxLength: maxLength || 512,
        showDownloadProgress: !cached,
    });
    const info = embedder.listSupportedModels().find(m => m.model === resolved);
    log(`model '${resolved}' ready (dim=${info?.dim ?? '?'}) in ${Date.now() - t0}ms`);
    return info?.dim ?? null;
}

async function embedPassages(texts) {
    const out = [];
    // embed() is a batched async generator yielding number[][] per batch.
    for await (const batch of embedder.embed(texts, 64)) {
        for (const vec of batch) { out.push(Array.from(vec)); }
    }
    return out;
}

parentPort.on('message', async (msg) => {
    if (msg?.type === 'init') {
        try {
            const dim = await init(msg);
            parentPort.postMessage({ type: 'ready', dim });
        } catch (error) {
            parentPort.postMessage({ type: 'initError', error: error.message });
        }
        return;
    }

    if (msg?.type === 'embed') {
        const { jobId, texts, mode } = msg;
        try {
            if (!embedder) { throw new Error('Embedder not initialized'); }
            let vectors;
            if (mode === 'query') {
                const vec = await embedder.queryEmbed(texts[0] ?? '');
                vectors = [Array.from(vec)];
            } else {
                vectors = await embedPassages(texts);
            }
            parentPort.postMessage({ jobId, vectors });
        } catch (error) {
            parentPort.postMessage({ jobId, error: error.message });
        }
    }
});
