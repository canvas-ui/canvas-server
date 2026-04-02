'use strict';

import path from 'path';
import fs from 'fs/promises';
import { createLogger } from '../../utils/log.js';
import { buildDeviceFeatureTags } from '../../utils/device-features.js';

const DEVICE_SCHEMA = 'data/abstraction/device';

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

    async ensureWorkspaceBinding(workspace, device = {}) {
        const deviceId = this.#requireDeviceId(device.deviceId);
        const now = new Date().toISOString();
        const featureArray = [DEVICE_SCHEMA, ...buildDeviceFeatureTags({
            deviceId,
            deviceOs: device.platform || device.os,
            deviceType: device.type,
        })];
        const context = workspace.getContextTreeSelector('/');
        const docs = await workspace.find({
            context,
            attributes: { allOf: [DEVICE_SCHEMA] },
            limit: 500,
        });
        const existing = Array.isArray(docs)
            ? docs.find((document) => document?.data?.deviceId === deviceId) || null
            : null;
        const data = pickDefined({
            ...(existing?.data || {}),
            deviceId,
            name: device.name || existing?.data?.name || deviceId,
            description: device.description ?? existing?.data?.description,
            platform: device.platform ?? existing?.data?.platform,
            arch: device.arch ?? existing?.data?.arch,
            type: device.type ?? existing?.data?.type,
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

        return path.join(this.#userHomePath, email, 'config', 'devices.json');
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

        return pickDefined({
            deviceId: this.#requireDeviceId(input.deviceId),
            name: String(input.name || existing?.name || input.deviceId).trim(),
            description,
            platform: input.platform ?? existing?.platform,
            arch: input.arch ?? existing?.arch,
            type: input.type ?? existing?.type,
            createdAt: existing?.createdAt || input.createdAt || now,
            updatedAt: now,
            lastSeen: input.lastSeen || now,
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
