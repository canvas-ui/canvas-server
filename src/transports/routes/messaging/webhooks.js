'use strict';

import crypto from 'node:crypto';
import { env } from '../../../env.js';

/**
 * Messaging webhooks — unauthenticated by design (verified per provider).
 *
 * WhatsApp Cloud API:
 *   GET  /whatsapp — subscription verification (hub.verify_token challenge)
 *   POST /whatsapp — inbound messages, HMAC-verified then fed to the adapter
 */
export default async function messagingWebhookRoutes(fastify, _options) {

    // Scoped JSON parser (this plugin only) that retains the raw bytes — Meta
    // signs the exact payload, so we must HMAC the raw body, not a re-serialized
    // object.
    fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
        req.rawBody = body;
        try {
            done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
        } catch (err) {
            err.statusCode = 400;
            done(err, undefined);
        }
    });

    // Verify the X-Hub-Signature-256 HMAC. Fail closed when no app secret is
    // configured (so a forged POST can never be processed), unless the operator
    // has explicitly opted into unsigned webhooks.
    const verifyWhatsappSignature = (request) => {
        const secret = env.messaging.whatsapp.appSecret;
        if (!secret) {
            if (env.messaging.whatsapp.allowUnsignedWebhooks) { return true; }
            fastify.log.warn('whatsapp webhook rejected: WHATSAPP_APP_SECRET is not configured');
            return false;
        }
        const header = request.headers['x-hub-signature-256'];
        if (typeof header !== 'string' || !header.startsWith('sha256=')) { return false; }
        const expected = `sha256=${crypto.createHmac('sha256', secret).update(request.rawBody || Buffer.alloc(0)).digest('hex')}`;
        const a = Buffer.from(header);
        const b = Buffer.from(expected);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    };

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
        // Reject forged deliveries before touching the adapter/chat router.
        if (!verifyWhatsappSignature(request)) {
            fastify.log.warn('whatsapp webhook rejected: invalid or missing X-Hub-Signature-256');
            return reply.code(403).send({ status: 'forbidden' });
        }
        // Verified deliveries always 200 — Cloud API disables webhooks that keep failing.
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
