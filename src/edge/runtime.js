'use strict';

import EdgeClient from './EdgeClient.js';
import { readWorkspaceConfig, listRemotes } from './remote-config.js';

/**
 * Edge runtime bootstrap for a single-workspace host (the `ws` binary):
 * read the workspace's own workspace.json, and auto-register with every
 * enabled remote canvas-server it lists.
 *
 * The workspace id doubles as the tunnel instanceId — a ws runtime hosts
 * exactly one workspace, so its identity *is* the workspace's identity.
 */

export function buildAnnounce(config = {}, { runtime = 'ws', version = '0.0.1' } = {}) {
  if (!config.id) throw new Error('workspace.json has no id — cannot announce');
  return {
    instanceId: config.id,
    runtime,
    version,
    caps: ['proxy', 'streaming'],
    exports: [
      { type: 'workspace', id: config.id, name: config.name || config.label || config.id },
    ],
  };
}

/**
 * Connect to all enabled remotes. Returns `{ clients, close }`.
 *
 * @param {Object} opts
 * @param {string} opts.dir - workspace directory (contains workspace.json)
 * @param {Object} opts.localApp - fastify instance serving the local API
 * @param {Object} [opts.events] - wildcard emitter whose events relay upstream
 * @param {Function} [opts.clientFactory] - injectable for tests
 */
export function connectRemotes({ dir, localApp, events, clientFactory } = {}) {
  const config = readWorkspaceConfig(dir);
  const announce = buildAnnounce(config);
  const createClient = clientFactory || ((clientOpts) => new EdgeClient(clientOpts).connect());

  const clients = listRemotes(config)
    .filter((remote) => remote.enabled)
    .map((remote) => {
      const client = createClient({
        serverUrl: remote.url,
        token: remote.token,
        localApp,
        announce,
      });
      if (events && client.forwardEvents) client.forwardEvents(events);
      return client;
    });

  return {
    clients,
    close() {
      for (const client of clients) client.close?.();
    },
  };
}
