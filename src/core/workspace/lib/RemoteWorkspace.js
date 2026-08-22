'use strict';

import EventEmitter from 'eventemitter2';
import { Agent, fetch } from 'undici';
import { guardedLookup } from '../../../utils/ssrf-guard.js';
import { WORKSPACE_ORIGINS, WORKSPACE_STATUS_CODES } from './constants.js';
import { workspaceNotReady } from './errors.js';

// How long a probe result is trusted before a listing re-asks the remote.
const PROBE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_500;

/**
 * A workspace that lives on ANOTHER canvas-server, registered in this user's
 * index as `name@host` (origin: remote). It exposes the small in-process
 * surface the manager, ACL middleware and listings rely on (id/name/owner/
 * status/toJSON/start/stop) and a REST client; everything under
 * /rest/v2/workspaces/:id/* is streamed to the remote by the forwarder
 * (transports/middleware/remote-proxy.js), so the remote's own routes — not a
 * re-implementation of Workspace — answer document, tree, search, blob … calls.
 *
 * Status mirrors the remote workspace's status ('active', 'inactive', …);
 * `offline` means the remote server could not be reached.
 */
export default class RemoteWorkspace extends EventEmitter {
    #entry;
    #credentials;
    #logger;
    #dispatcher;
    #status = WORKSPACE_STATUS_CODES.OFFLINE;
    #statusMessage = null;
    #remoteInfo = null;   // last toJSON() the remote returned for the workspace
    #probedAt = 0;
    #probing = null;

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
        // private/loopback remotes (CANVAS_WORKSPACE_ALLOW_INSECURE_REMOTE_IMPORT).
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
    get isActive() { return this.#status === WORKSPACE_STATUS_CODES.ACTIVE; }
    get isOnline() { return this.#status !== WORKSPACE_STATUS_CODES.OFFLINE; }
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

    /** JSON helper: returns the ResponseObject payload or throws a coded error. */
    async api(suffix = '', init = {}) {
        let res;
        try {
            res = await this.fetch(suffix, {
                ...init,
                headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) },
                body: init.body && typeof init.body !== 'string' ? JSON.stringify(init.body) : init.body,
            });
        } catch (err) {
            this.#setStatus(WORKSPACE_STATUS_CODES.OFFLINE, err.cause?.message || err.message);
            throw workspaceNotReady(`Remote workspace ${this.name} unreachable: ${err.cause?.message || err.message}`);
        }
        const body = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error(body?.message || `Remote error ${res.status}`);
            err.statusCode = res.status;
            err.code = 'REMOTE_ERROR';
            throw err;
        }
        return body?.payload;
    }

    /**
     * Ask the remote for the workspace record and mirror its status. Coalesces
     * concurrent callers and, unless forced, trusts a result for PROBE_TTL_MS
     * so listings don't hammer the remote.
     */
    async probe({ force = false, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
        if (!force && Date.now() - this.#probedAt < PROBE_TTL_MS) return this.#status;
        if (this.#probing) return this.#probing;
        this.#probing = (async () => {
            try {
                const res = await this.fetch('', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
                const body = await res.json().catch(() => null);
                if (!res.ok) {
                    this.#setStatus(WORKSPACE_STATUS_CODES.ERROR, body?.message || `Remote answered ${res.status}`);
                } else {
                    const remoteWs = body?.payload?.workspace || null;
                    this.#remoteInfo = remoteWs;
                    this.#setStatus(remoteWs?.status || WORKSPACE_STATUS_CODES.INACTIVE, null);
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

    async start() {
        await this.api('/start', { method: 'POST' });
        return this.probe({ force: true });
    }

    async stop() {
        await this.api('/stop', { method: 'POST' });
        return this.probe({ force: true });
    }

    /** No-op: nothing runs locally for a remote workspace. */
    async shutdown() { return true; }

    #setStatus(status, message) {
        const changed = status !== this.#status;
        this.#status = status;
        this.#statusMessage = message;
        if (changed) this.emit('workspace.status.changed', { workspaceId: this.id, status, message });
    }

    toJSON() {
        const { remote: _remote, ...local } = this.#entry;
        const info = this.#remoteInfo || {};
        // The remote's own presentation (color, description, icon, trees,
        // services …) comes through; local identity and bookkeeping win.
        return {
            ...info,
            ...local,
            label: this.label,
            origin: WORKSPACE_ORIGINS.REMOTE,
            isRemote: true,
            remote: this.remote,
            status: this.#status,
            statusMessage: this.#statusMessage,
            isActive: this.isActive,
            lastProbedAt: this.lastProbedAt,
            rootPath: null,
            ...(info.documentCount != null ? { documentCount: info.documentCount } : {}),
            ...(info.bitmapCount != null ? { bitmapCount: info.bitmapCount } : {}),
        };
    }
}
