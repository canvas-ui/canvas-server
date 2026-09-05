'use strict';

import path from 'path';
import fs from 'fs/promises';
import { createLogger } from '../../utils/log.js';
import { userStatePath } from '../user/lib/paths.js';

const DEVICE_SCHEMA = 'data/schema/device';

function pickDefined(data = {}) {
    return Object.fromEntries(
        Object.entries(data).filter(([, value]) => value !== undefined),
    );
}

class DeviceRegistry {
    #userHomePath;
    #usersIndex;
    #logger;

    constructor(options = {}) {
        if (!options.userHomePath) { throw new Error('userHomePath required'); }
        if (!options.usersIndex) { throw new Error('usersIndex required'); }

        this.#userHomePath = options.userHomePath;
        this.#usersIndex = options.usersIndex;
        this.#logger = options.logger || createLogger('device-registry');
    }

    /* --------------------
     * Public API
     * ------------------*/

    async listDevices(userId) {
        return Object.values(await this.#readDevices(userId));
    }

    async getDevice(userId, deviceId) {
        if (!deviceId) { return null; }
        const devices = await this.#readDevices(userId);
        return devices[deviceId] || null;
    }

    async getDeviceByAlias(userId, alias) {
        if (!alias) { return null; }
        const devices = await this.#readDevices(userId);
        return Object.values(devices).find((d) => d.alias === alias) || null;
    }

    async upsertDevice(userId, device = {}) {
        const deviceId = this.#requireDeviceId(device.deviceId);
        const devices = await this.#readDevices(userId);
        const existing = devices[deviceId] || null;
        const next = this.#buildDeviceRecord(device, existing);

        devices[deviceId] = next;
        await this.#writeDevices(userId, devices);
        return next;
    }

    async updateDevice(userId, deviceId, patch = {}) {
        const normalizedDeviceId = this.#requireDeviceId(deviceId);
        const devices = await this.#readDevices(userId);
        const existing = devices[normalizedDeviceId];

        if (!existing) {
            throw new Error(`Device "${normalizedDeviceId}" not found`);
        }

        const next = this.#buildDeviceRecord({
            ...existing,
            ...patch,
            deviceId: normalizedDeviceId,
        }, existing);

        devices[normalizedDeviceId] = next;
        await this.#writeDevices(userId, devices);
        return next;
    }

    async touchDevice(userId, deviceId, patch = {}) {
        const existing = await this.getDevice(userId, deviceId);
        if (!existing) { return null; }
        return this.updateDevice(userId, deviceId, patch);
    }

    /**
     * Forget a device entirely (its record and every mirror it reported).
     * Token revocation is the auth service's job — the route does both.
     */
    async removeDevice(userId, deviceId) {
        const normalizedDeviceId = this.#requireDeviceId(deviceId);
        const devices = await this.#readDevices(userId);
        if (!devices[normalizedDeviceId]) { return false; }
        delete devices[normalizedDeviceId];
        await this.#writeDevices(userId, devices);
        return true;
    }

    /* --------------------
     * Mirrors — what a device reports about the workspaces it keeps in sync.
     * Stored on the device record (`mirrors[workspaceId]`), never on the
     * workspace: the workspace travels between servers, the device pairing
     * does not.
     * ------------------*/

    async updateMirrorStatus(userId, deviceId, workspaceId, patch = {}) {
        const normalizedDeviceId = this.#requireDeviceId(deviceId);
        const wsId = String(workspaceId || '').trim();
        if (!wsId) { throw new Error('workspaceId is required'); }
        const devices = await this.#readDevices(userId);
        const existing = devices[normalizedDeviceId];
        if (!existing) { throw Object.assign(new Error(`Device "${normalizedDeviceId}" not found`), { statusCode: 404, code: 'DEVICE_NOT_FOUND' }); }
        const now = new Date().toISOString();
        const prior = existing.mirrors?.[wsId] || {};
        const mirror = pickDefined({
            ...prior,
            ...patch,
            workspaceId: wsId,
            backend: patch.backend || prior.backend || 'workspace:home',
            firstSeen: prior.firstSeen || now,
            lastSeen: now,
        });
        devices[normalizedDeviceId] = { ...existing, lastSeen: now, updatedAt: now, mirrors: { ...(existing.mirrors || {}), [wsId]: mirror } };
        await this.#writeDevices(userId, devices);
        return mirror;
    }

    async removeMirror(userId, deviceId, workspaceId) {
        const normalizedDeviceId = this.#requireDeviceId(deviceId);
        const wsId = String(workspaceId || '').trim();
        const devices = await this.#readDevices(userId);
        const existing = devices[normalizedDeviceId];
        if (!existing?.mirrors?.[wsId]) { return false; }
        const mirrors = { ...existing.mirrors };
        delete mirrors[wsId];
        devices[normalizedDeviceId] = { ...existing, updatedAt: new Date().toISOString(), mirrors };
        await this.#writeDevices(userId, devices);
        return true;
    }

    /** `[{ deviceId, name, platform, lastSeen, mirror }]` for one workspace. */
    async listMirrorsForWorkspace(userId, workspaceId) {
        const wsId = String(workspaceId || '').trim();
        const devices = await this.#readDevices(userId);
        return Object.values(devices)
            .filter((d) => d?.mirrors?.[wsId])
            .map((d) => ({ deviceId: d.deviceId, name: d.name, platform: d.platform, type: d.type, lastSeen: d.lastSeen, mirror: d.mirrors[wsId] }));
    }

    async ensureWorkspaceBinding(workspace, device = {}) {
        const deviceId = this.#requireDeviceId(device.deviceId);
        const now = new Date().toISOString();
        // No device/* asserted here: synapsd derives a Device document's own
        // id/os/arch/type keys from this row (Device.getFeatureBitmapArray), which
        // is what makes them survive a rebuild and untick on an OS upgrade.
        const featureArray = [DEVICE_SCHEMA];
        const context = workspace.getContextTreeSelector('/');
        const docs = await workspace.list({
            context,
            attributes: { allOf: [DEVICE_SCHEMA] },
            limit: 500,
        });
        const existing = Array.isArray(docs)
            ? docs.find((document) => document?.data?.deviceId === deviceId) || null
            : null;
        const username = device.username ?? existing?.data?.username;
        const hostname = device.hostname ?? existing?.data?.hostname;
        const data = pickDefined({
            ...(existing?.data || {}),
            deviceId,
            name: device.name || existing?.data?.name || hostname || deviceId,
            description: device.description ?? existing?.data?.description,
            platform: device.platform ?? existing?.data?.platform,
            osDistro: device.osDistro ?? existing?.data?.osDistro,
            osVersion: device.osVersion ?? existing?.data?.osVersion,
            arch: device.arch ?? existing?.data?.arch,
            type: device.type ?? existing?.data?.type,
            username,
            hostname,
            fqdn: device.fqdn ?? existing?.data?.fqdn,
            alias: device.alias ?? (username && hostname ? `${username}@${hostname}` : existing?.data?.alias),
            createdAt: existing?.data?.createdAt || device.createdAt || now,
            lastSeen: device.lastSeen || now,
        });

        if (existing?.id) {
            await workspace.put({ id: existing.id, data }, { context, attributes: { allOf: featureArray } });
            return { id: existing.id, created: false, data };
        }

        const id = await workspace.put({
            schema: DEVICE_SCHEMA,
            data,
        }, { context, attributes: { allOf: featureArray } });

        return { id, created: true, data };
    }

    /* --------------------
     * Storage
     * ------------------*/

    async #readDevices(userId) {
        const filePath = this.#getDevicesFilePath(userId);

        try {
            const raw = await fs.readFile(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            if (error.code === 'ENOENT') { return {}; }
            this.#logger.warn({ err: error, userId }, 'Failed to read devices');
            return {};
        }
    }

    async #writeDevices(userId, devices) {
        const filePath = this.#getDevicesFilePath(userId);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, JSON.stringify(devices, null, 2), 'utf8');
    }

    #getDevicesFilePath(userId) {
        const user = this.#usersIndex?.get?.(userId);
        const email = user?.email;

        if (!email) {
            throw new Error(`Cannot resolve device storage path for user ${userId}`);
        }

        return userStatePath(this.#userHomePath, email, 'config', 'devices.json');
    }

    /* --------------------
     * Normalization
     * ------------------*/

    #buildDeviceRecord(input = {}, existing = null) {
        const now = new Date().toISOString();
        const hasDescription = Object.prototype.hasOwnProperty.call(input, 'description');
        const description = hasDescription
            ? (typeof input.description === 'string' ? input.description.trim() || undefined : undefined)
            : existing?.description;

        const username = input.username ?? existing?.username;
        const hostname = input.hostname ?? existing?.hostname;

        return pickDefined({
            deviceId: this.#requireDeviceId(input.deviceId),
            // Human-readable handle: explicit name > hostname > raw uuid.
            name: String(input.name || existing?.name || hostname || input.deviceId).trim(),
            description,
            platform: input.platform ?? existing?.platform,
            arch: input.arch ?? existing?.arch,
            type: input.type ?? existing?.type,
            username,
            hostname,
            fqdn: input.fqdn ?? existing?.fqdn,
            alias: input.alias ?? (username && hostname ? `${username}@${hostname}` : existing?.alias),
            createdAt: existing?.createdAt || input.createdAt || now,
            updatedAt: now,
            lastSeen: input.lastSeen || now,
            // Mirror reports ride on the record; a touch/update must carry
            // them forward or every device request wipes them.
            mirrors: input.mirrors ?? existing?.mirrors,
        });
    }

    #requireDeviceId(deviceId) {
        const normalized = String(deviceId || '').trim();
        if (!normalized) {
            throw new Error('deviceId is required');
        }
        return normalized;
    }
}

export default DeviceRegistry;
