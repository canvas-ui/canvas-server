
import path from 'path';
import { existsSync } from 'fs';
import Conf from 'conf';

// Logging
import { createLogger } from '../log.js';

/**
 * For now, the only supported driver is Conf
 */

class JsonIndexManager {

    #logger;

    constructor(options = {}) {
        if (!options.rootPath) {
            throw new Error('rootPath is required');
        }

        this.rootPath = options.rootPath;
        this.driver = options.driver || 'conf';
        this.driverOptions = options.driverOptions || {};
        this.#logger = options.logger || createLogger('jim');
        this.#logger.debug({ rootPath: this.rootPath, driver: this.driver, driverOptions: this.driverOptions }, 'Initializing JsonIndexManager');
        this.indices = new Map();
    }

    // options: string (legacy driver shorthand) or { driver, scope }.
    // scope nests the index file under rootPath/<scope>/<name>.json — used for
    // per-user indexes (scope: `users/<userId>`).
    #resolveOptions(options) {
        if (typeof options === 'string') {
            return { driver: options, scope: null };
        }
        return {
            driver: options?.driver || this.driver,
            scope: options?.scope || null,
        };
    }

    #indexId(name, driver, scope) {
        return `${scope || ''}/${name}/${driver}`;
    }

    createIndex(name, options = {}) {
        const { driver, scope } = this.#resolveOptions(options);
        const id = this.#indexId(name, driver, scope);
        if (this.indices.has(id)) {
            console.warn(`Index '${name}' already exists for driver ${driver}${scope ? ` (scope ${scope})` : ''}`);
            return this.indices.get(id);
        }

        if (driver !== 'conf') {
            throw new Error(`Unsupported driver: ${driver}`);
        }

        const index = new Conf({
            configName: name,
            cwd: scope ? path.join(this.rootPath, scope) : this.rootPath,
            ...this.driverOptions,
        });

        this.indices.set(id, index);
        return index;
    }

    // Create-if-missing without the duplicate warning — the accessor for
    // lazily-opened scoped indexes.
    getOrCreateIndex(name, options = {}) {
        const { driver, scope } = this.#resolveOptions(options);
        const id = this.#indexId(name, driver, scope);
        if (this.indices.has(id)) {
            return this.indices.get(id);
        }
        return this.createIndex(name, { driver, scope });
    }

    hasIndexFile(name, options = {}) {
        const { scope } = this.#resolveOptions(options);
        const dir = scope ? path.join(this.rootPath, scope) : this.rootPath;
        return existsSync(path.join(dir, `${name}.json`));
    }

    getIndex(name, options = {}) {
        const { driver, scope } = this.#resolveOptions(options);
        const id = this.#indexId(name, driver, scope);

        if (!this.indices.has(id)) {
            throw new Error(`Index '${name}' for driver ${driver} not found`);
        }

        return this.indices.get(id);
    }

    listIndexes() {
        return Array.from(this.indices.keys());
    }
}

export default JsonIndexManager;
