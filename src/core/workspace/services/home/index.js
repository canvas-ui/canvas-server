'use strict';

import path from 'path';
import { existsSync } from 'fs';
import * as fsPromises from 'fs/promises';
import EventEmitter from 'eventemitter2';
import Stored from '../../../../services/stored/src/index.js';
import { createDebug } from '../../../../utils/log/index.js';

const debug = createDebug('home-service');

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
        debug('HomeService initialized');
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
            debug(`Creating home directory at ${homePath}`);
            await fsPromises.mkdir(homePath, { recursive: true });
        }

        // Initialize Stored instance for this workspace
        const stored = await this.#initializeStored(workspace, homePath);

        // Initial scan
        await stored.scan();
        debug(`Home service enabled for workspace ${workspace.id}`);

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
            debug(`Home service disabled for workspace ${workspace.id}`);
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
        debug(`File added in ${workspace.id}: ${data.key}`);
        try {
            await this.#upsertFileDocument(workspace, data);
        } catch (err) {
            debug(`Error handling file add: ${err.message}`);
        }
    }

    async #handleFileChange(workspace, data) {
        debug(`File changed in ${workspace.id}: ${data.key}`);
        try {
            await this.#upsertFileDocument(workspace, data);
        } catch (err) {
            debug(`Error handling file change: ${err.message}`);
        }
    }

    async #handleFileUnlink(workspace, data) {
        debug(`File unlinked in ${workspace.id}: ${data.key}`);
        try {
            await this.#removeFileDocument(workspace, data);
        } catch (err) {
            debug(`Error handling file unlink: ${err.message}`);
        }
    }

    /**
     * Create or update a File document in synapsd
     */
    async #upsertFileDocument(workspace, data) {
        if (!workspace.isActive) {
            debug(`Workspace ${workspace.id} not active, skipping file document upsert`);
            return;
        }

        const { key, checksums, size, mimeType, backend } = data;
        const dataPath = `file://{WORKSPACE_ROOT}/home/${key}`;

        // Build checksum array in the format synapsd expects
        const checksumArray = checksums?.sha256 ? [`sha256:${checksums.sha256}`] : [];

        // Check if document with this checksum already exists
        const existingDoc = await this.#findDocumentByChecksum(workspace, checksumArray);

        if (existingDoc) {
            // Document exists - add this dataPath if not already present
            const dataPaths = existingDoc.metadata?.dataPaths || [];
            if (!dataPaths.includes(dataPath)) {
                dataPaths.push(dataPath);
                await workspace.db.updateDocument(existingDoc.id, {
                    metadata: { ...existingDoc.metadata, dataPaths },
                });
                debug(`Added dataPath to existing file document: ${existingDoc.id}`);
            }
        } else {
            // Create new File document
            const fileDoc = {
                schema: 'data/abstraction/file',
                checksumArray,
                data: {
                    filename: path.basename(key),
                    size,
                    mime: mimeType,
                },
                metadata: {
                    dataPaths: [dataPath],
                },
            };

            await workspace.db.insertDocument(fileDoc, '/', ['data/abstraction/file']);
            debug(`Created new file document for: ${key}`);
        }
    }

    /**
     * Remove a file's dataPath from its document (or delete if last occurrence)
     */
    async #removeFileDocument(workspace, data) {
        if (!workspace.isActive) return;

        const { key, checksums } = data;
        const dataPath = `file://{WORKSPACE_ROOT}/home/${key}`;
        const checksumArray = checksums?.sha256 ? [`sha256:${checksums.sha256}`] : [];

        const existingDoc = await this.#findDocumentByChecksum(workspace, checksumArray);
        if (!existingDoc) return;

        const dataPaths = (existingDoc.metadata?.dataPaths || []).filter(p => p !== dataPath);

        if (dataPaths.length === 0) {
            // Last occurrence - delete the document
            await workspace.db.deleteDocument(existingDoc.id);
            debug(`Deleted file document (last occurrence): ${existingDoc.id}`);
        } else {
            // Update document with remaining paths
            await workspace.db.updateDocument(existingDoc.id, {
                metadata: { ...existingDoc.metadata, dataPaths },
            });
            debug(`Removed dataPath from file document: ${existingDoc.id}`);
        }
    }

    async #findDocumentByChecksum(workspace, checksumArray) {
        if (!checksumArray?.length) return null;

        try {
            // Query by checksum - synapsd should support this
            const docs = await workspace.db.findDocuments('/', ['data/abstraction/file'], [], {
                limit: 1,
                // Filter by checksum if supported
            });

            // For now, scan through results (should be optimized in synapsd)
            for (const doc of docs) {
                if (doc.checksumArray?.some(cs => checksumArray.includes(cs))) {
                    return doc;
                }
            }
        } catch (err) {
            debug(`Error finding document by checksum: ${err.message}`);
        }
        return null;
    }
}

export default HomeService;
