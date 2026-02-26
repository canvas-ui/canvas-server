'use strict';

import ResponseObject from '../../ResponseObject.js';
import { validateUser } from '../../auth/strategies.js';

export default async function contextRulesRoutes(fastify, options) {
    fastify.addHook('preHandler', async (request, reply) => {
        try {
            validateUser(request.user, ['id']);
        } catch (err) {
            const response = new ResponseObject().unauthorized(err.message);
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    fastify.get('/:contextId/rules', {
        onRequest: [fastify.authenticate],
    }, async (request, reply) => {
        try {
            const context = await fastify.contextManager.getContext(request.user.id, request.params.contextId);
            if (!context) {
                const response = new ResponseObject().notFound('Context not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const response = new ResponseObject().success({ rules: context.rules || [] });
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().error(error.message);
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    fastify.post('/:contextId/rules', {
        onRequest: [fastify.authenticate],
        schema: {
            body: {
                type: 'object',
                required: ['type', 'criteria'],
                properties: {
                    type: { type: 'string' },
                    criteria: { type: 'object' },
                    description: { type: 'string' }
                }
            }
        }
    }, async (request, reply) => {
        try {
            const context = await fastify.contextManager.getContext(request.user.id, request.params.contextId);
            if (!context) {
                const response = new ResponseObject().notFound('Context not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const rule = {
                id: `rule-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                type: request.body.type,
                criteria: request.body.criteria,
                description: request.body.description || '',
                createdAt: new Date().toISOString(),
            };

            context.addRule(rule);
            fastify.contextManager.saveContext(request.user.id, context);

            const response = new ResponseObject().created({ rule });
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().error(error.message);
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    fastify.put('/:contextId/rules/:ruleId', {
        onRequest: [fastify.authenticate],
    }, async (request, reply) => {
        try {
            const context = await fastify.contextManager.getContext(request.user.id, request.params.contextId);
            if (!context) {
                const response = new ResponseObject().notFound('Context not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const rules = context.rules || [];
            const existing = rules.find(r => r.id === request.params.ruleId);
            if (!existing) {
                const response = new ResponseObject().notFound('Rule not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const { type, criteria, description } = request.body;
            const updatedRule = {
                ...existing,
                type: type || existing.type,
                criteria: criteria || existing.criteria,
                description: description !== undefined ? description : existing.description,
                updatedAt: new Date().toISOString(),
            };

            context.removeRule(request.params.ruleId);
            context.addRule(updatedRule);
            fastify.contextManager.saveContext(request.user.id, context);

            const response = new ResponseObject().updated({ rule: updatedRule });
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().error(error.message);
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    fastify.delete('/:contextId/rules/:ruleId', {
        onRequest: [fastify.authenticate],
    }, async (request, reply) => {
        try {
            const context = await fastify.contextManager.getContext(request.user.id, request.params.contextId);
            if (!context) {
                const response = new ResponseObject().notFound('Context not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const removed = context.removeRule(request.params.ruleId);
            if (!removed) {
                const response = new ResponseObject().notFound('Rule not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            fastify.contextManager.saveContext(request.user.id, context);

            const response = new ResponseObject().deleted(null, 'Rule deleted successfully');
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().error(error.message);
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });
}
