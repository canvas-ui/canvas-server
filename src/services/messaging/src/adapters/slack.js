'use strict';

/*
 * Slack adapter — outbound via chat.postMessage, inbound via Socket Mode
 * (plain fetch + global WebSocket, no SDK).
 *
 * Outbound recipient = Slack channel or user id (D.../U.../C...).
 * Inbound requires an app-level token (xapp-*) with connections:write and the
 * app subscribed to message.im events.
 */
export class SlackAdapter {
    #botToken;
    #appToken;
    #onMessage = null;
    #ws = null;
    #stopped = true;
    #logger;

    constructor({ botToken, appToken = null, logger = console } = {}) {
        if (!botToken) throw new Error('SlackAdapter requires botToken');
        this.#botToken = botToken;
        this.#appToken = appToken;
        this.#logger = logger;
    }

    get name() { return 'slack'; }

    async sendText(recipient, text) {
        if (!recipient) throw new Error('Slack recipient (channel/user id) required');

        const response = await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.#botToken}`,
                'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({ channel: recipient, text }),
            signal: AbortSignal.timeout(10000),
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) {
            throw new Error(`Slack send failed: ${payload?.error || `HTTP ${response.status}`}`);
        }
        return { delivered: true, ts: payload.ts, channel: payload.channel };
    }

    // ── Inbound (Socket Mode) ───────────────────────────────────────────────

    async start(onMessage) {
        if (!this.#appToken) {
            this.#logger.debug?.('slack: no app token, inbound disabled (outbound only)');
            return;
        }
        if (typeof WebSocket === 'undefined') {
            this.#logger.warn?.('slack: global WebSocket unavailable, inbound disabled');
            return;
        }
        this.#onMessage = onMessage;
        this.#stopped = false;
        await this.#connect();
    }

    async stop() {
        this.#stopped = true;
        this.#onMessage = null;
        try { this.#ws?.close(); } catch { /* already closed */ }
        this.#ws = null;
    }

    async #connect() {
        if (this.#stopped) return;
        try {
            const response = await fetch('https://slack.com/api/apps.connections.open', {
                method: 'POST',
                headers: { Authorization: `Bearer ${this.#appToken}` },
                signal: AbortSignal.timeout(10000),
            });
            const payload = await response.json();
            if (!payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);

            const ws = new WebSocket(payload.url);
            this.#ws = ws;

            ws.addEventListener('message', (event) => {
                this.#handleEnvelope(ws, event.data).catch((err) => {
                    this.#logger.debug?.(`slack: envelope handling failed: ${err.message}`);
                });
            });
            ws.addEventListener('close', () => this.#scheduleReconnect());
            ws.addEventListener('error', () => { try { ws.close(); } catch { /* noop */ } });
            this.#logger.debug?.('slack: socket mode connected');
        } catch (err) {
            this.#logger.warn?.(`slack: socket mode connect failed: ${err.message}`);
            this.#scheduleReconnect();
        }
    }

    #scheduleReconnect() {
        if (this.#stopped) return;
        setTimeout(() => this.#connect(), 3000);
    }

    async #handleEnvelope(ws, raw) {
        let envelope;
        try { envelope = JSON.parse(raw); } catch { return; }

        // Ack immediately — Slack redelivers otherwise.
        if (envelope.envelope_id) {
            ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        }

        if (envelope.type === 'disconnect') {
            try { ws.close(); } catch { /* triggers reconnect */ }
            return;
        }
        if (envelope.type !== 'events_api') return;

        const event = envelope.payload?.event;
        if (!event || event.type !== 'message') return;
        // Ignore our own / other bot traffic and message edits.
        if (event.bot_id || event.subtype) return;
        if (!this.#onMessage) return;

        const media = await this.#downloadFiles(event.files || []);
        await this.#onMessage({
            channel: this.name,
            senderId: event.user,
            replyTo: event.channel,
            threadId: event.thread_ts || null,
            text: event.text || '',
            media,
        });
    }

    async #downloadFiles(files) {
        const media = [];
        for (const file of files.slice(0, 4)) {
            if (!file?.url_private || !String(file.mimetype || '').startsWith('image/')) continue;
            try {
                const response = await fetch(file.url_private, {
                    headers: { Authorization: `Bearer ${this.#botToken}` },
                    signal: AbortSignal.timeout(15000),
                });
                if (!response.ok) continue;
                const buffer = Buffer.from(await response.arrayBuffer());
                media.push({ data: buffer.toString('base64'), mimeType: file.mimetype });
            } catch (err) {
                this.#logger.debug?.(`slack: file download failed: ${err.message}`);
            }
        }
        return media;
    }
}

export default SlackAdapter;
