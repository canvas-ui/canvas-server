'use strict';

/**
 * canvas-edge — reusable tunnel module.
 *
 * Client side (zero core/ dependencies; safe for bun-compiled runtimes):
 *   EdgeClient       — dial out, announce, dispatch proxied requests
 *   connectRemotes   — auto-register from workspace.json `remotes`
 *   remote-config    — read/write the `remotes` entries
 *
 * Server side:
 *   EdgeRegistry     — track announced edges, assemble proxied responses
 *
 * Consumers import via the package subpath: `canvas-server/edge`.
 * Protocol: docs/canvas-edge-protocol.md
 */

export { default as EdgeClient } from './EdgeClient.js';
export { default as EdgeRegistry } from './registry.js';
export { connectRemotes, buildAnnounce } from './runtime.js';
export { readWorkspaceConfig, listRemotes, saveRemote, removeRemote } from './remote-config.js';
