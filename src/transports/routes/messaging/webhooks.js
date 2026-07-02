'use strict';

import { env } from '../../../env.js';

/**
 * Messaging webhooks — unauthenticated by design (verified per provider).
 *
 * WhatsApp Cloud API:
 *   GET  /whatsapp — subscription verification (hub.verify_token challenge)
 *   POST /whatsapp — inbound messages, fed to the whatsapp adapter
 */
export default async function messagingWebhookRoutes(fastify, _options) {

    fastify.get('/whatsapp', async (request, reply) => {
        const mode = request.query['hub.mode'];
        const token = request.query['hub.verify_token'];
        const challenge = request.query['hub.challenge'];

        const expected = env.messaging.whatsapp.verifyToken;
        if (mode === 'subscribe' && expected && token === expected) {
            return reply.code(200).send(challenge);
        }
        return reply.code(403).send('Forbidden');
    });

    fastify.post('/whatsapp', async (request, reply) => {
        // Always 200 — Cloud API disables webhooks that keep failing.
        try {
            const adapter = fastify.messaging?.getAdapter('whatsapp');
            if (adapter?.handleWebhook) {
                const dispatched = await adapter.handleWebhook(request.body || {});
                if (dispatched > 0) fastify.log.debug(`whatsapp webhook: ${dispatched} message(s) dispatched`);
            }
        } catch (err) {
            fastify.log.warn({ err }, 'whatsapp webhook processing failed');
        }
        return reply.code(200).send({ status: 'ok' });
    });
}
