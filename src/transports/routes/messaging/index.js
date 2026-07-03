'use strict';

import ResponseObject from '../../ResponseObject.js';
import { validateUser } from '../../auth/strategies.js';
import { rejectAgentTokens } from '../../middleware/agent-acl.js';

/**
 * Messaging routes
 *
 * POST /notify   — send a message to the authenticated user's own channels.
 *                  Agent tokens ARE allowed here: an agent can only notify its
 *                  owner (request.user is the owner for agent tokens).
 * GET  /bindings — read own channel bindings (control plane, no agent tokens).
 * PUT  /bindings — update own channel bindings (control plane, no agent tokens).
 */
export default async function messagingRoutes(fastify, _options) {

    const requireUser = (request, reply) => {
        if (!validateUser(request.user, ['id'])) {
            const r = new ResponseObject().unauthorized('Valid authentication required');
            reply.code(r.statusCode).send(r.getResponse());
            return false;
        }
        return true;
    };

    const requireMessaging = (reply) => {
        if (!fastify.messaging) {
            const r = new ResponseObject().serverError('Messaging service not available');
            reply.code(r.statusCode).send(r.getResponse());
            return false;
        }
        return true;
    };

    fastify.post('/notify', {
        onRequest: [fastify.authenticate],
        schema: {
            body: {
                type: 'object',
                required: ['message'],
                properties: {
                    message: { type: 'string', minLength: 1 },
                    channel: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        if (!requireUser(request, reply) || !requireMessaging(reply)) return;
        try {
            const result = await fastify.messaging.notify(
                request.user.id,
                request.body.message,
                { channel: request.body.channel },
            );
            const r = new ResponseObject().success(result, 'Notification sent');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = err.message?.includes('not available') || err.message?.includes('recipient')
                ? new ResponseObject().badRequest(err.message)
                : new ResponseObject().serverError(err.message || 'Failed to send notification');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    fastify.get('/bindings', {
        onRequest: [fastify.authenticate],
        preHandler: [rejectAgentTokens],
    }, async (request, reply) => {
        if (!requireUser(request, reply) || !requireMessaging(reply)) return;
        const bindings = fastify.messaging.getBindings(request.user.id);
        const r = new ResponseObject().found(
            { ...bindings, availableChannels: fastify.messaging.channels },
            'Messaging bindings retrieved',
        );
        return reply.code(r.statusCode).send(r.getResponse());
    });

    // Issue a short-lived link code binding a chat peer (WhatsApp number,
    // Slack user) to one of the user's agents. The user DMs "link <code>" to
    // the bot to claim it — identity is claimed, never inferred from JIDs.
    fastify.post('/bindings/link-code', {
        onRequest: [fastify.authenticate],
        preHandler: [rejectAgentTokens],
        schema: {
            body: {
                type: 'object',
                required: ['channel', 'agentId'],
                properties: {
                    channel: { type: 'string' },
                    agentId: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        if (!fastify.chatRouter) {
            const r = new ResponseObject().serverError('Chat routing not available');
            return reply.code(r.statusCode).send(r.getResponse());
        }
        try {
            const result = fastify.chatRouter.createLinkCode(request.user.id, request.body);
            const r = new ResponseObject().created(
                result,
                `Send "link ${result.code}" to the ${request.body.channel} bot to claim this binding`,
            );
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().badRequest(err.message || 'Failed to create link code');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    fastify.put('/bindings', {
        onRequest: [fastify.authenticate],
        preHandler: [rejectAgentTokens],
        schema: {
            body: {
                type: 'object',
                properties: {
                    channels: {
                        type: 'object',
                        additionalProperties: {
                            anyOf: [
                                { type: 'null' },
                                {
                                    type: 'object',
                                    required: ['recipient'],
                                    properties: { recipient: { type: 'string' } },
                                },
                            ],
                        },
                    },
                    defaultChannel: { type: ['string', 'null'] },
                },
            },
        },
    }, async (request, reply) => {
        if (!requireUser(request, reply) || !requireMessaging(reply)) return;
        try {
            const bindings = fastify.messaging.setBindings(request.user.id, request.body || {});
            const r = new ResponseObject().success(bindings, 'Messaging bindings updated');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().badRequest(err.message || 'Failed to update bindings');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });
}
