'use strict';

/**
 * In-app ("canvas") notification adapter.
 *
 * Delivers notify() messages to the user's connected web/desktop clients over
 * the websocket bridge (event: 'notification') and keeps a small per-user
 * ring buffer so the UI notifications area can show recent items on load.
 *
 * The broadcast function (fastify.broadcastToUser) only exists after the
 * transport layer boots, while Messaging is constructed before it — hence the
 * late `setBroadcast()` binding. Until it is set (or when the user has no
 * open connection), messages still land in the buffer.
 *
 * recipient == the canvas user id (no channel binding needed; Messaging
 * falls back to the userId for this adapter).
 */

const BUFFER_LIMIT = 50;

export class CanvasAdapter {
    name = 'canvas';

    #broadcast = null; // (userId, event, payload) => sentCount
    #buffers = new Map(); // userId -> [{ id, text, timestamp }]
    #logger;
    #seq = 0;

    constructor({ logger = console } = {}) {
        this.#logger = logger;
    }

    setBroadcast(fn) {
        this.#broadcast = typeof fn === 'function' ? fn : null;
    }

    async sendText(recipient, text) {
        const userId = String(recipient || '');
        if (!userId) { throw new Error('canvas adapter requires a user id recipient'); }

        const notification = {
            id: `ntf-${Date.now()}-${++this.#seq}`,
            text: String(text ?? ''),
            timestamp: new Date().toISOString(),
        };

        const buffer = this.#buffers.get(userId) || [];
        buffer.push(notification);
        if (buffer.length > BUFFER_LIMIT) { buffer.splice(0, buffer.length - BUFFER_LIMIT); }
        this.#buffers.set(userId, buffer);

        let sent = 0;
        if (this.#broadcast) {
            try { sent = this.#broadcast(userId, 'notification', notification) || 0; }
            catch (err) { this.#logger.warn?.(`canvas adapter broadcast failed: ${err.message}`); }
        }
        return { delivered: true, connections: sent, id: notification.id };
    }

    /** Recent notifications for a user (newest last). */
    list(userId) {
        return [...(this.#buffers.get(String(userId || '')) || [])];
    }

    clear(userId) {
        this.#buffers.delete(String(userId || ''));
    }
}

export default CanvasAdapter;
