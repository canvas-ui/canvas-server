'use strict';

import path from 'path';
import { existsSync } from 'fs';
import * as fsPromises from 'fs/promises';
import EventEmitter from 'eventemitter2';
import Stored from '../../../../services/stored/src/index.js';
import { createLogger } from '../../../../utils/log.js';

const logger = createLogger('home-service');

const HOME_DIR = 'home';

/**
 * HomeService - Manages workspace home directories with file indexing
 *
 * When enabled for a workspace:
 * - Creates {workspace}/home directory
 * - Sets up Stored backend with file watching
 * - Auto-indexes files and syncs with synapsd (File documents)
 * - Handles file deduplication (dataPath removal vs document deletion)
 */
class HomeService extends EventEmitter {
    #workspaceManager;
    #storedInstances = new Map(); // workspaceId -> Stored instance

    constructor(options = {}) {
        super();
        this.#workspaceManager = options.workspaceManager;
        if (!this.#workspaceManager) {
            throw new Error('WorkspaceManager is required');
        }
    }

    async initialize() {
        logger.debug('HomeService initialized');
        return this;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Enable home service for a workspace
     */
    async enable(workspace) {
        if (!workspace?.id) throw new Error('Invalid workspace');

        const homePath = path.join(workspace.rootPath, HOME_DIR);

        // Ensure home directory exists
        if (!existsSync(homePath)) {
            logger.debug(`Creating home directory at ${homePath}`);
            await fsPromises.mkdir(homePath, { recursive: true });
        }

        // Initialize Stored instance for this workspace
        const stored = await this.#initializeStored(workspace, homePath);

        // Initial scan and sync to synapsd
        const files = await stored.scan();
        await this.#syncInitialFiles(workspace, stored, files);
        logger.debug(`Home service enabled for workspace ${workspace.id}`);

        this.emit('home.enabled', { workspaceId: workspace.id, path: homePath });
        return { success: true, path: homePath };
    }

    /**
     * Disable home service for a workspace
     */
    async disable(workspace) {
        if (!workspace?.id) return { success: true };

        const stored = this.#storedInstances.get(workspace.id);
        if (stored) {
            await stored.stop();
            this.#storedInstances.delete(workspace.id);
            logger.debug(`Home service disabled for workspace ${workspace.id}`);
        }

        this.emit('home.disabled', { workspaceId: workspace.id });
        return { success: true };
    }

    /**
     * Check if home service is running for a workspace
     */
    isEnabled(workspaceId) {
        return this.#storedInstances.has(workspaceId);
    }

    /**
     * Get status of home service for a workspace
     */
    async getStatus(workspace) {
        if (!workspace?.id) return { enabled: false };

        const homePath = path.join(workspace.rootPath, HOME_DIR);
        const stored = this.#storedInstances.get(workspace.id);

        return {
            enabled: !!stored,
            path: homePath,
            exists: existsSync(homePath),
            backends: stored ? stored.listBackends() : [],
        };
    }

    /**
     * Get the home directory path for a workspace
     */
    getHomePath(workspace) {
        if (!workspace?.rootPath) return null;
        return path.join(workspace.rootPath, HOME_DIR);
    }

    /**
     * Get the Stored instance for a workspace (if enabled)
     */
    getStored(workspaceId) {
        return this.#storedInstances.get(workspaceId) || null;
    }

    /**
     * Rescan files in workspace home
     */
    async rescan(workspace) {
        const stored = this.#storedInstances.get(workspace.id);
        if (!stored) {
            throw new Error('Home service not enabled for this workspace');
        }
        return stored.scan();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private
    // ─────────────────────────────────────────────────────────────────────────

    async #initializeStored(workspace, homePath) {
        // Create Stored instance with workspace-specific index
        const indexPath = path.join(workspace.rootPath, 'var', 'home-index');

        const stored = new Stored({
            index: { path: indexPath },
            checksums: ['sha256'],
            primaryChecksum: 'sha256',
        });

        // Add home directory as file backend with watching
        stored.addBackend('fs:home', {
            driver: 'file',
            root: homePath,
            watch: true,
        });

        // Wire up events to sync with synapsd
        stored.on('file:add', (data) => this.#handleFileAdd(workspace, data));
        stored.on('file:change', (data) => this.#handleFileChange(workspace, data));
        stored.on('file:unlink', (data) => this.#handleFileUnlink(workspace, data));

        this.#storedInstances.set(workspace.id, stored);
        return stored;
    }

    async #handleFileAdd(workspace, data) {
        if (!workspace.isActive) return;

        const { key, checksums, size, mimeType } = data;
        if (!key || !checksums?.sha256) {
            logger.debug(`File add missing key or checksums: key=${key}, checksums=${JSON.stringify(checksums)}`);
            return;
        }

        const filename = path.basename(key);
        if (!filename) {
            logger.debug(`File add has empty filename from key: ${key}`);
            return;
        }

        const dataPath = this.#buildDataPath(key);
        const checksumString = `sha256/${checksums.sha256}`;
        logger.debug(`File add: key=${key}, checksum=${checksumString.slice(0, 20)}...`);

        try {
            const existingDoc = await workspace.db.getDocumentByChecksumString(checksumString);
            logger.debug(`Lookup result: ${existingDoc ? `found doc ${existingDoc.id}` : 'not found'}`);

            if (existingDoc) {
                const dataPaths = existingDoc.metadata?.dataPaths || [];
                logger.debug(`Existing dataPaths: ${JSON.stringify(dataPaths)}`);
                if (!dataPaths.includes(dataPath)) {
                    dataPaths.push(dataPath);
                    await workspace.db.updateDocument(existingDoc.id, {
                        metadata: { ...existingDoc.metadata, dataPaths },
                    });
                    logger.debug(`Added path to file doc ${existingDoc.id}: ${key} -> ${JSON.stringify(dataPaths)}`);
                } else {
                    logger.debug(`Path already exists in doc ${existingDoc.id}: ${dataPath}`);
                }
            } else {
                const fileDoc = {
                    schema: 'data/abstraction/file',
                    checksumArray: [checksumString],
                    data: { filename, size, mime: mimeType },
                    metadata: { dataPaths: [dataPath] },
                };
                logger.debug(`Inserting file doc: checksum=${checksumString.slice(0, 20)}..., data=${JSON.stringify(fileDoc.data)}`);
                await workspace.db.insertDocument(fileDoc, '/');
                logger.debug(`Created file doc: ${key}`);
            }
        } catch (err) {
            logger.debug(`Error handling file add for key=${key}: ${err.message}`);
        }
    }

    async #handleFileChange(workspace, data) {
        // Stored emits file:unlink + file:add for changes, so this is just for logging
        logger.debug(`File changed in ${workspace.id}: ${data.key}`);
    }

    async #handleFileUnlink(workspace, data) {
        if (!workspace.isActive) return;

        const { key, checksums, locations } = data;
        if (!checksums?.sha256) {
            logger.debug(`File unlink missing checksums (not indexed): ${key}`);
            return;
        }

        const dataPath = this.#buildDataPath(key);
        const checksumString = `sha256/${checksums.sha256}`;

        try {
            const existingDoc = await workspace.db.getDocumentByChecksumString(checksumString);
            if (!existingDoc) return;

            const dataPaths = (existingDoc.metadata?.dataPaths || []).filter(p => p !== dataPath);

            // locations.length === 0 means no more stored references exist
            if (locations?.length === 0 || dataPaths.length === 0) {
                await workspace.db.deleteDocument(existingDoc.id);
                logger.debug(`Deleted file doc (orphaned): ${existingDoc.id}`);
            } else {
                await workspace.db.updateDocument(existingDoc.id, {
                    metadata: { ...existingDoc.metadata, dataPaths },
                });
                logger.debug(`Removed path from file doc ${existingDoc.id}: ${key}`);
            }
        } catch (err) {
            logger.debug(`Error handling file unlink: ${err.message}`);
        }
    }

    #buildDataPath(key) {
        return `file://{WORKSPACE_ROOT}/home/${key}`;
    }

    async #syncInitialFiles(workspace, stored, files) {
        if (!workspace.isActive || !files?.length) return;

        let synced = 0;
        for (const file of files) {
            if (!file.key || !file.checksums?.sha256) continue;

            const filename = path.basename(file.key);
            if (!filename) continue;

            const dataPath = this.#buildDataPath(file.key);
            const checksumString = `sha256/${file.checksums.sha256}`;

            try {
                const existingDoc = await workspace.db.getDocumentByChecksumString(checksumString);

                if (existingDoc) {
                    const dataPaths = existingDoc.metadata?.dataPaths || [];
                    if (!dataPaths.includes(dataPath)) {
                        dataPaths.push(dataPath);
                        await workspace.db.updateDocument(existingDoc.id, {
                            metadata: { ...existingDoc.metadata, dataPaths },
                        });
                    }
                } else {
                    const fileDoc = {
                        schema: 'data/abstraction/file',
                        checksumArray: [checksumString],
                        data: { filename, size: file.size, mime: file.mimeType },
                        metadata: { dataPaths: [dataPath] },
                    };
                    logger.debug(`Syncing initial file doc: ${JSON.stringify(fileDoc.data)}`);
                    await workspace.db.insertDocument(fileDoc, '/');
                }
                synced++;
            } catch (err) {
                logger.debug(`Error syncing initial file ${file.key}: ${err.message}`);
            }
        }
        logger.debug(`Synced ${synced}/${files.length} initial files to synapsd`);
    }
}

export default HomeService;

