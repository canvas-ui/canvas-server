'use strict';

import ResponseObject from '../ResponseObject.js';

/**
 * Create middleware to resolve resource addresses in URL parameters
 * @param {string} resourceType - Type of resource ('workspace' or 'context')
 * @returns {Function} Middleware function
 */
export function createAddressResolver(resourceType = 'workspace') {
  return async function resolveAddress(request, reply) {
    const addressParam = request.params.id;

    if (!addressParam) {
      return; // No ID parameter to process
    }

    // Check if it's a user/resource address (contains '/')
    if (addressParam.includes('/')) {
      let resolvedId = null;

      try {
        if (resourceType === 'workspace') {
          // Use WorkspaceManager to resolve simple identifier
          resolvedId = await request.server.workspaceManager.resolveWorkspaceIdFromSimpleIdentifier(addressParam);
        } else if (resourceType === 'context') {
          // Use ContextManager to resolve simple identifier
          resolvedId = await request.server.contextManager.resolveContextIdFromSimpleIdentifier(addressParam);
        }

        if (resolvedId) {
          // Store original address for potential use in response
          request.originalAddress = addressParam;
          // Replace the ID parameter with the resolved internal ID
          request.params.id = resolvedId;
          return; // Successfully resolved
        }

        // Could not resolve the address
        const response = new ResponseObject().notFound(`${resourceType} not found: ${addressParam}`);
        return reply.code(response.statusCode).send(response.getResponse());

      } catch (error) {
        console.error(`Error resolving ${resourceType} address ${addressParam}:`, error.message);
        const response = new ResponseObject().badRequest(`Invalid ${resourceType} address format: ${addressParam}`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
    }

    // Not a user/resource address format, pass through as-is
    // The existing route handlers will validate it as a direct ID
  };
}

/**
 * Middleware for resolving workspace addresses
 */
export const resolveWorkspaceAddress = createAddressResolver('workspace');

/**
 * Middleware for resolving context addresses
 */
export const resolveContextAddress = createAddressResolver('context');
