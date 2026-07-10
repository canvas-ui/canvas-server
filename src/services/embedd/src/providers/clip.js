'use strict';

import debugInstance from 'debug';
const debug = debugInstance('canvas:embedd:clip');

/**
 * CLIP/SigLIP provider — joint image+text embedding space via transformers.js.
 *
 * The whole point of CLIP-family models is a SHARED vector space: an image and
 * the text "red car" land near each other. So this one provider fills the image
 * space from BOTH sides — `embedImage` (vision encoder) at index time, and
 * `embedQuery`/`embedText` (text encoder) at search time. Both are L2-normalized
 * so the space's cosine metric is meaningful.
 *
 * Model is a HuggingFace repo id with ONNX weights. Default is SigLIP (768-d);
 * override with CANVAS_CLIP_MODEL (e.g. a SigLIP2 export) — keep it 768-d or also
 * bump the image space's `dim` and reindex. transformers.js downloads + caches
 * the weights on first use (not shipped via npm).
 */

// SigLIP v1 base is a known-good transformers.js export (768-d). To upgrade to
// SigLIP2 for better retrieval, set CANVAS_CLIP_MODEL=onnx-community/siglip2-base-patch16-224
// (also 768-d, so no reindex). Kept as env override so it needs no code change.
const DEFAULT_MODEL = process.env.CANVAS_CLIP_MODEL || 'Xenova/siglip-base-patch16-224';
// fp32 for retrieval quality; set CANVAS_CLIP_DTYPE=q8 for a smaller/faster model.
const DEFAULT_DTYPE = process.env.CANVAS_CLIP_DTYPE || 'fp32';

// transformers.js is heavy (pulls onnxruntime); import lazily on first real use
// so the embedd service starts fast and text-only deployments never pay for it.
let _transformers = null;
async function transformers() {
    if (!_transformers) { _transformers = await import('@huggingface/transformers'); }
    return _transformers;
}

function l2normalize(arr) {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) { sum += arr[i] * arr[i]; }
    const norm = Math.sqrt(sum) || 1;
    const out = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) { out[i] = arr[i] / norm; }
    return out;
}

export default class ClipProvider {

    id = 'clip';
    #cacheDir;
    #dtype;
    #models = new Map();   // modelId -> Promise<{ tokenizer, textModel, processor, visionModel }>
    #envApplied = false;

    constructor({ cacheDir = null, dtype = DEFAULT_DTYPE } = {}) {
        this.#cacheDir = cacheDir;
        this.#dtype = dtype;
    }

    #resolveModel(model) {
        // env override wins so operators can swap models without touching router rules.
        return process.env.CANVAS_CLIP_MODEL || model || DEFAULT_MODEL;
    }

    async #load(modelId) {
        if (this.#models.has(modelId)) { return this.#models.get(modelId); }
        const promise = (async () => {
            const t = await transformers();
            const { AutoTokenizer, AutoProcessor, SiglipTextModel, SiglipVisionModel, env } = t;
            if (!this.#envApplied) {
                if (this.#cacheDir) { env.cacheDir = this.#cacheDir; }
                this.#envApplied = true;
            }
            debug(`loading CLIP model '${modelId}' (dtype=${this.#dtype})…`);
            const [tokenizer, textModel, processor, visionModel] = await Promise.all([
                AutoTokenizer.from_pretrained(modelId),
                SiglipTextModel.from_pretrained(modelId, { dtype: this.#dtype }),
                AutoProcessor.from_pretrained(modelId),
                SiglipVisionModel.from_pretrained(modelId, { dtype: this.#dtype }),
            ]);
            debug(`CLIP model '${modelId}' ready`);
            return { tokenizer, textModel, processor, visionModel };
        })();
        this.#models.set(modelId, promise);
        // If load fails, drop the rejected promise so a later call can retry.
        promise.catch(() => this.#models.delete(modelId));
        return promise;
    }

    // Extract an embedding tensor ([B, D], or [B, S, D] which we mean-pool over S)
    // into an array of L2-normalized number[]. Returns { vectors, dim }.
    #toRows(tensor) {
        const dims = tensor.dims;
        const data = tensor.data;
        const D = dims[dims.length - 1];
        if (dims.length === 3) {
            // [B, S, D] — no pooler output; mean-pool over the sequence.
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
        for (let b = 0; b < B; b++) {
            vectors.push(l2normalize(data.subarray(b * D, (b + 1) * D)));
        }
        return { vectors, dim: D };
    }

    async embedImage(images, { model } = {}) {
        if (!Array.isArray(images) || images.length === 0) { return { vectors: [], dim: 0 }; }
        const t = await transformers();
        const { processor, visionModel } = await this.#load(this.#resolveModel(model));
        const raws = await Promise.all(images.map(async (buf) => t.RawImage.fromBlob(new Blob([buf]))));
        const inputs = await processor(raws);
        const out = await visionModel(inputs);
        const pooled = out.pooler_output || out.image_embeds || out.last_hidden_state;
        return this.#toRows(pooled);
    }

    async embedText(texts, { model } = {}) {
        if (!Array.isArray(texts) || texts.length === 0) { return { vectors: [], dim: 0 }; }
        const { tokenizer, textModel } = await this.#load(this.#resolveModel(model));
        // SigLIP is trained with fixed-length (64) padding — required, not optional.
        const inputs = tokenizer(texts, { padding: 'max_length', truncation: true });
        const out = await textModel(inputs);
        const pooled = out.pooler_output || out.text_embeds || out.last_hidden_state;
        return this.#toRows(pooled);
    }

    async embedQuery(text, opts = {}) {
        const { vectors, dim } = await this.embedText([text], opts);
        return { vector: vectors[0] || null, dim };
    }

    status() {
        return { id: this.id, cacheDir: this.#cacheDir, dtype: this.#dtype, models: [...this.#models.keys()] };
    }

    async stop() {
        for (const promise of this.#models.values()) {
            try {
                const m = await promise;
                await m.textModel?.dispose?.();
                await m.visionModel?.dispose?.();
            } catch (_) { /* best effort */ }
        }
        this.#models.clear();
    }
}
