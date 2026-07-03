'use strict';

/*
 * WhatsApp adapter — Meta Cloud API (plain fetch, official API, no ban risk).
 * recipient = E.164 phone number without '+' (Cloud API "to" format).
 * A Baileys-based variant can implement the same interface later (openclaw
 * lineage) for setups without a Meta business account.
 */
export class WhatsAppAdapter {
    #accessToken;
    #phoneNumberId;
    #apiVersion;
    #onMessage = null;
    #logger;

    constructor({ accessToken, phoneNumberId, apiVersion = 'v19.0', logger = console } = {}) {
        if (!accessToken || !phoneNumberId) {
            throw new Error('WhatsAppAdapter requires accessToken and phoneNumberId');
        }
        this.#accessToken = accessToken;
        this.#phoneNumberId = phoneNumberId;
        this.#apiVersion = apiVersion;
        this.#logger = logger;
    }

    get name() { return 'whatsapp'; }

    async sendText(recipient, text) {
        if (!recipient) throw new Error('WhatsApp recipient (phone number) required');

        const url = `https://graph.facebook.com/${this.#apiVersion}/${this.#phoneNumberId}/messages`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.#accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: String(recipient).replace(/^\+/, ''),
                type: 'text',
                text: { body: text },
            }),
            signal: AbortSignal.timeout(10000),
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
            throw new Error(`WhatsApp send failed: ${payload?.error?.message || `HTTP ${response.status}`}`);
        }
        return { delivered: true, messageId: payload?.messages?.[0]?.id };
    }

    // ── Inbound (Cloud API webhook — fed by the transport route) ───────────

    async start(onMessage) {
        this.#onMessage = onMessage;
    }

    async stop() {
        this.#onMessage = null;
    }

    /**
     * Process a Cloud API webhook POST body. Returns the number of messages
     * dispatched (0 when inbound is not started or the body carries none).
     */
    async handleWebhook(body = {}) {
        if (!this.#onMessage) return 0;

        let dispatched = 0;
        for (const entry of body.entry || []) {
            for (const change of entry.changes || []) {
                for (const message of change.value?.messages || []) {
                    try {
                        await this.#dispatchMessage(message);
                        dispatched += 1;
                    } catch (err) {
                        this.#logger.debug?.(`whatsapp: inbound dispatch failed: ${err.message}`);
                    }
                }
            }
        }
        return dispatched;
    }

    async #dispatchMessage(message) {
        const media = [];
        let text = '';

        if (message.type === 'text') {
            text = message.text?.body || '';
        } else if (message.type === 'image' && message.image?.id) {
            text = message.image.caption || '';
            const downloaded = await this.#downloadMedia(message.image.id, message.image.mime_type);
            if (downloaded) media.push(downloaded);
        } else {
            return; // unsupported message type for now
        }

        await this.#onMessage({
            channel: this.name,
            senderId: message.from,
            replyTo: message.from,
            threadId: null,
            text,
            media,
        });
    }

    async #downloadMedia(mediaId, mimeType) {
        try {
            const headers = { Authorization: `Bearer ${this.#accessToken}` };
            const meta = await fetch(`https://graph.facebook.com/${this.#apiVersion}/${mediaId}`, {
                headers, signal: AbortSignal.timeout(10000),
            }).then((r) => r.json());
            if (!meta?.url) return null;

            const response = await fetch(meta.url, { headers, signal: AbortSignal.timeout(20000) });
            if (!response.ok) return null;
            const buffer = Buffer.from(await response.arrayBuffer());
            return { data: buffer.toString('base64'), mimeType: mimeType || meta.mime_type || 'image/jpeg' };
        } catch (err) {
            this.#logger.debug?.(`whatsapp: media download failed: ${err.message}`);
            return null;
        }
    }
}

export default WhatsAppAdapter;
