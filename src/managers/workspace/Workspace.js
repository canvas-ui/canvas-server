'use strict';

// Utils
import path from 'path';
import EventEmitter from 'eventemitter2';

// Logging
import logger, { createDebug } from '../../utils/log/index.js';
const debug = createDebug('workspace-manager:workspace');

// Includes
import Db from '../../services/synapsd/src/index.js';
import { parseDocumentId, parseDocumentIdArray } from '../../utils/documentId.js';

// Constants
import {
    WORKSPACE_STATUS_CODES,
    WORKSPACE_DIRECTORIES,
} from './lib/constants.js';

/**
 * Canvas Workspace
 */

class Workspace extends EventEmitter {

    // Core configuration
    #rootPath;
    #configStore;

    // Runtime state
    #status = WORKSPACE_STATUS_CODES.INACTIVE; // Internal runtime status
    #db = null;
    #eventForwardHandlers = null;

    /**
     * Create a new Workspace instance.
     * Manages its configuration via the injected config store.
     * @param {Object} options - Initialization options.
     * @param {string} options.rootPath - Absolute path to the workspace root directory.
     * @param {Conf} options.configStore - Initialized Conf instance for this workspace.
     * @param {object} [options.eventEmitterOptions] - Options for EventEmitter2.
     */
    constructor(options = {}) {
        super(options.eventEmitterOptions);

        if (!options.rootPath) throw new Error('Workspace rootPath is required');
        if (!options.configStore) throw new Error('Config store (Conf instance) is required');

        this.#rootPath = options.rootPath;
        this.#configStore = options.configStore;

        // Initialize status from config if available and valid, otherwise default to INACTIVE
        const persistedStatus = this.#configStore?.get('status');
        if (persistedStatus && Object.values(WORKSPACE_STATUS_CODES).includes(persistedStatus)) {
            // Only set if it's a valid status like ACTIVE or INACTIVE. AVAILABLE is a manager-level status.
            if ([WORKSPACE_STATUS_CODES.ACTIVE, WORKSPACE_STATUS_CODES.INACTIVE, WORKSPACE_STATUS_CODES.ERROR].includes(persistedStatus)) {
                 this.#status = persistedStatus;
            }
        }

        debug(`Workspace instance created for ID: ${this.id}, rootPath: ${this.rootPath}, Initial Status: ${this.#status}`);
    }

    /**
     * Getters & Setters
     */

    // Core Configuration & Path Getters
    get config() { return this.#configStore?.store || {}; }
    get path() { return this.#rootPath; }
    get rootPath() { return this.#rootPath; }
    get configPath() { return this.#configStore?.path; }

    // Persisted Configuration Getters (from configStore)
    get id() { return this.#configStore?.get('id'); }
    get name() { return this.#configStore?.get('name'); }
    get label() { return this.#configStore?.get('label', this.name || this.id); }
    get icon() { return this.#configStore?.get('icon'); }
    get description() { return this.#configStore?.get('description', `Canvas Workspace for ${this.name || this.id}`); }
    get color() { return this.#configStore?.get('color'); }
    get type() { return this.#configStore?.get('type', 'workspace'); }
    get owner() { return this.#configStore?.get('owner'); } // User ULID
    get acl() { return this.#configStore?.get('acl', {}); }
    get createdAt() { return this.#configStore?.get('createdAt'); }
    get updatedAt() { return this.#configStore?.get('updatedAt'); }    get metadata() { return this.#configStore?.get('metadata', {}); } // Generic metadata object


    // Runtime Status Getters & Setters
    get status() { return this.#status; }
    get isConfigLoaded() { return !!this.#configStore; } // More explicit check
    get isActive() { return this.#status === WORKSPACE_STATUS_CODES.ACTIVE; }

    setStatus(status) {
        if (!Object.values(WORKSPACE_STATUS_CODES).includes(status)) {
            debug(`Invalid status value provided to setStatus: ${status} for workspace ${this.id}`);
            return false;
        }
        if (this.#status !== status) {
            this.#status = status;
            debug(`Workspace ${this.id} status changed to: ${status}`);
            this.emit('status.changed', { id: this.id, status: this.#status });
            // Note: Persisting status to workspace.json is handled by WorkspaceManager based on its operations.
            // This setStatus is for internal runtime state of the Workspace object.
        }
        return true;
    }

    // Internal Resource Getters (DB, Tree)
    get db() {
        if (!this.#db) {
            // console.warn(`Database not initialized for workspace ${this.id}. Attempting to access db.`);
            throw new Error(`Database not initialized for workspace ${this.id}`);
        }
        return this.#db;
    }

    get tree() {
        if (!this.isActive || !this.#db.tree) {
            // console.warn(`Tree not available. Workspace ${this.id} active: ${this.isActive}, DB initialized: ${!!this.#db}`);
            throw new Error(`Tree not available. Workspace ${this.id} is not active or DB is not initialized.`);
        }
        return this.#db.tree;
    }

    get jsonTree() {
        try {
            return this.#db.jsonTree;
        } catch (error) {
            // This can happen if tree itself throws an error (e.g., not active)
            debug(`Error accessing jsonTree for workspace ${this.id}: ${error.message}`);
            return '{}';
        }
    }

    // Configuration Setters (persisted to workspace.json)
    async setColor(color) {
        if (!this.#validateColor(color)) {
            console.warn(`Invalid color format: "${color}" for workspace ${this.id}.`);
            return false;
        }
        return this.#updateConfig('color', color);
    }

    async setDescription(description) {
        return this.#updateConfig('description', String(description || ''));
    }

    async setLabel(label) {
        if (!label) {
            console.warn(`Invalid label for workspace ${this.id}. Must be a non-empty string.`);
            return false;
        }
        return this.#updateConfig('label', String(label));
    }

    async setName(name) {
        if (!name) {
            console.warn(`Invalid name for workspace ${this.id}. Must be a non-empty string.`);
            return false;
        }
        // Name should be slug-like (lowercase, alphanumeric, dashes, underscores)
        const sanitizedName = name.toLowerCase().replace(/[^a-z0-9-_]/g, '');
        if (sanitizedName !== name) {
            console.warn(`Name "${name}" was sanitized to "${sanitizedName}" for workspace ${this.id}`);
        }
        return this.#updateConfig('name', sanitizedName);
    }

    async setMetadata(metadata) {
        if (typeof metadata !== 'object' || metadata === null) {
            console.warn(`Invalid metadata for workspace ${this.id}. Must be an object.`);
            return false;
        }
        return this.#updateConfig('metadata', metadata);
    }

    /**
     * Generic config key setter for specific, allowed keys.
     * @param {string} key - The configuration key to set.
     * @param {*} value - The value to set for the key.
     * @returns {Promise<boolean>} True if successful, false otherwise.
     */
    async setConfigKey(key, value) {
        const allowedKeys = [
            'label',
            'description',
            'icon',
            'color',
            'locked',
            'acl',       // ACLs are complex; ensure `value` is a valid ACL object.
            'metadata',  // For generic metadata object
            'status',    // Internal runtime status
        ];

        if (!allowedKeys.includes(key)) {
            console.warn(`Attempted to set disallowed or unknown config key: "${key}" for workspace ${this.id}.`);
            return false;
        }

        // Specific validations
        if (key === 'color' && !this.#validateColor(value)) {
            console.warn(`Invalid color format for key ${key}: "${value}" for workspace ${this.id}.`);
            return false;
        }
        if (key === 'acl' && (typeof value !== 'object' || value === null)) {
             console.warn(`Invalid ACL value for workspace ${this.id}. Must be an object.`);
             return false;
        }
        if (key === 'metadata' && (typeof value !== 'object' || value === null)) {
            console.warn(`Invalid metadata value for workspace ${this.id}. Must be an object.`);
            return false;
        }

        return this.#updateConfig(key, value);
    }


    /**
     * Workspace Lifecycle Controls
     */

    /**
     * Start the workspace: Initialize DB connection and load the tree.
     * Updates the internal status.
     * @returns {Promise<Workspace>} The started workspace instance.
     */
    async start() {
        if (this.isActive) {
            debug(`Workspace "${this.id}" is already active.`);
            return this;
        }
        if (this.#status === WORKSPACE_STATUS_CODES.ERROR) {
            // Or some other unrecoverable status
            console.warn(`Workspace "${this.id}" is in an error state. Cannot start.`);
            throw new Error(`Workspace "${this.id}" is in an error state and cannot be started.`);
        }

        debug(`Starting workspace "${this.id}"...`);
        try {
            await this.#initializeResources();
            // await this.#initializeRoles(); // Placeholder
            this.setStatus(WORKSPACE_STATUS_CODES.ACTIVE);
            this.emit('afterStart', { id: this.id });
            debug(`Workspace "${this.id}" started successfully.`);
            return this;
        } catch (err) {
            console.error(`Failed to start workspace "${this.id}": ${err.message}`);
            await this.#shutdownResources(); // Ensure cleanup
            this.setStatus(WORKSPACE_STATUS_CODES.ERROR); // Set to error state on failed start
            this.emit('startFailed', { id: this.id, error: err.message });
            throw err; // Re-throw to allow WorkspaceManager to handle index status
        }
    }

    /**
     * Stop the workspace: Shutdown DB connection and release resources.
     * Updates the internal status.
     * @returns {Promise<boolean>} True if stopped successfully or already inactive, false otherwise.
     */
    async stop() {
        if (this.#status === WORKSPACE_STATUS_CODES.INACTIVE) {
            debug(`Workspace "${this.id}" is already inactive.`);
            return true;
        }
        // If it's in an ERROR state but resources might be partially up, still try to shut down.

        debug(`Stopping workspace "${this.id}"...`);
        try {
            await this.#shutdownResources();
            // await this.#shutdownRoles(); // Placeholder
            const previousStatus = this.#status;
            this.setStatus(WORKSPACE_STATUS_CODES.INACTIVE);
            this.emit('afterStop', { id: this.id, previousStatus });
            debug(`Workspace "${this.id}" stopped successfully.`);
            return true;
        } catch (err) {
            console.error(`Error stopping workspace "${this.id}": ${err.message}`);
            // Even if shutdown fails, set status to INACTIVE or ERROR?
            // Setting to INACTIVE seems safer as resources are likely down or in an unknown state.
            this.setStatus(WORKSPACE_STATUS_CODES.INACTIVE); // Or ERROR depending on desired recovery behavior
            this.emit('stopFailed', { id: this.id, error: err.message });
            return false; // Indicate stop had issues
        }
    }

    /**
     * DB CRUD Methods
     */

    async insertDocument(document, contextSpec = '/', featureBitmapArray = [], emitEvent = true) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.insertDocument(document, contextSpec, featureBitmapArray, emitEvent);
        return result;
    }

    async insertDocumentArray(docArray, contextSpec = '/', featureBitmapArray = []) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.insertDocumentArray(docArray, contextSpec, featureBitmapArray);
        return result;
    }

    async hasDocument(id, contextSpec, featureBitmapArrayInput) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.hasDocument(id, contextSpec, featureBitmapArrayInput);
        return result;
    }

    async hasDocumentByChecksum(checksum, contextSpec, featureBitmapArray) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.hasDocumentByChecksum(checksum, contextSpec, featureBitmapArray);
        return result;
    }

    async listDocuments(contextSpec = '/', featureBitmapArray = [], filterArray = [], options = { parse: true }) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.findDocuments(contextSpec, featureBitmapArray, filterArray, options);
        return result;
    }

    async findDocuments(contextSpec = '/', featureBitmapArray = [], filterArray = [], options = { parse: true }) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.findDocuments(contextSpec, featureBitmapArray, filterArray, options);
        return result;
    }

    async updateDocument(docIdentifier, updateData = null, contextSpec = null, featureBitmapArray = []) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.updateDocument(docIdentifier, updateData, contextSpec, featureBitmapArray);
        return result;
    }

    async updateDocumentArray(docArray, contextSpec = null, featureBitmapArray = []) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.updateDocumentArray(docArray, contextSpec, featureBitmapArray);
        return result;
    }

    async removeDocument(docId, contextSpec = '/', featureBitmapArray = []) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.removeDocument(docId, contextSpec, featureBitmapArray);
        return result;
    }

    async removeDocumentArray(docIdArray, contextSpec = '/', featureBitmapArray = []) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        // Parse and validate document IDs
        const numericDocumentIdArray = parseDocumentIdArray(docIdArray, 'Document ID array');

        const result = await this.db.removeDocumentArray(numericDocumentIdArray, contextSpec, featureBitmapArray);
        return result;
    }

    async deleteDocument(docId) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        // Parse and validate document ID
        const numericDocumentId = parseDocumentId(docId, 'Document ID');

        const result = await this.db.deleteDocument(numericDocumentId);
        return result;
    }

    async deleteDocumentArray(docIdArray) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        // Parse and validate document IDs
        const numericDocumentIdArray = parseDocumentIdArray(docIdArray, 'Document ID array');

        const result = await this.db.deleteDocumentArray(numericDocumentIdArray);
        return result;
    }

    async getDocument(docId, options = { parse: true }) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.getDocument(docId, options);
        return result;
    }

    async getDocumentById(id, options = { parse: true }) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.getDocumentById(id, options);
        return result;
    }

    async getDocumentsByIdArray(idArray, options = { parse: true, limit: null }) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.getDocumentsByIdArray(idArray, options);
        return result;
    }

    async getDocumentByChecksumString(checksumString, options = { parse: true }) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.getDocumentByChecksumString(checksumString, options);
        return result;
    }

    async getDocumentsByChecksumStringArray(checksumStringArray, options = { parse: true }) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.getDocumentsByChecksumStringArray(checksumStringArray, options);
        return result;
    }

    async setDocumentArrayFeatures(docIdArray, featureBitmapArray) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.setDocumentArrayFeatures(docIdArray, featureBitmapArray);
        return result;
    }

    async unsetDocumentArrayFeatures(docIdArray, featureBitmapArray) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.unsetDocumentArrayFeatures(docIdArray, featureBitmapArray);
        return result;
    }

    async query(query, contextBitmapArray = [], featureBitmapArray = [], filterArray = [], metadataOnly = false) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.query(query, contextBitmapArray, featureBitmapArray, filterArray, metadataOnly);
        return result;
    }

    async ftsQuery(queryString, contextSpec = null, featureBitmapArray = [], filterArray = [], options = { parse: true, limit: 50, offset: 0 }) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.ftsQuery(queryString, contextSpec, featureBitmapArray, filterArray, options);
        return result;
    }

    async dumpDocuments(dstDir, contextSpec = null, featureBitmapArray = [], filterArray = []) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.dumpDocuments(dstDir, contextSpec, featureBitmapArray, filterArray);
        return result;
    }

    async dumpBitmaps(dstDir, bitmapArray = []) {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }

        const result = await this.db.dumpBitmaps(dstDir, bitmapArray);
        return result;
    }

    clearDatabaseSync() {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }
        return this.db.clearSync();
    }

    clearDatabaseAsync() {
        if (!this.isActive) {
            throw new Error('Workspace is not active');
        }
        return this.db.clearAsync();
    }

    /**
     * Tree Manipulation Methods
     */

    #ensureActiveForTreeOp(operationName) {
        if (!this.isActive) {
            const errorMsg = `Workspace "${this.id}" is not active. Cannot perform tree operation: ${operationName}.`;
            debug(errorMsg);
            throw new Error(errorMsg);
        }
    }

    /** Helper to emit tree update and return standard response */
    #emitTreeUpdateAndRespond(operation, details, success = true, resultData = null) {
        const response = {
            success,
            operation,
            ...details,
            tree: success ? this.jsonTree : null,
        };
        if (resultData) {
            response.data = resultData;
        }
        if (success) {
            this.emit('tree.updated', response);
        }
        return response;
    }

    async insertPath(path, data = null, autoCreateLayers = true) {
        this.#ensureActiveForTreeOp('insertPath');
        const result = await this.tree.insertPath(path, data, autoCreateLayers);
        return result;
    }

        async removePath(path, recursive = false) {
        this.#ensureActiveForTreeOp('removePath');
        const result = await this.tree.removePath(path, recursive);
        // ContextTree returns {data, count, error} - convert to boolean for API compatibility
        return result && !result.error && result.count > 0;
    }

    async movePath(pathFrom, pathTo, recursive = false) {
        this.#ensureActiveForTreeOp('movePath');
        const result = await this.tree.movePath(pathFrom, pathTo, recursive);
        // ContextTree returns {data, count, error} - convert to boolean for API compatibility
        return result && !result.error && result.count > 0;
    }

    async copyPath(pathFrom, pathTo, recursive = false) {
        this.#ensureActiveForTreeOp('copyPath');
        const result = await this.tree.copyPath(pathFrom, pathTo, recursive);
        // ContextTree returns boolean for copyPath (different from other methods)
        return result === true;
    }

    pathToIdArray(path) {
        this.#ensureActiveForTreeOp('pathToIdArray');
        return this.tree.pathToIdArray(path); // This one might not need the standard response format
    }

    async mergeUp(path) {
        this.#ensureActiveForTreeOp('mergeUp');
        const result = await this.tree.mergeUp(path);
        return result && !result.error && result.count > 0;
    }

    async mergeDown(path) {
        this.#ensureActiveForTreeOp('mergeDown');
        const result = await this.tree.mergeDown(path);
        return result && !result.error && result.count > 0;
    }

    async subtractUp(path) {
        this.#ensureActiveForTreeOp('subtractUp');
        const result = await this.tree.subtractUp(path);
        return result && !result.error && result.count > 0;
    }

    async subtractDown(path) {
        this.#ensureActiveForTreeOp('subtractDown');
        const result = await this.tree.subtractDown(path);
        return result && !result.error && result.count > 0;
    }

    async mergeLayer(layerId, layerArray) {
        this.#ensureActiveForTreeOp('mergeLayer');
        return await this.tree.mergeLayer(layerId, layerArray);
    }

    async subtractLayer(layerId, layerArray) {
        this.#ensureActiveForTreeOp('subtractLayer');
        return await this.tree.subtractLayer(layerId, layerArray);
    }

    get paths() {
        if (!this.isActive) return [];
        return this.tree?.paths || [];
    }

    /**
     * Layer & Item Creation/Management Methods
     */

    insertCanvas(parentPath, canvasName, options = {}) {
        this.#ensureActiveForTreeOp('insertCanvas');
        const canvasLayer = this.createLayer({
            name: canvasName, // SynapsD Layer name should be unique
            type: 'canvas',
            label: options.label || canvasName, // Optional: user-facing label
            ...options,
        });

        const canvasPath = parentPath === '/' || parentPath === '' ? `/${canvasName}` : `${parentPath}/${canvasName}`;
        // Associate the layer with the path node. Data stored on the node can be the layer ID.
        const insertResult = this.insertPath(canvasPath, { layerId: canvasLayer.id, type: 'canvas' });

        if (!insertResult.success) {
            // If path insertion failed, we might need to roll back layer creation or handle error
            console.error(`Failed to insert path for canvas "${canvasName}" at "${parentPath}". Layer may have been created but not linked.`);
            // Consider deleting the orphaned layer: this.deleteLayer(canvasLayer.name);
            throw new Error(`Failed to insert canvas path for "${canvasName}".`);
        }

        const responsePayload = {
            operation: 'insertCanvas',
            parentPath,
            canvasName,
            canvasId: canvasLayer.id,
            path: canvasPath,
            tree: this.jsonTree,
        };
        this.emit('canvas.inserted', responsePayload);
        return responsePayload; // Return a more comprehensive object
    }

    insertWorkspace(parentPath, workspaceRefName, targetWorkspaceId, options = {}) {
        this.#ensureActiveForTreeOp('insertWorkspace');
        const workspaceLayer = this.createLayer({
            name: workspaceRefName, // Unique name for this layer representing the workspace ref
            type: 'workspace', // Layer type indicates it's a reference
            label: options.label || workspaceRefName,
            metadata: {
                targetWorkspaceId,
                ...(options.metadata || {}),
            },
            ...options,
        });

        const workspacePath = parentPath === '/' || parentPath === '' ? `/${workspaceRefName}` : `${parentPath}/${workspaceRefName}`;
        const insertResult = this.insertPath(workspacePath, { layerId: workspaceLayer.id, type: 'workspace' });

        if (!insertResult.success) {
            console.error(`Failed to insert path for workspace reference "${workspaceRefName}" at "${parentPath}".`);
            // Consider deleting the orphaned layer: this.deleteLayer(workspaceLayer.name);
            throw new Error(`Failed to insert workspace reference path for "${workspaceRefName}".`);
        }

        const responsePayload = {
            operation: 'insertWorkspaceRef',
            parentPath,
            workspaceRefName,
            workspaceRefId: workspaceLayer.id,
            targetWorkspaceId,
            path: workspacePath,
            tree: this.jsonTree,
        };
        this.emit('ref.inserted', responsePayload);
        return responsePayload;
    }

    // Tree Layer Methods (direct pass-through with active check and eventing)
    createLayer(options) {
        this.#ensureActiveForTreeOp('createLayer');
        const layer = this.tree.createLayer(options);
        // Ensure layer has an id, SynapsD should provide it.
        if (!layer || !layer.id) {
            console.error('Layer creation in SynapsD did not return a valid layer object with ID.', options);
            throw new Error('Failed to create layer or layer ID missing.');
        }
        this.emit('layer.created', {
            layerId: layer.id,
            layerName: layer.name, // Assuming name is part of options or generated
            options,
            tree: this.jsonTree,
        });
        return layer; // Return the full layer object from SynapsD
    }

    getLayer(name) {
        if (!this.isActive) return undefined;
        return this.tree?.getLayer(name);
    }

    getLayerById(id) {
        if (!this.isActive) return undefined;
        return this.tree?.getLayerById(id);
    }

    renameLayer(nameOrId, newName) {
        this.#ensureActiveForTreeOp('renameLayer');
        const success = this.tree.renameLayer(nameOrId, newName);
        return this.#emitTreeUpdateAndRespond('renameLayer', { oldNameOrId: nameOrId, newName }, success);
    }

    updateLayer(nameOrId, updates) {
        this.#ensureActiveForTreeOp('updateLayer');
        // SynapsD's updateLayer might take name or ID. Assuming it handles this.
        const success = this.tree.updateLayer(nameOrId, updates);
        return this.#emitTreeUpdateAndRespond('updateLayer', { nameOrId, updates }, success);
    }

    deleteLayer(nameOrId) {
        this.#ensureActiveForTreeOp('deleteLayer');
        const success = this.tree.deleteLayer(nameOrId);
        return this.#emitTreeUpdateAndRespond('deleteLayer', { nameOrId }, success);
    }

    /**
     * Output Methods
     */

    /**
     * Convert the workspace's current state (config and runtime) to a plain JSON object.
     * @returns {Object} - JSON object representing workspace.
     */
    toJSON() {
        return {
            ...this.config, // Get all persisted config from configStore
            // Append/override with runtime or essential derived values
            id: this.id,
            label: this.label,
            icon: this.icon,
            description: this.description,
            color: this.color,
            type: this.type,
            owner: this.owner,
            acl: this.acl,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            metadata: this.metadata,
            rootPath: this.rootPath,
            configPath: this.configPath,
            status: this.status,
            isActive: this.isActive,
            name: this.name,
        };
    }

    /**
     * Private Utility Methods
     */

    /**
     * Updates a key in the workspace's configStore and sets the 'updated' timestamp.
     * Emits a change event.
     * @param {string} key - The configuration key to update.
     * @param {*} value - The new value for the key.
     * @returns {Promise<boolean>} True if successful, false otherwise.
     * @private
     */
    async #updateConfig(key, value) {
        if (!this.#configStore) {
            console.error(`Cannot update config for workspace "${this.id}". Config store not available.`);
            return false;
        }
        try {
            const oldValue = this.#configStore.get(key);
            if (oldValue === value) {
                // debug(`Config key "${key}" for workspace "${this.id}" already has value "${value}". No update needed.`);
                // return true; // No change, but operation is successful in intent
            }
            this.#configStore.set(key, value);
            this.#configStore.set('updatedAt', new Date().toISOString());
            // It might be good to emit an event specific to this workspace instance
            this.emit(`${key}.changed`, { id: this.id, [key]: value });
            debug(`Workspace "${this.id}" config updated: { ${key}: ${value} }. Old value: ${oldValue}`);
            return true;
        } catch (err) {
            console.error(`Failed to update config key "${key}" for workspace "${this.id}": ${err.message}`);
            return false;
        }
    }

    /**
     * Validate color format (hex color: #RGB or #RRGGBB).
     * @param {string} color - Color to validate.
     * @returns {boolean} - True if color is valid.
     * @private
     */
    #validateColor(color) {
        if (typeof color !== 'string') return false;
        return /^#(?:[0-9a-fA-F]{3}){1,2}$/.test(color);
    }

    /**
     * Initialize workspace resources (DB, Tree)
     * @private
     */
    async #initializeResources() {
        if (this.#db) {
            debug(`Resources already initialized for workspace "${this.id}". DB status: ${this.#db.status}`);
            // If DB says it's not running, try to start it.
            if (this.#db.status !== 'running' && this.#db.status !== 'starting') { // Assuming Db has a status getter
                 debug(`DB for workspace "${this.id}" exists but not running. Attempting to start.`);
                 await this.#db.start();
            }
            return; // Already initialized (or started)
        }

        try {
            const dbDirName = WORKSPACE_DIRECTORIES.db || 'Db'; // Ensure fallback
            const dbPath = path.join(this.rootPath, dbDirName);
            debug(`Initializing database for workspace "${this.id}" at ${dbPath}`);

            this.#db = new Db({
                path: dbPath,
                // Any other DB specific options from workspace config?
                // Example: this.config.dbOptions || {}
            });

            await this.#db.start(); // This should handle internal tree initialization
            // this.#tree = this.#db.tree; // No longer needed if we use this.db.tree

            debug(`Database and Tree started for workspace "${this.id}".`);

            // Set up event forwarding from database and tree
            this.#setupEventForwarding();

        } catch (err) {
            debug(`Error during resource initialization for workspace "${this.id}": ${err.message}`);
            this.#db = null; // Clear DB instance on failure
            throw err; // Re-throw to be caught by start()
        }
    }

    /**
     * Setup event forwarding from database and tree to workspace
     * @private
     */
    #setupEventForwarding() {
        if (!this.#db) return;

        debug(`Setting up event forwarding for workspace "${this.id}" (wild-card mode)`);

        const forward = (eventName, payload) => {
            const dotEvent = eventName.replace(/:/g, '.');
            this.emit(dotEvent, {
                workspaceId: this.id,
                workspaceName: this.label,
                ...payload
            });
        };

        const dbHandler = (eventName, payload) => forward(eventName, payload);
        this.#db.onAny(dbHandler);

        let treeHandler = null;
        if (this.#db.tree) {
            treeHandler = (eventName, payload) => forward(eventName, payload);
            this.#db.tree.onAny(treeHandler);
        }

        // Keep refs for cleanup
        this.#eventForwardHandlers = { dbHandler, treeHandler };

        debug(`Event forwarding setup completed for workspace "${this.id}"`);
    }

    /**
     * Clean up event listeners from database and tree
     * @private
     */
    #cleanupEventForwarding() {
        if (!this.#db) return;

        debug(`Cleaning up event forwarding for workspace "${this.id}"`);

        if (this.#db && this.#eventForwardHandlers) {
            this.#db.offAny(this.#eventForwardHandlers.dbHandler);
            if (this.#db.tree && this.#eventForwardHandlers.treeHandler) {
                this.#db.tree.offAny(this.#eventForwardHandlers.treeHandler);
            }
            this.#eventForwardHandlers = null;
        }

        debug(`Event forwarding cleanup completed for workspace "${this.id}"`);
    }

    /**
     * Shutdown workspace resources (DB, Tree)
     * @private
     */
    async #shutdownResources() {
        debug(`Shutting down resources for workspace "${this.id}"...`);

        // Clean up event forwarding first
        this.#cleanupEventForwarding();

        // this.#tree = null; // Not needed if accessed via this.db.tree

        if (this.#db) {
            try {
                // Assuming Db.shutdown() handles tree shutdown implicitly or tree doesn't need explicit shutdown
                await this.#db.shutdown();
                debug(`Database shutdown complete for workspace "${this.id}".`);
            } catch (dbErr) {
                console.error(`Error shutting down database for workspace "${this.id}": ${dbErr.message}`);
                // Decide if we should throw or just log and continue cleanup
            } finally {
                this.#db = null; // Ensure DB instance is cleared
            }
        } else {
            debug(`No active DB instance to shut down for workspace "${this.id}".`);
        }
        debug(`Workspace "${this.id}" resources shut down attempt complete.`);
    }
}

export default Workspace;
