'use strict';

import crypto from 'crypto';

/*
 * ChatRouter — inbound message → agent → reply.
 *
 * Identity is claimed, never trusted: the server issues a short-lived link
 * code (POST /rest/v2/messaging/bindings/link-code), the user DMs it to the
 * bot, and only then is the channel peer bound to {userId, agentId}. The same
 * claim also records the outbound recipient so notify() works immediately.
 *
 * Store layout (shared bindings index):
 *   <userId>                     -> { channels, defaultChannel }   (Messaging)
 *   peer:<channel>:<senderId>    -> { userId, agentId, replyTo }
 *   code:<code>                  -> { userId, agentId, channel, expiresAt }
 *
 * Inbound message envelope (from adapters):
 *   { channel, senderId, replyTo?, text, media?: [{ data, mimeType }] }
 */

const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const LINK_RE = /^\s*link\s+([a-z0-9-]{4,32})\s*$/i;

export class ChatRouter {
    #store;
    #messaging;
    #promptAgent;
    #logger;

    /**
     * @param {Object} options
     * @param {Object} options.store        - bindings index store (get/set/delete)
     * @param {Object} options.messaging    - Messaging instance (for replies + bindings)
     * @param {Function} options.promptAgent - (userId, agentId, text, options) => Promise<string>
     * @param {Object} [options.logger]
     */
    constructor(options = {}) {
        if (!options.store) throw new Error('store is required');
        if (!options.messaging) throw new Error('messaging is required');
        if (typeof options.promptAgent !== 'function') throw new Error('promptAgent is required');
        this.#store = options.store;
        this.#messaging = options.messaging;
        this.#promptAgent = options.promptAgent;
        this.#logger = options.logger || console;
    }

    /**
     * Issue a link code binding a channel peer to {userId, agentId} on claim.
     */
    createLinkCode(userId, { channel, agentId } = {}) {
        if (!userId || !channel || !agentId) throw new Error('userId, channel and agentId required');
        const code = crypto.randomBytes(4).toString('hex');
        const entry = {
            userId,
            agentId,
            channel,
            expiresAt: new Date(Date.now() + LINK_CODE_TTL_MS).toISOString(),
        };
        this.#store.set(`code:${code}`, entry);
        return { code, ...entry };
    }

    getPeerBinding(channel, senderId) {
        return this.#store.get(`peer:${channel}:${senderId}`) || null;
    }

    /**
     * Handle an inbound adapter message. Always resolves (errors are logged
     * and reported to the peer), so adapter loops never crash.
     */
    async handle(message = {}) {
        const { channel, senderId, text = '' } = message;
        const replyTo = message.replyTo || senderId;
        if (!channel || !senderId) return;

        const reply = (body) => this.#reply(channel, replyTo, body);

        try {
            // 1. Link-code claim
            const linkMatch = String(text).match(LINK_RE);
            if (linkMatch) {
                return await reply(this.#claim(linkMatch[1].toLowerCase(), channel, senderId, replyTo));
            }

            // 2. Resolve peer binding
            const binding = this.getPeerBinding(channel, senderId);
            if (!binding) {
                return await reply(
                    'This chat is not linked to a canvas agent yet. '
                    + 'Create a link code in canvas (POST /rest/v2/messaging/bindings/link-code) '
                    + 'and send: link <code>',
                );
            }

            // 3. Prompt the bound agent
            const images = (message.media || [])
                .filter((entry) => entry?.data && entry?.mimeType)
                .map((entry) => ({ type: 'image', data: entry.data, mimeType: entry.mimeType }));

            if (!String(text).trim() && images.length === 0) return;

            const answer = await this.#promptAgent(binding.userId, binding.agentId, String(text), { images });
            await reply(answer?.trim() || '(agent returned no reply)');
        } catch (err) {
            this.#logger.error?.(`chat-router: ${err.message}`);
            await reply(`Agent error: ${err.message}`).catch(() => {});
        }
    }

    #claim(code, channel, senderId, replyTo) {
        const key = `code:${code}`;
        const entry = this.#store.get(key);
        if (!entry) return 'Unknown or already used link code.';
        if (entry.channel !== channel) return `This code is for the ${entry.channel} channel.`;
        if (new Date(entry.expiresAt) < new Date()) {
            this.#store.delete(key);
            return 'Link code expired — create a new one.';
        }

        this.#store.delete(key);
        this.#store.set(`peer:${channel}:${senderId}`, {
            userId: entry.userId,
            agentId: entry.agentId,
            replyTo,
            linkedAt: new Date().toISOString(),
        });
        // Record the outbound recipient so notify() reaches this peer too.
        this.#messaging.setBindings(entry.userId, {
            channels: { [channel]: { recipient: replyTo } },
        });

        this.#logger.debug?.(`chat-router: ${channel}:${senderId} linked to agent ${entry.agentId}`);
        return 'Linked. This chat now talks to your canvas agent.';
    }

    async #reply(channel, recipient, body) {
        if (!body) return;
        const adapter = this.#messaging.getAdapter(channel);
        if (!adapter) {
            this.#logger.debug?.(`chat-router: no adapter for reply channel ${channel}`);
            return;
        }
        await adapter.sendText(recipient, body);
    }
}

export default ChatRouter;
