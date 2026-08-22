'use strict';

import workspaceRoutes from './routes/workspaces/index.js';
import contextRoutes from './routes/contexts/index.js';

/**
 * The explicit contract between route plugins and the fastify instance they
 * mount on. Anything a route group reads off `fastify.*` must be listed here —
 * this is what lets the same plugins register on the full canvas-server or on
 * a bare canvas-edge instance that provides its own implementations.
 */

// Service option keys decorated verbatim onto the instance when present.
export const SERVICE_DECORATIONS = [
  'users',
  'workspaceManager',
  'contextManager',
  'dotfileManager',
  'roles',
  'agents',
  'authService',
  'deviceRegistry',
  'userConfig',
  'messaging',
  'chatRouter',
  'voice',
];

// Decorations the workspaces route group requires on its instance.
// `jwt` comes from @fastify/jwt (streaming tokens in documents.js);
// `broadcastToUser` comes from the websocket layer (edge: stub or tunnel relay).
export const WORKSPACES_CONTRACT = [
  'authenticate',
  'authenticateClient',
  'workspaceManager',
  'deviceRegistry',
  'dotfileManager',
  'contextManager',
  'users',
  'authService',
  'jwt',
  'broadcastToUser',
];

// Decorations the contexts route group requires on its instance.
export const CONTEXTS_CONTRACT = [
  'authenticate',
  'authenticateClient',
  'contextManager',
  'workspaceManager',
  'users',
];

export function decorateServices(app, options = {}) {
  for (const name of SERVICE_DECORATIONS) {
    if (options[name] && !app.hasDecorator(name)) {
      app.decorate(name, options[name]);
    }
  }
}

export function assertContract(app, names, label) {
  const missing = names.filter((name) => !app.hasDecorator(name));
  if (missing.length) {
    throw new Error(`${label}: missing required decorations: ${missing.join(', ')}`);
  }
}

/**
 * Mount the workspaces REST API on any fastify instance satisfying
 * WORKSPACES_CONTRACT — the full server or a bare canvas-edge runtime.
 */
function mountRoutes(app, routes, prefix, preHandlers, onRequest = []) {
  if (!preHandlers.length && !onRequest.length) {
    app.register(routes, { prefix });
    return;
  }
  app.register(async (instance) => {
    // Scope-level onRequest hooks run before the routes' own onRequest chain
    // (auth, ACL) and before body parsing — where a forwarder has to sit.
    for (const handler of onRequest) instance.addHook('onRequest', handler);
    for (const handler of preHandlers) instance.addHook('preHandler', handler);
    await instance.register(routes);
  }, { prefix });
}

/**
 * Mount the workspaces REST API on any fastify instance satisfying
 * WORKSPACES_CONTRACT — the full server or a bare canvas-edge runtime.
 * `preHandlers` lets the caller apply instance policy (e.g. agent-token
 * rejection) without the route group knowing about it.
 */
export function mountWorkspacesApi(app, { prefix = '/rest/v2/workspaces', preHandlers = [], onRequest = [] } = {}) {
  assertContract(app, WORKSPACES_CONTRACT, 'workspaces api');
  mountRoutes(app, workspaceRoutes, prefix, preHandlers, onRequest);
}

/** Mount the contexts REST API; same contract idea as mountWorkspacesApi. */
export function mountContextsApi(app, { prefix = '/rest/v2/contexts', preHandlers = [] } = {}) {
  assertContract(app, CONTEXTS_CONTRACT, 'contexts api');
  mountRoutes(app, contextRoutes, prefix, preHandlers);
}
