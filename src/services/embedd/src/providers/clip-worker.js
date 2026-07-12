'use strict';

/**
 * CLIP/SigLIP embedding worker — runs in a FORKED CHILD PROCESS.
 *
 * Why a separate process: transformers.js pins onnxruntime-node 1.24.3 while
 * fastembed (the text embedder) pins 1.21.0. Two native onnxruntime versions
 * cannot coexist in one process — they share the global `libonnxruntime.so.1`
 * soname, so the second to load fails its symbol-version check (and forcing one
 * onto the other's version crashes with a V8 HandleScope fault). Isolating CLIP
 * in its own process gives it a clean ORT 1.24.3 with no fastembed present.
 *
 * Protocol (Node fork IPC, 'advanced' serialization for Buffers/TypedArrays):
 *   parent → { id, kind: 'image'|'text', payload: Buffer[] | string[] }
 *   child  → { id, vectors: number[][], dim }  |  { id, error }
 *   child  → { ready: true }  once the process is alive (model still lazy)
 * Requests are serialized (one ORT run at a time) — concurrent runs on a shared
 * session are the exact thing that faulted the in-process attempt.
 */

import os from 'node:os';
import { AutoTokenizer, AutoProcessor, SiglipTextModel, SiglipVisionModel, RawImage, env } from '@huggingface/transformers';

const MODEL = process.env.CANVAS_CLIP_MODEL || 'Xenova/siglip-base-patch16-224';
// fp32 for retrieval quality: SigLIP's cross-modal match band is narrow
// (matches ~0.85–0.95 cosine distance vs noise ~0.94+), and q8 quantization
// error eats into exactly that margin. Set CANVAS_CLIP_DTYPE=q8 for a smaller
// download + faster inference on constrained hosts. NOTE: changing dtype shifts
// embeddings — re-embed the image space after switching or stored vectors won't
// line up with query vectors.
const DTYPE = process.env.CANVAS_CLIP_DTYPE || 'fp32';

// ORT must be told its thread count EXPLICITLY. Left to default, onnxruntime-node
// spins one intra-op thread per visible core and pins each to a CPU via
// pthread_setaffinity_np — which fails (EINVAL) under a cgroup-limited VPS whose
// visible cores exceed its quota, spamming errors and thrashing (why more vCPU
// gave no gain). An explicit count disables the affinity pinning entirely.
// Bounded default (embedd runs one inference at a time, so a handful of intra-op
// threads is plenty); override with CANVAS_EMBED_THREADS.
const THREADS = Math.max(1, Number(process.env.CANVAS_EMBED_THREADS) || Math.min(4, os.cpus().length || 4));
const SESSION_OPTIONS = { intraOpNumThreads: THREADS, interOpNumThreads: 1 };

let modelsPromise = null;
function models() {
    if (!modelsPromise) {
        modelsPromise = (async () => {
            if (process.env.CANVAS_CLIP_CACHE) { env.cacheDir = process.env.CANVAS_CLIP_CACHE; }
            const [tokenizer, textModel, processor, visionModel] = await Promise.all([
                AutoTokenizer.from_pretrained(MODEL),
                SiglipTextModel.from_pretrained(MODEL, { dtype: DTYPE, session_options: SESSION_OPTIONS }),
                AutoProcessor.from_pretrained(MODEL),
                SiglipVisionModel.from_pretrained(MODEL, { dtype: DTYPE, session_options: SESSION_OPTIONS }),
            ]);
            return { tokenizer, textModel, processor, visionModel };
        })();
    }
    return modelsPromise;
}

function l2normalize(arr) {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) { sum += arr[i] * arr[i]; }
    const norm = Math.sqrt(sum) || 1;
    const out = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) { out[i] = arr[i] / norm; }
    return out;
}

// [B, D] (or [B, S, D] → mean-pool over S) → array of L2-normalized number[].
function toRows(tensor) {
    const dims = tensor.dims;
    const data = tensor.data;
    const D = dims[dims.length - 1];
    if (dims.length === 3) {
        const [B, S] = dims;
        const vectors = [];
        for (let b = 0; b < B; b++) {
            const acc = new Float32Array(D);
            for (let s = 0; s < S; s++) {
                const base = (b * S + s) * D;
                for (let k = 0; k < D; k++) { acc[k] += data[base + k]; }
            }
            for (let k = 0; k < D; k++) { acc[k] /= S; }
            vectors.push(l2normalize(acc));
        }
        return { vectors, dim: D };
    }
    const B = dims.length > 1 ? dims[0] : 1;
    const vectors = [];
    for (let b = 0; b < B; b++) { vectors.push(l2normalize(data.subarray(b * D, (b + 1) * D))); }
    return { vectors, dim: D };
}

async function handle(msg) {
    const { id, kind, payload } = msg;
    try {
        const m = await models();
        let out;
        if (kind === 'image') {
            const imgs = await Promise.all(payload.map((buf) => RawImage.fromBlob(new Blob([buf]))));
            const res = await m.visionModel(await m.processor(imgs));
            out = toRows(res.pooler_output || res.image_embeds || res.last_hidden_state);
        } else {
            // SigLIP requires fixed-length (64) padding.
            const inputs = m.tokenizer(payload, { padding: 'max_length', truncation: true });
            const res = await m.textModel(inputs);
            out = toRows(res.pooler_output || res.text_embeds || res.last_hidden_state);
        }
        process.send({ id, vectors: out.vectors, dim: out.dim });
    } catch (e) {
        process.send({ id, error: e.message });
    }
}

// Serialize per session, not globally: the in-process fault was concurrent runs
// on a SHARED session, but text (tokenizer+textModel) and image (processor+
// visionModel) are disjoint sessions. Keeping them on separate chains means a
// search's query embedding ('text') never waits behind the ingest queue's image
// embeds — that head-of-line blocking showed up as sporadic multi-second (up to
// timeout) search latency during bulk ingest.
const chains = { text: Promise.resolve(), image: Promise.resolve() };
process.on('message', (msg) => {
    const lane = msg?.kind === 'image' ? 'image' : 'text';
    chains[lane] = chains[lane].then(() => handle(msg));
});

process.send({ ready: true });
