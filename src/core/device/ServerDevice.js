'use strict';

import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { env } from '../../env.js';
import { createLogger } from '../../utils/log.js';

const logger = createLogger('server-device');

/**
 * The server's own device identity — the URL authority for
 * file://<deviceId>/<path> locations authored by this instance (fs data
 * backends). deviceId is a uuid, NOT a machine-id: identity survives OS
 * reinstalls by restoring <SERVER_HOME>/config/device.json, setting
 * CANVAS_DEVICE_ID, or re-associating through the device registry. The
 * metadata fields (hostname/fqdn/os/arch/user) exist to make that
 * re-association decision by a human possible.
 *
 * `name` is the human-readable handle (defaults to the hostname) used for
 * display and as the device segment of backend mirror paths
 * (/device/<device-name>/<mount>); the uuid never surfaces in tree paths.
 */

let cached = null;

function detectType() {
    const platform = os.platform();
    if (platform === 'darwin') return 'mac';
    if (platform === 'win32') return 'windows';
    if (platform === 'linux') {
        if (process.env.CONTAINER || process.env.DOCKER) return 'container';
        if (!process.env.DISPLAY) return 'server';
        return 'linux';
    }
    return 'generic';
}

/**
 * Distro and version, for the `device/os/linux/ubuntu/24.04` facet chain — the
 * axis a fleet actually differs along, since 22.04 and 24.04 are not
 * interchangeable targets for anything you might install.
 *
 * Linux only. /etc/os-release is the one cross-distro contract for this and is
 * present on non-systemd distros too. macOS and Windows would each need their
 * own version heuristic (Darwin kernel and NT build number respectively map to
 * the marketing version only by table) and no caller needs it yet; the key shape
 * already accommodates them, so that stays a client-side change.
 *
 * NB: canvas/apps/cli/src/modules/dot/lib/device.js carries the same probe.
 * Separate packages with no shared dependency, and the file format is frozen by
 * spec — cheaper duplicated than coupled.
 */
function detectOsRelease() {
    if (os.platform() !== 'linux') { return {}; }
    try {
        const fields = Object.fromEntries(
            fs.readFileSync('/etc/os-release', 'utf8')
                .split('\n')
                .map((line) => line.match(/^([A-Z_]+)=(.*)$/))
                .filter(Boolean)
                .map(([, key, value]) => [key, value.replace(/^"|"$/g, '').trim()]),
        );
        return { osDistro: fields.ID || undefined, osVersion: fields.VERSION_ID || undefined };
    } catch {
        return {};
    }
}

function currentUsername() {
    try {
        return os.userInfo().username;
    } catch {
        return null;
    }
}

function pickDefined(data = {}) {
    return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== null));
}

/**
 * Load-or-create the server device identity (lazy singleton, sync — read once
 * per process). Always re-collects live metadata; deviceId/name/description
 * are the durable, user-controlled fields.
 * @returns {{deviceId: string, name: string, hostname: string, platform: string, arch: string, type: string}}
 */
export function getServerDevice() {
    if (cached) return cached;

    const filePath = path.join(env.server.home, 'config', 'device.json');
    let saved = null;
    try {
        saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logger.warn(`Unreadable device identity at ${filePath}: ${error.message}`);
        }
    }

    const now = new Date().toISOString();
    const hostname = os.hostname();
    const device = pickDefined({
        deviceId: process.env.CANVAS_DEVICE_ID?.trim() || saved?.deviceId || randomUUID(),
        name: process.env.CANVAS_DEVICE_NAME?.trim() || saved?.name || hostname,
        description: saved?.description,
        hostname,
        fqdn: hostname.includes('.') ? hostname : saved?.fqdn,
        platform: os.platform(),
        ...detectOsRelease(),
        // os.machine() (x86_64/aarch64), not os.arch() (x64/arm64): the former is
        // the vocabulary flatpak, snap and appimage publish against, so a device
        // facet and a package's capability compare without a translation table.
        arch: os.machine ? os.machine() : os.arch(),
        release: os.release(),
        type: saved?.type || detectType(),
        username: currentUsername(),
        createdAt: saved?.createdAt || now,
    });

    // Persist only on material change so a plain restart never rewrites the file.
    const material = ({ _updatedAt, ...rest } = {}) => JSON.stringify(rest);
    if (!saved || material(saved) !== material(device)) {
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, JSON.stringify({ ...device, updatedAt: now }, null, 2));
            logger.info(`Server device identity ${saved ? 'updated' : 'created'}: ${device.name} (${device.deviceId})`);
        } catch (error) {
            logger.warn(`Failed to persist device identity to ${filePath}: ${error.message}`);
        }
    }

    cached = device;
    return device;
}

export default getServerDevice;
