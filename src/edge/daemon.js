'use strict';

import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { EDGE_PATHS, daemonMirrors, deviceIdentity, hubFor } from './env.js';
import { MirrorRuntime } from './mirror-runtime.js';
import { startControl } from './control.js';

/*
 * canvas-edge: the device-side daemon for real-folder mirrors (the non-FUSE
 * client of the sync protocol, for macOS/Windows and anyone who wants a plain
 * folder). One process per device runs every `client: 'daemon'` mirror from
 * ~/.canvas/config/mirrors.json; the CLI (`canvas mirror`) writes that file and
 * talks to this process over the control socket.
 */
export async function main(argv = process.argv.slice(2)) {
    const foreground = argv.includes('--foreground') || argv.includes('-f');
    fs.mkdirSync(path.dirname(EDGE_PATHS.log), { recursive: true });
    const logger = foreground
        ? pino({ level: process.env.LOG_LEVEL || 'info' })
        : pino({ level: process.env.LOG_LEVEL || 'info' }, pino.destination({ dest: EDGE_PATHS.log, sync: false }));

    const runtimes = new Map();

    const load = async () => {
        const wanted = daemonMirrors();
        const wantedIds = new Set(wanted.map((m) => m.id));
        for (const [id, rt] of runtimes) {
            if (!wantedIds.has(id)) { await rt.stop().catch(() => {}); runtimes.delete(id); logger.info({ mirror: id }, 'mirror stopped (removed from config)'); }
        }
        for (const mirror of wanted) {
            if (runtimes.has(mirror.id)) continue;
            const hub = hubFor(mirror.remote);
            if (!hub?.token) { logger.warn({ mirror: mirror.id, remote: mirror.remote }, 'no credentials for hub — skipped'); continue; }
            const identity = deviceIdentity(hub);
            const rt = new MirrorRuntime({ mirror, hub, identity, logger });
            try {
                await rt.start();
                runtimes.set(mirror.id, rt);
            } catch (err) {
                logger.error({ mirror: mirror.id, err: err?.message }, 'mirror failed to start');
            }
        }
    };

    let stopping = false;
    const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        logger.info('shutting down');
        for (const rt of runtimes.values()) await rt.stop().catch(() => {});
        await control?.close().catch(() => {});
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('SIGHUP', () => load().catch((err) => logger.error({ err: err?.message }, 'reload failed')));

    const control = await startControl({ runtimes, reload: load, shutdown, logger });
    await load();
    logger.info({ device: deviceIdentity().deviceId, mirrors: runtimes.size }, 'canvas-edge running');
}
