'use strict';

import debugInstance from 'debug';
const debug = debugInstance('canvas:embedd');

import Router, { DEFAULT_SPACES } from './router.js';
import Queue from './queue.js';
import Semaphore from './semaphore.js';
import { normalizeConfig, mergeConfigLayers } from './config.js';
import ProviderPool from './providers/pool.js';
import { chunkText } from './chunking.js';
import { COMMENT_CHUNK_ID, TEXT_SPACE, BASELINE_SPACES, presenceKey, seenKey } from './constants.js';

/**
 * Embedd — the canvas embedding service.
 *
 * Three things are scoped differently, on purpose:
 *
 *   per USER      the backend config — which provider/model fills each modality.
 *                 Workspaces belong to users, so a workspace embeds with its
 *                 OWNER's models. Resolution: built-in ← server default ← user.
 *   per WORKSPACE the queue, so a bulk import in one workspace never shows up as
 *                 pending work in another.
 *   per SERVER    the model runtimes (pooled by backend config, so N users on the
 *                 same endpoint share one client) and the inference concurrency
 *                 cap, because inference is a server-wide resource however many
 *                 users want a slice of it. Default limit 1 reproduces the old
 *                 single-serial queue exactly.
 *
 * synapsd owns no model — it only stores + searches vectors; for search, the
 * synapsd Db is handed this service's `embedQuery` bound to the workspace owner.
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

    #baseOptions;              // cache dirs / hosts for the built-in providers
    #serverConfig;             // admin-set defaults (the embedd.json layer)
    #resolveUserConfig;        // async (userId) -> raw per-user config | null
    #pool = new ProviderPool();
    #contexts = new Map();     // userId -> { config, router, providers } (lazy, invalidatable)
    #workspaces = new Map();   // wsId -> adapter
    #wsUser = new Map();       // wsId -> userId (whose models the workspace embeds with)
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
     * @param {object} [options.providers] server-default providers (embedd.json)
     * @param {object} [options.spaces]    server-default per-space backends
     * @param {Array}  [options.rules]     routing rules
     * @param {string} [options.onnxCacheDir]
     * @param {string} [options.clipCacheDir]
     * @param {string} [options.ollamaHost]
     * @param {number} [options.concurrency] max batches in flight across all queues
     * @param {(userId:string)=>Promise<object|null>} [options.resolveUserConfig]
     *        per-user overrides. Omitted → every user gets the server config.
     */
    constructor(options = {}) {
        const { providers, spaces, rules, concurrency, resolveUserConfig, ...base } = options;
        this.#baseOptions = base;
        this.#serverConfig = { providers, spaces, rules };
        this.#resolveUserConfig = typeof resolveUserConfig === 'function' ? resolveUserConfig : null;
        // Validate the server layer eagerly: a broken embedd.json must fail at
        // boot, not on the first document a user happens to save.
        this.#context(null);
        // Batched drain: images resolved in one batch share a single provider
        // call (one IPC round-trip + one batched ORT run for up to N images)
        // instead of one call per doc — the dominant ingest cost for photo sets.
        this.#batchSize = Math.max(1, Number(process.env.CANVAS_EMBED_BATCH) || 8);
        this.#gate = new Semaphore(concurrency || Number(process.env.CANVAS_EMBEDD_CONCURRENCY) || 1);
    }

    // ── Per-user configuration ────────────────────────────────────────────────

    /**
     * Build (and cache) a user's resolved context: their config, the router it
     * produces, and their provider instances drawn from the shared pool.
     * `userId === null` is the server layer — used for validation at boot and as
     * the fallback for any workspace with no resolvable owner.
     */
    #context(userId, rawUser = null) {
        const cached = this.#contexts.get(userId);
        if (cached) { return cached; }

        // Built-in ← server ← user, all merged KEY-WISE per space. The built-in
        // layer has to take part: a user who sets only `{ text: { model, dim } }`
        // must inherit the provider from underneath rather than declaring a
        // space with no backend.
        const merged = mergeConfigLayers({ spaces: DEFAULT_SPACES }, this.#serverConfig, rawUser);
        // A user's config is data they typed. It must never take the server down:
        // fall back to the server layer and surface the reason instead.
        let normalized;
        try {
            normalized = normalizeConfig({ ...this.#baseOptions, ...merged });
        } catch (e) {
            if (userId === null) { throw e; }   // the server layer is an operator error → loud
            debug(`user ${userId} has invalid embedd config, falling back to server defaults: ${e.message}`);
            const ctx = { ...this.#context(null), invalid: e.message };
            this.#contexts.set(userId, ctx);
            return ctx;
        }

        const ctx = {
            config: normalized,
            router: new Router({ rules: normalized.rules, spaces: normalized.spaces }),
            providers: this.#pool.resolve(normalized.providers),
        };
        this.#contexts.set(userId, ctx);
        return ctx;
    }

    /** Resolved context for a user, loading their stored config on first use. */
    async contextFor(userId) {
        if (!userId || !this.#resolveUserConfig) { return this.#context(userId || null); }
        if (this.#contexts.has(userId)) { return this.#contexts.get(userId); }
        let raw = null;
        try { raw = await this.#resolveUserConfig(userId); }
        catch (e) { debug(`resolveUserConfig(${userId}) failed, using server defaults: ${e.message}`); }
        return this.#context(userId, raw);
    }

    /**
     * Drop a user's cached context so their next operation re-reads config.
     * Providers stay pooled — a config change must not tear down a model runtime
     * another user is mid-batch on.
     */
    invalidateUser(userId) {
        this.#contexts.delete(userId);
        debug(`config cache invalidated for ${userId}`);
    }

    /** Router for a user (their routing + backends). */
    async routerFor(userId) { return (await this.contextFor(userId)).router; }

    /** The server-default layer, as stored (unresolved). */
    get serverConfig() { return this.#serverConfig; }

    /**
     * Replace the server-default layer at runtime. Validates before adopting —
     * a rejected config leaves the running one untouched — then drops EVERY
     * cached context, since the defaults sit underneath every user.
     * @throws if the new config does not resolve
     */
    setServerConfig(config = {}) {
        const previous = this.#serverConfig;
        const previousContexts = this.#contexts;
        this.#serverConfig = { providers: config.providers, spaces: config.spaces, rules: config.rules };
        this.#contexts = new Map();
        try {
            this.#context(null);
        } catch (e) {
            this.#serverConfig = previous;
            this.#contexts = previousContexts;
            throw e;
        }
        debug('server default config replaced; all user contexts invalidated');
        return this.#context(null).config;
    }

    /**
     * Validate a candidate config the way it would actually be used — layered
     * under (or over) the server defaults — without adopting it. This is what
     * lets the API reject a bad config before it is ever persisted.
     */
    validate(config = {}, { asServerDefault = false } = {}) {
        const layers = asServerDefault
            ? [{ spaces: DEFAULT_SPACES }, config]
            : [{ spaces: DEFAULT_SPACES }, this.#serverConfig, config];
        return normalizeConfig({ ...this.#baseOptions, ...mergeConfigLayers(...layers) });
    }

    /** A pooled provider instance for an ad-hoc spec — used by test-connection. */
    providerFor(spec) { return this.#pool.get(spec.id || 'test', spec); }

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
    async spaceConfigsFor(userId) {
        const router = await this.routerFor(userId);
        const out = {};
        for (const space of router.spaces) {
            const rule = router.spaceRule(space);
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

    /**
     * @param {string} wsId
     * @param {object} adapter  resolveInput / storeVectors / getUnembedded / …
     * @param {{userId?: string}} [opts] the workspace OWNER — whose configured
     *   models this workspace embeds with. Omitted → server defaults.
     */
    registerWorkspace(wsId, adapter, { userId = null } = {}) {
        if (!wsId || !adapter?.resolveInput || !adapter?.storeVectors) {
            throw new Error('registerWorkspace requires { resolveInput, storeVectors }');
        }
        this.#workspaces.set(wsId, adapter);
        if (userId) { this.#wsUser.set(wsId, userId); }
        this.#queueFor(wsId);
        debug(`workspace registered: ${wsId}${userId ? ` (owner ${userId})` : ''}`);
    }

    unregisterWorkspace(wsId) {
        this.#queues.get(wsId)?.stop();
        this.#queues.delete(wsId);
        this.#workspaces.delete(wsId);
        this.#wsUser.delete(wsId);
        debug(`workspace unregistered: ${wsId}`);
    }

    /** Workspaces owned by a user — the ones a config change affects. */
    workspacesOf(userId) {
        return [...this.#wsUser.entries()].filter(([, u]) => u === userId).map(([wsId]) => wsId);
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
        // The workspace embeds with its OWNER's configured models.
        const ctx = await this.contextFor(this.#wsUser.get(wsId));

        // 1) Resolve inputs.
        const items = [];   // { job, input, rule }
        for (const job of jobs) {
            try {
                const input = await ws.resolveInput(job.docId);
                if (!input) { continue; }   // doc gone → do not record as seen
                const rule = input.skip ? null : ctx.router.route(input);
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
            const provider = ctx.providers.get(rule.provider);
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
                await this.#finish(wsId, ws, ctx, it, rowsByItem.get(it));
            } catch (e) {
                console.warn(`embedd: job ${wsId}:${it.job.docId} failed (doc keeps no vectors until reconcile): ${e.message}`);
            }
        }
    }

    // Store/comment/seen pipeline for one resolved doc. `precomputedRows` skips
    // the primary embed (batch image path); undefined → embed here.
    async #finish(wsId, ws, ctx, { job, input, rule }, precomputedRows) {
        const { schema, updatedAt } = input;
        // The doc appears in the gap of EVERY space that lists its schema as a
        // candidate (files are candidates for both text+image). It resolves to at
        // most one; the rest must still be marked seen so reconcile converges.
        const candidateSpaces = ctx.router.candidateSpaces(schema);
        const comment = typeof input.comment === 'string' ? input.comment.trim() : '';

        // Spaces we've written real vectors to (so the seen-[] pass below skips them
        // and never wipes a row we just wrote — e.g. a photo's comment in the text
        // space, where the doc's content routed to the image space).
        const written = new Set();

        if (rule) {
            const provider = ctx.providers.get(rule.provider);
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
                const cRow = await this.#embedComment(comment, ctx);
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
            const cRow = await this.#embedComment(comment, ctx);
            const textModel = ctx.router.spaceRule(TEXT_SPACE)?.model;
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
    async #embedComment(comment, ctx) {
        const rule = ctx.router.spaceRule(TEXT_SPACE);
        if (!rule) { return null; }
        const provider = ctx.providers.get(rule.provider);
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

        // The gap is defined by the OWNER's spaces — a user who switched models
        // has a different set of candidate spaces to drain.
        const router = await this.routerFor(this.#wsUser.get(wsId));
        const spaces = space ? [space] : router.spaces;
        const per = {};
        let enqueued = 0;
        for (const sp of spaces) {
            if (reindex && ws.clearSpace) { await ws.clearSpace(sp); }
            const schemas = router.candidateSchemas(sp);
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

    /**
     * Embed a query string into a space's vector, for synapsd search. Must use
     * the SAME model that filled the space, so it takes the workspace owner —
     * querying a Qwen-filled table with a bge vector returns noise.
     */
    async embedQuery(text, space = 'text', userId = null) {
        if (typeof text !== 'string' || text.length === 0) { return null; }
        const ctx = await this.contextFor(userId);
        const rule = ctx.router.spaceRule(space);
        if (!rule) { return null; }
        const provider = ctx.providers.get(rule.provider);
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
        const queues = {};
        for (const [wsId, q] of this.#queues) {
            queues[wsId] = {
                pending: q.size, draining: q.isDraining, paused: q.isPaused,
                owner: this.#wsUser.get(wsId) || null,
            };
        }
        const serverRouter = (await this.contextFor(null)).router;
        return {
            workspaces: this.#workspaces.size,
            // The SERVER-default spaces. Per-user spaces are reported by the
            // per-user config endpoint — this is an operator view.
            spaces: serverRouter.spaces,
            spaceConfigs: await this.spaceConfigsFor(null),
            configuredUsers: [...this.#contexts.keys()].filter(Boolean).length,
            concurrency: { limit: this.#gate.limit, active: this.#gate.active, waiting: this.#gate.waiting },
            // Server-wide rollup — the admin pause/resume surface.
            queue: {
                pending: this.#pending(),
                draining: [...this.#queues.values()].some((q) => q.isDraining),
                paused: this.#paused,
                ingestDisabled: this.#ingestDisabled,
            },
            queues,
            // Pooled by backend config, so this is the set of DISTINCT backends
            // in use across all users, not one entry per user.
            providers: await this.#pool.status(),
        };
    }

    async stop() {
        this.#stopped = true;
        for (const q of this.#queues.values()) { q.stop(); }
        this.#queues.clear();
        this.#contexts.clear();
        await this.#pool.stopAll();
    }
}
