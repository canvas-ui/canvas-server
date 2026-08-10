'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import randomcolor from 'randomcolor';
import path from 'path';
import * as fsPromises from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import Conf from 'conf';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

// Logging
import { createLogger } from '../../utils/log.js';
import { compareByUserOrder } from '../../utils/list-order.js';

// Includes
import Workspace from './Workspace.js';
import { WorkspaceErrorCode, accessDenied, workspaceNotFound, workspaceNotReady, notImplemented } from './lib/errors.js';
import { discoverWorkspaceCandidates, validateWorkspaceConfig, findWorkspaceConfigPath, workspaceConfigPathFor } from './lib/scanner.js';
import DotfileManager from './services/dotfile/index.js';
import { USER_MODULE_DIRS } from '../user/lib/paths.js';
import HookService from './services/hook/index.js';
import GraphService from './services/graph/index.js';
import ChatService from './services/chat/index.js';

// Constants
import {
    WORKSPACE_STATUS_CODES,
    WORKSPACE_CONFIG_FILENAME,
    WORKSPACE_DEFAULT_HOST,
    WORKSPACE_INTERNAL_DIRNAME,
    WORKSPACE_LAYOUTS,
    WORKSPACE_ORIGINS,
    normalizeWorkspaceLayout,
    workspaceDirectories,
    workspaceInternals,
    workspaceServices,
    workspaceStoredDefault,
} from './lib/constants.js';

// Fields that live only in the per-user index — they describe this server's
// relationship to the workspace dir, not the workspace itself, so they are
// never written into workspace.json (a transplanted dir must not carry them).
const INDEX_ONLY_FIELDS = ['origin', 'importedFrom', 'lastScannedAt', 'remote'];

function stripIndexOnlyFields(entry) {
    const clean = { ...entry };
    for (const field of INDEX_ONLY_FIELDS) delete clean[field];
    return clean;
}

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

    #indexFactory;      // Jim instance — per-user index files (db/users/<id>/workspaces.json)
    #userIndexes = new Map(); // userId -> Conf (lazily opened per-user index)
    #users;             // Users service
    #roles;             // Roles service
    #inferd;            // shared embedding service (optional; passed to each Workspace)
    #logger;

    #workspaces = new Map(); // Runtime cache
    #workspaceListeners = new Map();
    #initialized = false;
    #defaultRootPath;
    #defaultLayout;

    // Lookup Indexes (in-memory)
    #nameIndex = new Map();         // Key: userId@host:workspaceName -> workspaceId
    #referenceIndex = new Map();    // Key: fullReference -> workspaceId
    #idIndex = new Map();           // Key: workspaceId -> owner userId

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
        if (!options.indexFactory) throw new Error('indexFactory (jim) required');
        if (!options.users) throw new Error('users service required');

        this.#defaultRootPath = path.resolve(options.defaultRootPath);
        // Layout used when a caller does not name one. The container defaults it
        // to `home` (a workspace that is just a folder), a bare-metal install to
        // `full` — see CANVAS_WORKSPACE_LAYOUT.
        this.#defaultLayout = normalizeWorkspaceLayout(options.defaultLayout);
        this.#indexFactory = options.indexFactory;
        this.#users = options.users;
        this.#roles = options.roles;
        this.#inferd = options.inferd || null;
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

        // Rebuild lookups from the per-user index files first (scan needs the
        // id/name indexes for collision detection), then discover/validate each
        // user's on-disk workspaces — the index is a rebuildable cache of the
        // workspace.json files.
        await this.#rebuildIndexes();
        try {
            const users = await this.#users.list();
            for (const user of users) {
                try {
                    await this.scanUserWorkspaces(user.id);
                } catch (err) {
                    this.#logger.warn({ err, userId: user.id }, 'Workspace scan failed for user');
                }
            }
        } catch (err) {
            this.#logger.warn({ err }, 'Workspace discovery scan failed');
        }

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
    get rootPath() { return this.#defaultRootPath; }
    get defaultLayout() { return this.#defaultLayout; }
    get roles() { return this.#roles; }
    get inferd() { return this.#inferd; }

    setRoles(roles) {
        this.#roles = roles;
    }

    setContextManager(_contextManager) {
    }

    async listWorkspaces(userId) {
        if (!this.#initialized) throw new Error('Not initialized');

        const results = [];
        let userEmail = null;

        if (userId) {
            try {
                const u = await this.#users.get(userId);
                userEmail = u?.email || null;
            } catch  {
                userEmail = null;
            }
        }

        for (const [, entry] of this.#allEntries()) {
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
                    } catch { /* intentionally ignored */ }
                } else {
                    try {
                        const ownerUser = await this.#users.get(entry.owner);
                        if (ownerUser?.email) item.ownerEmail = ownerUser.email;
                    } catch { /* intentionally ignored */ }
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
                    } catch { /* intentionally ignored */ }
                } else {
                    try {
                        const ownerUser = await this.#users.get(entry.owner);
                        if (ownerUser?.email) item.ownerEmail = ownerUser.email;
                    } catch { /* intentionally ignored */ }
                }
                results.push(item);
            }
        }
        // User-defined order at the source so every consumer (web lists,
        // Link To pickers, CLI, ...) sees the same ordering: explicit `order`
        // first, unordered last, stable tiebreak on createdAt then name.
        return results.sort(compareByUserOrder);
    }

    // Every workspace entry across all users — the explicit form of the
    // no-arg listWorkspaces() used by cross-user resolution (ACL middleware,
    // public shares, token lookups).
    async listAllWorkspaces() {
        return this.listWorkspaces();
    }

    async hasWorkspace(workspaceId, userId) {
        // Check index
        const entry = this.#findInIndex(workspaceId);
        if (!entry) return false;
        if (userId && entry.owner !== userId) return false;
        return true;
    }

    /**
     * Resolve a workspace share token (canvas-workspace-*) to the workspace it
     * grants access to. Single source of truth for REST auth, websocket auth
     * and the ACL middleware — the token alone identifies the workspace, no
     * route params needed. Returns null for unknown or expired tokens.
     * @param {string} tokenValue - Raw token value
     * @returns {Object|null} { workspaceId, workspaceName, owner, permissions, tokenData }
     */
    resolveWorkspaceShareToken(tokenValue) {
        if (!tokenValue || typeof tokenValue !== 'string') return null;

        const hashKey = `sha256:${crypto.createHash('sha256').update(tokenValue).digest('hex')}`;
        for (const [, entry] of this.#allEntries()) {
            // workspace.json is the source of truth for the ACL — the index
            // copy is a registration-time snapshot. Prefer the loaded
            // instance, fall back to reading the config file.
            let acl = this.#workspaces.get(entry.id)?.acl;
            if (!acl && entry.configPath && existsSync(entry.configPath)) {
                try {
                    acl = JSON.parse(readFileSync(entry.configPath, 'utf8'))?.acl;
                } catch { /* unreadable config — treat as no ACL */ }
            }
            const tokenData = acl?.tokens?.[hashKey];
            if (!tokenData) continue;
            if (tokenData.expiresAt && new Date(tokenData.expiresAt) < new Date()) return null;
            return {
                workspaceId: entry.id,
                workspaceName: entry.name,
                owner: entry.owner,
                permissions: tokenData.permissions || ['read'],
                tokenData,
            };
        }
        return null;
    }

    /**
     * Raw index entry lookup — no Workspace instantiation. Lets config-level
     * operations (PATCH/DELETE) work on workspaces that cannot be instantiated
     * (missing/legacy directory, status not_found).
     * @param {string} workspaceId - Workspace ID or name
     * @param {string|null} userId - When set, entry must be owned by this user
     * @returns {Object|null} Index entry (plain config object) or null
     */
    getWorkspaceIndexEntry(workspaceId, userId = null) {
        // #findInIndex matches by id only — resolve names the same way
        // tryOwnerAccess does before giving up.
        let entry = this.#findInIndex(workspaceId);
        if (!entry && userId) {
            const resolvedId = this.resolveWorkspaceId(userId, workspaceId);
            if (resolvedId) entry = this.#findInIndex(resolvedId);
        }
        if (!entry) return null;
        if (userId && entry.owner !== userId) return null;
        return entry;
    }

    /**
     * Resolve a workspace instance, returning `null` on any failure (not found,
     * access denied, or not instantiable). Kept for backward compatibility —
     * the many callers that branch on `if (!workspace)` continue to work.
     * Use {@link getWorkspaceOrThrow} when the caller needs to distinguish
     * *why* a workspace is unavailable (e.g. to return 403 vs 404 vs 503).
     */
    async getWorkspace(workspaceId, userId) {
        try {
            return await this.getWorkspaceOrThrow(workspaceId, userId);
        } catch (err) {
            // Coded workspace errors map cleanly back to the null contract;
            // anything unexpected (e.g. "Not initialized") still propagates.
            if (err && err.code && WorkspaceErrorCode[err.code]) {
                return null;
            }
            throw err;
        }
    }

    /**
     * Like {@link getWorkspace} but throws a coded workspace error instead of
     * returning null, so callers can distinguish permission failures from a
     * transient "workspace not ready" condition. Mirrors ContextManager.getContext.
     * @throws accessDenied (403) / workspaceNotFound (404) / workspaceNotReady (503)
     */
    async getWorkspaceOrThrow(workspaceId, userId) {
        if (!this.#initialized) throw new Error('Not initialized');

        // 1. Check cache
        if (this.#workspaces.has(workspaceId)) {
            const ws = this.#workspaces.get(workspaceId);
            if (userId && ws.owner !== userId) {
                throw accessDenied(`Access denied to workspace ${workspaceId}`);
            }
            this.#registerWorkspaceInstance(ws);
            return ws;
        }

        // 2. Load from index
        const entry = this.#findInIndex(workspaceId);
        if (!entry) throw workspaceNotFound(`Workspace not found: ${workspaceId}`);
        if (userId && entry.owner !== userId) {
            throw accessDenied(`Access denied to workspace ${workspaceId}`);
        }
        if (entry.origin === WORKSPACE_ORIGINS.REMOTE) {
            throw notImplemented(`Workspace ${workspaceId} is remote (${entry.host}) — remote workspaces are not yet supported`);
        }

        // 3. Instantiate
        // A missing config file would produce a hollow instance (owner/id
        // undefined from an empty Conf store) that poisons the cache and
        // breaks every downstream call — treat as not instantiable (retryable).
        if (!entry.configPath || !existsSync(entry.configPath)) {
            console.error(`Workspace ${workspaceId} config missing at ${entry.configPath} — not instantiable`);
            throw workspaceNotReady(`Workspace ${workspaceId} is not available (config missing)`);
        }

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
                inferd: this.#inferd
            });

            this.#workspaces.set(workspaceId, workspace);
            this.#registerWorkspaceInstance(workspace);

            return workspace;
        } catch (err) {
            console.error(`Failed to load workspace ${workspaceId}:`, err);
            throw workspaceNotReady(`Failed to load workspace ${workspaceId}: ${err.message}`);
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
        const layout = normalizeWorkspaceLayout(options.layout || this.#defaultLayout);

        const workspaceDir = options.rootPath
            || path.join(await this.userWorkspacesPath(userId, options.userEmail), sanitizedName);

        if (existsSync(workspaceDir)) {
            // A `home`-layout workspace is meant to wrap a folder the user
            // already has (that's the roaming-profile case): adopting it costs
            // nothing but a `.workspace/` dir. `full` would scatter home/, db/,
            // data/ … through their files, so it keeps refusing.
            if (findWorkspaceConfigPath(workspaceDir)) {
                throw new Error(`Directory is already a workspace: ${workspaceDir}`);
            }
            if (layout !== WORKSPACE_LAYOUTS.HOME) {
                throw new Error(`Workspace directory already exists: ${workspaceDir}`);
            }
        }

        await fsPromises.mkdir(workspaceDir, { recursive: true });
        await this.#createSubdirectories(workspaceDir, layout);

        const configPath = workspaceConfigPathFor(workspaceDir, layout);

        const reference = constructWorkspaceReference(userId, sanitizedName, host);

        const configData = {
            id: workspaceId,
            name: sanitizedName,
            label: options.label || sanitizedName,
            // Folder structure — fixed at creation, drives the internals/services
            // defaults below and where workspace.json itself lives.
            layout,
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
            internals: { ...workspaceInternals(layout) },
            // services.stored carries the storage config (root/cache/sync/backends);
            // the layout builders already return fresh (deep-cloned) objects.
            services: options.services || {
                ...workspaceServices(layout),
                stored: {
                    ...workspaceStoredDefault(layout),
                    ...(options.dataBackends ? { backends: options.dataBackends } : {}),
                },
            },
            links: options.links || {},
        };

        // Store config (in `.workspace/` for the home layout — hence dirname,
        // not workspaceDir)
        const conf = new Conf({
            configName: path.basename(configPath, '.json'),
            cwd: path.dirname(configPath),
            accessPropertiesByDotNotation: false
        });
        conf.store = configData;

        // Index it in the owner's per-user index (key: workspaceId). The
        // workspace.json above is the source of truth; the entry mirrors it
        // plus index-only bookkeeping.
        const origin = this.#classifyOrigin(workspaceDir);
        this.#getUserIndex(userId).set(workspaceId, {
            ...configData,
            origin,
            importedFrom: null,
            lastScannedAt: null,
            remote: null,
        });

        // Update in-memory lookups
        this.#addToIndexes(userId, workspaceId, sanitizedName, host, reference);

        this.#logger.debug({ workspaceId, userId, origin }, 'Created workspace');
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

        const userIndex = this.#getUserIndex(ownerUserId);
        const existing = userIndex.get(workspaceId);
        if (!existing) {
            return false;
        }

        const newEntry = {
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
            // workspace.json never carries the index-only bookkeeping fields
            conf.store = stripIndexOnlyFields(newEntry);
        } catch (err) {
            console.error(`Failed to persist workspace config for ${workspaceId}:`, err);
            return false;
        }

        userIndex.set(workspaceId, newEntry);
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

        for (const [, entry] of this.#allEntries()) {
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

    async removeWorkspace(workspaceId, userId, destroyData = false) {
        // Resolve via the index so broken workspaces (missing dir, legacy
        // config) stay deletable — instantiation is best-effort for stop().
        const entry = this.getWorkspaceIndexEntry(workspaceId, userId);
        if (!entry) return false;

        const ws = await this.getWorkspace(entry.id, userId);
        if (ws) {
            await ws.stop();
        }
        this.#unregisterWorkspaceInstance(entry.id);
        this.#workspaces.delete(entry.id);

        this.#getUserIndex(entry.owner).delete(entry.id);
        this.#removeFromIndexes(entry.owner, entry.id, entry.name, entry.host || WORKSPACE_DEFAULT_HOST, entry.reference);

        // Remote entries are index-only on this server — nothing to destroy.
        if (destroyData && entry.origin !== WORKSPACE_ORIGINS.REMOTE && entry.rootPath && existsSync(entry.rootPath)) {
            await fsPromises.rm(entry.rootPath, { recursive: true, force: true });
        }

        this.emit('workspace.deleted', { workspaceId: entry.id, userId: entry.owner });
        return true;
    }

    /**
     * Discovery / import
     */

    /**
     * Scan a user's workspace directories (Workspaces/ + legacy workspaces/)
     * for directories holding a valid workspace.json and (re)register them in
     * the user's index. Transplanted directories get their rootPath rewritten,
     * foreign owners are adopted (recorded as importedFrom), id collisions get
     * a fresh id, name collisions an incremented suffix. Also validates
     * existing index entries against disk.
     * @returns {Promise<{discovered: [], adopted: [], updated: [], skipped: [], missing: []}>}
     */
    async scanUserWorkspaces(userId) {
        const report = { discovered: [], adopted: [], updated: [], skipped: [], missing: [] };

        let user;
        try {
            user = await this.#users.get(userId);
        } catch {
            user = null;
        }
        if (!user?.homePath) {
            throw new Error(`Cannot scan workspaces: user not found: ${userId}`);
        }

        const home = path.resolve(user.homePath);
        // The user's configured workspaces root (which may sit anywhere —
        // ~/Workspaces on a personal instance), plus the in-home legacy
        // lowercase dir that older installs still use.
        const roots = [await this.userWorkspacesPath(userId), path.join(home, 'workspaces')];
        const { candidates, skipped } = await discoverWorkspaceCandidates(roots);
        report.skipped.push(...skipped);

        for (const candidate of candidates) {
            try {
                const result = await this.#indexWorkspaceFromDisk(userId, candidate, WORKSPACE_ORIGINS.LOCAL);
                if (result) {
                    report[result.kind].push({
                        id: result.id,
                        name: result.name,
                        dir: candidate.dir,
                        ...(result.importedFrom ? { importedFrom: result.importedFrom } : {}),
                    });
                }
            } catch (err) {
                this.#logger.warn({ err, dir: candidate.dir, userId }, 'Failed to register scanned workspace');
                report.skipped.push({ dir: candidate.dir, reason: err.message });
            }
        }

        // Validate existing entries against disk
        const userIndex = this.#getUserIndex(userId);
        const store = userIndex.store || {};
        for (const wsId in store) {
            const entry = store[wsId];
            if (!entry || entry.origin === WORKSPACE_ORIGINS.REMOTE) continue;

            if (!entry.rootPath || !existsSync(entry.rootPath)) {
                if (entry.status !== WORKSPACE_STATUS_CODES.NOT_FOUND) {
                    userIndex.set(wsId, { ...entry, status: WORKSPACE_STATUS_CODES.NOT_FOUND });
                }
                report.missing.push({ id: wsId, name: entry.name, rootPath: entry.rootPath || null });
            } else if (entry.status === WORKSPACE_STATUS_CODES.ACTIVE && !this.#workspaces.has(wsId)) {
                // Reset stale active state (e.g. after a server restart)
                userIndex.set(wsId, { ...entry, status: WORKSPACE_STATUS_CODES.INACTIVE });
            } else if (entry.status === WORKSPACE_STATUS_CODES.NOT_FOUND) {
                // Directory reappeared
                userIndex.set(wsId, { ...entry, status: WORKSPACE_STATUS_CODES.AVAILABLE });
            }
        }

        return report;
    }

    /**
     * Where this user's workspaces live — their `workspaces` module root.
     * Single authority for both discovery and default placement of new
     * workspaces; falls back to <userHome>/Workspaces when the users service
     * cannot resolve it (older callers, stub services).
     * @param {string} userId
     * @param {string} [userEmail] - only used by the last-resort fallback
     * @returns {Promise<string>}
     */
    async userWorkspacesPath(userId, userEmail = null) {
        try {
            const resolved = this.#users.getUserPaths?.(userId)?.workspaces;
            if (resolved) return resolved;
        } catch (err) {
            this.#logger.debug({ userId, error: err.message }, 'Falling back to the in-home workspaces root');
        }
        // Fallbacks for callers/services that predate the module-root resolver.
        try {
            const user = await this.#users.get(userId);
            if (user?.homePath) return path.join(user.homePath, USER_MODULE_DIRS.workspaces);
        } catch { /* unknown user — fall through to the email-based default */ }
        return userEmail
            ? path.join(this.#defaultRootPath, userEmail, USER_MODULE_DIRS.workspaces)
            : path.join(this.#defaultRootPath, 'workspaces');
    }

    /**
     * Register a workspace by absolute path (foreign-local support). The dir
     * must contain a valid workspace.json. Paths inside the user's workspace
     * dirs classify as `local`, anything else as `foreign-local`.
     * @param {string} userId
     * @param {string} absolutePath
     * @param {Object} [options]
     * @param {boolean} [options.adopt=true] - rewrite a foreign owner to userId
     * @returns {Promise<Object>} the created index entry
     */
    async registerWorkspacePath(userId, absolutePath, options = {}) {
        if (!this.#initialized) throw new Error('Not initialized');
        const adopt = options.adopt !== false;

        if (!absolutePath || !path.isAbsolute(absolutePath)) {
            throw new Error('An absolute workspace path is required');
        }
        const dir = path.resolve(absolutePath);
        if (!existsSync(dir)) {
            throw new Error(`Workspace directory not found: ${dir}`);
        }
        // Either layout: <dir>/workspace.json or <dir>/.workspace/workspace.json
        const configPath = findWorkspaceConfigPath(dir);
        if (!configPath) {
            throw new Error(`No ${WORKSPACE_CONFIG_FILENAME} found in: ${dir}`);
        }

        const config = JSON.parse(await fsPromises.readFile(configPath, 'utf8'));
        const invalid = validateWorkspaceConfig(config);
        if (invalid) {
            throw new Error(`Invalid ${WORKSPACE_CONFIG_FILENAME}: ${invalid}`);
        }

        // Reject an already-registered directory (any user)
        for (const [, entry] of this.#allEntries()) {
            if (entry?.rootPath && path.resolve(entry.rootPath) === dir) {
                throw new Error(`Workspace directory already registered: ${dir} (workspace ${entry.id})`);
            }
        }

        if (!adopt && config.owner !== userId) {
            throw new Error(`Workspace at ${dir} is owned by ${config.owner}; pass adopt=true to take ownership`);
        }

        const result = await this.#indexWorkspaceFromDisk(userId, { dir, configPath, config }, this.#classifyOrigin(dir));
        return this.#getUserIndex(userId).get(result.id);
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
        const _services = workspace.services || {};

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

    // Lazily open a user's index file (db/users/<userId>/workspaces.json).
    // Conf keeps the file content in memory, so this is a one-time cost per user.
    #getUserIndex(userId) {
        if (!this.#userIndexes.has(userId)) {
            this.#userIndexes.set(userId, this.#indexFactory.getOrCreateIndex('workspaces', { scope: `users/${userId}` }));
        }
        return this.#userIndexes.get(userId);
    }

    // Union of users known to the Users service and indexes already opened
    // (covers entries whose user record was deleted).
    #knownUserIds() {
        const ids = new Set(this.#userIndexes.keys());
        for (const id of Object.keys(this.#users.indexStore?.store || {})) {
            ids.add(id);
        }
        return ids;
    }

    // Iterate every [userId, entry] across all per-user indexes.
    *#allEntries() {
        for (const userId of this.#knownUserIds()) {
            const store = this.#getUserIndex(userId).store || {};
            for (const wsId in store) {
                if (store[wsId]) yield [userId, store[wsId]];
            }
        }
    }

    #classifyOrigin(dir) {
        // Anything under the users root (a user home) is a normal local
        // workspace; arbitrary paths elsewhere on this machine are foreign-local.
        const resolved = path.resolve(dir);
        return resolved.startsWith(this.#defaultRootPath + path.sep)
            ? WORKSPACE_ORIGINS.LOCAL
            : WORKSPACE_ORIGINS.FOREIGN_LOCAL;
    }

    #findInIndex(workspaceId) {
        const ownerId = this.#idIndex.get(workspaceId);
        if (ownerId) {
            const entry = this.#getUserIndex(ownerId).get(workspaceId);
            if (entry) return entry;
        }
        // Fallback linear scan (entry added out-of-band); repair the id index on hit.
        for (const [userId, entry] of this.#allEntries()) {
            if (entry.id === workspaceId) {
                this.#idIndex.set(workspaceId, userId);
                return entry;
            }
        }
        return null;
    }

    /**
     * Register/refresh one on-disk workspace dir in the user's index.
     * Handles adoption (foreign owner), id collisions (fresh uuid for live
     * duplicates, replacement for stale entries), name collisions (suffix),
     * and path drift (transplanted dirs). Writes back to workspace.json only
     * when something actually changed.
     * @returns {{kind: 'discovered'|'adopted'|'updated', id, name, importedFrom}|null} null when already indexed and unchanged
     */
    async #indexWorkspaceFromDisk(userId, { dir, configPath, config }, origin) {
        const cfg = { ...stripIndexOnlyFields(config) };
        const host = cfg.host || WORKSPACE_DEFAULT_HOST;
        const userIndex = this.#getUserIndex(userId);
        let changed = false;
        let importedFrom = null;
        let kind = 'discovered';

        // Layout: the config is authoritative, but a workspace.json sitting in
        // `.workspace/` can only be a home-layout one — infer and stamp it so a
        // hand-built (or pre-layout) dir resolves its paths correctly.
        const inferredLayout = path.basename(path.dirname(configPath)) === WORKSPACE_INTERNAL_DIRNAME
            ? WORKSPACE_LAYOUTS.HOME
            : WORKSPACE_LAYOUTS.FULL;
        if (normalizeWorkspaceLayout(cfg.layout) !== inferredLayout || !cfg.layout) {
            cfg.layout = inferredLayout;
            changed = true;
        }

        // ID collision handling
        const existingOwner = this.#idIndex.get(cfg.id);
        const existingEntry = existingOwner ? this.#getUserIndex(existingOwner).get(cfg.id) : null;
        const samePath = existingEntry?.rootPath && path.resolve(existingEntry.rootPath) === path.resolve(dir);

        if (existingEntry && existingOwner === userId && samePath) {
            kind = 'updated'; // already indexed — refresh below, report only if changed
        } else if (existingEntry && existingOwner === userId && (!existingEntry.rootPath || !existsSync(existingEntry.rootPath))) {
            // Stale entry pointing at a gone dir — this dir replaces it (moved workspace)
            this.#removeFromIndexes(userId, cfg.id, existingEntry.name, existingEntry.host || WORKSPACE_DEFAULT_HOST, existingEntry.reference);
            kind = 'updated';
        } else if (existingEntry) {
            // Live duplicate (copied dir, same or different user) — newcomer gets a fresh id
            this.#logger.warn({ dir, duplicateOf: cfg.id, existingOwner }, 'Workspace id collision — assigning new id');
            cfg.id = uuidv4();
            changed = true;
        }

        // Owner adoption — the dir lives under this user's control now
        if (cfg.owner !== userId) {
            importedFrom = cfg.owner || null;
            cfg.owner = userId;
            changed = true;
            if (kind === 'discovered') kind = 'adopted';
            this.#logger.info({ dir, userId, importedFrom }, 'Adopting workspace from foreign owner');
        }

        // Name collision within the user — suffix until unambiguous
        const baseName = this.#sanitizeWorkspaceName(cfg.name) || 'workspace';
        let name = baseName;
        let suffix = 1;
        while (true) {
            const holder = this.#nameIndex.get(`${userId}@${host}:${name}`);
            if (!holder || holder === cfg.id) break;
            suffix += 1;
            name = `${baseName}-${suffix}`;
        }
        if (name !== cfg.name) {
            this.#logger.warn({ dir, from: cfg.name, to: name }, 'Workspace name adjusted on registration');
            cfg.name = name;
            changed = true;
        }

        // Reference + path drift (transplanted/copied dirs)
        const expectedReference = constructWorkspaceReference(userId, cfg.name, host);
        if (cfg.reference !== expectedReference) {
            cfg.reference = expectedReference;
            changed = true;
        }
        if (cfg.rootPath !== dir || cfg.configPath !== configPath) {
            cfg.rootPath = dir;
            cfg.configPath = configPath;
            changed = true;
        }

        if (changed) {
            cfg.updatedAt = new Date().toISOString();
            const conf = new Conf({
                configName: path.basename(configPath, '.json'),
                cwd: path.dirname(configPath), // `.workspace/` in the home layout
                accessPropertiesByDotNotation: false
            });
            conf.store = cfg;
        }

        const previous = userIndex.get(cfg.id) || null;
        const isActive = this.#workspaces.has(cfg.id);
        userIndex.set(cfg.id, {
            ...cfg,
            status: isActive ? WORKSPACE_STATUS_CODES.ACTIVE : WORKSPACE_STATUS_CODES.AVAILABLE,
            origin,
            importedFrom: importedFrom ?? previous?.importedFrom ?? null,
            lastScannedAt: new Date().toISOString(),
            remote: previous?.remote ?? null,
        });
        this.#addToIndexes(userId, cfg.id, cfg.name, host, cfg.reference);

        if (kind === 'updated' && previous && !changed) {
            return null; // routine rescan of an unchanged workspace
        }
        return { kind, id: cfg.id, name: cfg.name, importedFrom };
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

    async #rebuildIndexes() {
        this.#nameIndex.clear();
        this.#referenceIndex.clear();
        this.#idIndex.clear();

        for (const [userId, entry] of this.#allEntries()) {
            if (entry.owner && entry.name) {
                this.#addToIndexes(
                    userId,
                    entry.id,
                    entry.name,
                    entry.host || WORKSPACE_DEFAULT_HOST,
                    entry.reference
                );
            }
        }
        this.#logger.debug({ names: this.#nameIndex.size, references: this.#referenceIndex.size, ids: this.#idIndex.size }, 'Rebuilt indexes');
    }

    #addToIndexes(userId, workspaceId, name, host, reference) {
        const nameKey = `${userId}@${host}:${name}`;
        this.#nameIndex.set(nameKey, workspaceId);
        this.#idIndex.set(workspaceId, userId);

        if (reference) {
            this.#referenceIndex.set(reference, workspaceId);
        }
    }

    #removeFromIndexes(userId, workspaceId, name, host, reference) {
        const nameKey = `${userId}@${host}:${name}`;
        this.#nameIndex.delete(nameKey);
        this.#idIndex.delete(workspaceId);
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

    async #createSubdirectories(dir, layout) {
        const directories = workspaceDirectories(layout);
        for (const key in directories) {
            await fsPromises.mkdir(path.join(dir, directories[key]), { recursive: true });
        }
    }

}

export default WorkspaceManager;
