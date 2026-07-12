'use strict';

import debugInstance from 'debug';
const debug = debugInstance('canvas:embedd');

import Router from './router.js';
import Queue from './queue.js';
import OnnxProvider from './providers/onnx.js';
import OllamaProvider from './providers/ollama.js';
import ClipProvider from './providers/clip.js';
import { chunkText } from './chunking.js';
import { COMMENT_CHUNK_ID, TEXT_SPACE } from './constants.js';

/**
 * Embedd — the canvas embedding service.
 *
 * Singleton (one model runtime shared across all workspaces — no per-workspace
 * model footprint). Owns pluggable providers (ONNX local, Ollama remote) and a
 * content router. Workspaces register a small adapter and enqueue doc ids; the
 * queue resolves the doc's embeddable input, routes it to a provider/space,
 * embeds, and pushes chunk vectors back through the workspace's storeVectors.
 *
 * synapsd owns no model — it only stores + searches vectors. For search, the
 * synapsd Db is handed this service's `embedQuery` as a callback.
 *
 * Workspace adapter contract (per registerWorkspace):
 *   resolveInput(docId) -> {
 *     modality: 'text' | 'image',
 *     schema: string,
 *     updatedAt: string,
 *     text?: string,            // modality 'text'
 *     bytes?: Buffer,           // modality 'image'
 *     contentType?: string,
 *     chunkOpts?: object,       // embeddingOptions.chunking
 *   } | null                    // null => skip (doc gone / not embeddable)
 *   storeVectors(docId, schema, updatedAt, chunks, { space }) -> Promise<void>
 *     chunks: { chunkId, text?, vector }[]
 *   onQueueDrained?() -> Promise<void>   // optional: queue fully drained (compact/index hook)
 */
export default class Embedd {

    #router;
    #providers = new Map();
    #workspaces = new Map();   // wsId -> { resolveInput, storeVectors }
    #queue;
    #stopped = false;

    constructor(options = {}) {
        this.#router = new Router({ rules: options.rules });
        this.#providers.set('onnx', new OnnxProvider({ cacheDir: options.onnxCacheDir || null }));
        this.#providers.set('ollama', new OllamaProvider({ host: options.ollamaHost }));
        this.#providers.set('clip', new ClipProvider({ cacheDir: options.clipCacheDir || options.onnxCacheDir || null }));
        // Batched drain: images resolved in one batch share a single provider
        // call (one IPC round-trip + one batched ORT run for up to N images)
        // instead of one call per doc — the dominant ingest cost for photo sets.
        const batchSize = Math.max(1, Number(process.env.CANVAS_EMBED_BATCH) || 8);
        this.#queue = new Queue((jobs) => this.#handleBatch(jobs), { batchSize });
        this.#queue.on('error', (e) => console.warn(`embedd: job ${e.key} failed (doc keeps no vectors until reconcile): ${e.error}`));
        // Bulk ingests leave the Lance tables shredded (one delete+add commit per
        // doc) with no ANN index; notify workspaces on drain so they can compact
        // + index without waiting for a manual admin optimize. Best-effort.
        this.#queue.on('drained', async () => {
            // Sequential on purpose: compaction + ANN rebuild is CPU-heavy native
            // work inside this process — running every workspace's maintenance in
            // parallel right after a drain visibly degrades live queries.
            for (const [wsId, ws] of this.#workspaces) {
                if (typeof ws.onQueueDrained !== 'function') { continue; }
                try { await ws.onQueueDrained(); }
                catch (e) { debug(`onQueueDrained failed for ${wsId}: ${e.message}`); }
            }
        });
    }

    get router() { return this.#router; }

    // ── Workspace registration ────────────────────────────────────────────────

    registerWorkspace(wsId, adapter) {
        if (!wsId || !adapter?.resolveInput || !adapter?.storeVectors) {
            throw new Error('registerWorkspace requires { resolveInput, storeVectors }');
        }
        this.#workspaces.set(wsId, adapter);
        debug(`workspace registered: ${wsId}`);
    }

    unregisterWorkspace(wsId) {
        this.#workspaces.delete(wsId);
        debug(`workspace unregistered: ${wsId}`);
    }

    // ── Ingestion ─────────────────────────────────────────────────────────────

    enqueue(wsId, docId) {
        if (this.#stopped || !this.#workspaces.has(wsId)) { return; }
        const id = Number(docId);
        if (!Number.isInteger(id) || id <= 0) { return; }
        this.#queue.enqueue(`${wsId}:${id}`, { wsId, docId: id });
    }

    enqueueMany(wsId, docIds) {
        if (!Array.isArray(docIds)) { return; }
        for (const id of docIds) { this.enqueue(wsId, id); }
    }

    /**
     * Drain one batch: resolve every job's input, embed all image-modality
     * inputs per rule in ONE provider call, then finish each doc individually
     * (store vectors, comment chunk, seen ticks). Per-doc errors are isolated —
     * one broken doc never fails its batch-mates.
     */
    async #handleBatch(jobs) {
        // 1) Resolve inputs.
        const items = [];   // { job, ws, input, rule }
        for (const job of jobs) {
            const ws = this.#workspaces.get(job.wsId);
            if (!ws) { continue; }
            try {
                const input = await ws.resolveInput(job.docId);
                if (!input) { continue; }   // doc gone → do not record as seen
                const rule = input.skip ? null : this.#router.route(input);
                items.push({ job, ws, input, rule });
            } catch (e) {
                console.warn(`embedd: resolveInput failed for ${job.wsId}:${job.docId} (doc keeps no vectors until reconcile): ${e.message}`);
            }
        }

        // 2) Batch-embed images, grouped by rule (provider/space/model).
        const rowsByItem = new Map();
        const imageGroups = new Map();
        for (const it of items) {
            if (!it.rule || it.input.modality !== 'image' || !it.input.bytes) { continue; }
            const key = `${it.rule.provider}/${it.rule.space}/${it.rule.model}`;
            if (!imageGroups.has(key)) { imageGroups.set(key, { rule: it.rule, list: [] }); }
            imageGroups.get(key).list.push(it);
        }
        for (const { rule, list } of imageGroups.values()) {
            const provider = this.#providers.get(rule.provider);
            if (!provider) { continue; }   // #finish surfaces the unknown-provider error per doc
            try {
                const { vectors } = await provider.embedImage(list.map((it) => it.input.bytes), rule);
                list.forEach((it, i) => {
                    const vec = vectors?.[i];
                    rowsByItem.set(it, Array.isArray(vec) ? [{ chunkId: 0, vector: vec }] : []);
                });
            } catch (e) {
                // Whole-batch inference failure (e.g. one corrupt image poisons
                // the ORT run) → fall back to per-doc embedding in #finish.
                debug(`batch image embed failed (${list.length} docs), falling back to per-doc: ${e.message}`);
            }
        }

        // 3) Finish docs sequentially (bounded main-thread/LMDB pressure).
        for (const it of items) {
            try {
                await this.#finish(it, rowsByItem.get(it));
            } catch (e) {
                console.warn(`embedd: job ${it.job.wsId}:${it.job.docId} failed (doc keeps no vectors until reconcile): ${e.message}`);
            }
        }
    }

    // Store/comment/seen pipeline for one resolved doc. `precomputedRows` skips
    // the primary embed (batch image path); undefined → embed here.
    async #finish({ job, ws, input, rule }, precomputedRows) {
        const { schema, updatedAt } = input;
        // The doc appears in the gap of EVERY space that lists its schema as a
        // candidate (files are candidates for both text+image). It resolves to at
        // most one; the rest must still be marked seen so reconcile converges.
        const candidateSpaces = this.#router.candidateSpaces(schema);
        const comment = typeof input.comment === 'string' ? input.comment.trim() : '';

        // Spaces we've written real vectors to (so the seen-[] pass below skips them
        // and never wipes a row we just wrote — e.g. a photo's comment in the text
        // space, where the doc's content routed to the image space).
        const written = new Set();

        if (rule) {
            const provider = this.#providers.get(rule.provider);
            if (!provider) { throw new Error(`unknown provider '${rule.provider}'`); }
            let rows = precomputedRows;
            try {
                rows = rows ?? await this.#embedInput(provider, rule, input);
            } catch (err) {
                // A provider that can't handle this input yet (e.g. image/CLIP is not
                // wired) must NOT abort the job — the doc's comment still needs its
                // text vector. Treat as 0 content rows (seen, no presence).
                debug(`primary embed failed ${job.wsId}:${job.docId} in '${rule.space}': ${err.message}`);
                rows = [];
            }
            // If content routes to the text space, bundle the comment chunk into the
            // same upsert (one storeVectors per space — a second text upsert would
            // delete+replace and wipe the content chunks).
            if (rule.space === TEXT_SPACE && comment) {
                const cRow = await this.#embedComment(comment);
                if (cRow) { rows = [...rows, cRow]; }
            }
            await ws.storeVectors(job.docId, schema, updatedAt, rows, { space: rule.space });
            written.add(rule.space);
            debug(`embedded ${job.wsId}:${job.docId} → ${rows.length} chunk(s) in '${rule.space}'`);
        } else {
            debug(`skip ${job.wsId}:${job.docId} (schema=${schema}, ct=${input.contentType})`);
        }

        // Comment → text space when content didn't already route there (photos,
        // non-text files, or non-embeddable JSON like tabs). Own upsert with just
        // the comment chunk; marks the doc seen in text so it leaves the gap.
        if (comment && !written.has(TEXT_SPACE)) {
            const cRow = await this.#embedComment(comment);
            await ws.storeVectors(job.docId, schema, updatedAt, cRow ? [cRow] : [], { space: TEXT_SPACE });
            written.add(TEXT_SPACE);
        }

        // Mark seen (no vectors) in every other candidate space so the doc leaves
        // all gaps. storeVectors with [] ticks the seen bitmap without presence.
        for (const sp of candidateSpaces) {
            if (written.has(sp)) { continue; }
            await ws.storeVectors(job.docId, schema, updatedAt, [], { space: sp });
        }
    }

    // Embed a document's user-authored comment as a single dedicated chunk row
    // (reserved chunkId) using the text space's provider/model. Returns null if the
    // text space has no provider or the vector couldn't be produced.
    async #embedComment(comment) {
        const rule = this.#router.spaceRule(TEXT_SPACE);
        if (!rule) { return null; }
        const provider = this.#providers.get(rule.provider);
        if (!provider) { return null; }
        const { vectors } = await provider.embedText([comment], rule);
        const vec = vectors?.[0];
        return Array.isArray(vec) ? { chunkId: COMMENT_CHUNK_ID, text: comment, vector: vec } : null;
    }

    // Turn a resolved input into chunk rows { chunkId, text?, vector }.
    async #embedInput(provider, rule, input) {
        if (input.modality === 'image') {
            if (!input.bytes) { return []; }
            const { vectors } = await provider.embedImage([input.bytes], rule);
            const vec = vectors?.[0];
            return Array.isArray(vec) ? [{ chunkId: 0, vector: vec }] : [];
        }

        // text
        const text = typeof input.text === 'string' ? input.text.trim() : '';
        if (!text) { return []; }

        const chunks = rule.chunk === false
            ? [{ chunkId: 0, text }]
            : chunkText(text, input.chunkOpts || {});
        if (chunks.length === 0) { return []; }

        const { vectors } = await provider.embedText(chunks.map(c => c.text), rule);
        return chunks
            .map((c, i) => ({ chunkId: c.chunkId, text: c.text, vector: vectors[i] }))
            .filter(r => Array.isArray(r.vector));
    }

    // ── Reconcile / reindex (durable bitmap ledger) ───────────────────────────

    /**
     * Drain a workspace's unembedded gap. Pulls docIds that match each space's
     * candidate schemas but have no embedding yet (from the workspace's synapsd
     * bitmap ledger) and enqueues them. Idempotent — safe to call any time.
     * @param {string} wsId
     * @param {{space?:string, reindex?:boolean}} [opts] reindex clears the space first
     * @returns {Promise<{enqueued:number, spaces:Record<string,number>}|{error:string}>}
     */
    async reconcile(wsId, { space = null, reindex = false } = {}) {
        const ws = this.#workspaces.get(wsId);
        if (!ws) { return { error: 'workspace not registered' }; }
        if (!ws.getUnembedded) { return { error: 'workspace has no ledger adapter' }; }

        const spaces = space ? [space] : this.#router.spaces;
        const per = {};
        let enqueued = 0;
        for (const sp of spaces) {
            if (reindex && ws.clearSpace) { await ws.clearSpace(sp); }
            const schemas = this.#router.candidateSchemas(sp);
            if (schemas.length === 0) { per[sp] = 0; continue; }
            let ids = [];
            try { ids = await ws.getUnembedded(sp, schemas); } catch (e) { debug(`reconcile ${wsId}/${sp}: ${e.message}`); }
            for (const id of ids) { this.enqueue(wsId, id); }
            per[sp] = ids.length;
            enqueued += ids.length;
        }
        debug(`reconcile ${wsId}: enqueued ${enqueued} across ${Object.keys(per).length} space(s)`);
        return { enqueued, spaces: per };
    }

    // ── Query (search side) ───────────────────────────────────────────────────

    /** Embed a query string into a space's vector, for synapsd search. */
    async embedQuery(text, space = 'text') {
        if (typeof text !== 'string' || text.length === 0) { return null; }
        const rule = this.#router.spaceRule(space);
        if (!rule) { return null; }
        const provider = this.#providers.get(rule.provider);
        if (!provider) { return null; }
        const { vector } = await provider.embedQuery(text, rule);
        return vector || null;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    async drained() { await this.#queue.drained(); }

    async status() {
        const providers = {};
        for (const [id, p] of this.#providers) {
            try { providers[id] = await p.status(); } catch (e) { providers[id] = { id, error: e.message }; }
        }
        return {
            workspaces: this.#workspaces.size,
            spaces: this.#router.spaces,
            queue: { pending: this.#queue.size, draining: this.#queue.isDraining },
            providers,
        };
    }

    async stop() {
        this.#stopped = true;
        this.#queue.stop();
        await Promise.all([...this.#providers.values()].map(p => p.stop().catch(() => {})));
    }
}
