'use strict';

/**
 * Messaging — user notification/chat channel service (embedd pattern: nested
 * package, pure-DI constructor, adapter seam, zero env reads — the host owns
 * env→config translation).
 *
 * Outbound (Phase B): notify(userId, message, { channel }) resolves the user's
 * channel binding and delivers via the matching adapter.
 *
 * Inbound (Phase C seam): adapters that support receiving implement
 * start(onMessage)/stop(); onMessage receives
 * { channel, senderId, threadId?, text, media[] }.
 *
 * Adapter contract:
 *   { name, sendText(recipient, text), sendMedia?(recipient, media),
 *     start?(onMessage), stop?() }
 *
 * Bindings store (injected, Conf/jim-like get/set/delete/store):
 *   <userId> -> { channels: { slack: { recipient }, whatsapp: { recipient }, ... },
 *                 defaultChannel }
 */
export class Messaging {
    #adapters = new Map();
    #bindingsStore;
    #logger;
    #onMessage = null;

    /**
     * @param {Object} options
     * @param {Array} [options.adapters]      - adapter instances
     * @param {Object} options.bindingsStore  - initialized index store (get/set)
     * @param {Object} [options.logger]
     */
    constructor(options = {}) {
        if (!options.bindingsStore) throw new Error('bindingsStore is required');
        this.#bindingsStore = options.bindingsStore;
        this.#logger = options.logger || console;

        for (const adapter of options.adapters || []) {
            if (!adapter?.name || typeof adapter.sendText !== 'function') {
                throw new Error('Invalid messaging adapter: requires name + sendText()');
            }
            this.#adapters.set(adapter.name, adapter);
        }
    }

    get channels() { return [...this.#adapters.keys()]; }

    getAdapter(name) { return this.#adapters.get(name) || null; }

    // ── Bindings ────────────────────────────────────────────────────────────

    getBindings(userId) {
        if (!userId) return null;
        return this.#bindingsStore.get(userId) || { channels: {}, defaultChannel: null };
    }

    setBindings(userId, update = {}) {
        if (!userId) throw new Error('userId required');
        const current = this.getBindings(userId);
        const next = {
            channels: { ...current.channels, ...(update.channels || {}) },
            defaultChannel: update.defaultChannel !== undefined
                ? update.defaultChannel
                : current.defaultChannel,
        };
        // null channel entry removes the binding
        for (const [name, value] of Object.entries(next.channels)) {
            if (value === null) delete next.channels[name];
        }
        this.#bindingsStore.set(userId, next);
        return next;
    }

    // ── Outbound ────────────────────────────────────────────────────────────

    /**
     * Deliver a message to a user over a bound channel.
     * @param {string} userId
     * @param {string} message
     * @param {Object} [options]
     * @param {string} [options.channel] - adapter name; defaults to the user's
     *   defaultChannel, then the first bound channel, then console.
     * @returns {Promise<{ channel: string, delivered: boolean, detail?: Object }>}
     */
    async notify(userId, message, options = {}) {
        if (!userId) throw new Error('userId required');
        const text = String(message ?? '').trim();
        if (!text) throw new Error('message required');

        const bindings = this.getBindings(userId);
        const channel = options.channel
            || bindings.defaultChannel
            || Object.keys(bindings.channels)[0]
            || 'console';

        const adapter = this.#adapters.get(channel);
        if (!adapter) throw new Error(`Messaging channel not available: ${channel}`);

        const recipient = bindings.channels[channel]?.recipient || null;
        if (!recipient && channel !== 'console') {
            throw new Error(`No ${channel} recipient bound for user ${userId}`);
        }

        const detail = await adapter.sendText(recipient, text);
        this.#logger.debug?.(`notify: ${channel} -> user ${userId}`);
        return { channel, delivered: true, detail };
    }

    // ── Inbound seam (Phase C) ──────────────────────────────────────────────

    async start(onMessage) {
        this.#onMessage = onMessage || null;
        for (const adapter of this.#adapters.values()) {
            if (typeof adapter.start === 'function' && this.#onMessage) {
                await adapter.start(this.#onMessage);
            }
        }
        return this;
    }

    async stop() {
        for (const adapter of this.#adapters.values()) {
            if (typeof adapter.stop === 'function') {
                await adapter.stop().catch(() => {});
            }
        }
        this.#onMessage = null;
    }

    status() {
        return {
            channels: this.channels,
            inbound: Boolean(this.#onMessage),
        };
    }
}

export default Messaging;
