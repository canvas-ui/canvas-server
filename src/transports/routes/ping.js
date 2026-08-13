'use strict';

import { env } from '../../env.js';
import _os from 'os';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ResponseObject from '../ResponseObject.js';

// Installed canvas components whose versions the About page reports. Read once
// at startup — the installed tree cannot change under a running process.
const COMPONENT_PACKAGES = [
    'canvas-synapsd',
    'canvas-stored',
    'canvas-inferd',
    'canvas-agentd',
    'canvas-roles',
    'canvas-web',
];

function readComponentVersions() {
    const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const components = {};
    for (const name of COMPONENT_PACKAGES) {
        try {
            const pkg = JSON.parse(readFileSync(path.join(serverRoot, 'node_modules', name, 'package.json'), 'utf8'));
            if (pkg.version) components[name] = pkg.version;
        } catch { /* not installed — omit */ }
    }
    return components;
}

const componentVersions = readComponentVersions();

/**
 * Ping route for server status (no authentication required)
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function pingRoute(fastify, _options) {
  // Simple ping endpoint
  fastify.get('/ping', async (_request, _reply) => {
    return { pong: `Hello, world! (${env.app.name} v${env.app.version})` };
  });

  // Debug endpoint to check auth and server decorators
  fastify.get('/debug', {
    onRequest: [fastify.authenticate]
  }, async (request, _reply) => {
    // List all decorators on the server
    const decorators = Object.keys(fastify).filter(key =>
      typeof fastify[key] !== 'function' ||
      key.startsWith('has') ||
      ['decorate', 'register', 'listen'].includes(key)
    );

    // Get user information if authenticated
    const userInfo = request.user ? {
      id: request.user.id,
      email: request.user.email,
      isApiToken: !!request.isApiTokenAuth
    } : null;

    return {
      auth: {
        authenticated: !!request.user,
        method: request.isApiTokenAuth ? 'api_token' : 'jwt',
        user: userInfo
      },
      server: {
        decorators: decorators,
        hasUserManager: fastify.hasDecorator('userManager'),
        hasWorkspaceManager: fastify.hasDecorator('workspaceManager'),
        hasContextManager: fastify.hasDecorator('contextManager'),
        hasAuthService: fastify.hasDecorator('authService')
      }
    };
  });

  fastify.get('/rest/v2/ping', {
  }, async (request, reply) => {
    // Basic system info
    const response = new ResponseObject().success({
      appName: env.app.name,
      productName: env.app.productName,
      version: env.app.version,
      // AGPL §13: anyone interacting with this server over a network is entitled
      // to its corresponding source. This is the unauthenticated, machine-readable
      // half of that offer (the web UI carries the human-readable link); a fork
      // must repoint sourceUrl at its own repository rather than strip it.
      license: env.app.license,
      sourceUrl: env.app.sourceUrl,
      commit: env.app.commit,
      // Versions of the installed canvas-* components (Settings > About)
      components: componentVersions,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      defaults: {
        // Preselected in the workspace-creation UI; the server applies the same
        // value when a create call omits `layout`.
        workspaceLayout: env.workspace.defaultLayout,
      }
    }, 'Server status retrieved successfully');
    return reply.code(response.statusCode).send(response.getResponse());
  });
}
