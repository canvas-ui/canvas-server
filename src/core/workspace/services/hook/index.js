'use strict';

import EventEmitter from 'eventemitter2';
import fs from 'fs';
import path from 'path';
import { WORKSPACE_DIRECTORIES } from '../../lib/constants.js';
import { pathToFileURL } from 'url';
import { createLogger } from '../../../../utils/log.js';
import { classifyDocument } from '../../lib/classifier.js';
import { resolveRuleFiles, loadRuleFile, matchRule, executeRuleActions } from './rules.js';
import { buildHookAgentPrompt } from './agent-prompt.js';
import { resolveHookFiles, statFile } from './files.js';
import HookRunLog, { buildReplayEnvelope } from './run-log.js';

const logger = createLogger('hook-service');

// Automation cascade ceiling: an event at this depth or beyond is never
// dispatched to hooks/rules, even ones that opted into cascading — the loop
// terminates by construction. Per-workspace override: config `hooks.maxDepth`;
// process-wide override: CANVAS_HOOKS_MAX_DEPTH.
const DEFAULT_MAX_DEPTH = Math.max(1, Number(process.env.CANVAS_HOOKS_MAX_DEPTH) || 2);

// Any origin other than 'user' means the write was produced by automation
// (hook/rule/agent/backfill/replay). Handlers ignore automated events unless
// they opt in (JS: `export const cascade = true`; rule: `"cascade": true`).
const isAutomatedOrigin = (origin) => Boolean(origin) && origin !== 'user';

/**
 * HookService
 *
 * Manages workspace hooks (both system and user-defined).
 * Listens to workspace events and dispatches them to registered hooks.
 */
class HookService extends EventEmitter {
    #workspaceManager;
    #agents = null;
    #messaging = null;
    #hooks = new Map(); // hookId -> hookInstance
    #workspaceListeners = new Map();
    #recentDispatches = new Map();
    #hookModuleCache = new Map(); // hookPath -> { mtimeMs, run, debounce }
    #ruleFileCache = new Map(); // filePath -> { mtimeMs, rules }
    #debounce = new Map(); // key -> { timer, payloads }
    #runLogs = new Map(); // workspaceId -> HookRunLog
    #initialized = false;

    constructor(options = {}) {
        super();
        this.#workspaceManager = options.workspaceManager;
        this.#agents = options.agents || null;

        if (!this.#workspaceManager) {
            throw new Error('WorkspaceManager is required');
        }
    }

    // ── Late-bound service wiring ───────────────────────────────────────────
    // Agents is constructed after HookService, so it is injected once available
    // rather than required up front.

    setAgents(agents) { this.#agents = agents; }
    setMessaging(messaging) { this.#messaging = messaging; }

    async initialize() {
        if (this.#initialized) return this;

        // System hooks have all been moved to seeded, user-editable example
        // hooks under git/hooks. Nothing to register in-process.
        this.#initialized = true;
        logger.debug('HookService initialized');
        return this;
    }

    registerHook(hook) {
        if (!hook || !hook.id) {
            throw new Error('Invalid hook: must have an id');
        }
        this.#hooks.set(hook.id, hook);
        logger.debug(`Registered hook: ${hook.id}`);
    }

    trackWorkspace(workspace) {
        if (!workspace?.id) {
            return;
        }

        const existing = this.#workspaceListeners.get(workspace.id);
        if (existing?.workspace === workspace) { return; }
        if (existing) { this.untrackWorkspace(workspace.id); }

        const hookService = this;
        const listener = async function (payload = {}) {
            const eventName = this.event;
            if (!eventName) { return; }
            if (payload?.source === 'hook') { return; }
            try {
                await hookService.dispatchEvent(eventName, payload, workspace.id);
            } catch (err) {
                logger.debug(`Error dispatching workspace hook event ${eventName}: ${err.message}`);
            }
        };

        workspace.on('**', listener);
        this.#workspaceListeners.set(workspace.id, { workspace, listener });
        this.#sweepStaleWorkDirs(workspace);
    }

    // Detached scripts clean nothing up themselves — lazily drop var/tmp
    // work dirs older than 24h whenever a workspace is (re)tracked.
    #sweepStaleWorkDirs(workspace) {
        if (!workspace.rootPath) { return; }
        const tmpRoot = path.join(workspace.rootPath, WORKSPACE_DIRECTORIES.varTmp);
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        (async () => {
            let handlers;
            try { handlers = await fs.promises.readdir(tmpRoot, { withFileTypes: true }); }
            catch { return; }
            for (const handler of handlers) {
                if (!handler.isDirectory()) { continue; }
                const handlerDir = path.join(tmpRoot, handler.name);
                let runs;
                try { runs = await fs.promises.readdir(handlerDir, { withFileTypes: true }); }
                catch { continue; }
                for (const run of runs) {
                    const runDir = path.join(handlerDir, run.name);
                    try {
                        const stat = await fs.promises.stat(runDir);
                        if (stat.mtimeMs < cutoff) {
                            await fs.promises.rm(runDir, { recursive: true, force: true });
                        }
                    } catch { /* raced or unreadable — skip */ }
                }
            }
        })().catch(() => {});
    }

    untrackWorkspace(workspaceId) {
        const binding = this.#workspaceListeners.get(workspaceId);
        if (!binding) { return; }

        binding.workspace.off('**', binding.listener);
        this.#workspaceListeners.delete(workspaceId);
    }

    /**
     * Dispatch an event to all applicable hooks
     * @param {string} eventName
     * @param {Object} payload
     * @param {string} workspaceId
     */
    async dispatchEvent(eventName, payload, workspaceId) {
        if (payload?.source === 'hook') { return; }
        // putMany's compat emission (singular event name, batch:true, ids only)
        // carries no document — hooks/rules get their per-document dispatch via
        // the .batch fan-out below. Skip it here to avoid a doc-less run PLUS a
        // fanned-out run of the same hooks.
        if ((eventName === 'document.inserted' || eventName === 'document.updated') && payload?.batch === true) { return; }
        if (this.#isDuplicateDispatch(eventName, payload, workspaceId)) { return; }

        logger.debug(`Dispatching event ${eventName} to ${this.#hooks.size} hooks`);

        const workspace = await this.#workspaceManager.getWorkspace(workspaceId);
        if (!workspace) {
            logger.debug(`Workspace ${workspaceId} not available for hook dispatch`);
            return;
        }

        // Cascade ceiling: automation-caused events beyond maxDepth never reach
        // any handler — this is the hard loop terminator (the opt-in `cascade`
        // flag below only governs depth 1..maxDepth-1).
        const depth = Number.isInteger(payload?.depth) ? payload.depth : 0;
        const maxDepth = Number(workspace.config?.hooks?.maxDepth) || DEFAULT_MAX_DEPTH;
        if (depth >= maxDepth) {
            logger.warn(`Hook cascade depth ${depth} >= maxDepth ${maxDepth} — dropping ${eventName} (origin=${payload?.origin}, causedBy=${payload?.causedBy}) in workspace ${workspaceId}`);
            this.runLogFor(workspace)?.append({
                trigger: 'event', event: eventName, eventId: payload?.eventId ?? null,
                origin: payload?.origin ?? 'user', depth, batch: payload?.batch === true,
                handlerType: 'dispatch', handler: '*',
                docIds: HookService.#payloadDocIds(payload),
                durationMs: 0, status: 'skipped', skipReason: `depth ${depth} >= maxDepth ${maxDepth}`,
            });
            return;
        }
        const automated = isAutomatedOrigin(payload?.origin);

        const promises = [];
        for (const hook of this.#hooks.values()) {
            if (this.#shouldRunHook(hook, eventName)) {
                promises.push(this.#runHook(hook, eventName, payload, workspaceId));
            }
        }

        promises.push(this.#runWorkspaceHook(workspace, eventName, payload, automated));
        promises.push(this.#runWorkspaceRules(workspace, eventName, payload, automated));

        // Batch fan-out: batch events additionally re-dispatch as per-document
        // singular events (full document loaded, batch:true stamped), so plain
        // document.inserted hooks and declarative rules work unchanged for
        // batch-ingested documents (imap sync, browser-extension batch sync).
        const singularEvent = HookService.#BATCH_FANOUT[eventName];
        if (singularEvent && Array.isArray(payload?.ids) && payload.ids.length > 0) {
            promises.push(this.#fanOutBatch(workspace, singularEvent, payload, automated));
        }

        await Promise.allSettled(promises);
    }

    static #BATCH_FANOUT = {
        'document.inserted.batch': 'document.inserted',
        'document.updated.batch': 'document.updated',
    };

    static #payloadDocIds(payload = {}) {
        if (Array.isArray(payload.ids)) { return payload.ids; }
        const id = payload.id ?? payload.documentId ?? payload.document?.id;
        return id != null ? [id] : [];
    }

    // Run one specific handler (a rule by id or a JS hook file) against a
    // synthesized/replayed envelope, bypassing dispatchEvent (no dedup, no
    // cascade gating on the way IN — the caller controls the envelope; writes
    // the handler makes are still provenance-stamped and cascade-guarded on
    // the way OUT). Backing for the backfill and replay endpoints.
    //
    // @param {Object} target - { ruleId } | { hookFile } (path rel. hooks root)
    // @returns {{ status: 'ok'|'error'|'skipped', actions? }}
    async runTargeted(workspace, target, eventName, payload, { trigger = 'backfill' } = {}) {
        const runLog = this.runLogFor(workspace);

        if (target?.ruleId) {
            const rule = this.findRule(workspace, target.ruleId);
            if (!rule) { throw new Error(`Rule "${target.ruleId}" not found`); }

            const classification = classifyDocument(payload?.document, payload);
            if (!matchRule(rule, eventName, classification)) {
                runLog?.append({
                    ...this.#baseRecord(eventName, payload, trigger),
                    handlerType: 'rule', handler: rule.id || '?',
                    durationMs: 0, status: 'skipped', skipReason: 'matcher did not match',
                });
                return { status: 'skipped' };
            }

            const context = this.#buildHookContext(workspace, eventName, payload, 'rule');
            const t0 = Date.now();
            const actions = await executeRuleActions(rule, context, logger);
            const status = actions.some((a) => a.status === 'error') ? 'error' : 'ok';
            runLog?.append({
                ...this.#baseRecord(eventName, payload, trigger),
                handlerType: 'rule', handler: rule.id || '?',
                durationMs: Date.now() - t0, status, actions,
                replayEnvelope: buildReplayEnvelope(eventName, payload),
            });
            return { status, actions };
        }

        if (target?.hookFile) {
            const hooksRoot = path.resolve(workspace.hooksPath || path.join(workspace.rootPath, 'hooks'));
            const hookPath = path.resolve(hooksRoot, String(target.hookFile));
            if (hookPath !== hooksRoot && !hookPath.startsWith(`${hooksRoot}${path.sep}`)) {
                throw new Error('Hook path escapes the hooks root');
            }
            const loaded = await this.#loadHookRun(hookPath);
            if (!loaded) { throw new Error(`Hook "${target.hookFile}" not found`); }

            const context = this.#buildHookContext(workspace, eventName, payload);
            await this.#invokeHook(loaded.run, context, hookPath, { workspace, eventName, payload, trigger });
            // #invokeHook records ok/error itself; read nothing back — errors
            // are swallowed by design, the run log is the outcome surface.
            return { status: 'ok' };
        }

        throw new Error('runTargeted: target must be { ruleId } or { hookFile }');
    }

    // Locate one rule by id across rules.json + rules/*.json (enabled files).
    findRule(workspace, ruleId) {
        const hooksRoot = workspace.hooksPath || path.join(workspace.rootPath, 'hooks');
        for (const filePath of resolveRuleFiles(hooksRoot)) {
            for (const rule of loadRuleFile(filePath, this.#ruleFileCache, logger)) {
                if (rule.id === ruleId) { return rule; }
            }
        }
        return null;
    }

    // Lazy per-workspace run log (JSONL under {root}/var/hooks). Public so the
    // REST layer (runs/replay endpoints) reads through the same instance —
    // sharing the size cache used for rotation.
    runLogFor(workspace) {
        if (!workspace?.id || !workspace.rootPath) { return null; }
        let log = this.#runLogs.get(workspace.id);
        if (!log) {
            log = new HookRunLog(workspace.rootPath);
            this.#runLogs.set(workspace.id, log);
        }
        return log;
    }

    // Shared record skeleton for one handler execution.
    #baseRecord(eventName, payload, trigger = 'event') {
        return {
            trigger,
            event: eventName,
            eventId: payload?.eventId ?? null,
            origin: payload?.origin ?? 'user',
            depth: Number.isInteger(payload?.depth) ? payload.depth : 0,
            batch: payload?.batch === true,
            docIds: HookService.#payloadDocIds(payload),
        };
    }

    // Load each batched document and run the workspace's singular hooks/rules
    // for it, sequentially — a 50-message imap batch must not spawn 50
    // concurrent hook chains (agents, scripts).
    async #fanOutBatch(workspace, eventName, batchPayload, automated = false) {
        for (const id of batchPayload.ids) {
            let document = null;
            try { document = await workspace.get(id); }
            catch (err) { logger.debug(`Batch fan-out: failed to load doc ${id}: ${err.message}`); }
            if (!document) { continue; }

            const payload = {
                id,
                document,
                context: batchPayload.context ?? null,
                directory: batchPayload.directory ?? null,
                batch: true,
                batchCount: batchPayload.count ?? batchPayload.ids.length,
                ...(batchPayload.workspaceId ? { workspaceId: batchPayload.workspaceId } : {}),
                ...(batchPayload.source ? { source: batchPayload.source } : {}),
                // Provenance rides through the fan-out unchanged: the per-doc
                // dispatch is the same event, not a new automation step.
                ...(batchPayload.eventId ? { eventId: batchPayload.eventId } : {}),
                ...(batchPayload.origin ? { origin: batchPayload.origin } : {}),
                ...(batchPayload.causedBy ? { causedBy: batchPayload.causedBy } : {}),
                ...(Number.isInteger(batchPayload.depth) ? { depth: batchPayload.depth } : {}),
            };
            await Promise.allSettled([
                this.#runWorkspaceHook(workspace, eventName, payload, automated),
                this.#runWorkspaceRules(workspace, eventName, payload, automated),
            ]);
        }
    }

    #shouldRunHook(hook, eventName) {
        // Simple filter: if hook has 'events' array, check if eventName is in it
        // If no 'events' array, assume it wants all events (or let it filter internally)
        if (hook.events && Array.isArray(hook.events)) {
            return hook.events.includes(eventName) || hook.events.includes('*');
        }
        return true;
    }

    async #runHook(hook, eventName, payload, workspaceId) {
        try {
            logger.debug(`Running hook ${hook.id} for event ${eventName}`);
            await hook.run(eventName, payload, workspaceId);
        } catch (err) {
            logger.debug(`Error running hook ${hook.id}: ${err.message}`);
        }
    }

    async #runWorkspaceHook(workspace, eventName, payload, automated = false) {
        const hooksRoot = workspace.hooksPath || path.join(workspace.rootPath, 'hooks');
        const hookFiles = resolveHookFiles(hooksRoot, eventName);
        if (hookFiles.length === 0) { return; }

        await Promise.allSettled(
            hookFiles.map((hookPath) => this.#dispatchHookFile(hookPath, workspace, eventName, payload, automated))
        );
    }

    // Declarative rules: rules.json + rules/*.json evaluated against the
    // event's classified document. Runs alongside JS hooks with no precedence;
    // every matching rule fires (no first-match-wins).
    async #runWorkspaceRules(workspace, eventName, payload, automated = false) {
        const hooksRoot = workspace.hooksPath || path.join(workspace.rootPath, 'hooks');
        const ruleFiles = resolveRuleFiles(hooksRoot);
        if (ruleFiles.length === 0) { return; }

        const classification = classifyDocument(payload?.document, payload);
        let context = null;

        const runLog = this.runLogFor(workspace);
        for (const filePath of ruleFiles) {
            for (const rule of loadRuleFile(filePath, this.#ruleFileCache, logger)) {
                if (!matchRule(rule, eventName, classification)) { continue; }
                // Cascade gate AFTER matching so the run log only records
                // skips for rules that would actually have fired.
                if (automated && rule.cascade !== true) {
                    logger.debug(`Rule ${rule.id || '?'} skipped: automated event (origin=${payload?.origin}) and rule has no cascade:true`);
                    runLog?.append({
                        ...this.#baseRecord(eventName, payload),
                        handlerType: 'rule', handler: rule.id || '?',
                        durationMs: 0, status: 'skipped',
                        skipReason: `automated origin '${payload?.origin}' and no cascade:true`,
                    });
                    continue;
                }
                context = context || this.#buildHookContext(workspace, eventName, payload, 'rule');
                logger.debug(`Rule ${rule.id || '?'} matched ${eventName} in workspace ${workspace.id}`);
                const t0 = Date.now();
                const actions = await executeRuleActions(rule, context, logger);
                runLog?.append({
                    ...this.#baseRecord(eventName, payload),
                    handlerType: 'rule', handler: rule.id || '?',
                    durationMs: Date.now() - t0,
                    status: actions.some((a) => a.status === 'error') ? 'error' : 'ok',
                    actions,
                    replayEnvelope: buildReplayEnvelope(eventName, payload),
                });
            }
        }
    }

    // Resolve a hook's exported function (and its optional `debounce` window)
    // from cache, keyed on mtime so an edited hook is hot-reloaded but an
    // unchanged hook is compiled once (re-importing on every event also leaks a
    // module into the ESM registry per call).
    async #loadHookRun(hookPath) {
        const stat = statFile(hookPath);
        if (!stat) { return null; }

        let cached = this.#hookModuleCache.get(hookPath);
        if (!cached || cached.mtimeMs !== stat.mtimeMs) {
            const moduleUrl = `${pathToFileURL(hookPath).href}?mtime=${stat.mtimeMs}`;
            const hookModule = await import(moduleUrl);
            const run = hookModule.default || hookModule.run;
            if (typeof run !== 'function') {
                throw new Error(`Hook "${hookPath}" does not export a function`);
            }
            const debounce = Number(hookModule.debounce) > 0 ? Number(hookModule.debounce) : 0;
            // `export const cascade = true` opts the hook into automation-caused
            // events (origin hook/rule/agent/...), bounded by the maxDepth stop.
            const cascade = hookModule.cascade === true;
            cached = { mtimeMs: stat.mtimeMs, run, debounce, cascade };
            this.#hookModuleCache.set(hookPath, cached);
        }
        return cached;
    }

    // Handler name as recorded/reported: path relative to the hooks root.
    #hookName(workspace, hookPath) {
        const hooksRoot = workspace.hooksPath || path.join(workspace.rootPath, 'hooks');
        return path.relative(hooksRoot, hookPath) || hookPath;
    }

    async #dispatchHookFile(hookPath, workspace, eventName, payload, automated = false) {
        let loaded;
        try {
            loaded = await this.#loadHookRun(hookPath);
        } catch (err) {
            logger.warn(`Error loading workspace hook ${hookPath}: ${err.message}`);
            this.runLogFor(workspace)?.append({
                ...this.#baseRecord(eventName, payload),
                handlerType: 'hook', handler: this.#hookName(workspace, hookPath),
                durationMs: 0, status: 'error', error: `load failed: ${err.message}`,
            });
            return;
        }
        if (!loaded) { return; }

        if (automated && !loaded.cascade) {
            logger.debug(`Hook ${hookPath} skipped: automated event (origin=${payload?.origin}) and no \`export const cascade = true\``);
            this.runLogFor(workspace)?.append({
                ...this.#baseRecord(eventName, payload),
                handlerType: 'hook', handler: this.#hookName(workspace, hookPath),
                durationMs: 0, status: 'skipped',
                skipReason: `automated origin '${payload?.origin}' and no cascade export`,
            });
            return;
        }

        if (loaded.debounce > 0) {
            this.#scheduleDebounced(hookPath, workspace, eventName, payload, loaded);
            return;
        }

        const context = this.#buildHookContext(workspace, eventName, payload);
        await this.#invokeHook(loaded.run, context, hookPath, { workspace, eventName, payload });
    }

    // Coalesce a burst of events (e.g. N singleton inserts the app didn't batch)
    // into a single run carrying every payload in `context.payloads`, so an
    // agent()-driven categorizer fires once per burst, not once per document.
    #scheduleDebounced(hookPath, workspace, eventName, payload, loaded) {
        const key = `${workspace.id}::${eventName}::${hookPath}`;
        let entry = this.#debounce.get(key);
        if (!entry) { entry = { payloads: [] }; this.#debounce.set(key, entry); }
        entry.payloads.push(payload);

        if (entry.timer) { clearTimeout(entry.timer); }
        entry.timer = setTimeout(() => {
            this.#debounce.delete(key);
            const payloads = entry.payloads;
            const lastPayload = payloads[payloads.length - 1];
            const context = this.#buildHookContext(workspace, eventName, lastPayload);
            context.payloads = payloads;
            context.event.payloads = payloads;
            this.#invokeHook(loaded.run, context, hookPath, {
                workspace, eventName, payload: lastPayload, debouncedCount: payloads.length,
            });
        }, loaded.debounce);
        if (entry.timer.unref) { entry.timer.unref(); }
    }

    async #invokeHook(run, context, hookPath, meta = null) {
        const t0 = Date.now();
        let error = null;
        try {
            await run(context);
        } catch (err) {
            error = err;
            logger.warn(`Error running workspace hook ${hookPath}: ${err.message}`);
        }
        if (meta?.workspace) {
            this.runLogFor(meta.workspace)?.append({
                ...this.#baseRecord(meta.eventName, meta.payload, meta.trigger || 'event'),
                handlerType: 'hook', handler: this.#hookName(meta.workspace, hookPath),
                ...(meta.debouncedCount ? { debouncedCount: meta.debouncedCount } : {}),
                durationMs: Date.now() - t0,
                status: error ? 'error' : 'ok',
                ...(error ? { error: error.message } : {}),
                replayEnvelope: buildReplayEnvelope(meta.eventName, meta.payload),
            });
        }
    }

    #buildHookContext(workspace, eventName, payload, origin = 'hook') {
        const event = {
            name: eventName,
            workspaceId: workspace.id,
            payload,
            timestamp: new Date().toISOString(),
        };

        // Every write made from this context is an automation step caused by
        // the triggering event: stamp origin + causedBy + depth+1 so the
        // resulting events are recognizable (and cascade-guarded) downstream.
        // An explicit `provenance` in the caller's options wins.
        const childProvenance = {
            origin,
            causedBy: payload?.eventId ?? null,
            depth: (Number.isInteger(payload?.depth) ? payload.depth : 0) + 1,
        };
        const withProvenance = (options = {}) => ({ provenance: childProvenance, ...options });

        const db = workspace.isActive ? workspace.db : null;
        const tree = workspace.isActive ? workspace.getDefaultContextTree() : null;
        const emit = async (name, nextPayload = {}) => {
            workspace.emit(name, {
                ...(nextPayload && typeof nextPayload === 'object' ? nextPayload : { value: nextPayload }),
                workspaceId: workspace.id,
                source: 'hook',
                ...childProvenance,
            });
        };
        const put = async (document, options = {}) => workspace.put(document, withProvenance(options));

        return {
            event,
            payload,
            payloads: [payload], // debounced runs replace this with the coalesced burst
            eventName,
            workspace,
            db,
            tree,
            logger,
            emit,
            insert: put,
            update: async (id, document, options = {}) => workspace.put({ ...document, id }, withProvenance(options)),
            // unlink takes (id, selector, options) — provenance rides in the
            // options arg (spread into db.unlink), not the selector.
            remove: async (id, options = {}) => workspace.unlink(id, options, { provenance: childProvenance }),
            deleteDocument: async (id) => workspace.delete(id, { provenance: childProvenance }),
            // Destroy = delete bytes on every deletable location (stored://
            // blob, workspace file, imap EXPUNGE; read-only locations degrade
            // to a reference drop), then purge the doc from the index.
            destroy: async (idOrDoc) => {
                const doc = typeof idOrDoc === 'object' && idOrDoc !== null ? idOrDoc : await workspace.get(idOrDoc);
                if (!doc?.id) { return null; }
                const res = await workspace.destroyDocument(doc);
                if (!res?.docDeleted) { await workspace.delete(doc.id, { provenance: childProvenance }).catch(() => {}); }
                return res;
            },
            get: async (id, options = { parse: true }) => workspace.get(id, options),
            list: async (spec = {}) => workspace.list(spec),
            find: async (spec = {}) => workspace.search(spec),
            // Hook-fired agent prompts get a standard envelope (event, doc
            // summary, reply expectations) so small agents know what hit them.
            // Opt out with agent(slug, prompt, { raw: true }).
            agent: (slugOrId, prompt, options = {}) => {
                const { raw, ...rest } = options;
                const finalPrompt = raw ? prompt : buildHookAgentPrompt({
                    workspaceName: workspace.name || workspace.id,
                    eventName,
                    payload,
                    prompt,
                });
                return this.#buildAgentHelper(workspace)(slugOrId, finalPrompt, rest);
            },
            notify: this.#buildNotifyHelper(workspace),
            // classify() → the event's document; classify(otherPayload) for a
            // debounced burst element; classify(rawDoc) for a fetched document.
            classify: (target = payload) => {
                if (target?.document) { return classifyDocument(target.document, target); }
                if (target?.schema) { return classifyDocument(target, null); }
                return classifyDocument(null, target);
            },
            link: async (documentId, contexts = []) => {
                const targets = Array.isArray(contexts) ? contexts : [contexts];
                for (const context of targets.filter(Boolean)) {
                    await workspace.link(documentId, { context, emitEvent: true, provenance: childProvenance });
                }
            },
        };
    }

    // Pure-function agent call: start the agent if needed, prompt it, return text.
    // Returns null (and logs) instead of throwing so a hook keeps running.
    #buildAgentHelper(workspace) {
        return async (slugOrId, prompt, options = {}) => {
            if (!this.#agents) {
                logger.debug('Hook agent() called but no agents service is wired');
                return null;
            }
            try {
                return await this.#agents.prompt(workspace.owner, slugOrId, prompt, options);
            } catch (err) {
                logger.debug(`Hook agent(${slugOrId}) failed: ${err.message}`);
                return null;
            }
        };
    }

    // Deliver a message to the workspace owner over a bound channel
    // (Slack/WhatsApp/console). Returns null instead of throwing so a hook
    // keeps running when no channel is configured.
    #buildNotifyHelper(workspace) {
        return async (message, options = {}) => {
            if (!this.#messaging) {
                logger.debug('Hook notify() called but no messaging service is wired');
                return null;
            }
            try {
                return await this.#messaging.notify(workspace.owner, message, options);
            } catch (err) {
                logger.debug(`Hook notify() failed: ${err.message}`);
                return null;
            }
        };
    }

    #isDuplicateDispatch(eventName, payload = {}, workspaceId) {
        const key = this.#buildDispatchKey(eventName, payload, workspaceId);
        if (!key) { return false; }
        const now = Date.now();
        for (const [entryKey, timestamp] of this.#recentDispatches) {
            if (now - timestamp > 1000) {
                this.#recentDispatches.delete(entryKey);
            }
        }
        if (this.#recentDispatches.has(key)) {
            logger.debug(`Skipping duplicate hook event ${eventName} for workspace ${workspaceId}`);
            return true;
        }
        this.#recentDispatches.set(key, now);
        return false;
    }

    #buildDispatchKey(eventName, payload = {}, workspaceId) {
        // eventId is unique per emit — the precise dedup key (two rapid but
        // distinct updates of the same doc no longer falsely dedup). The
        // id-based key remains for payloads that predate the envelope field.
        if (payload.eventId) { return `${workspaceId}:${eventName}:${payload.eventId}`; }
        const ids = payload.ids || payload.documentIds || payload.id || payload.documentId || payload.document?.id || '';
        const normalizedIds = Array.isArray(ids) ? ids.join(',') : String(ids || '');
        if (!normalizedIds) { return null; }
        return `${workspaceId}:${eventName}:${normalizedIds}:${payload.source || ''}`;
    }
}

export default HookService;
