'use strict';

import fs from 'fs';
import path from 'path';
import { env } from '../env.js';
import { generateNanoid } from './id.js';

/**
 * Stable identity of THIS canvas-server install (`<SERVER_HOME>/db/instance.json`,
 * created once, never rotated). Remote peers key on it — a device mirror stamps
 * the hub's instance id into its ledger so a re-pointed URL (new host, new
 * port, tunnel) is routing detail, never a new hub. Readable by anyone who can
 * ping the server; it carries no secret.
 */

let cached = null;

export function instanceFilePath(serverHome = env.server.home) {
    return path.join(serverHome, 'db', 'instance.json');
}

export function getInstanceId(serverHome = env.server.home) {
    if (cached && cached.home === serverHome) return cached.instanceId;
    const file = instanceFilePath(serverHome);
    let record = null;
    try {
        record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* absent or unreadable — create below */ }
    if (!record?.instanceId || typeof record.instanceId !== 'string') {
        record = { instanceId: generateNanoid(16), createdAt: new Date().toISOString() };
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            // Exclusive create: two workers racing on first boot keep one id.
            fs.writeFileSync(file, JSON.stringify(record, null, 2), { flag: 'wx' });
        } catch (err) {
            if (err.code === 'EEXIST') {
                try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* keep ours */ }
            }
            // Any other failure (read-only home): the id lives for this process only.
        }
    }
    cached = { home: serverHome, instanceId: record.instanceId };
    return record.instanceId;
}

/** Test seam. */
export function resetInstanceIdCache() { cached = null; }
