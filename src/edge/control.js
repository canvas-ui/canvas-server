'use strict';

import fs from 'fs';
import Fastify from 'fastify';
import { EDGE_PATHS } from './env.js';

/**
 * Local control API for the CLI (unix socket, 0600; a localhost port on
 * Windows). Nothing here is reachable from the network.
 */
export async function startControl({ runtimes, reload, shutdown, logger }) {
    const app = Fastify({ logger: false });
    const byId = (id) => runtimes.get(id) || [...runtimes.values()].find((r) => r.status().workspace === id) || null;

    app.get('/status', async () => ({ pid: process.pid, mirrors: [...runtimes.values()].map((r) => r.status()) }));
    app.get('/mirrors', async () => [...runtimes.values()].map((r) => r.status()));
    app.post('/mirrors/:id/resync', async (req, reply) => {
        const r = byId(req.params.id);
        if (!r) return reply.code(404).send({ error: 'no such mirror' });
        await r.resync();
        return r.status();
    });
    app.post('/mirrors/:id/nudge', async (req, reply) => {
        const r = byId(req.params.id);
        if (!r) return reply.code(404).send({ error: 'no such mirror' });
        r.nudge();
        return { ok: true };
    });
    app.post('/reload', async () => { await reload(); return { ok: true, mirrors: runtimes.size }; });
    app.post('/shutdown', async () => { setTimeout(() => shutdown(), 50); return { ok: true }; });

    if (EDGE_PATHS.socket) {
        fs.mkdirSync(EDGE_PATHS.run, { recursive: true });
        try { fs.unlinkSync(EDGE_PATHS.socket); } catch { /* absent */ }
        await app.listen({ path: EDGE_PATHS.socket });
        fs.chmodSync(EDGE_PATHS.socket, 0o600);
        logger.info({ socket: EDGE_PATHS.socket }, 'control socket ready');
    } else {
        await app.listen({ host: '127.0.0.1', port: EDGE_PATHS.port });
        logger.info({ port: EDGE_PATHS.port }, 'control port ready');
    }
    return app;
}
