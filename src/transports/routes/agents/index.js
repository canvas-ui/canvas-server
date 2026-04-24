'use strict';

import ResponseObject from '../../ResponseObject.js';
import { validateUser } from '../../auth/strategies.js';

/**
 * Agent routes handler
 * @param {FastifyInstance} fastify
 */
export default async function agentRoutes(fastify, _options) {

    const requireUser = (request, reply) => {
        if (!validateUser(request.user, ['id', 'email'])) {
            const r = new ResponseObject().unauthorized('Valid authentication required');
            reply.code(r.statusCode).send(r.getResponse());
            return false;
        }
        return true;
    };

    /**
     * List agents
     */
    fastify.get('/', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const agents = await fastify.agents.listByUser(request.user.id, request.query.host);
            const r = new ResponseObject().found(agents, 'Agents retrieved', 200, agents.length);
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError('Failed to list agents');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Create agent
     */
    fastify.post('/', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const {
                name, label, description, color, llmProvider, model, apiKey, baseUrl,
                prompts, tools, mcp, metadata, connectors, parameters, identity, memory, skills,
                config = {},
            } = request.body;
            const mergedConfig = {
                ...config,
                ...(apiKey !== undefined ? { apiKey } : {}),
                ...(baseUrl !== undefined ? { baseUrl } : {}),
                ...(identity !== undefined ? { identity: { ...(config.identity || {}), ...identity } } : {}),
                ...(prompts !== undefined ? { prompts: { ...(config.prompts || {}), ...prompts } } : {}),
                ...(tools !== undefined ? { tools: { ...(config.tools || {}), ...tools } } : {}),
                ...(connectors !== undefined ? { connectors: { ...(config.connectors || {}), ...connectors } } : {}),
                ...(parameters !== undefined ? { parameters: { ...(config.parameters || {}), ...parameters } } : {}),
                ...(memory !== undefined ? { memory } : {}),
                ...(skills !== undefined ? { skills } : {}),
                ...(mcp !== undefined ? { mcp } : {}),
            };
            const agent = await fastify.agents.create(request.user.id, name, {
                owner: request.user.id, label, description, color, llmProvider, model, metadata, config: mergedConfig,
            });
            const r = new ResponseObject().created(agent, 'Agent created');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = err.message.includes('already exists')
                ? new ResponseObject().conflict(err.message)
                : new ResponseObject().serverError(err.message || 'Failed to create agent');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Get agent
     */
    fastify.get('/:agentIdentifier', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const agent = await fastify.agents.open(request.user.id, request.params.agentIdentifier, request.user.id);
            if (!agent) {
                const r = new ResponseObject().notFound('Agent not found');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().found(agent.toJSON(), 'Agent retrieved');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError('Failed to get agent');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Get agent status
     */
    fastify.get('/:agentIdentifier/status', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const agent = await fastify.agents.open(request.user.id, request.params.agentIdentifier, request.user.id);
            if (!agent) {
                const r = new ResponseObject().notFound('Agent not found');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().found(
                { id: agent.id, name: agent.name, status: agent.status, isActive: agent.isActive, model: agent.model },
                'Status retrieved'
            );
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError('Failed to get agent status');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Update agent config
     */
    fastify.put('/:agentIdentifier', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const {
                label, description, color, llmProvider, model, apiKey, baseUrl,
                prompts, tools, mcp, metadata, connectors, parameters, identity, memory, skills,
                config = {},
            } = request.body;
            const updateData = {};
            if (label       !== undefined) updateData.label       = label;
            if (description !== undefined) updateData.description = description;
            if (color       !== undefined) updateData.color       = color;
            if (llmProvider !== undefined) updateData.llmProvider = llmProvider;
            if (model       !== undefined) updateData.model       = model;
            const mergedConfig = {
                ...config,
                ...(apiKey !== undefined ? { apiKey } : {}),
                ...(baseUrl !== undefined ? { baseUrl } : {}),
                ...(identity !== undefined ? { identity: { ...(config.identity || {}), ...identity } } : {}),
                ...(prompts !== undefined ? { prompts: { ...(config.prompts || {}), ...prompts } } : {}),
                ...(tools !== undefined ? { tools: { ...(config.tools || {}), ...tools } } : {}),
                ...(connectors !== undefined ? { connectors: { ...(config.connectors || {}), ...connectors } } : {}),
                ...(parameters !== undefined ? { parameters: { ...(config.parameters || {}), ...parameters } } : {}),
                ...(memory !== undefined ? { memory } : {}),
                ...(skills !== undefined ? { skills } : {}),
                ...(mcp !== undefined ? { mcp } : {}),
            };
            if (Object.keys(mergedConfig).length > 0) updateData.config = mergedConfig;
            if (metadata    !== undefined) updateData.metadata    = metadata;

            const agent = await fastify.agents.update(
                request.user.id, request.params.agentIdentifier, updateData, request.user.id
            );
            if (!agent) {
                const r = new ResponseObject().notFound('Agent not found');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().success(agent.toJSON(), 'Agent updated');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError(err.message || 'Failed to update agent');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Delete agent
     */
    fastify.delete('/:agentIdentifier', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const success = await fastify.agents.delete(
                request.user.id, request.params.agentIdentifier, request.user.id
            );
            if (!success) {
                const r = new ResponseObject().notFound('Agent not found or failed to delete');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().success({ success: true }, 'Agent deleted');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError(err.message || 'Failed to delete agent');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Start agent
     */
    fastify.post('/:agentIdentifier/start', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const agent = await fastify.agents.start(
                request.user.id, request.params.agentIdentifier, request.user.id
            );
            if (!agent) {
                const r = new ResponseObject().notFound('Agent not found or failed to start');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().success(agent.toJSON(), 'Agent started');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError(err.message || 'Failed to start agent');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Stop agent
     */
    fastify.post('/:agentIdentifier/stop', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const success = await fastify.agents.stop(
                request.user.id, request.params.agentIdentifier, request.user.id
            );
            if (!success) {
                const r = new ResponseObject().notFound('Agent not found or failed to stop');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().success({ success: true }, 'Agent stopped');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError(err.message || 'Failed to stop agent');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Restart agent
     */
    fastify.post('/:agentIdentifier/restart', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const agent = await fastify.agents.restart(
                request.user.id, request.params.agentIdentifier, request.user.id
            );
            if (!agent) {
                const r = new ResponseObject().notFound('Agent not found or failed to restart');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().success(agent.toJSON(), 'Agent restarted');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError(err.message || 'Failed to restart agent');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Prompt (non-streaming) — waits for completion, returns messages.
     */
    fastify.post('/:agentIdentifier/prompt', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const agent = await fastify.agents.open(
                request.user.id, request.params.agentIdentifier, request.user.id
            );
            if (!agent) {
                const r = new ResponseObject().notFound('Agent not found');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            if (!agent.isActive) {
                const r = new ResponseObject().badRequest('Agent is not active. Start it first.');
                return reply.code(r.statusCode).send(r.getResponse());
            }

            const { message } = request.body;
            const messages = await agent.prompt(message);
            const r = new ResponseObject().success({ messages }, 'Prompt completed');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError(err.message || 'Prompt failed');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Prompt streaming (SSE)
     *
     * Event types forwarded to client:
     *   { type: 'chunk',        delta: string }          — assistant text delta
     *   { type: 'thinking',     delta: string }          — thinking delta
     *   { type: 'tool_start',   toolName: string }
     *   { type: 'tool_end',     toolName: string, isError: boolean }
     *   { type: 'complete',     messages: AgentMessage[] }
     *   { type: 'error',        error: string }
     */
    fastify.post('/:agentIdentifier/prompt/stream', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const agent = await fastify.agents.open(
                request.user.id, request.params.agentIdentifier, request.user.id
            );
            if (!agent) {
                const r = new ResponseObject().notFound('Agent not found');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            if (!agent.isActive) {
                const r = new ResponseObject().badRequest('Agent is not active. Start it first.');
                return reply.code(r.statusCode).send(r.getResponse());
            }

            const { message } = request.body;

            reply.raw.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            });

            const send = (payload) => reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
            send({ type: 'start' });

            const collectedMessages = [];

            const onEvent = (event) => {
                switch (event.type) {
                    case 'message_update': {
                        const ae = event.assistantMessageEvent;
                        if (ae?.type === 'text_delta')     send({ type: 'chunk', delta: ae.delta });
                        if (ae?.type === 'thinking_delta') send({ type: 'thinking', delta: ae.delta });
                        break;
                    }
                    case 'tool_execution_start':
                        send({ type: 'tool_start', toolName: event.toolName });
                        break;
                    case 'tool_execution_end':
                        send({ type: 'tool_end', toolName: event.toolName, isError: event.isError ?? false });
                        break;
                    case 'message_end':
                        if (event.message?.role === 'assistant') collectedMessages.push(event.message);
                        break;
                    case 'agent_end':
                        send({ type: 'complete', messages: collectedMessages });
                        break;
                }
            };

            try {
                await agent.stream(message, onEvent);
            } catch (streamErr) {
                send({ type: 'error', error: streamErr.message });
            }

            reply.raw.write('data: [DONE]\n\n');
            reply.raw.end();
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError(err.message || 'Failed to start stream');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });
}
