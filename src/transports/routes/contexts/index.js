'use strict';

import lifecycleRoutes from './lifecycle.js';
import documentRoutes from './documents.js';
import treeRoutes from './tree.js';
import tokenRoutes from './tokens.js';
import shareRoutes from './shares.js';
import { resolveContextAddress } from '../../middleware/address-resolver.js';

/**
 * Context routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function contextRoutes(fastify, options) {
  fastify.register(lifecycleRoutes, { prefix: '/' });
  fastify.register(documentRoutes, {
    prefix: '/:id/documents',
    onRequest: [resolveContextAddress]
  });
  fastify.register(import('./dotfiles.js'), {
    prefix: '/:id/dotfiles',
    onRequest: [resolveContextAddress]
  });

  fastify.register(treeRoutes, {
    prefix: '/:id/tree',
    onRequest: [resolveContextAddress]
  });

  fastify.register(tokenRoutes, {
    prefix: '/',
    onRequest: [resolveContextAddress]
  });

  fastify.register(shareRoutes, {
    prefix: '/',
    onRequest: [resolveContextAddress]
  });

  // Additional general routes for /contexts if any can go here
  // For example, the current GET / and POST / for listing/creating contexts
  // might stay here or be moved to lifecycle.js depending on preference.
  // For now, I'll assume they are part of lifecycle.
}
