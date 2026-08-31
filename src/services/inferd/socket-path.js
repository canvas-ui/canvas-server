'use strict';

import os from 'node:os';
import path from 'node:path';

/**
 * Where the inferd socket lives.
 *
 * canvas-server and canvas-inferd are separate packages that must nonetheless
 * agree on one path with nothing configured, so this rule is DUPLICATED
 * verbatim in canvas-inferd (src/socket-path.js). It is
 * deliberately pure — no probing, no filesystem checks — because a rule that
 * depends on what a process can write resolves differently for two processes
 * and the pair silently never meets.
 *
 * Precedence:
 *   1. CANVAS_INFERD_SOCKET        explicit wins, always
 *   2. $XDG_RUNTIME_DIR/canvas/inferd.sock   per-user runtime dir (desktop, dev)
 *   3. /run/canvas/inferd.sock     system service (systemd RuntimeDirectory=canvas)
 *
 * A box with no XDG_RUNTIME_DIR and no writable /run — some containers, some
 * CI — has to set CANVAS_INFERD_SOCKET. That is a loud failure at bind time
 * rather than a quiet one where the server waits forever on a socket the
 * daemon never created.
 */
export function defaultSocketPath(env = process.env) {
    if (env.CANVAS_INFERD_SOCKET) { return env.CANVAS_INFERD_SOCKET; }
    if (env.XDG_RUNTIME_DIR) { return path.join(env.XDG_RUNTIME_DIR, 'canvas', 'inferd.sock'); }
    return path.join('/run', 'canvas', 'inferd.sock');
}

/** Same rule, but falling back to the temp dir — for tests and throwaway runs. */
export function devSocketPath(env = process.env) {
    if (env.CANVAS_INFERD_SOCKET) { return env.CANVAS_INFERD_SOCKET; }
    if (env.XDG_RUNTIME_DIR) { return path.join(env.XDG_RUNTIME_DIR, 'canvas', 'inferd.sock'); }
    return path.join(os.tmpdir(), 'canvas-inferd.sock');
}

export default { defaultSocketPath, devSocketPath };
