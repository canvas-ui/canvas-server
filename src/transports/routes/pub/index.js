'use strict';

import workspaceRoutes from './workspaces.js';
import contextRoutes from './contexts.js';
import tokenRoutes from './tokens.js';

/**
 * Public/shared resource routes registry
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function pubRoutes(fastify, options) {

  // Register workspace sharing routes
  fastify.register(workspaceRoutes, { prefix: '/workspaces' });

  // Register context sharing routes
  fastify.register(contextRoutes, { prefix: '/contexts' });

  // Register token management routes
  fastify.register(tokenRoutes, { prefix: '/tokens' });

  // Health check endpoint for pub routes
  fastify.get('/health', async (request, reply) => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      routes: ['workspaces', 'contexts', 'tokens']
    };
  });
}
