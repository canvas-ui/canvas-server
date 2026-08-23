'use strict';

import EventEmitter from 'eventemitter2';
import { Agent, fetch } from 'undici';
import { io } from 'socket.io-client';
import { guardedLookup } from '../../../utils/ssrf-guard.js';
import { WORKSPACE_ORIGINS, WORKSPACE_STATUS_CODES } from './constants.js';
import { workspaceNotReady } from './errors.js';
import RemoteTree from './RemoteTree.js';

// How long a probe result is trusted before a listing re-asks the remote.
const PROBE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_500;
// Tree JSON re-reads after a burst of tree.* events are coalesced.
const TREE_REFRESH_DEBOUNCE_MS = 150;

const CONTEXT_TREE_NAME = 'context';
const DIRECTORY_TREE_NAME = 'directory';

// socket.io housekeeping events that are not workspace events.
const SOCKET_INTERNAL_EVENTS = new Set([
    'connect', 'disconnect', 'connect_error', 'authenticated', 'subscribed', 'unsubscribed', 'error', 'pong', 'ping',
]);

/**
 * A workspace that lives on ANOTHER canvas-server, registered in this user's
 * index as `name@host` (origin: remote).
 *
 * Two layers of "as if local":
 *  - REST: everything under /rest/v2/workspaces/:id/* is streamed to the
 *    remote by transports/middleware/remote-proxy.js — the remote's routes
 *    answer, nothing is re-implemented.
 *  - In-process: the subset of the Workspace surface that contexts (and other
 *    server-side consumers) use — documents (list, search, has, get, put,
 *    putMany, linkMany, unlink(Many), deleteMany, *ByChecksumString), trees
 *    (getTree, getContextTree, … — each
 *    backed by a RemoteTree) and lifecycle — implemented over the remote's REST
 *    API with the share token. A context therefore binds to a remote workspace
 *    exactly like to a local one: same class, same tree, same query spec.
 *
 * Live updates: one socket.io connection per remote workspace subscribes to
 * `workspace:<remote id>` with the share token and re-emits every event here
 * with `workspaceId` rewritten to the local entry id, so the manager, the
 * websocket fan-out, context forwarding and tree refreshes all work unchanged.
 *
 * Status mirrors the remote workspace ('active', 'inactive', …); `offline`
 * means the remote server could not be reached.
 */
export default class RemoteWorkspace extends EventEmitter {
    #entry;
    #credentials;
    #logger;
    #dispatcher;
    #status = WORKSPACE_STATUS_CODES.OFFLINE;
    #statusMessage = null;
    #remoteInfo = null;   // last record the remote returned for the workspace
    #probedAt = 0;
    #probing = null;

    #trees = new Map();   // tree id → RemoteTree
    #treesByName = new Map();
    #treesLoaded = false;
    #treesLoading = null;
    #treeRefreshTimer = null;

    #socket = null;
    #socketEverConnected = false;
    #disposed = false;

    constructor({ entry, credentials, allowInsecure = false, logger = console } = {}) {
        super({ wildcard: true, delimiter: '.', newListener: false, maxListeners: 100 });
        if (!entry?.id || !entry.remote?.url || !entry.remote?.workspaceId) {
            throw new Error('RemoteWorkspace needs an index entry with remote.url and remote.workspaceId');
        }
        if (!credentials?.token) throw new Error('RemoteWorkspace needs credentials (share token)');
        this.#entry = entry;
        this.#credentials = credentials;
        this.#logger = logger;
        // One agent per remote: connect timeout so an unreachable host fails
        // fast, no body timeout so large content downloads are never cut.
        // The SSRF lookup guard stays on unless the operator opted into
        // private/loopback remotes (CANVAS_ALLOW_INSECURE_REMOTE_IMPORT).
        this.#dispatcher = new Agent({
            connect: { timeout: 5_000, ...(allowInsecure ? {} : { lookup: guardedLookup }) },
            headersTimeout: 60_000,
            bodyTimeout: 0,
        });
    }

    // ── identity (index entry is authoritative for the local side) ─────────

    get id() { return this.#entry.id; }
    /** Local address: `<remote name>@<host>` — what URLs and the UI use. */
    get name() { return this.#entry.name; }
    get label() { return this.#entry.label || this.#remoteInfo?.label || this.#entry.remote.workspaceName; }
    get owner() { return this.#entry.owner; }
    get host() { return this.#entry.host; }
    get type() { return this.#entry.type || 'workspace'; }
    get origin() { return WORKSPACE_ORIGINS.REMOTE; }
    get isRemote() { return true; }
    get rootPath() { return null; }
    get configDir() { return null; }
    get stats() { return null; }
    get entry() { return this.#entry; }
    get config() { return { ...this.#remoteInfo, ...this.localIdentity() }; }
    /** Credentials-free remote descriptor (safe to surface in listings). */
    get remote() {
        const { url, workspaceId, workspaceName, permissions = [], addedAt = null } = this.#entry.remote;
        return { url, workspaceId, workspaceName, permissions, addedAt };
    }
    /** The share token — never enumerable, never in toJSON(). */
    get token() { return this.#credentials.token; }
    get dispatcher() { return this.#dispatcher; }
    get permissions() { return this.#entry.remote.permissions || []; }
    get canWrite() { return this.permissions.includes('write'); }

    get status() { return this.#status; }
    get statusMessage() { return this.#statusMessage; }
    /** Active = the remote says so AND the in-process surface is ready (trees loaded). */
    get isActive() { return this.#status === WORKSPACE_STATUS_CODES.ACTIVE && this.#treesLoaded; }
    get isOnline() { return this.#status !== WORKSPACE_STATUS_CODES.OFFLINE; }
    get isLive() { return this.#socket?.connected === true; }
    get lastProbedAt() { return this.#probedAt ? new Date(this.#probedAt).toISOString() : null; }

    // ── REST client ────────────────────────────────────────────────────────

    /** `/rest/v2/workspaces/<remote id><suffix>` on the remote server. */
    remotePath(suffix = '') {
        return `/rest/v2/workspaces/${encodeURIComponent(this.#entry.remote.workspaceId)}${suffix}`;
    }

    remoteUrl(suffix = '') {
        return `${this.#entry.remote.url}${this.remotePath(suffix)}`;
    }

    /** Raw fetch against the remote workspace, authenticated with the share token. */
    async fetch(suffix = '', init = {}) {
        const headers = { ...(init.headers || {}), authorization: `Bearer ${this.token}` };
        // undici's own fetch: Node's bundled fetch rejects an Agent from the
        // npm undici package as dispatcher ("invalid onRequestStart method").
        return fetch(this.remoteUrl(suffix), { ...init, headers, dispatcher: this.#dispatcher });
    }

    /**
     * JSON helper: returns the ResponseObject payload, or throws a coded error
     * (`statusCode`, `code: 'REMOTE_ERROR'`; WORKSPACE_NOT_READY when the
     * remote is unreachable). Pass `{ notFoundAsNull: true }` to map 404 → null.
     */
    async api(suffix = '', init = {}) {
        const { notFoundAsNull = false, raw = false, ...fetchInit } = init;
        let res;
        try {
            res = await this.fetch(suffix, {
                ...fetchInit,
                headers: {
                    accept: 'application/json',
                    ...(fetchInit.body != null ? { 'content-type': 'application/json' } : {}),
                    ...(fetchInit.headers || {}),
                },
                body: fetchInit.body != null && typeof fetchInit.body !== 'string' ? JSON.stringify(fetchInit.body) : fetchInit.body,
            });
        } catch (err) {
            this.#setStatus(WORKSPACE_STATUS_CODES.OFFLINE, err.cause?.message || err.message);
            throw workspaceNotReady(`Remote workspace ${this.name} unreachable: ${err.cause?.message || err.message}`);
        }
        const body = await res.json().catch(() => null);
        if (res.status === 404 && notFoundAsNull) return null;
        if (!res.ok) {
            const err = new Error(body?.message || `Remote error ${res.status}`);
            err.statusCode = res.status;
            err.code = res.status === 403 ? 'ACCESS_DENIED' : 'REMOTE_ERROR';
            err.remote = true;
            throw err;
        }
        return raw ? body : body?.payload;
    }

    /**
     * Ask the remote for the workspace record and mirror its status. Coalesces
     * concurrent callers and, unless forced, trusts a result for PROBE_TTL_MS
     * so listings don't hammer the remote. Also brings the live socket up.
     */
    async probe({ force = false, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
        this.#connectSocket();
        if (!force && Date.now() - this.#probedAt < PROBE_TTL_MS) return this.#status;
        if (this.#probing) return this.#probing;
        this.#probing = (async () => {
            try {
                const res = await this.fetch('', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
                const body = await res.json().catch(() => null);
                if (!res.ok) {
                    this.#setStatus(WORKSPACE_STATUS_CODES.ERROR, body?.message || `Remote answered ${res.status}`);
                } else {
                    this.observe(body?.payload?.workspace || null);
                }
            } catch (err) {
                const reason = err.cause?.message || err.message;
                this.#logger.debug?.(`Remote workspace ${this.name} probe failed: ${reason}`);
                this.#setStatus(WORKSPACE_STATUS_CODES.OFFLINE, reason);
            } finally {
                this.#probedAt = Date.now();
                this.#probing = null;
            }
            return this.#status;
        })();
        return this.#probing;
    }

    /**
     * The forwarder just relayed the remote's own workspace record — as good
     * as a probe, so listings reflect it without another round-trip.
     */
    observe(record) {
        if (!record || typeof record !== 'object') return;
        this.#remoteInfo = record;
        this.#setStatus(record.status || WORKSPACE_STATUS_CODES.INACTIVE, null);
        this.#probedAt = Date.now();
    }

    /** Identity + local presentation only — what must win over the remote's record. */
    localIdentity() {
        const { remote: _remote, ...entry } = this.#entry;
        const presentation = {};
        for (const key of ['label', 'color', 'icon', 'order', 'description']) {
            if (entry[key] != null) presentation[key] = entry[key];
        }
        return {
            ...presentation,
            id: this.id,
            name: this.name,
            owner: this.owner,
            host: this.host,
            origin: WORKSPACE_ORIGINS.REMOTE,
            isRemote: true,
            remote: this.remote,
            rootPath: null,
            configPath: null,
        };
    }

    /** Called by the forwarder when a proxied request fails at transport level. */
    markOffline(message) {
        this.#setStatus(WORKSPACE_STATUS_CODES.OFFLINE, message || null);
        this.#probedAt = Date.now();
    }

    /** Called by the forwarder after any successful round-trip — the remote is up. */
    markOnline() {
        if (this.#status === WORKSPACE_STATUS_CODES.OFFLINE) {
            // We know it answers; the exact workspace status needs a probe.
            this.#probedAt = 0;
        }
    }

    // ── lifecycle ──────────────────────────────────────────────────────────

    /**
     * Make the in-process surface usable: the remote workspace must be
     * running (started here if the token allows, otherwise the owner has to),
     * its trees are loaded and the live socket is up. Idempotent.
     */
    async start() {
        if (this.#disposed) throw new Error('Remote workspace has been disposed');
        await this.probe({ force: true });
        if (this.#status === WORKSPACE_STATUS_CODES.OFFLINE) {
            throw workspaceNotReady(`Remote workspace ${this.name} unreachable: ${this.#statusMessage || 'offline'}`);
        }
        if (this.#status !== WORKSPACE_STATUS_CODES.ACTIVE) {
            try {
                await this.api('/start', { method: 'POST' });
            } catch (err) {
                if (err?.statusCode === 403) {
                    throw workspaceNotReady(`Remote workspace ${this.name} is stopped and this share token cannot start it — ask its owner`);
                }
                throw err;
            }
            await this.probe({ force: true });
            if (this.#status !== WORKSPACE_STATUS_CODES.ACTIVE) {
                throw workspaceNotReady(`Remote workspace ${this.name} did not start (${this.#status})`);
            }
        }
        await this.#loadTrees();
        this.emit('started', { workspaceId: this.id });
        return this;
    }

    /** Stop the workspace ON THE REMOTE (needs admin on the share token). */
    async stop() {
        await this.api('/stop', { method: 'POST' });
        return this.probe({ force: true });
    }

    /** Tear down local resources (socket, cached trees). The remote is untouched. */
    dispose() {
        this.#disposed = true;
        if (this.#treeRefreshTimer) { clearTimeout(this.#treeRefreshTimer); this.#treeRefreshTimer = null; }
        if (this.#socket) {
            try { this.#socket.removeAllListeners(); this.#socket.disconnect(); } catch { /* already gone */ }
            this.#socket = null;
        }
        this.#trees.clear();
        this.#treesByName.clear();
        this.#treesLoaded = false;
        this.removeAllListeners();
        return true;
    }

    /** No-op for server shutdown parity with Workspace; dispose() frees the socket. */
    async shutdown() { this.dispose(); return true; }

    // ── trees ──────────────────────────────────────────────────────────────

    async #loadTrees() {
        if (this.#treesLoading) return this.#treesLoading;
        this.#treesLoading = (async () => {
            const list = await this.api('/trees');
            const seen = new Set();
            for (const meta of Array.isArray(list) ? list : []) {
                if (!meta?.id) continue;
                seen.add(meta.id);
                let tree = this.#trees.get(meta.id);
                if (tree) tree.updateMeta(meta);
                else {
                    tree = new RemoteTree(this, meta);
                    this.#trees.set(meta.id, tree);
                }
            }
            for (const id of [...this.#trees.keys()]) {
                if (!seen.has(id)) this.#trees.delete(id);
            }
            this.#treesByName.clear();
            for (const tree of this.#trees.values()) this.#treesByName.set(tree.name, tree);
            await Promise.all([...this.#trees.values()].map((tree) => tree.refresh()));
            this.#treesLoaded = true;
        })().finally(() => { this.#treesLoading = null; });
        return this.#treesLoading;
    }

    /** Re-read tree JSON after tree.* events; bursts coalesce into one read. */
    #scheduleTreeRefresh() {
        if (!this.#treesLoaded || this.#treeRefreshTimer) return;
        this.#treeRefreshTimer = setTimeout(() => {
            this.#treeRefreshTimer = null;
            this.#loadTrees().catch((err) => this.#logger.debug?.(`Remote workspace ${this.name} tree refresh failed: ${err.message}`));
        }, TREE_REFRESH_DEBOUNCE_MS);
        this.#treeRefreshTimer.unref?.();
    }

    #requireTrees() {
        if (!this.#treesLoaded) {
            throw workspaceNotReady(`Remote workspace ${this.name} is not started (trees not loaded)`);
        }
    }

    getTree(nameOrId) {
        this.#requireTrees();
        const tree = nameOrId
            ? (this.#trees.get(nameOrId) || this.#treesByName.get(nameOrId))
            : this.#treesByName.get(CONTEXT_TREE_NAME);
        if (!tree) throw new Error(`Tree not found: ${nameOrId}`);
        return tree;
    }

    getContextTree(nameOrId = null) {
        const tree = this.getTree(nameOrId || CONTEXT_TREE_NAME);
        if (tree.type !== 'context') throw new Error(`Tree is not a context tree: ${nameOrId}`);
        return tree;
    }

    getDirectoryTree(nameOrId = null) {
        const tree = this.getTree(nameOrId || DIRECTORY_TREE_NAME);
        if (tree.type !== 'directory') throw new Error(`Tree is not a directory tree: ${nameOrId}`);
        return tree;
    }

    getDefaultContextTree() { return this.getContextTree(); }
    getDefaultDirectoryTree() { return this.getDirectoryTree(); }

    async listTrees(type = null) {
        if (!this.#treesLoaded) await this.#loadTrees();
        const out = [...this.#trees.values()].map((tree) => tree.toJSON());
        return type ? out.filter((tree) => tree.type === type) : out;
    }

    getContextTreeSelector(path = '/', treeNameOrId = null) {
        return { tree: treeNameOrId || CONTEXT_TREE_NAME, path: path || '/' };
    }

    getDirectoryTreeSelector(path = '/', treeNameOrId = null) {
        return { tree: treeNameOrId || DIRECTORY_TREE_NAME, path: path || '/' };
    }

    // ── documents (same spec the local Workspace takes, over REST) ─────────

    /**
     * Translate an in-process query spec ({ context | directory, features |
     * attributes, filters, limit … }) into the /documents query string. A
     * missing selector means "whole workspace", which the route spells
     * `scope=workspace`.
     */
    #querySpecToParams(spec = {}) {
        const params = new URLSearchParams();
        const ctx = RemoteWorkspace.#selector(spec.context);
        const dir = RemoteWorkspace.#selector(spec.directory);
        if (!ctx && !dir) {
            params.set('scope', 'workspace');
        } else if (ctx) {
            params.set('treeType', 'context');
            if (ctx.tree) params.set('treeNameOrTreeId', String(ctx.tree));
            params.set('context', ctx.path || '/');
        } else {
            params.set('treeType', 'directory');
            if (dir.tree) params.set('treeNameOrTreeId', String(dir.tree));
            params.set('context', dir.path || '/');
        }
        const attrs = RemoteWorkspace.#attributes(spec.features ?? spec.attributes);
        for (const key of ['allOf', 'anyOf', 'noneOf']) {
            for (const value of attrs[key] || []) params.append(key, value);
        }
        for (const filter of Array.isArray(spec.filters) ? spec.filters : []) params.append('filters', filter);
        for (const id of Array.isArray(spec.ids) ? spec.ids : []) params.append('ids', String(id));
        for (const key of ['limit', 'offset', 'page', 'order', 'sortBy', 'mode', 'minDistance', 'maxDistance']) {
            if (spec[key] != null) params.set(key, String(spec[key]));
        }
        if (spec.idsOnly) params.set('idsOnly', 'true');
        if (spec.applyCanvasQuerySpec === false) params.set('applyCanvasSpec', 'false');
        const query = spec.query ?? spec.search ?? spec.q;
        if (typeof query === 'string' && query.trim()) params.set('q', query);
        return params;
    }

    static #selector(value) {
        if (value == null) return null;
        if (typeof value === 'string' || Array.isArray(value)) return { tree: null, path: Array.isArray(value) ? `/${value.filter(Boolean).join('/')}` : value };
        if (typeof value === 'object') return { tree: value.tree ?? value.treeId ?? null, path: value.path ?? '/' };
        return null;
    }

    static #attributes(value) {
        if (!value) return {};
        if (Array.isArray(value)) return value.length ? { allOf: value } : {};
        if (typeof value === 'object') return value;
        return {};
    }

    async #listVia(params) {
        const body = await this.api(`/documents?${params.toString()}`, { raw: true });
        const rows = Array.isArray(body?.payload) ? body.payload : [];
        rows.count = body?.count ?? rows.length;
        rows.totalCount = body?.totalCount ?? rows.count;
        if (body?.debug) rows.debug = body.debug;
        return rows;
    }

    async list(spec = {}) {
        return this.#listVia(this.#querySpecToParams(spec));
    }

    async search(spec = {}) {
        return this.#listVia(this.#querySpecToParams(spec));
    }

    async get(id) {
        return this.api(`/documents/${encodeURIComponent(id)}`, { notFoundAsNull: true });
    }

    async has(id, scope = {}) {
        const rows = await this.list({ ...scope, ids: [Number(id)], idsOnly: true, limit: 1 });
        return rows.some((row) => Number(row?.id ?? row) === Number(id));
    }

    async getByChecksumString(checksumString) {
        return this.api(`/documents/by-hash/${checksumString}`, { notFoundAsNull: true });
    }

    async hasByChecksumString(checksumString, scope = {}) {
        const params = this.#querySpecToParams(scope);
        params.delete('scope');
        const doc = await this.api(`/documents/by-hash/${checksumString}?${params.toString()}`, { notFoundAsNull: true });
        return doc != null;
    }

    #insertBody(records, scope = {}) {
        const ctx = RemoteWorkspace.#selector(scope.context);
        const dir = RemoteWorkspace.#selector(scope.directory);
        const body = { ...records, features: Array.isArray(scope.features) ? scope.features : [] };
        const target = ctx || dir;
        if (target) {
            body.context = target.path || '/';
            if (target.tree) body.treeNameOrTreeId = String(target.tree);
            if (dir && !ctx) body.treeType = 'directory';
        }
        return body;
    }

    async put(record, scope = {}) {
        const result = await this.putMany([record], scope);
        return Array.isArray(result) ? (result[0] ?? result) : (result?.successful?.[0]?.id ?? result?.successful?.[0] ?? result);
    }

    async putMany(records, scope = {}) {
        const docs = Array.isArray(records) ? records : [records];
        return this.api('/documents', { method: 'POST', body: this.#insertBody({ documents: docs }, scope) });
    }

    async linkMany(ids, scope = {}) {
        const list = (Array.isArray(ids) ? ids : [ids]).map(Number);
        return this.api('/documents', { method: 'POST', body: this.#insertBody({ documentIds: list }, scope) });
    }

    async unlinkMany(ids, scope = {}, options = {}) {
        const list = (Array.isArray(ids) ? ids : [ids]).map(Number);
        const params = this.#querySpecToParams(scope);
        params.delete('scope');
        if (options.trashIfOrphaned) params.set('trashIfOrphaned', 'true');
        return this.api(`/documents/remove?${params.toString()}`, { method: 'DELETE', body: { documentIds: list } });
    }

    async unlink(id, scope = {}, options = {}) {
        return this.unlinkMany([id], scope, options);
    }

    async deleteMany(ids) {
        const list = (Array.isArray(ids) ? ids : [ids]).map(Number);
        return this.api('/documents', { method: 'DELETE', body: { documentIds: list } });
    }

    async delete(id) { return this.deleteMany([id]); }

    // ── live updates ───────────────────────────────────────────────────────

    #connectSocket() {
        if (this.#socket || this.#disposed) return;
        let socket;
        try {
            socket = io(this.#entry.remote.url, {
                auth: { token: this.token },
                transports: ['websocket'],
                reconnection: true,
                reconnectionDelay: 1_000,
                reconnectionDelayMax: 30_000,
                timeout: 10_000,
            });
        } catch (err) {
            this.#logger.debug?.(`Remote workspace ${this.name}: socket setup failed: ${err.message}`);
            return;
        }
        this.#socket = socket;
        const channel = `workspace:${this.#entry.remote.workspaceId}`;

        socket.on('connect', () => {
            socket.emit('subscribe', { channel });
            const reconnected = this.#socketEverConnected;
            this.#socketEverConnected = true;
            this.#probedAt = 0;
            this.probe({ force: true }).catch(() => null);
            if (reconnected) {
                // Events during the gap are gone: tell consumers to re-read.
                if (this.#treesLoaded) this.#scheduleTreeRefresh();
                this.emit('workspace.resynced', { workspaceId: this.id, reason: 'socket-reconnected' });
            }
        });
        socket.on('disconnect', (reason) => {
            if (this.#disposed) return;
            this.#setStatus(WORKSPACE_STATUS_CODES.OFFLINE, `live connection lost (${reason})`);
            this.#probedAt = Date.now();
        });
        socket.on('connect_error', (err) => {
            this.#logger.debug?.(`Remote workspace ${this.name}: socket connect error: ${err.message}`);
        });
        socket.onAny((event, payload) => this.#relay(event, payload));
    }

    #relay(event, payload) {
        if (this.#disposed || typeof event !== 'string' || SOCKET_INTERNAL_EVENTS.has(event)) return;
        const remoteId = this.#entry.remote.workspaceId;
        const out = payload && typeof payload === 'object' ? { ...payload } : { value: payload };
        // Events are addressed by workspace: the remote's id must become ours
        // so every downstream filter (socket subscriptions, hooks, contexts)
        // recognises them; the original stays for anyone who needs provenance.
        if (out.workspaceId === undefined || out.workspaceId === remoteId) out.workspaceId = this.id;
        if (out.workspaceName === undefined || out.workspaceName === this.#entry.remote.workspaceName) out.workspaceName = this.name;
        out.remoteWorkspaceId = remoteId;
        out.source = out.source || 'remote';

        if (event.startsWith('tree.')) this.#scheduleTreeRefresh();
        if (event === 'workspace.status.changed' || event === 'status.changed') {
            if (out.status) this.#setStatus(out.status, null);
        } else if (event === 'started') {
            this.#setStatus(WORKSPACE_STATUS_CODES.ACTIVE, null);
        } else if (event === 'stopped') {
            this.#setStatus(WORKSPACE_STATUS_CODES.INACTIVE, null);
        }
        this.emit(event, out);
    }

    #setStatus(status, message) {
        const changed = status !== this.#status;
        this.#status = status;
        this.#statusMessage = message;
        if (changed) this.emit('workspace.status.changed', { workspaceId: this.id, status, message, source: 'remote-facade' });
    }

    toJSON() {
        const info = this.#remoteInfo || {};
        // The remote's own presentation (color, description, icon, trees,
        // services …) comes through; local identity and bookkeeping win.
        return {
            ...info,
            ...this.localIdentity(),
            label: this.label,
            status: this.#status,
            statusMessage: this.#statusMessage,
            isActive: this.isActive,
            isLive: this.isLive,
            lastProbedAt: this.lastProbedAt,
            ...(info.documentCount != null ? { documentCount: info.documentCount } : {}),
            ...(info.bitmapCount != null ? { bitmapCount: info.bitmapCount } : {}),
        };
    }
}
