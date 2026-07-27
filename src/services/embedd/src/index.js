'use strict';

import debugInstance from 'debug';
const debug = debugInstance('canvas:embedd');

import Router from './router.js';
import Queue from './queue.js';
import Semaphore from './semaphore.js';
import { normalizeConfig } from './config.js';
import { createProviders } from './providers/index.js';
import { chunkText } from './chunking.js';
import { COMMENT_CHUNK_ID, TEXT_SPACE, BASELINE_SPACES, presenceKey, seenKey } from './constants.js';

/**
 * Embedd — the canvas embedding service.
 *
 * One shared model runtime for the whole server (no per-workspace model
 * footprint) with pluggable providers and a content router — but a SEPARATE
 * queue per workspace, so a workspace's backlog is its own and a bulk import in
 * one never shows up as pending work in another. Concurrency across those queues
 * is capped by a shared semaphore, because the expensive part (inference) is
 * still a server-wide resource; default limit 1 reproduces the old single-serial
 * queue exactly.
 *
 * Providers and routing rules are CONFIG (see config.js), which is what lets the
 * provider layer point at a remote/GPU inference host without touching code.
 * synapsd owns no model — it only stores + searches vectors; for search, the
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
 *   onQueueDrained?() -> Promise<void>   // optional: THIS workspace's queue drained
 */
export default class Embedd {

    #router;
    #providers;
    #workspaces = new Map();   // wsId -> adapter
    #queues = new Map();       // wsId -> Queue  (one per workspace)
    #gate;                     // shared inference concurrency cap
    #batchSize;
    #stopped = false;
    #paused = false;           // global pause (admin control); per-queue pause is separate
    // Soft ingest gate: CANVAS_EMBEDD_INGEST_DISABLED=true drops enqueues and
    // no-ops reconcile while queries (embedQuery) keep serving existing
    // vectors. Escape hatch for CPU-bound bulk ingests (the serialized CLIP
    // child pins the whole box); the gap ledger re-drives skipped docs via
    // reconcile once the gate is lifted. CANVAS_EMBEDD_ENABLED=false remains
    // the hard switch (no embedd instance at all, dense search degrades).
    #ingestDisabled = process.env.CANVAS_EMBEDD_INGEST_DISABLED === 'true';

    /**
     * @param {object} [options]
     * @param {object} [options.providers]    declared providers, keyed by id (config.js)
     * @param {Array}  [options.rules]        routing rules (defaults to DEFAULT_RULES)
     * @param {string} [options.onnxCacheDir] built-in `onnx` provider cache dir
     * @param {string} [options.clipCacheDir] built-in `clip` provider cache dir
     * @param {string} [options.ollamaHost]   built-in `ollama` provider host
     * @param {number} [options.concurrency]  max batches in flight across all queues
     */
    constructor(options = {}) {
        const { providers, spaces, rules } = normalizeConfig(options);
        this.#router = new Router({ rules, spaces });
        this.#providers = createProviders(providers);
        // Batched drain: images resolved in one batch share a single provider
        // call (one IPC round-trip + one batched ORT run for up to N images)
        // instead of one call per doc — the dominant ingest cost for photo sets.
        this.#batchSize = Math.max(1, Number(process.env.CANVAS_EMBED_BATCH) || 8);
        this.#gate = new Semaphore(options.concurrency || Number(process.env.CANVAS_EMBEDD_CONCURRENCY) || 1);
    }

    get router() { return this.#router; }

    /**
     * Per-space vector config for synapsd (`semantic.spaces`). The router knows
     * each space's model+dim, so it also decides where those vectors live and
     * which ledgers track them.
     *
     * Ledger keys are ALWAYS keyed by (space, model) — that is what makes
     * switching models and switching back cheap: the previous model's vectors and
     * its "already embedded" bookkeeping are both still there, so a revert costs
     * a restart rather than a full re-embed. Only the Lance TABLE is special-cased:
     * a space still on its baseline model keeps the original `vec_text`/`vec_image`
     * so making the model configurable orphans nothing.
     */
    spaceConfigs() {
        const out = {};
        for (const space of this.#router.spaces) {
            const rule = this.#router.spaceRule(space);
            if (!rule) { continue; }
            const baseline = BASELINE_SPACES[space];

            const cfg = {
                model: rule.model,
                dim: rule.dim,
                bitmapKey: presenceKey(space, rule.model),
                seenKey: seenKey(space, rule.model),
            };
            // Baseline (model AND dim unchanged) → pin to the pre-config table.
            if (baseline && baseline.model === rule.model && baseline.dim === rule.dim) {
                cfg.table = baseline.table;
            }
            const annIndex = rule.annIndex ?? baseline?.annIndex;
            if (annIndex === false) { cfg.annIndex = false; }
            out[space] = cfg;
        }
        return out;
    }

    // ── Workspace registration ────────────────────────────────────────────────

    registerWorkspace(wsId, adapter) {
        if (!wsId || !adapter?.resolveInput || !adapter?.storeVectors) {
            throw new Error('registerWorkspace requires { resolveInput, storeVectors }');
        }
        this.#workspaces.set(wsId, adapter);
        this.#queueFor(wsId);
        debug(`workspace registered: ${wsId}`);
    }

    unregisterWorkspace(wsId) {
        this.#queues.get(wsId)?.stop();
        this.#queues.delete(wsId);
        this.#workspaces.delete(wsId);
        debug(`workspace unregistered: ${wsId}`);
    }

    /** This workspace's queue, created on demand. */
    #queueFor(wsId) {
        let q = this.#queues.get(wsId);
        if (q) { return q; }

        // Every batch takes a permit from the shared gate, so per-workspace
        // queues give isolation and visibility without multiplying the load the
        // inference runtime actually sees.
        q = new Queue((jobs) => this.#gate.run(() => this.#handleBatch(wsId, jobs)), { batchSize: this.#batchSize });
        q.on('error', (e) => console.warn(`embedd: job ${e.key} failed (doc keeps no vectors until reconcile): ${e.error}`));
        // Bulk ingests leave the Lance tables shredded (one delete+add commit per
        // doc) with no ANN index; notify the workspace on drain so it can compact
        // + index without waiting for a manual admin optimize. Best-effort, and
        // now scoped to the workspace that actually drained — the shared queue
        // used to wake EVERY registered workspace on any drain.
        q.on('drained', async () => {
            const ws = this.#workspaces.get(wsId);
            if (typeof ws?.onQueueDrained !== 'function') { return; }
            try { await ws.onQueueDrained(); }
            catch (e) { debug(`onQueueDrained failed for ${wsId}: ${e.message}`); }
        });
        // A workspace registered while embedding is globally paused must not
        // start draining behind the admin's back.
        if (this.#paused) { q.pause(); }
        this.#queues.set(wsId, q);
        return q;
    }

    // ── Ingestion ─────────────────────────────────────────────────────────────

    enqueue(wsId, docId) {
        if (this.#stopped || this.#ingestDisabled || !this.#workspaces.has(wsId)) { return; }
        const id = Number(docId);
        if (!Number.isInteger(id) || id <= 0) { return; }
        this.#queueFor(wsId).enqueue(`${wsId}:${id}`, { wsId, docId: id });
    }

    enqueueMany(wsId, docIds) {
        if (!Array.isArray(docIds)) { return; }
        for (const id of docIds) { this.enqueue(wsId, id); }
    }

    /**
     * Drain one batch of a single workspace: resolve every job's input, embed all
     * image-modality inputs per rule in ONE provider call, then finish each doc
     * individually (store vectors, comment chunk, seen ticks). Per-doc errors are
     * isolated — one broken doc never fails its batch-mates.
     */
    async #handleBatch(wsId, jobs) {
        const ws = this.#workspaces.get(wsId);
        if (!ws) { return; }   // unregistered mid-flight

        // 1) Resolve inputs.
        const items = [];   // { job, input, rule }
        for (const job of jobs) {
            try {
                const input = await ws.resolveInput(job.docId);
                if (!input) { continue; }   // doc gone → do not record as seen
                const rule = input.skip ? null : this.#router.route(input);
                items.push({ job, input, rule });
            } catch (e) {
                console.warn(`embedd: resolveInput failed for ${wsId}:${job.docId} (doc keeps no vectors until reconcile): ${e.message}`);
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
                const { vectors } = await provider.embedImage(
                    list.map((it) => it.input.bytes),
                    rule,
                    // Remote providers encode images as data URIs and need the
                    // mime; local ones ignore the third argument.
                    { contentTypes: list.map((it) => it.input.contentType || null) },
                );
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
                await this.#finish(wsId, ws, it, rowsByItem.get(it));
            } catch (e) {
                console.warn(`embedd: job ${wsId}:${it.job.docId} failed (doc keeps no vectors until reconcile): ${e.message}`);
            }
        }
    }

    // Store/comment/seen pipeline for one resolved doc. `precomputedRows` skips
    // the primary embed (batch image path); undefined → embed here.
    async #finish(wsId, ws, { job, input, rule }, precomputedRows) {
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
                debug(`primary embed failed ${wsId}:${job.docId} in '${rule.space}': ${err.message}`);
                rows = [];
            }
            // If content routes to the text space, bundle the comment chunk into the
            // same upsert (one storeVectors per space — a second text upsert would
            // delete+replace and wipe the content chunks).
            if (rule.space === TEXT_SPACE && comment) {
                const cRow = await this.#embedComment(comment);
                if (cRow) { rows = [...rows, cRow]; }
            }
            await ws.storeVectors(job.docId, schema, updatedAt, rows, { space: rule.space, model: rule.model });
            written.add(rule.space);
            debug(`embedded ${wsId}:${job.docId} → ${rows.length} chunk(s) in '${rule.space}'`);
        } else {
            debug(`skip ${wsId}:${job.docId} (schema=${schema}, ct=${input.contentType})`);
        }

        // Comment → text space when content didn't already route there (photos,
        // non-text files, or non-embeddable JSON like tabs). Own upsert with just
        // the comment chunk; marks the doc seen in text so it leaves the gap.
        if (comment && !written.has(TEXT_SPACE)) {
            const cRow = await this.#embedComment(comment);
            const textModel = this.#router.spaceRule(TEXT_SPACE)?.model;
            await ws.storeVectors(job.docId, schema, updatedAt, cRow ? [cRow] : [], { space: TEXT_SPACE, model: textModel });
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
            const { vectors } = await provider.embedImage([input.bytes], rule, { contentTypes: [input.contentType || null] });
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
        if (this.#ingestDisabled) { return { enqueued: 0, spaces: {}, ingestDisabled: true }; }
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

    /**
     * Resolve when the given workspace's queue has drained, or (no argument)
     * when every workspace's has. The all-workspaces form re-checks after each
     * settle: queues drain independently, so one finishing says nothing about
     * the others, and a reconcile can feed a queue while another is still busy.
     */
    async drained(wsId = null) {
        if (wsId) { await this.#queues.get(wsId)?.drained(); return; }
        for (;;) {
            await Promise.all([...this.#queues.values()].map((q) => q.drained()));
            if ([...this.#queues.values()].every((q) => q.size === 0 && !q.isDraining)) { return; }
        }
    }

    /**
     * Pause embedding after the in-flight batch: queues hold their backlog (and
     * keep accepting enqueues) but drain nothing until resume(). Runtime state
     * only — a restart clears it; reconcile re-drives anything missed.
     * @param {string} [wsId] pause just this workspace (default: all)
     */
    pause(wsId = null) {
        if (wsId) {
            const q = this.#queues.get(wsId);
            q?.pause();
            debug(`queue paused: ${wsId}`);
            return { paused: true, workspace: wsId, pending: q?.size || 0 };
        }
        this.#paused = true;
        for (const q of this.#queues.values()) { q.pause(); }
        debug('queues paused (all)');
        return { paused: true, pending: this.#pending() };
    }

    resume(wsId = null) {
        if (wsId) {
            const q = this.#queues.get(wsId);
            q?.resume();
            debug(`queue resumed: ${wsId}`);
            return { paused: false, workspace: wsId, pending: q?.size || 0 };
        }
        this.#paused = false;
        for (const q of this.#queues.values()) { q.resume(); }
        debug('queues resumed (all)');
        return { paused: false, pending: this.#pending() };
    }

    #pending() {
        let total = 0;
        for (const q of this.#queues.values()) { total += q.size; }
        return total;
    }

    /** Queue state for ONE workspace — what the workspace settings UI shows. */
    workspaceStatus(wsId) {
        const q = this.#queues.get(wsId);
        if (!q) { return null; }
        return {
            pending: q.size,
            draining: q.isDraining,
            paused: q.isPaused,
            ingestDisabled: this.#ingestDisabled,
        };
    }

    async status() {
        const providers = {};
        for (const [id, p] of this.#providers) {
            try { providers[id] = await p.status(); } catch (e) { providers[id] = { id, error: e.message }; }
        }
        const queues = {};
        for (const [wsId, q] of this.#queues) {
            queues[wsId] = { pending: q.size, draining: q.isDraining, paused: q.isPaused };
        }
        return {
            workspaces: this.#workspaces.size,
            spaces: this.#router.spaces,
            spaceConfigs: this.spaceConfigs(),
            concurrency: { limit: this.#gate.limit, active: this.#gate.active, waiting: this.#gate.waiting },
            // Server-wide rollup — the admin pause/resume surface.
            queue: {
                pending: this.#pending(),
                draining: [...this.#queues.values()].some((q) => q.isDraining),
                paused: this.#paused,
                ingestDisabled: this.#ingestDisabled,
            },
            queues,
            providers,
        };
    }

    async stop() {
        this.#stopped = true;
        for (const q of this.#queues.values()) { q.stop(); }
        this.#queues.clear();
        await Promise.all([...this.#providers.values()].map(p => p.stop().catch(() => {})));
    }
}
