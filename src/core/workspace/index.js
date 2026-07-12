'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import randomcolor from 'randomcolor';
import path from 'path';
import * as fsPromises from 'fs/promises';
import { existsSync } from 'fs';
import Conf from 'conf';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

// Logging
import { createLogger } from '../../utils/log.js';

// Includes
import Workspace from './Workspace.js';
import DotfileManager from './services/dotfile/index.js';
import HookService from './services/hook/index.js';
import GraphService from './services/graph/index.js';
import ChatService from './services/chat/index.js';

// Constants
import {
    WORKSPACE_STATUS_CODES,
    WORKSPACE_DIRECTORIES,
    WORKSPACE_CONFIG_FILENAME,
    WORKSPACE_DEFAULT_HOST,
    WORKSPACE_DATA_BACKENDS,
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
    #contextManager;    // Context Manager
    #embedd;            // shared embedding service (optional; passed to each Workspace)
    #logger;

    #workspaces = new Map(); // Runtime cache
    #workspaceListeners = new Map();
    #initialized = false;
    #defaultRootPath;

    // Lookup Indexes (in-memory)
    #nameIndex = new Map();         // Key: userId@host:workspaceName -> workspaceId
    #referenceIndex = new Map();    // Key: fullReference -> workspaceId

    // Services
    dotfileService = null;
    hookService = null;
    graphService = null;
    chatService = null;

    constructor(options = {}) {
        super({
            wildcard: true,
            delimiter: '.',
            newListener: false,
            maxListeners: 100,
            ...(options.eventEmitterOptions || {})
        });

        if (!options.defaultRootPath) throw new Error('defaultRootPath required');
        if (!options.indexStore) throw new Error('indexStore required');
        if (!options.users) throw new Error('users service required');

        this.#defaultRootPath = path.resolve(options.defaultRootPath);
        this.#indexStore = options.indexStore;
        this.#users = options.users;
        this.#roles = options.roles;
        this.#embedd = options.embedd || null;
        this.#logger = options.logger || createLogger('workspace-manager');
    }

    async initialize() {
        if (this.#initialized) { return true; }

        // Initialize Dotfile Service
        this.dotfileService = new DotfileManager({
            workspaceManager: this
        });
        await this.dotfileService.initialize();

        // Initialize Hook Service
        this.hookService = new HookService({
            workspaceManager: this
        });
        await this.hookService.initialize();

        // IMAP ingest is owned by the stored layer (WorkspaceStoredIndex + the
        // stored imap backend); no standalone service to initialize.

        // Initialize Graph Service
        this.graphService = new GraphService({
            workspaceManager: this,
            hookService: this.hookService
        });
        await this.graphService.initialize();

        // Initialize Chat Service
        this.chatService = new ChatService({
            workspaceManager: this,
            hookService: this.hookService
        });
        await this.chatService.initialize();

        // Scan/Validate index and rebuild lookups
        await this.#scanWorkspaces();
        await this.#rebuildIndexes();

        this.#initialized = true;
        this.#logger.debug('WorkspaceManager initialized');
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
            case 'git':
            case 'dotfiles':
                result = await this.dotfileService.enable(workspace, userId);
                break;
            case 'webdav':
            case 'home':
                await workspace.startHomeService();
                result = true;
                break;
            case 'hook':
                // Hooks are always enabled if service is initialized, but we can toggle specific hooks
                // For now, just return true
                result = true;
                break;
            case 'imap':
            case 'imapSync':
                result = await workspace.enableImap();
                break;
            case 'graph':
                result = await this.graphService.enable(workspace);
                break;
            case 'chat':
                result = await this.chatService.enable(workspace);
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
            case 'git':
            case 'dotfiles':
                result = await this.dotfileService.disable(workspace);
                break;
            case 'webdav':
            case 'home':
                await workspace.stopHomeService();
                result = true;
                break;
            case 'imap':
            case 'imapSync':
                result = await workspace.disableImap();
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
        const imapStatus = await workspace.getImapStatus();

        return {
            dotfiles: {
                ...config.dotfiles,
                initialized: this.dotfileService.isEnabled(workspace),
            },
            git: {
                ...config.git,
                initialized: this.dotfileService.isEnabled(workspace),
            },
            home: {
                ...config.home,
                initialized: config.home?.enabled === true || config.webdav?.enabled === true,
            },
            webdav: {
                ...config.webdav,
                initialized: config.home?.enabled === true || config.webdav?.enabled === true,
            },
            imap: { ...config.imap, ...imapStatus },
            imapSync: {
                ...config.imapSync,
                initialized: imapStatus.initialized,
            },
        };
    }

    /**
     * Public API
     */

    get users() { return this.#users; }
    get roles() { return this.#roles; }
    get embedd() { return this.#embedd; }

    setRoles(roles) {
        this.#roles = roles;
    }

    setContextManager(contextManager) {
        this.#contextManager = contextManager;
    }

    async listWorkspaces(userId) {
        if (!this.#initialized) throw new Error('Not initialized');

        const all = this.#indexStore.store || {};
        const results = [];
        let userEmail = null;

        if (userId) {
            try {
                const u = await this.#users.get(userId);
                userEmail = u?.email || null;
            } catch (e) {
                userEmail = null;
            }
        }

        for (const key in all) {
            const entry = all[key];
            const isOwner = !userId || entry.owner === userId;
            const sharedVia = userEmail ? (entry.acl?.users?.[userEmail] || null) : null;
            const hasSharedAccess = !!sharedVia;

            if (userId && !isOwner && !hasSharedAccess) continue;

            // If workspace is loaded, return runtime status
            if (this.#workspaces.has(entry.id)) {
                const ws = this.#workspaces.get(entry.id);
                const item = {
                    ...entry,
                    status: ws.status,
                    isActive: ws.isActive,
                    documentCount: ws.stats?.documentCount ?? 0,
                    bitmapCount: ws.stats?.bitmapStoreSize ?? 0
                };
                if (userId && !isOwner && hasSharedAccess) {
                    item.type = 'shared';
                    item.isShared = true;
                    item.sharedVia = sharedVia;
                    try {
                        const ownerUser = await this.#users.get(entry.owner);
                        if (ownerUser?.email) item.ownerEmail = ownerUser.email;
                    } catch {}
                } else {
                    try {
                        const ownerUser = await this.#users.get(entry.owner);
                        if (ownerUser?.email) item.ownerEmail = ownerUser.email;
                    } catch {}
                }
                results.push(item);
            } else {
                const item = { ...entry };
                if (userId && !isOwner && hasSharedAccess) {
                    item.type = 'shared';
                    item.isShared = true;
                    item.sharedVia = sharedVia;
                    try {
                        const ownerUser = await this.#users.get(entry.owner);
                        if (ownerUser?.email) item.ownerEmail = ownerUser.email;
                    } catch {}
                } else {
                    try {
                        const ownerUser = await this.#users.get(entry.owner);
                        if (ownerUser?.email) item.ownerEmail = ownerUser.email;
                    } catch {}
                }
                results.push(item);
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
            this.#registerWorkspaceInstance(ws);
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
                roleManager: this.#roles,
                embedd: this.#embedd
            });

            this.#workspaces.set(workspaceId, workspace);
            this.#registerWorkspaceInstance(workspace);

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
        } else if (options.userEmail) {
            workspaceDir = path.join(this.#defaultRootPath, options.userEmail, 'Workspaces', sanitizedName);
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
            icon: options.icon || null,
            order: Number.isFinite(options.order) ? options.order : null,
            homeScreen: options.homeScreen || {},
            type: options.type || 'workspace',
            status: WORKSPACE_STATUS_CODES.AVAILABLE,
            rootPath: workspaceDir,
            configPath: configPath,
            host: host,
            reference: reference,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            metadata: options.metadata || {},
            acl: options.acl || { tokens: {}, users: {} },
            roles: options.roles || [],
            dataBackends: options.dataBackends || WorkspaceManager.#cloneConfigMap(WORKSPACE_DATA_BACKENDS),
            services: options.services || WorkspaceManager.#cloneConfigMap(WORKSPACE_SERVICES),
            links: options.links || {},
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

        this.#logger.debug({ workspaceId, userId }, 'Created workspace');
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

    async createPublicCanvasShare(ownerUserId, workspaceId, options = {}) {
        if (!this.#initialized) throw new Error('Not initialized');
        const workspace = await this.getWorkspace(workspaceId, ownerUserId);
        if (!workspace) throw new Error('Workspace not found');
        if (!workspace.isActive) await workspace.start();

        const treeName = options.treeName || Workspace.CONTEXT_TREE_NAME;
        const path = WorkspaceManager.#normalizeSharePath(options.path || '/');
        const tree = workspace.getTree(treeName);
        const layer = tree.getLayerForPath(path);
        if (!layer || layer.type !== 'canvas') {
            throw new Error(`Path is not a canvas: ${path}`);
        }

        const shares = workspace.publicCanvasShares || {};
        const existing = Object.values(shares).find((share) => (
            share?.workspaceId === workspace.id
            && share?.treeName === tree.name
            && share?.path === path
            && share?.layerId === layer.id
        ));
        if (existing) {
            await WorkspaceManager.#reconcilePublicCanvasLocks(tree, existing, shares);
            await WorkspaceManager.#lockPublicCanvasLayer(tree, existing);
            return existing;
        }

        const code = await this.#createPublicShareCode();
        const share = {
            code,
            workspaceId: workspace.id,
            owner: workspace.owner,
            treeId: tree.id,
            treeName: tree.name,
            treeType: tree.type,
            path,
            layerId: layer.id,
            createdAt: new Date().toISOString(),
        };

        const nextShares = { ...shares, [code]: share };
        await WorkspaceManager.#reconcilePublicCanvasLocks(tree, share, nextShares);
        await WorkspaceManager.#lockPublicCanvasLayer(tree, share);
        workspace.setPublicCanvasShares(nextShares);
        await this.updateWorkspaceConfig(workspace.owner, workspace.id, ownerUserId, { publicCanvasShares: nextShares });
        return share;
    }

    async resolvePublicCanvasShare(code) {
        if (!this.#initialized) throw new Error('Not initialized');
        const normalizedCode = WorkspaceManager.#normalizeShareCode(code);
        if (!normalizedCode) return null;

        const all = this.#indexStore.store || {};
        for (const key in all) {
            const entry = all[key];
            const share = entry?.publicCanvasShares?.[normalizedCode];
            if (!share) continue;

            const workspace = await this.getWorkspace(entry.id, entry.owner);
            if (!workspace) return null;
            return { share, workspace, workspaceEntry: entry };
        }
        return null;
    }

    async findPublicCanvasShare(ownerUserId, workspaceId, options = {}) {
        if (!this.#initialized) throw new Error('Not initialized');
        const workspace = await this.getWorkspace(workspaceId, ownerUserId);
        if (!workspace) throw new Error('Workspace not found');

        const treeName = options.treeName || Workspace.CONTEXT_TREE_NAME;
        const path = WorkspaceManager.#normalizeSharePath(options.path || '/');
        const tree = workspace.getTree(treeName);
        const layer = tree.getLayerForPath(path);
        if (!layer || layer.type !== 'canvas') {
            throw new Error(`Path is not a canvas: ${path}`);
        }

        return Object.values(workspace.publicCanvasShares || {}).find((share) => (
            share?.workspaceId === workspace.id
            && share?.treeName === tree.name
            && share?.path === path
            && share?.layerId === layer.id
        )) || null;
    }

    async deletePublicCanvasShare(requestingUserId, code, options = {}) {
        if (!this.#initialized) throw new Error('Not initialized');
        const resolved = await this.resolvePublicCanvasShare(code);
        if (!resolved) return false;
        const { workspace, share } = resolved;
        const allowedByWorkspaceAdmin = options.allowWorkspaceAdmin === true && options.workspaceId === share.workspaceId;
        if (share.owner !== requestingUserId && !allowedByWorkspaceAdmin) {
            throw new Error('Only the workspace owner can unshare this canvas');
        }

        const shares = { ...(workspace.publicCanvasShares || {}) };
        delete shares[share.code];

        if (!workspace.isActive) await workspace.start();

        let tree = null;
        try {
            // Prefer the immutable treeId; treeName is volatile (tree renames).
            tree = workspace.getTree(share.treeId || share.treeName);
        } catch (_) {
            // Legacy/remnant shares may point at trees that no longer exist.
        }
        if (tree) {
            await WorkspaceManager.#reconcilePublicCanvasLocks(tree, share, shares);
        }

        workspace.setPublicCanvasShares(shares);
        await this.updateWorkspaceConfig(workspace.owner, workspace.id, requestingUserId, { publicCanvasShares: shares });
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

    /**
     * Re-register a universe workspace from its on-disk config if it exists but is missing from the index.
     * Creates a fresh one if no on-disk config is found.
     * Returns the resolved workspace ID, or null on failure.
     */
    async repairUniverseWorkspace(userId, userEmail, universeWorkspacePath) {
        const configPath = path.join(universeWorkspacePath, WORKSPACE_CONFIG_FILENAME);

        if (existsSync(configPath)) {
            try {
                const raw = await fsPromises.readFile(configPath, 'utf8');
                const configData = JSON.parse(raw);
                if (configData?.id && configData?.owner === userId) {
                    const indexKey = `${userId}/${configData.id}`;
                    this.#indexStore.set(indexKey, { ...configData, rootPath: universeWorkspacePath, configPath });
                    this.#addToIndexes(userId, configData.id, configData.name, configData.host || WORKSPACE_DEFAULT_HOST, configData.reference);
                    this.#logger.info({ userId, workspaceId: configData.id }, 'Re-registered universe workspace from disk');
                    return configData.id;
                }
            } catch (e) {
                this.#logger.warn({ err: e, userId }, 'Failed to read existing universe workspace config');
            }
        }

        // No valid on-disk config — create fresh
        const newConfig = await this.createUniverseWorkspace(userId, userEmail, universeWorkspacePath);
        return newConfig?.id || null;
    }

    async removeWorkspace(workspaceId, userId, destroyData = false) {
        const ws = await this.getWorkspace(workspaceId, userId);
        if (!ws) return false;

        await ws.stop();
        this.#unregisterWorkspaceInstance(workspaceId);
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
        const sanitizedName = this.#sanitizeWorkspaceName(workspaceName || '');
        const nameKey = `${userId}@${host}:${sanitizedName}`;
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

        // Home service is auto-enabled by workspace.start() based on config
    }

    async stopWorkspace(workspaceId, userId) {
        const ws = await this.getWorkspace(workspaceId, userId);
        if (!ws) return true;

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

    async #createPublicShareCode() {
        for (let i = 0; i < 20; i++) {
            const code = WorkspaceManager.#randomShareCode();
            if (!await this.resolvePublicCanvasShare(code)) return code;
        }
        throw new Error('Failed to generate unique public canvas code');
    }

    static #randomShareCode() {
        const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
        const bytes = crypto.randomBytes(8);
        let out = '';
        for (const byte of bytes) {
            out += alphabet[byte % alphabet.length];
        }
        return out;
    }

    static #normalizeShareCode(code) {
        const normalized = String(code || '').trim().toLowerCase();
        return /^[a-z0-9]{1,8}$/.test(normalized) ? normalized : null;
    }

    static #normalizeSharePath(value) {
        const pathValue = `/${String(value || '').replace(/^\/+/, '')}`.replace(/\/+/g, '/');
        return pathValue.length > 1 ? pathValue.replace(/\/$/, '') : '/';
    }

    static async #lockPublicCanvasLayer(tree, share) {
        if (typeof tree.lockLayer !== 'function') return;
        await tree.lockLayer(share.layerId, WorkspaceManager.#publicShareLockId(share.code));
    }

    static async #unlockPublicCanvasLayer(tree, share) {
        if (typeof tree.unlockLayer !== 'function') return;
        try {
            await tree.unlockLayer(share.layerId, WorkspaceManager.#publicShareLockId(share.code));
        } catch (error) {
            if (!String(error?.message || '').includes('Layer not found')) {
                throw error;
            }
        }
    }

    static #getShareLayer(tree, share) {
        if (share?.path && typeof tree.getLayerForPath === 'function') {
            try {
                const layer = tree.getLayerForPath(share.path);
                if (layer) return layer;
            } catch (_) {
                // fall through
            }
        }
        if (typeof tree.getLayerById === 'function') {
            try {
                return tree.getLayerById(share.layerId);
            } catch (_) {
                return null;
            }
        }
        return null;
    }

    // Each public share adds a distinct public-share:<code> lock. Remove any that
    // no longer exist in workspace config (including the share being deleted).
    static async #reconcilePublicCanvasLocks(tree, share, remainingShares) {
        if (typeof tree.unlockLayer !== 'function') return;

        const allowed = new Set(
            Object.values(remainingShares || {})
                .filter((item) => (
                    item?.workspaceId === share.workspaceId
                    && item?.treeName === share.treeName
                    && item?.layerId === share.layerId
                ))
                .map((item) => WorkspaceManager.#publicShareLockId(item.code))
        );

        const layer = WorkspaceManager.#getShareLayer(tree, share);
        const locks = Array.isArray(layer?.lockedBy) ? [...layer.lockedBy] : [];
        for (const lockId of locks) {
            if (!String(lockId).startsWith('public-share:')) continue;
            if (allowed.has(lockId)) continue;
            await WorkspaceManager.#unlockPublicCanvasLayer(tree, {
                layerId: share.layerId,
                code: String(lockId).slice('public-share:'.length),
            });
        }
    }

    static #publicShareLockId(code) {
        return `public-share:${code}`;
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
        this.#logger.debug({ names: this.#nameIndex.size, references: this.#referenceIndex.size }, 'Rebuilt indexes');
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

    #registerWorkspaceInstance(workspace) {
        if (!workspace || this.#workspaceListeners.has(workspace.id)) { return; }

        const manager = this;
        const listener = function (payload = {}) {
            const eventName = this.event;
            if (!eventName) { return; }

            const eventPayload = payload && typeof payload === 'object'
                ? { ...payload }
                : { value: payload };

            if (!eventPayload.workspaceId) {
                eventPayload.workspaceId = workspace.id;
            }

            manager.emit(eventName, eventPayload);
        };

        workspace.on('**', listener);
        this.#workspaceListeners.set(workspace.id, { workspace, listener });
        this.hookService?.trackWorkspace(workspace);
    }

    #unregisterWorkspaceInstance(workspaceId) {
        const binding = this.#workspaceListeners.get(workspaceId);
        if (!binding) { return; }

        binding.workspace.off('**', binding.listener);
        this.#workspaceListeners.delete(workspaceId);
        this.hookService?.untrackWorkspace(workspaceId);
    }

    async #createSubdirectories(dir) {
        for (const key in WORKSPACE_DIRECTORIES) {
            await fsPromises.mkdir(path.join(dir, WORKSPACE_DIRECTORIES[key]), { recursive: true });
        }
    }

    static #cloneConfigMap(config) {
        return Object.fromEntries(Object.entries(config || {}).map(([key, value]) => [key, { ...(value || {}) }]));
    }

}

export default WorkspaceManager;
