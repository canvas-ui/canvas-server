import { FastMCP } from "fastmcp";
import { z } from "zod";
import { validateUser } from '../auth/strategies.js';

export class MCPServer {
  constructor(fastify) {
    this.fastify = fastify;
    this.authenticatedUser = null; // Store the real authenticated user
    this.server = new FastMCP({
      name: "Canvas MCP Server",
      version: "1.0.0",
      authenticate: this.authenticate.bind(this),
      capabilities: {
        tools: true,
        resources: false,
        prompts: false,
        sampling: false
      }
    });

    this.setupTools();
  }

  async authenticate(request) {
    try {
      this.fastify.log.info('MCP Auth: Starting authentication');

      // Try to extract token from rawHeaders
      let token = null;

      if (request.rawHeaders && Array.isArray(request.rawHeaders)) {
        const authIndex = request.rawHeaders.findIndex(header =>
          header.toLowerCase() === 'authorization'
        );
        if (authIndex !== -1 && authIndex + 1 < request.rawHeaders.length) {
          const authHeader = request.rawHeaders[authIndex + 1];
          if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.split(' ')[1];
            this.fastify.log.info('MCP Auth: Found token in headers');
          }
        }
      }

      if (!token) {
        this.fastify.log.error('MCP Auth: No token found in request');
        throw new Error('No authentication token provided');
      }

      // Create a proper mock request object that works with the Fastify authenticate decorator
      const mockRequest = {
        headers: {
          authorization: `Bearer ${token}`
        },
        server: this.fastify,
        method: 'GET',
        url: '/mcp/v1/sse',
        // Add jwtVerify method for JWT tokens
        jwtVerify: async () => {
          return this.fastify.jwt.verify(token);
        }
      };

      // Use the existing Fastify authenticate decorator
      try {
        await this.fastify.authenticate(mockRequest);

        // The authenticate decorator sets mockRequest.user
        if (!mockRequest.user || !mockRequest.user.id) {
          throw new Error('Authentication succeeded but no user object was set');
        }

        // Store the real authenticated user for tools to use
        this.authenticatedUser = mockRequest.user;
        this.fastify.log.info('MCP Auth: Authentication successful for user:', mockRequest.user.id);
        return mockRequest.user;

      } catch (authError) {
        this.fastify.log.error('MCP Auth: Fastify authenticate failed:', authError.message);
        throw authError;
      }

    } catch (error) {
      this.fastify.log.error('MCP Authentication error:', error.message);
      throw new Response(null, {
        status: 401,
        statusText: "Unauthorized",
      });
    }
  }

  setupTools() {
    // Context Lifecycle Tools
    this.server.addTool({
      name: "listContexts",
      description: "List all contexts for the authenticated user",
      execute: async (args, { session }) => {
        const userId = this.authenticatedUser?.id || session?.id;
        if (!userId) { throw new Error('No authenticated user found'); }

        this.fastify.log.info('MCP Tool: listContexts for user:', userId);
        const contexts = await this.fastify.contextManager.listUserContexts(userId);
        this.fastify.log.info('MCP Tool: Found contexts:', contexts.length);

        if (contexts.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No contexts found for this user."
              }
            ]
          };
        }

        const formattedContexts = contexts.map((ctx, index) => {
          let data = typeof ctx.toJSON === 'function' ? ctx.toJSON() : ctx;
          return [
            `Context ${index + 1}:`,
            `  ID(name): ${data.id}`,
            `  Owner of the context (if different from the current user, its a shared context): ${data.userId}`,
            `  Current context URL: ${data.url}`,
            `  Context BaseUrl (user is not allowed to navigate below this path): ${data.baseUrl}`,
            `  Current user Workspace: ${data.workspaceId}`,
            `  Description: ${data.description || 'No description'}`,
            `  Created: ${data.createdAt || 'Unknown'}`,
            `  Updated: ${data.updatedAt || 'Never'}`,
            `  Context Locked: ${data.locked}`,
            `  Context ACL: ${JSON.stringify(data.acl)}`,
          ].join('\n');
        }).join('\n\n');

        return {
          content: [
            {
              type: "text",
              text: `Found ${contexts.length} context(s):\n\n${formattedContexts}`
            }
          ]
        };
      },
    });

    this.server.addTool({
      name: "getContext",
      description: "Get a specific context for the current user by context Name(ID)",
      parameters: z.object({
        contextId: z.string(),
        userId: z.string().optional(),
      }),
      execute: async (args, { session }) => {
        const userId = args?.userId || this.authenticatedUser?.id;
        if (!userId) {
          throw new Error('No authenticated user found');
        }

        const context = await this.fastify.contextManager.getContext(userId, args.contextId);
        if (!context) {
          throw new Error(`Context with ID '${args.contextId}' not found`);
        }

        // Format single context as human-readable text
        let data = typeof context.toJSON === 'function' ? context.toJSON() : context;
        const formattedContext = [
          `Context Details:`,
          `  ID(name): ${data.id}`,
          `  Owner of the context (if different from the current user, its a shared context): ${data.userId}`,
          `  Current context URL: ${data.url}`,
          `  Context BaseUrl (user is not allowed to navigate below this path): ${data.baseUrl}`,
          `  Current user Workspace: ${data.workspaceId}`,
          `  Description: ${data.description || 'No description'}`,
          `  Created: ${data.createdAt || 'Unknown'}`,
          `  Updated: ${data.updatedAt || 'Never'}`,
          `  Context Locked: ${data.locked}`,
          `  Context ACL: ${JSON.stringify(data.acl)}`,
        ].join('\n');

        return {
          content: [
            {
              type: "text",
              text: formattedContext
            }
          ]
        };
      },
    });
  }

  async handleMessage(message, write) {
    try {
      const parsed = JSON.parse(message);
      this.fastify.log.info('MCP: Received message:', parsed);

      if (parsed.type === 'initialize') {
        write({
          type: 'initialize',
          version: '1.0.0',
          capabilities: {
            tools: true,
            resources: false,
            prompts: false,
            sampling: false
          }
        });
        return;
      }

      // Handle other message types through FastMCP
      const response = await this.server.handleMessage(parsed);
      if (response) {
        write(response);
      }
    } catch (error) {
      this.fastify.log.error('MCP: Error handling message:', error);
      write({
        type: 'error',
        error: error.message
      });
    }
  }

  async start(port = 8002) {
    this.fastify.log.info(`Starting MCP server on port ${port}`);

    return this.server.start({
      transportType: "httpStream",
      httpStream: {
        port
      }
    });
  }

  stop() {
    return this.server.stop();
  }
}
