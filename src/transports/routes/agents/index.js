'use strict';

import ResponseObject from '../../ResponseObject.js';
import { validateUser } from '../../auth/strategies.js';

/**
 * Agent routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function agentRoutes(fastify, options) {

  /**
   * Middleware to validate user
   */
  const validateUserWithResponse = (request, reply) => {
    if (!validateUser(request.user, ['id', 'email'])) {
      const response = new ResponseObject().unauthorized('Valid authentication required');
      return reply.code(response.statusCode).send(response.getResponse());
    }
    return true;
  };

  // List all agents for the authenticated user
  fastify.get('/', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      if (!validateUserWithResponse(request, reply)) return;

      const { host } = request.query;
      const agents = await fastify.agents.listByUser(request.user.id, host);

      const response = new ResponseObject().found(agents, 'Agents retrieved successfully', 200, agents.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to list agents');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Create a new agent
  fastify.post('/', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      if (!validateUserWithResponse(request, reply)) return;

      const {
        name,
        label,
        description,
        color,
        llmProvider = 'anthropic',
        model,
        connectors = {},
        prompts = {},
        tools = {},
        mcp = { servers: [] },
        metadata = {}
      } = request.body;

      const agent = await fastify.agents.create(
        request.user.id,
        name,
        {
          owner: request.user.id,
          label: label || name,
          description: description || '',
          color,
          llmProvider,
          model,
          connectors,
          prompts,
          tools,
          mcp,
          metadata
        }
      );

      const response = new ResponseObject().created(agent, 'Agent created successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);

      // Handle specific errors
      if (error.message.includes('already exists')) {
        const response = new ResponseObject().conflict(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().serverError(error.message || 'Failed to create agent');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get agent by ID or name
  fastify.get('/:agentIdentifier', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      if (!validateUserWithResponse(request, reply)) return;

      const agent = await fastify.agents.open(
        request.user.id,
        request.params.agentIdentifier,
        request.user.id
      );

      if (!agent) {
        const response = new ResponseObject().notFound('Agent not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().found(agent.toJSON(), 'Agent retrieved successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to get agent');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Start an agent
  fastify.post('/:agentIdentifier/start', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      if (!validateUserWithResponse(request, reply)) return;

      const agent = await fastify.agents.start(
        request.user.id,
        request.params.agentIdentifier,
        request.user.id
      );

      if (!agent) {
        const response = new ResponseObject().notFound('Agent not found or failed to start');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success(agent.toJSON(), 'Agent started successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to start agent');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Stop an agent
  fastify.post('/:agentIdentifier/stop', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      if (!validateUserWithResponse(request, reply)) return;

      const success = await fastify.agents.stop(
        request.user.id,
        request.params.agentIdentifier,
        request.user.id
      );

      if (!success) {
        const response = new ResponseObject().notFound('Agent not found or failed to stop');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success({ success: true }, 'Agent stopped successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to stop agent');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get agent status
  fastify.get('/:agentIdentifier/status', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      if (!validateUserWithResponse(request, reply)) return;

      const agent = await fastify.agents.open(
        request.user.id,
        request.params.agentIdentifier,
        request.user.id
      );

      if (!agent) {
        const response = new ResponseObject().notFound('Agent not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const status = {
        id: agent.id,
        name: agent.name,
        status: agent.status,
        isActive: agent.isActive,
        llmProvider: agent.llmProvider,
        model: agent.model,
        lastAccessed: agent.lastAccessed
      };

      const response = new ResponseObject().found(status, 'Agent status retrieved successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to get agent status');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Update agent configuration
  fastify.put('/:agentIdentifier', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      if (!validateUserWithResponse(request, reply)) return;

      const agent = await fastify.agents.open(
        request.user.id,
        request.params.agentIdentifier,
        request.user.id
      );

      if (!agent) {
        const response = new ResponseObject().notFound('Agent not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const {
        label,
        description,
        color,
        llmProvider,
        model,
        connectors,
        prompts,
        tools,
        mcp,
        metadata
      } = request.body;

      // Update agent configuration
      const updateData = {};
      if (label !== undefined) updateData.label = label;
      if (description !== undefined) updateData.description = description;
      if (color !== undefined) updateData.color = color;
      if (llmProvider !== undefined) updateData.llmProvider = llmProvider;
      if (model !== undefined) updateData.model = model;
      if (connectors !== undefined) updateData.connectors = connectors;
      if (prompts !== undefined) updateData.prompts = prompts;
      if (tools !== undefined) updateData.tools = tools;
      if (mcp !== undefined) updateData.mcp = mcp;
      if (metadata !== undefined) updateData.metadata = metadata;

      const updatedAgent = await fastify.agents.update(
        request.user.id,
        request.params.agentIdentifier,
        updateData
      );

      const response = new ResponseObject().success(updatedAgent.toJSON(), 'Agent updated successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to update agent');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Delete agent (permanent removal)
  fastify.delete('/:agentIdentifier', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      if (!validateUserWithResponse(request, reply)) return;

      const agent = await fastify.agents.open(
        request.user.id,
        request.params.agentIdentifier,
        request.user.id
      );

      if (!agent) {
        const response = new ResponseObject().notFound('Agent not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Stop agent if it's running before deletion
      if (agent.isActive) {
        await fastify.agents.stop(
          request.user.id,
          request.params.agentIdentifier,
          request.user.id
        );
      }

      // Delete the agent
      const success = await fastify.agents.delete(
        request.user.id,
        request.params.agentIdentifier
      );

      if (!success) {
        const response = new ResponseObject().serverError('Failed to delete agent');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success({ success: true }, 'Agent deleted successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to delete agent');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Chat with an agent
  fastify.post('/:agentIdentifier/chat', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      if (!validateUserWithResponse(request, reply)) return;

      const agent = await fastify.agents.open(
        request.user.id,
        request.params.agentIdentifier,
        request.user.id
      );

      if (!agent) {
        const response = new ResponseObject().notFound('Agent not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      if (!agent.isActive) {
        const response = new ResponseObject().badRequest('Agent is not active. Please start the agent first.');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const { message, context, mcpContext = true, maxTokens, temperature } = request.body;

      const result = await agent.chat(message, {
        context,
        mcpContext,
        maxTokens,
        temperature
      });

      const response = new ResponseObject().success(result, 'Chat response generated successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to chat with agent');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Chat with an agent using streaming (Server-Sent Events fallback)
  fastify.post('/:agentIdentifier/chat/stream', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      if (!validateUserWithResponse(request, reply)) return;

      const agent = await fastify.agents.open(
        request.user.id,
        request.params.agentIdentifier,
        request.user.id
      );

      if (!agent) {
        const response = new ResponseObject().notFound('Agent not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      if (!agent.isActive) {
        const response = new ResponseObject().badRequest('Agent is not active. Please start the agent first.');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const { message, context, mcpContext = true, maxTokens, temperature } = request.body;

      // Set up Server-Sent Events
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
      });

      // Send initial event
      reply.raw.write(`data: ${JSON.stringify({ type: 'start' })}\n\n`);

      const onChunk = (chunk) => {
        reply.raw.write(`data: ${JSON.stringify({
          type: 'chunk',
          content: chunk.content,
          delta: chunk.delta
        })}\n\n`);
      };

      try {
        const result = await agent.chatStream(message, {
          context,
          mcpContext,
          maxTokens,
          temperature,
          onChunk
        });

        // Send completion event
        reply.raw.write(`data: ${JSON.stringify({
          type: 'complete',
          result
        })}\n\n`);

        reply.raw.write(`data: [DONE]\n\n`);
      } catch (streamError) {
        reply.raw.write(`data: ${JSON.stringify({
          type: 'error',
          error: streamError.message
        })}\n\n`);
      }

      reply.raw.end();
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to start chat stream');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get agent memory
  fastify.get('/:agentIdentifier/memory', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      if (!validateUserWithResponse(request, reply)) return;

      const agent = await fastify.agents.open(
        request.user.id,
        request.params.agentIdentifier,
        request.user.id
      );

      if (!agent) {
        const response = new ResponseObject().notFound('Agent not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      if (!agent.isActive) {
        const response = new ResponseObject().badRequest('Agent is not active');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const { query, context = '/', treeNameOrTreeId = null, limit = 50 } = request.query;
      const contextSelector = agent.getContextTreeSelector(context, treeNameOrTreeId);

      let memory;
      if (query) {
        memory = await agent.queryMemory(query, contextSelector, { limit });
      } else {
        // List recent memories
        memory = await agent.db.findDocuments(contextSelector, [], [], { parse: true });
        memory = memory.slice(0, limit);
      }

      const response = new ResponseObject().found(memory, 'Agent memory retrieved successfully', 200, memory.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to get agent memory');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Clear agent memory
  fastify.delete('/:agentIdentifier/memory', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      if (!validateUserWithResponse(request, reply)) return;

      const agent = await fastify.agents.open(
        request.user.id,
        request.params.agentIdentifier,
        request.user.id
      );

      if (!agent) {
        const response = new ResponseObject().notFound('Agent not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      if (!agent.isActive) {
        const response = new ResponseObject().badRequest('Agent is not active');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const success = await agent.clearMemory();

      const response = new ResponseObject().success({ success }, 'Agent memory cleared successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to clear agent memory');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get agent MCP tools
  fastify.get('/:agentIdentifier/mcp/tools', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      if (!validateUserWithResponse(request, reply)) return;

      const agent = await fastify.agents.open(
        request.user.id,
        request.params.agentIdentifier,
        request.user.id
      );

      if (!agent) {
        const response = new ResponseObject().notFound('Agent not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      if (!agent.isActive) {
        const response = new ResponseObject().badRequest('Agent is not active');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const tools = await agent.getMCPTools();

      const response = new ResponseObject().found(tools, 'MCP tools retrieved successfully', 200, tools.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to get MCP tools');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Call an MCP tool
  fastify.post('/:agentIdentifier/mcp/tools/:toolName', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      if (!validateUserWithResponse(request, reply)) return;

      const agent = await fastify.agents.open(
        request.user.id,
        request.params.agentIdentifier,
        request.user.id
      );

      if (!agent) {
        const response = new ResponseObject().notFound('Agent not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      if (!agent.isActive) {
        const response = new ResponseObject().badRequest('Agent is not active');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const { toolName } = request.params;
      const { arguments: args = {}, source } = request.body;

      const result = await agent.callMCPTool(toolName, args, source);

      const response = new ResponseObject().success(result, 'MCP tool executed successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to execute MCP tool');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
