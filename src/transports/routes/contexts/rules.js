'use strict';

import ResponseObject from '../../ResponseObject.js';

/**
 * Context Rules Routes
 *
 * Manages context-specific linking rules
 */
export default async function contextRulesRoutes(fastify, options) {
    const { contextManager } = options;

    /**
     * List all rules for a context
     */
    fastify.get('/:contextId/rules', async (request, reply) => {
        try {
            const { contextId } = request.params;
            const userId = request.user.id;

            const context = await contextManager.getContext(contextId, userId);
            if (!context) {
                return reply.code(404).send(ResponseObject.error('Context not found'));
            }

            const rules = context.rules || [];
            return reply.send(ResponseObject.success({ rules }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });

    /**
     * Add a new rule to a context
     */
    fastify.post('/:contextId/rules', async (request, reply) => {
        try {
            const { contextId } = request.params;
            const { type, criteria, description } = request.body;
            const userId = request.user.id;

            if (!type || !criteria) {
                return reply.code(400).send(ResponseObject.error('Type and criteria are required'));
            }

            const context = await contextManager.getContext(contextId, userId);
            if (!context) {
                return reply.code(404).send(ResponseObject.error('Context not found'));
            }

            const rule = {
                id: `rule-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                type,
                criteria,
                description: description || '',
                createdAt: new Date().toISOString(),
            };

            context.addRule(rule);
            await contextManager.saveContext(context);

            return reply.code(201).send(ResponseObject.success({ rule }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });

    /**
     * Update a rule
     */
    fastify.put('/:contextId/rules/:ruleId', async (request, reply) => {
        try {
            const { contextId, ruleId } = request.params;
            const { type, criteria, description } = request.body;
            const userId = request.user.id;

            const context = await contextManager.getContext(contextId, userId);
            if (!context) {
                return reply.code(404).send(ResponseObject.error('Context not found'));
            }

            const rules = context.rules || [];
            const ruleIndex = rules.findIndex(r => r.id === ruleId);

            if (ruleIndex === -1) {
                return reply.code(404).send(ResponseObject.error('Rule not found'));
            }

            // Update rule
            const updatedRule = {
                ...rules[ruleIndex],
                type: type || rules[ruleIndex].type,
                criteria: criteria || rules[ruleIndex].criteria,
                description: description !== undefined ? description : rules[ruleIndex].description,
                updatedAt: new Date().toISOString(),
            };

            // Remove old rule and add updated one
            context.removeRule(ruleId);
            context.addRule(updatedRule);
            await contextManager.saveContext(context);

            return reply.send(ResponseObject.success({ rule: updatedRule }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });

    /**
     * Delete a rule
     */
    fastify.delete('/:contextId/rules/:ruleId', async (request, reply) => {
        try {
            const { contextId, ruleId } = request.params;
            const userId = request.user.id;

            const context = await contextManager.getContext(contextId, userId);
            if (!context) {
                return reply.code(404).send(ResponseObject.error('Context not found'));
            }

            const removed = context.removeRule(ruleId);
            if (!removed) {
                return reply.code(404).send(ResponseObject.error('Rule not found'));
            }

            await contextManager.saveContext(context);

            return reply.send(ResponseObject.success({ message: 'Rule deleted successfully' }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });
}
