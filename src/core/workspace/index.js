'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import randomcolor from 'randomcolor';
import path from 'path';
import * as fsPromises from 'fs/promises';
import { existsSync } from 'fs';
import Conf from 'conf';
import { v4 as uuidv4 } from 'uuid';
import createDebug from 'debug';
const debug = createDebug('workspace-manager');

// Includes
import Workspace from './Workspace.js';
import DotfileManager from './services/dotfile/index.js';
import HomeService from './services/home/index.js';

// Constants
import {
    WORKSPACE_STATUS_CODES,
    WORKSPACE_DIRECTORIES,
    WORKSPACE_CONFIG_FILENAME,
    WORKSPACE_DEFAULT_HOST,
    WORKSPACE_SERVICES,
} from './lib/constants.js';

/**
 * Workspace Reference Utilities
 */

function parseSimpleWorkspaceIdentifier(workspaceIdentifier) {
    if (!workspaceIdentifier || typeof workspaceIdentifier !== 'string') {
        return null;
    }

    if (workspaceIdentifier.includes('/')) {
        const parts = workspaceIdentifier.split('/');
        if (parts.length === 2 && parts[0] && parts[1]) {
            return {
                userIdentifier: parts[0].trim(),
                workspaceIdentifier: parts[1].trim(),
                full: workspaceIdentifier
            };
        }
    }
    return null;
}

function parseWorkspaceReference(workspaceRef) {
    if (!workspaceRef || typeof workspaceRef !== 'string') {
        return null;
    }

    const colonIndex = workspaceRef.indexOf(':');
    if (colonIndex === -1 || colonIndex === workspaceRef.length - 1) {
        return null;
    }

    const userHostPart = workspaceRef.substring(0, colonIndex);
    const resourcePart = workspaceRef.substring(colonIndex + 1);

    const atIndex = userHostPart.lastIndexOf('@');
    if (atIndex === -1 || atIndex === 0 || atIndex === userHostPart.length - 1) {
        return null;
    }

    const userIdentifier = userHostPart.substring(0, atIndex).trim();
    const host = userHostPart.substring(atIndex + 1).trim();

    if (!userIdentifier || !host) {
        return null;
    }

    const [workspaceSlug, ...optionalPathParts] = resourcePart.split('/');
    const optionalPath = optionalPathParts.length > 0 ? '/' + optionalPathParts.join('/') : '';

    return {
        userIdentifier,
        host,
        workspaceSlug: workspaceSlug.trim(),
        path: optionalPath || '',
        full: workspaceRef,
        isLocal: host === WORKSPACE_DEFAULT_HOST,
        isRemote: host !== WORKSPACE_DEFAULT_HOST
    };
}

function constructWorkspaceReference(userIdentifier, workspaceSlug, host = WORKSPACE_DEFAULT_HOST, path = '') {
    if (!userIdentifier || !workspaceSlug) {
        throw new Error('userIdentifier and workspaceSlug are required to construct a workspace reference.');
    }
    return `${userIdentifier}@${host}:${workspaceSlug}${path}`;
}

/**
 * Workspace Manager
 */
class WorkspaceManager extends EventEmitter {

    #indexStore;        // Persistent index
    #users;             // Users service
    #roles;             // Roles service

    #workspaces = new Map(); // Runtime cache
    #initialized = false;
    #defaultRootPath;

    // Lookup Indexes (in-memory)
    #nameIndex = new Map();         // Key: userId@host:workspaceName -> workspaceId
    #referenceIndex = new Map();    // Key: fullReference -> workspaceId

    // Services
    dotfileService = null;
    homeService = null;

    constructor(options = {}) {
        super(options.eventEmitterOptions);

        if (!options.defaultRootPath) throw new Error('defaultRootPath required');
        if (!options.indexStore) throw new Error('indexStore required');
        if (!options.users) throw new Error('users service required');

        this.#defaultRootPath = path.resolve(options.defaultRootPath);
        this.#indexStore = options.indexStore;
        this.#users = options.users;
        this.#roles = options.roles;
    }

    async initialize() {
        if (this.#initialized) { return true; }

        // Initialize Dotfile Service
        this.dotfileService = new DotfileManager({
            workspaceManager: this
        });
        await this.dotfileService.initialize();

        // Initialize Home Service
        this.homeService = new HomeService({
            workspaceManager: this
        });
        await this.homeService.initialize();

        // Scan/Validate index and rebuild lookups
        await this.#scanWorkspaces();
        await this.#rebuildIndexes();

        this.#initialized = true;
        debug('WorkspaceManager initialized');
        return this;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Service Management
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Enable a service for a workspace
     */
    async enableService(workspaceId, userId, serviceName) {
        const workspace = await this.getWorkspace(workspaceId, userId);
        if (!workspace) throw new Error('Workspace not found');

        let result;
        switch (serviceName) {
            case 'dotfiles':
                result = await this.dotfileService.enable(workspace, userId);
                break;
            case 'home':
                result = await this.homeService.enable(workspace);
                break;
            default:
                throw new Error(`Unknown service: ${serviceName}`);
        }

        // Update workspace config
        workspace.setServiceConfig(serviceName, { enabled: true });

        return result;
    }

    /**
     * Disable a service for a workspace
     */
    async disableService(workspaceId, userId, serviceName) {
        const workspace = await this.getWorkspace(workspaceId, userId);
        if (!workspace) throw new Error('Workspace not found');

        let result;
        switch (serviceName) {
            case 'dotfiles':
                result = await this.dotfileService.disable(workspace);
                break;
            case 'home':
                result = await this.homeService.disable(workspace);
                break;
            default:
                throw new Error(`Unknown service: ${serviceName}`);
        }

        // Update workspace config
        workspace.setServiceConfig(serviceName, { enabled: false });

        return result;
    }

    /**
     * Get status of all services for a workspace
     */
    async getServicesStatus(workspaceId, userId) {
        const workspace = await this.getWorkspace(workspaceId, userId);
        if (!workspace) throw new Error('Workspace not found');

        const config = workspace.services;

        return {
            dotfiles: {
                ...config.dotfiles,
                initialized: this.dotfileService.isEnabled(workspace),
            },
            home: {
                ...config.home,
                initialized: this.homeService.isEnabled(workspace.id),
            },
        };
    }

    /**
     * Public API
     */

    get users() { return this.#users; }
    get roles() { return this.#roles; }

    setRoles(roles) {
        this.#roles = roles;
    }

    async listWorkspaces(userId) {
        if (!this.#initialized) throw new Error('Not initialized');

        const all = this.#indexStore.store || {};
        const results = [];

        for (const key in all) {
            const entry = all[key];
            if (userId && entry.owner !== userId) continue;

            // If workspace is loaded, return runtime status
            if (this.#workspaces.has(entry.id)) {
                const ws = this.#workspaces.get(entry.id);
                results.push({
                    ...entry,
                    status: ws.status,
                    isActive: ws.isActive
                });
            } else {
                results.push(entry);
            }
        }
        return results;
    }

    async hasWorkspace(workspaceId, userId) {
        // Check index
        const entry = this.#findInIndex(workspaceId);
        if (!entry) return false;
        if (userId && entry.owner !== userId) return false;
        return true;
    }

    async getWorkspace(workspaceId, userId) {
        if (!this.#initialized) throw new Error('Not initialized');

        // 1. Check cache
        if (this.#workspaces.has(workspaceId)) {
            const ws = this.#workspaces.get(workspaceId);
            if (userId && ws.owner !== userId) return null; // Access denied or wrong workspace
            return ws;
        }

        // 2. Load from index
        const entry = this.#findInIndex(workspaceId);
        if (!entry) return null;
        if (userId && entry.owner !== userId) return null;

        // 3. Instantiate
        try {
            const conf = new Conf({
                configName: path.basename(entry.configPath, '.json'),
                cwd: path.dirname(entry.configPath),
                 accessPropertiesByDotNotation: false
            });

            const workspace = new Workspace({
                rootPath: entry.rootPath,
                configStore: conf,
                storageManager: this.storageManager,
                roleManager: this.#roles
            });

            this.#workspaces.set(workspaceId, workspace);

            return workspace;
        } catch (err) {
            console.error(`Failed to load workspace ${workspaceId}:`, err);
            return null;
        }
    }

    async createWorkspace(name, userId, options = {}) {
        if (!this.#initialized) throw new Error('Not initialized');
        if (!name || !userId) throw new Error('Name and UserID required');

        // Sanitize Name
        const sanitizedName = this.#sanitizeWorkspaceName(name);
        const host = options.host || WORKSPACE_DEFAULT_HOST;

        // Check uniqueness
        if (this.resolveWorkspaceId(userId, sanitizedName, host)) {
             throw new Error(`Workspace with name "${sanitizedName}" already exists for user ${userId}`);
        }

        const workspaceId = uuidv4(); // Or nanoid if preferred

        let workspaceDir;
        if (options.rootPath) {
            workspaceDir = options.rootPath;
        } else {
            workspaceDir = path.join(this.#defaultRootPath, 'workspaces', sanitizedName);
        }

        if (existsSync(workspaceDir)) {
            throw new Error(`Workspace directory already exists: ${workspaceDir}`);
        }

        await fsPromises.mkdir(workspaceDir, { recursive: true });
        await this.#createSubdirectories(workspaceDir);

        const configPath = path.join(workspaceDir, WORKSPACE_CONFIG_FILENAME);

        const reference = constructWorkspaceReference(userId, sanitizedName, host);

        const configData = {
            id: workspaceId,
            name: sanitizedName,
            label: options.label || sanitizedName,
            description: options.description || '',
            owner: userId,
            color: options.color || randomcolor(),
            type: options.type || 'workspace',
            status: WORKSPACE_STATUS_CODES.AVAILABLE,
            rootPath: workspaceDir,
            configPath: configPath,
            host: host,
            reference: reference,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            metadata: options.metadata || {}
        };

        // Store config
        const conf = new Conf({
            configName: path.basename(configPath, '.json'),
            cwd: workspaceDir,
            accessPropertiesByDotNotation: false
        });
        conf.store = configData;

        // Index it
        // Key: userId/workspaceId
        const indexKey = `${userId}/${workspaceId}`;
        this.#indexStore.set(indexKey, configData);

        // Update in-memory lookups
        this.#addToIndexes(userId, workspaceId, sanitizedName, host, reference);

        debug(`Created workspace ${workspaceId} for user ${userId}`);
        return configData;
    }

    /**
     * Update workspace configuration (e.g., ACL, metadata)
     * @param {string} ownerUserId
     * @param {string} workspaceId
     * @param {string} requestingUserId - currently unused (ACL enforced at route level)
     * @param {Object} updates - partial config to merge
     * @returns {Promise<boolean>}
     */
    async updateWorkspaceConfig(ownerUserId, workspaceId, requestingUserId, updates = {}) {
        if (!this.#initialized) throw new Error('Not initialized');
        if (!ownerUserId || !workspaceId || !updates || typeof updates !== 'object') {
            return false;
        }

        const indexKey = `${ownerUserId}/${workspaceId}`;
        const all = this.#indexStore.store || {};
        const existing = all[indexKey];
        if (!existing) {
            return false;
        }

        const newConfig = {
            ...existing,
            ...updates,
            updatedAt: new Date().toISOString()
        };

        try {
            const conf = new Conf({
                configName: path.basename(existing.configPath, '.json'),
                cwd: path.dirname(existing.configPath),
                accessPropertiesByDotNotation: false
            });
            conf.store = newConfig;
        } catch (err) {
            console.error(`Failed to persist workspace config for ${workspaceId}:`, err);
            return false;
        }

        this.#indexStore.set(indexKey, newConfig);
        return true;
    }

    async createUniverseWorkspace(userId, userEmail, universeWorkspacePath) {
        return this.createWorkspace('universe', userId, {
            label: 'Universe',
            description: `Personal workspace for ${userEmail}`,
            color: '#ffffff',
            type: 'universe',
            rootPath: universeWorkspacePath
        });
    }

    async removeWorkspace(workspaceId, userId, destroyData = false) {
        const ws = await this.getWorkspace(workspaceId, userId);
        if (!ws) return false;

        await ws.stop();
        this.#workspaces.delete(workspaceId);

        const entry = this.#findInIndex(workspaceId);
        if (entry) {
             const indexKey = `${entry.owner}/${entry.id}`;
             this.#indexStore.delete(indexKey);
             this.#removeFromIndexes(entry.owner, entry.name, entry.host || WORKSPACE_DEFAULT_HOST, entry.reference);
        }

        if (destroyData && ws.rootPath) {
            await fsPromises.rm(ws.rootPath, { recursive: true, force: true });
        }

        return true;
    }

    /**
     * Resolution Methods
     */

    resolveWorkspaceId(userId, workspaceName, host = WORKSPACE_DEFAULT_HOST) {
        const nameKey = `${userId}@${host}:${workspaceName}`;
        return this.#nameIndex.get(nameKey) || null;
    }

    resolveWorkspaceIdFromReference(workspaceRef) {
         const parsed = parseWorkspaceReference(workspaceRef);
         if (!parsed) return null;

         // This implies strict reference matching or we reconstruct the key
         // If the reference is stored in #referenceIndex, use it
         if (this.#referenceIndex.has(workspaceRef)) {
             return this.#referenceIndex.get(workspaceRef);
         }

         // Fallback: try to reconstruct name key if we can resolve user identifier
         // But here we might need async user resolution if the ref uses email/name
         // The old code did synchronous lookup if possible or async elsewhere.
         // Here we stick to synchronous lookups on the index.
         // If reference contains ID, we might need to handle that.

         return null;
    }

    async resolveWorkspaceIdFromSimpleIdentifier(workspaceIdentifier) {
        const parsed = parseSimpleWorkspaceIdentifier(workspaceIdentifier);
        if (!parsed) return null;

        const userId = await this.#users.resolveId(parsed.userIdentifier);
        if (!userId) return null;

        return this.resolveWorkspaceId(userId, parsed.workspaceIdentifier);
    }

    // Static helpers exposed as instance methods if needed
    parseWorkspaceReference(ref) { return parseWorkspaceReference(ref); }
    constructWorkspaceReference(user, slug, host, path) { return constructWorkspaceReference(user, slug, host, path); }


    /**
     * Control Methods
     */

    async startWorkspace(workspaceId, userId) {
        const ws = await this.getWorkspace(workspaceId, userId);
        if (!ws) throw new Error('Workspace not found');

        await ws.start();

        // Start roles
        if (this.#roles && ws.config.roles && Array.isArray(ws.config.roles)) {
            for (const roleId of ws.config.roles) {
                try {
                    await this.#roles.start(roleId, userId);
                } catch (e) {
                    console.warn(`Failed to start role ${roleId}: ${e.message}`);
                }
            }
        }

        // Enable services based on config
        await this.#enableConfiguredServices(ws);

        return ws;
    }

    async #enableConfiguredServices(workspace) {
        const services = workspace.services || {};

        // Enable home service if configured
        if (services.home?.enabled && !this.homeService.isEnabled(workspace.id)) {
            try {
                await this.homeService.enable(workspace);
                debug(`Home service auto-enabled for workspace ${workspace.id}`);
            } catch (e) {
                console.warn(`Failed to enable home service for ${workspace.id}: ${e.message}`);
            }
        }
    }

    async stopWorkspace(workspaceId, userId) {
        const ws = await this.getWorkspace(workspaceId, userId);
        if (!ws) return true;

        // Disable services
        if (this.homeService.isEnabled(ws.id)) {
            try {
                await this.homeService.disable(ws);
            } catch (e) {
                console.warn(`Failed to disable home service for ${ws.id}: ${e.message}`);
            }
        }

        // Stop roles
        if (this.#roles && ws.config.roles && Array.isArray(ws.config.roles)) {
            for (const roleId of ws.config.roles) {
                try {
                    await this.#roles.stop(roleId, userId);
                } catch (e) {
                    console.warn(`Failed to stop role ${roleId}: ${e.message}`);
                }
            }
        }

        return await ws.stop();
    }

    /**
     * Private Methods
     */

    #findInIndex(workspaceId) {
        const all = this.#indexStore.store;
        for (const key in all) {
            const entry = all[key];
            if (entry && entry.id === workspaceId) return entry;
        }
        return null;
    }

    async #scanWorkspaces() {
        // Minimal scan to ensure paths exist
        const all = this.#indexStore.store;
        for (const key in all) {
            const entry = all[key];
            if (!existsSync(entry.rootPath)) {
                entry.status = WORKSPACE_STATUS_CODES.NOT_FOUND;
            } else if (entry.status === WORKSPACE_STATUS_CODES.ACTIVE) {
                entry.status = WORKSPACE_STATUS_CODES.INACTIVE; // Reset active state
            }
            this.#indexStore.set(key, entry);
        }
    }

    async #rebuildIndexes() {
        this.#nameIndex.clear();
        this.#referenceIndex.clear();

        const all = this.#indexStore.store;
        for (const key in all) {
            const entry = all[key];
            if (entry.owner && entry.name) {
                this.#addToIndexes(
                    entry.owner,
                    entry.id,
                    entry.name,
                    entry.host || WORKSPACE_DEFAULT_HOST,
                    entry.reference
                );
            }
        }
        debug(`Rebuilt indexes: ${this.#nameIndex.size} names, ${this.#referenceIndex.size} references`);
    }

    #addToIndexes(userId, workspaceId, name, host, reference) {
        const nameKey = `${userId}@${host}:${name}`;
        this.#nameIndex.set(nameKey, workspaceId);

        if (reference) {
            this.#referenceIndex.set(reference, workspaceId);
        }
    }

    #removeFromIndexes(userId, name, host, reference) {
        const nameKey = `${userId}@${host}:${name}`;
        this.#nameIndex.delete(nameKey);
        if (reference) {
            this.#referenceIndex.delete(reference);
        }
    }

    #sanitizeWorkspaceName(name) {
        return name.toLowerCase().replace(/[^a-z0-9-_]/g, '');
    }

    async #createSubdirectories(dir) {
        for (const key in WORKSPACE_DIRECTORIES) {
            await fsPromises.mkdir(path.join(dir, WORKSPACE_DIRECTORIES[key]), { recursive: true });
        }
    }

}

export default WorkspaceManager;
