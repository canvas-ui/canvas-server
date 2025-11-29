import { MCPServer } from './server.js';

export default async function mcpPlugin(fastify, options) {
  const mcpServer = new MCPServer(fastify);

  // Start the MCP server on a separate port
  const port = options.mcpPort || 8002;
  await mcpServer.start(port);
  fastify.log.info(`MCP server started on port ${port}`);

  // Add a health check endpoint to the main Fastify server
  fastify.get('/mcp/v1/health', async (request, reply) => {
    return {
      status: 'ok',
      version: '1.0.0',
      port,
      capabilities: {
        tools: true,
        resources: false,
        prompts: false,
        sampling: false
      }
    };
  });

  // Add the MCP server instance to fastify for potential use in other plugins
  fastify.decorate('mcpServer', mcpServer);

  // Cleanup on server close
  fastify.addHook('onClose', async () => {
    await mcpServer.stop();
  });
}
