'use strict';

import fs from 'fs';
import os from 'os';
import path from 'path';

/*
 * The daemon's own home. Deliberately NOT src/env.js: there CANVAS_USER_HOME
 * means the server's users root, while for every client (cli, canvas-fuse,
 * desktop) it is the per-user config home (~/.canvas). The daemon is a client.
 */
export const EDGE_HOME = process.env.CANVAS_EDGE_HOME
    || process.env.CANVAS_USER_HOME
    || (process.platform === 'win32' ? path.join(os.homedir(), 'Canvas') : path.join(os.homedir(), '.canvas'));

export const EDGE_PATHS = Object.freeze({
    home: EDGE_HOME,
    mirrors: path.join(EDGE_HOME, 'config', 'mirrors.json'),
    remotes: path.join(EDGE_HOME, 'config', 'remotes.json'),
    device: process.env.CANVAS_DEVICE_FILE || (process.platform === 'win32'
        ? path.join(os.homedir(), 'Canvas', 'device.json')
        : path.join(os.homedir(), '.canvas', 'device.json')),
    run: path.join(EDGE_HOME, 'run'),
    socket: process.platform === 'win32' ? null : path.join(EDGE_HOME, 'run', 'edge.sock'),
    port: Number(process.env.CANVAS_EDGE_PORT) || 8802,
    log: path.join(EDGE_HOME, 'var', 'log', 'canvas-edge.log'),
});

export function readJson(file, fallback = null) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/**
 * Who this daemon is towards a hub. A device token is minted for one device
 * id, so when remotes.json holds one, THAT id is the identity (the hub rejects
 * status reports under any other); device.json is the fallback for
 * user/API tokens, then a stable host-derived id.
 */
export function deviceIdentity(hub = null) {
    const rec = readJson(EDGE_PATHS.device, null);
    const name = rec?.hostname || os.hostname();
    if (hub?.deviceId) return { deviceId: String(hub.deviceId), deviceName: name };
    if (rec?.deviceId) return { deviceId: String(rec.deviceId), deviceName: name };
    return { deviceId: `host-${os.hostname()}-${os.userInfo().username}`.replace(/[^a-zA-Z0-9._-]+/g, '-'), deviceName: name };
}

/** Hub url + token (+ the device id the token belongs to) for a remote id. */
export function hubFor(remoteId) {
    const remotes = readJson(EDGE_PATHS.remotes, {}) || {};
    const r = remotes[remoteId];
    if (!r?.url) return null;
    const deviceToken = r.device?.token || null;
    const token = deviceToken || r.auth?.token || null;
    return {
        id: remoteId,
        url: String(r.url).replace(/\/+$/, ''),
        apiBase: r.apiBase || '/rest/v2',
        token,
        deviceId: deviceToken && r.device?.deviceId ? String(r.device.deviceId) : null,
    };
}

/** Mirrors this daemon owns: `client: 'daemon'` entries of the CLI's mirrors.json. */
export function daemonMirrors() {
    const cfg = readJson(EDGE_PATHS.mirrors, { mirrors: [] }) || {};
    return (Array.isArray(cfg.mirrors) ? cfg.mirrors : []).filter((m) => m && m.client === 'daemon' && !m.paused);
}
