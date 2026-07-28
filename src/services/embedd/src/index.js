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
 *   per WORKSPACE the backend config (which provider/model fills each modality)
 *                 and the queue. Config lives in workspace.json, so it TRAVELS
 *                 with the workspace — tar it, move it, run it standalone under
 *                 canvas-edge and it still embeds the way its vectors were built.
 *                 Resolution: built-in ← server default ← user default ←
 *                 workspace, merged key-wise so each layer can override one
 *                 field. The queue is per-workspace so a bulk import in one
 *                 never shows up as pending work in another.
 *   per SERVER    the model runtimes (pooled by backend config, so N users on the
 *                 same endpoint share one client) and the inference concurrency
 *                 cap, because inference is a server-wide resource however many
 *                 users want a slice of it. Default limit 1 reproduces the old
 *                 single-serial queue exactly.
 *
 * synapsd owns no model — it only stores + searches vectors; for search, the
 * synapsd Db is handed this service's `embedQuery` bound to the workspace, so a
 * query is embedded by the same model that filled the space.
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
    #wsUser = new Map();       // wsId -> userId (whose defaults the workspace inherits)
    #wsConfig = new Map();     // wsId -> services.embedd from workspace.json (top layer)
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
        this.#context(null, [this.#serverConfig], { strict: true });
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
    #context(cacheKey, layers, { strict = false } = {}) {
        const cached = this.#contexts.get(cacheKey);
        if (cached) { return cached; }

        // All layers merge KEY-WISE per space, so each one can override a single
        // field. The built-in layer has to take part: a config that sets only
        // `{ text: { model, dim } }` must inherit the provider from underneath
        // rather than declaring a space with no backend.
        const merged = mergeConfigLayers({ spaces: DEFAULT_SPACES }, ...layers);
        let normalized;
        try {
            normalized = normalizeConfig({ ...this.#baseOptions, ...merged });
        } catch (e) {
            // The server layer is an operator error → loud. Everything above it
            // is data someone typed into a form: fall back to the layer below
            // and surface the reason instead of refusing to embed at all.
            if (strict) { throw e; }
            debug(`invalid embedd config for '${cacheKey}', falling back to server defaults: ${e.message}`);
            const ctx = { ...this.#context(null, [this.#serverConfig], { strict: true }), invalid: e.message };
            this.#contexts.set(cacheKey, ctx);
            return ctx;
        }

        const ctx = {
            config: normalized,
            router: new Router({ rules: normalized.rules, spaces: normalized.spaces }),
            providers: this.#pool.resolve(normalized.providers),
        };
        this.#contexts.set(cacheKey, ctx);
        return ctx;
    }

    /** A user's stored defaults, if a resolver was injected. */
    async #userLayer(userId) {
        if (!userId || !this.#resolveUserConfig) { return null; }
        try { return await this.#resolveUserConfig(userId); }
        catch (e) { debug(`resolveUserConfig(${userId}) failed, using server defaults: ${e.message}`); return null; }
    }

    /**
     * Resolve a context from the full layer stack:
     *   built-in ← server ← user default ← WORKSPACE
     * The workspace layer wins because it lives in workspace.json and travels
     * with the data — a workspace moved to another host or run standalone under
     * canvas-edge must keep embedding the way its vectors were built.
     */
    async resolve({ userId = null, workspaceConfig = null, cacheKey = null } = {}) {
        const key = cacheKey ?? `u:${userId || ''}`;
        if (this.#contexts.has(key)) { return this.#contexts.get(key); }
        const userLayer = await this.#userLayer(userId);
        return this.#context(key, [this.#serverConfig, userLayer, workspaceConfig]);
    }

    /** Resolved context for a user's defaults (no workspace layer). */
    async contextFor(userId) {
        if (!userId) { return this.#context(null, [this.#serverConfig], { strict: true }); }
        return this.resolve({ userId });
    }

    /** Resolved context for a registered workspace — what it actually embeds with. */
    async contextForWorkspace(wsId) {
        if (!this.#workspaces.has(wsId) && !this.#wsConfig.has(wsId)) { return this.contextFor(null); }
        return this.resolve({
            userId: this.#wsUser.get(wsId) || null,
            workspaceConfig: this.#wsConfig.get(wsId) || null,
            cacheKey: `w:${wsId}`,
        });
    }

    /**
     * Drop cached contexts so the next operation re-reads config. Providers stay
     * pooled — a config change must not tear down a model runtime another
     * workspace is mid-batch on.
     */
    invalidateUser(userId) {
        this.#contexts.delete(`u:${userId}`);
        this.#contexts.delete(userId);
        // Workspaces inherit the user layer, so their resolved configs are stale too.
        for (const wsId of this.workspacesOf(userId)) { this.#contexts.delete(`w:${wsId}`); }
        debug(`config cache invalidated for user ${userId}`);
    }

    /** Adopt a new workspace layer (after workspace.json was written) and reresolve. */
    invalidateWorkspace(wsId, config = undefined) {
        if (config !== undefined) { this.#wsConfig.set(wsId, config); }
        this.#contexts.delete(`w:${wsId}`);
        debug(`config cache invalidated for workspace ${wsId}`);
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
            this.#context(null, [this.#serverConfig], { strict: true });
        } catch (e) {
            this.#serverConfig = previous;
            this.#contexts = previousContexts;
            throw e;
        }
        debug('server default config replaced; all user contexts invalidated');
        return this.#context(null, [this.#serverConfig], { strict: true }).config;
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
        return this.#spaceConfigsFromRouter((await this.contextFor(userId)).router);
    }

    /**
     * Space configs for a workspace, resolvable BEFORE it registers — synapsd
     * latches its vector tables at Db construction, so the workspace has to know
     * its models first. Caches under the workspace key, which registerWorkspace
     * then reuses.
     */
    async spaceConfigsForWorkspace(wsId, { userId = null, config = null } = {}) {
        if (userId) { this.#wsUser.set(wsId, userId); }
        if (config) { this.#wsConfig.set(wsId, config); }
        const ctx = await this.resolve({ userId, workspaceConfig: config, cacheKey: `w:${wsId}` });
        return this.#spaceConfigsFromRouter(ctx.router);
    }

    #spaceConfigsFromRouter(router) {
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
     * @param {{userId?: string, config?: object}} [opts]
     *   userId — the owner, whose stored defaults this workspace inherits.
     *   config — `services.embedd` from workspace.json, the TOP layer.
     */
    registerWorkspace(wsId, adapter, { userId = null, config = null } = {}) {
        if (!wsId || !adapter?.resolveInput || !adapter?.storeVectors) {
            throw new Error('registerWorkspace requires { resolveInput, storeVectors }');
        }
        this.#workspaces.set(wsId, adapter);
        if (userId) { this.#wsUser.set(wsId, userId); }
        if (config) { this.#wsConfig.set(wsId, config); }
        this.#queueFor(wsId);
        debug(`workspace registered: ${wsId}${userId ? ` (owner ${userId})` : ''}`);
    }

    unregisterWorkspace(wsId) {
        this.#queues.get(wsId)?.stop();
        this.#queues.delete(wsId);
        this.#workspaces.delete(wsId);
        this.#wsUser.delete(wsId);
        this.#wsConfig.delete(wsId);
        this.#contexts.delete(`w:${wsId}`);
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
        // The workspace embeds with ITS resolved config (workspace.json on top).
        const ctx = await this.contextForWorkspace(wsId);

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
     * @param {{space?:string, reindex?:boolean, scope?:string}} [opts]
     *   reindex — clear the space first (full re-embed).
     *   scope   — `ctx://path` / `dir://path`; restricts the drain to documents
     *             under that path, so a model change can be tried on one project
     *             before committing the whole workspace to it. NOTE: scope and
     *             reindex together still clear the WHOLE space — clearing part
     *             of a space is not something the ledger can express — so the
     *             out-of-scope documents leave the index until a later
     *             unscoped reconcile refills them.
     * @returns {Promise<{enqueued:number, spaces:Record<string,number>}|{error:string}>}
     */
    async reconcile(wsId, { space = null, reindex = false, scope = null } = {}) {
        if (this.#ingestDisabled) { return { enqueued: 0, spaces: {}, ingestDisabled: true }; }
        const ws = this.#workspaces.get(wsId);
        if (!ws) { return { error: 'workspace not registered' }; }
        if (!ws.getUnembedded) { return { error: 'workspace has no ledger adapter' }; }

        // The gap is defined by the WORKSPACE's spaces — one that switched models
        // has a different set of candidate spaces to drain.
        const router = (await this.contextForWorkspace(wsId)).router;
        // Resolve the scope once — it is the same id set for every space.
        let scopeIds = null;
        if (scope) {
            if (!ws.documentIdsUnderScope) { return { error: 'workspace cannot resolve a scope path' }; }
            const resolved = await ws.documentIdsUnderScope(scope);
            if (resolved === null) { return { error: `unknown scope '${scope}'` }; }
            scopeIds = new Set(resolved);
            if (scopeIds.size === 0) { return { enqueued: 0, spaces: {}, scope, scopedDocs: 0 }; }
        }

        const spaces = space ? [space] : router.spaces;
        const per = {};
        let enqueued = 0;
        for (const sp of spaces) {
            if (reindex && ws.clearSpace) { await ws.clearSpace(sp); }
            const schemas = router.candidateSchemas(sp);
            if (schemas.length === 0) { per[sp] = 0; continue; }
            let ids = [];
            try { ids = await ws.getUnembedded(sp, schemas); } catch (e) { debug(`reconcile ${wsId}/${sp}: ${e.message}`); }
            if (scopeIds) { ids = ids.filter((id) => scopeIds.has(id)); }
            for (const id of ids) { this.enqueue(wsId, id); }
            per[sp] = ids.length;
            enqueued += ids.length;
        }
        debug(`reconcile ${wsId}: enqueued ${enqueued} across ${Object.keys(per).length} space(s)${scope ? ` (scope ${scope})` : ''}`);
        return { enqueued, spaces: per, ...(scope ? { scope, scopedDocs: scopeIds.size } : {}) };
    }

    // ── Query (search side) ───────────────────────────────────────────────────

    /**
     * Embed a query string into a space's vector, for synapsd search. Must use
     * the SAME model that filled the space, so it takes the workspace owner —
     * querying a Qwen-filled table with a bge vector returns noise.
     */
    async embedQuery(text, space = 'text', userId = null) {
        return this.#embedQueryWith(await this.contextFor(userId), text, space);
    }

    /**
     * Query embedding for a specific workspace — the form search actually uses,
     * since a workspace's own config (workspace.json) decides which model filled
     * its tables.
     */
    async embedQueryForWorkspace(wsId, text, space = 'text') {
        return this.#embedQueryWith(await this.contextForWorkspace(wsId), text, space);
    }

    async #embedQueryWith(ctx, text, space) {
        if (typeof text !== 'string' || text.length === 0) { return null; }
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
