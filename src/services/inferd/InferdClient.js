'use strict';

import net from 'node:net';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { RpcPeer } from './rpc-peer.js';
import { createLogger } from '../../utils/log.js';

const defaultLogger = createLogger('inferd-client');

/**
 * InferdClient — canvas-server's handle on the inference daemon.
 *
 * Mirrors the method surface canvas-server used to call on an in-process
 * `Inferd` instance, so call sites read the same; the difference is that every
 * call now crosses a unix socket into a process that owns the models. Nothing
 * about ONNX, transformers.js or model caches exists on this side any more.
 *
 * The socket is symmetric. The daemon calls back for the things only the server
 * has — a document's bytes, the place vectors are stored, per-user config — via
 * the adapter handed to `registerWorkspace`. That adapter stays here; only its
 * results travel.
 *
 * Inference is optional (it always was: `services.inferd.enabled`). When the
 * daemon is unreachable, calls reject with a clear message rather than the
 * server failing to boot — search degrades to keyword, ingestion stops
 * embedding, everything else works.
 */
export class InferdClient extends EventEmitter {
    #socketPath;
    #logger;
    #peer = null;
    #socket = null;
    #child = null;
    #connecting = null;
    #stopped = false;
    #spawnCommand;
    #spawnArgs;
    #reconnectDelay = 250;

    // Workspace adapters live here — the daemon holds only their names.
    #adapters = new Map();
    // Registration intent, replayed after a reconnect so a daemon restart does
    // not silently leave every workspace unembedded.
    #registrations = new Map();
    #resolveUserConfig;

    constructor({ socketPath, logger, resolveUserConfig = null, spawn: spawnOptions = null } = {}) {
        super();
        if (!socketPath) { throw new Error('InferdClient requires a socketPath'); }
        this.#socketPath = socketPath;
        this.#logger = logger || defaultLogger;
        this.#resolveUserConfig = resolveUserConfig;
        this.#spawnCommand = spawnOptions?.command || null;
        this.#spawnArgs = spawnOptions?.args || [];
    }

    get socketPath() { return this.#socketPath; }
    get connected() { return Boolean(this.#peer) && !this.#peer.closed; }

    // ── Connection ───────────────────────────────────────────────────────────

    async start() {
        if (this.#spawnCommand) { await this.#spawnDaemon(); }
        await this.#connect();
        return this;
    }

    async #spawnDaemon() {
        // Dev convenience: one command still brings the whole stack up. In
        // production the daemon is its own unit and this is left unset.
        this.#child = spawn(this.#spawnCommand, ['--socket', this.#socketPath, ...this.#spawnArgs], {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
        });
        this.#child.stdout.on('data', (d) => this.#logger.debug(`inferd: ${d.toString().trim()}`));
        this.#child.stderr.on('data', (d) => this.#logger.warn(`inferd: ${d.toString().trim()}`));
        this.#child.on('exit', (code, signal) => {
            this.#child = null;
            if (!this.#stopped) {
                this.#logger.warn({ code, signal }, 'inferd daemon exited; inference is unavailable until it returns');
            }
        });
        this.#child.on('error', (error) => {
            this.#child = null;
            this.#logger.warn({ error: error.message }, `could not spawn "${this.#spawnCommand}"`);
        });
    }

    #connect() {
        if (this.#connecting) { return this.#connecting; }
        this.#connecting = new Promise((resolve, reject) => {
            // The daemon may still be binding its socket when we get here.
            const deadline = Date.now() + 15_000;
            const attempt = () => {
                if (this.#stopped) { resolve(null); return; }
                const socket = net.connect(this.#socketPath);
                socket.once('connect', () => {
                    socket.setNoDelay(true);
                    this.#socket = socket;
                    this.#peer = new RpcPeer(socket, { label: 'inferd-client' });
                    this.#peer.handleAll(this.#callbacks());
                    this.#peer.on('close', () => this.#onDisconnect());
                    this.#peer.on('error', (error) => this.#logger.debug(`inferd peer: ${error.message}`));
                    this.#reconnectDelay = 250;
                    this.#connecting = null;
                    this.#logger.info({ socketPath: this.#socketPath }, 'connected to inferd daemon');
                    this.#replayRegistrations();
                    this.emit('connected');
                    resolve(this);
                });
                socket.once('error', (error) => {
                    socket.destroy();
                    if (Date.now() > deadline) {
                        this.#connecting = null;
                        reject(new Error(`inferd daemon unreachable at ${this.#socketPath}: ${error.message}`));
                        return;
                    }
                    setTimeout(attempt, 200);
                });
            };
            attempt();
        });
        return this.#connecting;
    }

    #onDisconnect() {
        this.#peer = null;
        this.#socket = null;
        this.emit('disconnected');
        if (this.#stopped) { return; }
        // Back off, but keep trying: a daemon restart should heal on its own.
        const delay = this.#reconnectDelay;
        this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 30_000);
        setTimeout(() => {
            if (this.#stopped) { return; }
            this.#connect().catch((error) => this.#logger.debug(`inferd reconnect: ${error.message}`));
        }, delay);
    }

    // A daemon that restarted has no memory of our workspaces; re-register them
    // or nothing would ever embed again until the server itself restarted.
    #replayRegistrations() {
        for (const [wsId, opts] of this.#registrations) {
            this.#peer.call('inferd.registerWorkspace', [wsId, opts])
                .catch((error) => this.#logger.warn({ wsId, error: error.message }, 'inferd re-registration failed'));
        }
    }

    /** Methods the daemon calls on us — the half of the seam only we can serve. */
    #callbacks() {
        const adapter = (wsId) => {
            const found = this.#adapters.get(wsId);
            if (!found) { throw new Error(`inferd: workspace ${wsId} is not registered here`); }
            return found;
        };
        return {
            'server.resolveUserConfig': (userId) =>
                (this.#resolveUserConfig ? this.#resolveUserConfig(userId) : null),
            'ws.resolveInput': (wsId, docId) => adapter(wsId).resolveInput(docId),
            'ws.storeVectors': (wsId, docId, schema, updatedAt, chunks, opts) =>
                adapter(wsId).storeVectors(docId, schema, updatedAt, chunks, opts),
            'ws.getUnembedded': (wsId, space, schemas) => adapter(wsId).getUnembedded(space, schemas),
            'ws.documentIdsUnderScope': (wsId, scope) => adapter(wsId).documentIdsUnderScope(scope),
            'ws.clearSpace': (wsId, space) => adapter(wsId).clearSpace(space),
            'ws.onQueueDrained': (wsId) => adapter(wsId).onQueueDrained(),
            'ws.imageDocumentIds': (wsId) => adapter(wsId).imageDocumentIds(),
            'ws.setSummary': (wsId, docId, text) => adapter(wsId).setSummary(docId, text),
        };
    }

    #call(method, params = []) {
        if (!this.#peer || this.#peer.closed) {
            // Not a fault — a service that is down and will come back. Coded so
            // the transport answers 503 retryable rather than a 500 that reads
            // like the server broke.
            const error = new Error('Inference service is not available (inferd daemon not connected)');
            error.code = 'EINFERDDOWN';
            error.statusCode = 503;
            return Promise.reject(error);
        }
        return this.#peer.call(method, params);
    }

    // Fire-and-forget callers (event handlers, teardown) must not turn a
    // disconnected daemon into an unhandled rejection that kills the process.
    #tell(method, params = []) {
        const promise = this.#call(method, params);
        promise.catch((error) => this.#logger.debug(`inferd ${method}: ${error.message}`));
        return promise;
    }

    // ── The Inferd surface ───────────────────────────────────────────────────

    registerWorkspace(wsId, adapter, opts = {}) {
        this.#adapters.set(wsId, adapter);
        this.#registrations.set(wsId, opts);
        return this.#tell('inferd.registerWorkspace', [wsId, opts]);
    }

    unregisterWorkspace(wsId) {
        this.#adapters.delete(wsId);
        this.#registrations.delete(wsId);
        return this.#tell('inferd.unregisterWorkspace', [wsId]);
    }

    enqueueMany(wsId, docIds) { return this.#tell('inferd.enqueueMany', [wsId, docIds]); }
    reconcile(wsId, opts = {}) { return this.#call('inferd.reconcile', [wsId, opts]); }
    drained(wsId = null) { return this.#call('inferd.drained', [wsId]); }
    pause(wsId = null) { return this.#tell('inferd.pause', [wsId]); }
    resume(wsId = null) { return this.#tell('inferd.resume', [wsId]); }

    embedQueryForWorkspace(wsId, text, space = 'text') {
        return this.#call('inferd.embedQueryForWorkspace', [wsId, text, space]);
    }
    embedImageQuery(wsId, bytes, contentType = null, space = 'image') {
        return this.#call('inferd.embedImageQuery', [wsId, bytes, contentType, space]);
    }
    describeImage(wsId, bytes, opts = {}) { return this.#call('inferd.describeImage', [wsId, bytes, opts]); }
    startImageSummaries(wsId, opts = {}) { return this.#call('inferd.startImageSummaries', [wsId, opts]); }
    stopImageSummaries(wsId) { return this.#call('inferd.stopImageSummaries', [wsId]); }
    imageSummaryStatus(wsId) { return this.#call('inferd.imageSummaryStatus', [wsId]); }
    resetDescribeWorkers(wsId) { return this.#call('inferd.resetDescribeWorkers', [wsId]); }

    contextForWorkspace(wsId) { return this.#call('inferd.contextForWorkspace', [wsId]); }
    spaceConfigsForWorkspace(wsId, opts = {}) { return this.#call('inferd.spaceConfigsForWorkspace', [wsId, opts]); }
    invalidateWorkspace(wsId, config) { return this.#tell('inferd.invalidateWorkspace', [wsId, config]); }
    invalidateUser(userId) { return this.#tell('inferd.invalidateUser', [userId]); }
    validate(config, opts = {}) { return this.#call('inferd.validate', [config, opts]); }
    serverConfig() { return this.#call('inferd.serverConfig', []); }
    setServerConfig(config) { return this.#call('inferd.setServerConfig', [config]); }
    status() { return this.#call('inferd.status', []); }
    workspaceStatus(wsId) { return this.#call('inferd.workspaceStatus', [wsId]); }

    // Config helpers the API routes need. They used to be imported straight out
    // of canvas-inferd; routing them over the socket is what lets canvas-server
    // drop the dependency (and its native tree) altogether.
    redactConfig(config) { return this.#call('inferd.redactConfig', [config]); }
    checkConfigEndpoints(config) { return this.#call('inferd.checkConfigEndpoints', [config]); }
    checkEndpoint(url, opts = {}) { return this.#call('inferd.checkEndpoint', [url, opts]); }
    endpointFor(spec) { return this.#call('inferd.endpointFor', [spec]); }

    async stop() {
        this.#stopped = true;
        if (this.#peer) { this.#peer.destroy(); this.#peer = null; }
        if (this.#socket) { try { this.#socket.destroy(); } catch { /* gone */ } this.#socket = null; }
        // Only kill a daemon we started; a shared one outlives us.
        if (this.#child) {
            this.#child.kill('SIGTERM');
            this.#child = null;
        }
    }
}

export default InferdClient;
