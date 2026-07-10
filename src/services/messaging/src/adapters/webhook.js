'use strict';

/*
 * Outbound webhook adapter — POSTs { text } as JSON to a user-bound URL.
 * Compatible with Slack/Teams/Discord/Mattermost incoming webhooks (all
 * accept a JSON body with a `text` field) and any custom receiver.
 *
 * The recipient IS the webhook URL, stored via the normal channel binding:
 *   channels: { webhook: { recipient: 'https://hooks.slack.com/services/…' } }
 *
 * Needs no credentials, so the host registers it unconditionally.
 *
 * Security note (deliberate, self-hosted posture): the URL is user-supplied →
 * outbound SSRF surface. We enforce http(s) only and reject credentials in
 * the URL; private-range blocking is a non-goal — self-hosted users legitimately
 * point webhooks at LAN receivers.
 */
export class WebhookAdapter {
    #logger;
    #timeoutMs;

    constructor({ logger = console, timeoutMs = 10_000 } = {}) {
        this.#logger = logger;
        this.#timeoutMs = timeoutMs;
    }

    get name() { return 'webhook'; }

    async sendText(recipient, text) {
        let url;
        try {
            url = new URL(String(recipient || ''));
        } catch {
            throw new Error('webhook: recipient is not a valid URL');
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            throw new Error(`webhook: unsupported protocol ${url.protocol}`);
        }
        if (url.username || url.password) {
            throw new Error('webhook: credentials in the URL are not allowed');
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: String(text ?? '') }),
                signal: controller.signal,
            });
            if (!res.ok) {
                throw new Error(`webhook: receiver responded ${res.status}`);
            }
            return { delivered: true, status: res.status };
        } catch (error) {
            const message = error.name === 'AbortError' ? `webhook: timed out after ${this.#timeoutMs}ms` : error.message;
            this.#logger.debug?.(`webhook delivery failed: ${message}`);
            throw new Error(message);
        } finally {
            clearTimeout(timer);
        }
    }
}

export default WebhookAdapter;
