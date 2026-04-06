import { CanvasApiError } from './errors.js';

/**
 * Thin wrapper around socket.io-client for the Canvas WebSocket API.
 *
 * - socket.io-client is loaded lazily via dynamic import so that bundlers
 *   can tree-shake it entirely for consumers that never call connect().
 * - Implements a minimal universal EventEmitter for proxying server events.
 *
 * Usage:
 *   const socket = new SocketClient({ baseUrl, getToken });
 *   await socket.connect();
 *   socket.subscribe('workspace:<id>');
 *   socket.on('workspace.documents.inserted', handler);
 *   socket.disconnect();
 */
export class SocketClient {
    /** @type {import('socket.io-client').Socket|null} */
    #socket = null;

    /** @type {Map<string, Set<Function>>} */
    #listeners = new Map();

    /**
     * @param {object} options
     * @param {string} options.baseUrl - Server origin e.g. "http://localhost:8001"
     * @param {() => string|null} options.getToken
     */
    constructor({ baseUrl, getToken }) {
        // Strip path — socket.io connects to the origin
        const url = new URL(baseUrl);
        this.#serverOrigin = `${url.protocol}//${url.host}`;
        this.#getToken = getToken;
    }

    #serverOrigin;
    #getToken;

    get connected() {
        return this.#socket?.connected ?? false;
    }

    // ── Connection ─────────────────────────────────────────────────────────

    /**
     * Connect to the server. Resolves once the socket is connected.
     * Safe to call multiple times — subsequent calls are no-ops if already connected.
     *
     * @returns {Promise<void>}
     */
    async connect() {
        if (this.#socket?.connected) return;

        // Lazy-load socket.io-client so bundlers can exclude it when unused
        const { io } = await import('socket.io-client');

        return new Promise((resolve, reject) => {
            this.#socket = io(this.#serverOrigin, {
                auth: { token: this.#getToken() },
                transports: ['websocket'],
                reconnection: true,
                reconnectionAttempts: 5,
                reconnectionDelay: 1000,
            });

            this.#socket.once('connect', () => {
                this.#reattachListeners();
                resolve();
            });

            this.#socket.once('connect_error', (err) => {
                reject(new CanvasApiError(`WebSocket connection failed: ${err.message}`, 0, null));
            });

            // Proxy all server events through our listeners
            this.#socket.onAny((event, ...args) => {
                this.#emit(event, ...args);
            });
        });
    }

    disconnect() {
        this.#socket?.disconnect();
        this.#socket = null;
    }

    // ── Subscriptions ──────────────────────────────────────────────────────

    /**
     * Subscribe to a server channel (e.g. "workspace:<id>", "context:<id>").
     * Must be connected first.
     *
     * @param {string} channel
     */
    subscribe(channel) {
        this.#assertConnected();
        this.#socket.emit('subscribe', { channel });
    }

    /**
     * @param {string} channel
     */
    unsubscribe(channel) {
        this.#assertConnected();
        this.#socket.emit('unsubscribe', { channel });
    }

    // ── Event listener API (universal, no Node.js EventEmitter) ───────────

    /**
     * @param {string} event
     * @param {Function} handler
     */
    on(event, handler) {
        if (!this.#listeners.has(event)) {
            this.#listeners.set(event, new Set());
        }
        this.#listeners.get(event).add(handler);
    }

    /**
     * @param {string} event
     * @param {Function} handler
     */
    off(event, handler) {
        this.#listeners.get(event)?.delete(handler);
    }

    /**
     * Register a one-time listener.
     *
     * @param {string} event
     * @param {Function} handler
     */
    once(event, handler) {
        const wrapper = (...args) => {
            this.off(event, wrapper);
            handler(...args);
        };
        this.on(event, wrapper);
    }

    // ── Agent-specific helpers ─────────────────────────────────────────────

    /**
     * Subscribe to a specific agent's events.
     * @param {string} agentId
     */
    subscribeAgent(agentId) {
        this.#assertConnected();
        this.#socket.emit('agent:subscribe', { agentId });
    }

    /**
     * @param {string} agentId
     */
    unsubscribeAgent(agentId) {
        this.#assertConnected();
        this.#socket.emit('agent:unsubscribe', { agentId });
    }

    // ── Private ────────────────────────────────────────────────────────────

    #assertConnected() {
        if (!this.#socket?.connected) {
            throw new CanvasApiError('Socket not connected. Call connect() first.', 0, null);
        }
    }

    #emit(event, ...args) {
        this.#listeners.get(event)?.forEach(fn => fn(...args));
    }

    /** Re-register any listeners that were added before connect() was called. */
    #reattachListeners() {
        // Listeners are stored in #listeners; #emit is called via onAny — nothing to re-attach.
    }
}
