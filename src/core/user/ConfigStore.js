'use strict';

import path from 'path';
import fs from 'fs/promises';
import { createLogger } from '../../utils/log.js';

/**
 * UserConfigStore - per-user client configuration as plain JSON under
 * <userHome>/<email>/config/<name>.json, alongside tokens.json and devices.json.
 *
 * The store is deliberately schema-less: it round-trips whatever object the
 * client owns (webui.json). The server never introspects it, the same way canvas
 * layer metadata is opaque to the backend.
 *
 * `embedd` is the exception and it matters: the server DOES read and act on it
 * (it selects the embedding backends a user's workspaces run), so it must be
 * validated before it lands here. Validation lives in the route rather than the
 * store, keeping the store schema-less while ensuring nothing invalid is ever
 * persisted — embedd itself also refuses to trust it, falling back to server
 * defaults if a stored config no longer resolves.
 */

// The name lands in a filesystem path, so an open parameter would be a
// traversal vector. Whitelist rather than sanitize.
const ALLOWED_CONFIGS = new Set(['webui', 'embedd']);

// Configs the server acts on, which therefore may NOT be written through the
// generic schema-less /me/config/:name route — they have a dedicated endpoint
// that validates the shape, checks the endpoints it points at, and redacts
// secrets on read. Without this the generic PUT would be a way to store an
// arbitrary, unvalidated embedding config.
const VALIDATED_CONFIGS = new Set(['embedd']);

const MAX_CONFIG_BYTES = 256 * 1024;

class UserConfigStore {
    #userHomePath;
    #usersIndex;
    #logger;

    constructor(options = {}) {
        if (!options.userHomePath) { throw new Error('userHomePath required'); }
        if (!options.usersIndex) { throw new Error('usersIndex required'); }

        this.#userHomePath = options.userHomePath;
        this.#usersIndex = options.usersIndex;
        this.#logger = options.logger || createLogger('user-config');
    }

    static isValidName(name) {
        return ALLOWED_CONFIGS.has(name);
    }

    /** True when this config has a dedicated validating endpoint of its own. */
    static requiresValidation(name) {
        return VALIDATED_CONFIGS.has(name);
    }

    static get names() {
        return [...ALLOWED_CONFIGS];
    }

    /* --------------------
     * Public API
     * ------------------*/

    async read(userId, name) {
        const filePath = this.#getConfigFilePath(userId, name);

        try {
            const raw = await fs.readFile(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (error) {
            if (error.code === 'ENOENT') { return {}; }
            this.#logger.warn({ err: error, userId, name }, 'Failed to read user config');
            return {};
        }
    }

    async write(userId, name, config) {
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
            throw new Error('User config must be a JSON object');
        }

        const serialized = JSON.stringify(config, null, 2);
        if (Buffer.byteLength(serialized, 'utf8') > MAX_CONFIG_BYTES) {
            throw new Error(`User config exceeds the ${MAX_CONFIG_BYTES} byte limit`);
        }

        const filePath = this.#getConfigFilePath(userId, name);
        await fs.mkdir(path.dirname(filePath), { recursive: true });

        // Write-then-rename: a torn write here loses every pinned canvas the
        // user has, and the whole file is rewritten on each change.
        const tempPath = `${filePath}.tmp`;
        await fs.writeFile(tempPath, serialized, 'utf8');
        await fs.rename(tempPath, filePath);

        return config;
    }

    /* --------------------
     * Storage
     * ------------------*/

    #getConfigFilePath(userId, name) {
        if (!UserConfigStore.isValidName(name)) {
            throw new Error(`Unknown user config "${name}"`);
        }

        const user = this.#usersIndex?.get?.(userId);
        const email = user?.email;

        if (!email) {
            throw new Error(`Cannot resolve config storage path for user ${userId}`);
        }

        return path.join(this.#userHomePath, email, 'config', `${name}.json`);
    }
}

export default UserConfigStore;
