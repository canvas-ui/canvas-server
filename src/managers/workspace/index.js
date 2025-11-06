'use strict';

// Utils
import randomcolor from 'randomcolor';
import path from 'path';
import * as fsPromises from 'fs/promises';
import { existsSync } from 'fs';
import EventEmitter from 'eventemitter2';
import Conf from 'conf';
import { generateUUID } from '../../utils/id.js';
//import AdmZip from 'adm-zip';

// Logging
import logger, { createDebug } from '../../utils/log/index.js';
const debug = createDebug('workspace-manager');

// Includes
import Workspace from './Workspace.js';

// Constants
import {
    WORKSPACE_DEFAULT_HOST,
    WORKSPACE_CONFIG_FILENAME,
    WORKSPACE_DIRECTORIES,
    WORKSPACE_STATUS_CODES,
} from '../workspaced/constants.js';


/**
 * Workspace Reference Utilities
 */

/**
 * Parse simple workspace identifier in format user.name/workspace.name
 * @param {string} workspaceIdentifier - Simple workspace identifier
 * @returns {Object|null} Parsed identifier or null if invalid
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

    return null; // Not a user/workspace format
}

/**
 * Parse workspace reference in format [user_identifier]@[host]:[workspace_slug][/optional_path...]
 * @param {string} workspaceRef - Workspace reference string
 * @returns {Object|null} Parsed reference or null if invalid
 */
function parseWorkspaceReference(workspaceRef) {
    if (!workspaceRef || typeof workspaceRef !== 'string') {
        return null;
    }

    const colonIndex = workspaceRef.indexOf(':');
    if (colonIndex === -1 || colonIndex === workspaceRef.length - 1) {
        return null; // No colon or empty resource part
    }

    const userHostPart = workspaceRef.substring(0, colonIndex);
    const resourcePart = workspaceRef.substring(colonIndex + 1);

    const atIndex = userHostPart.lastIndexOf('@');
    if (atIndex === -1 || atIndex === 0 || atIndex === userHostPart.length - 1) {
        return null; // No '@' or it's at the start/end
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

/**
 * Construct workspace reference string
 * @param {string} userIdentifier - User ID, name, or email
 * @param {string} workspaceSlug - Workspace slug/name
 * @param {string} [host=WORKSPACE_DEFAULT_HOST] - Host (defaults to canvas.local)
 * @param {string} [path=''] - Optional path within workspace
 * @returns {string} Workspace reference string
 */
function constructWorkspaceReference(userIdentifier, workspaceSlug, host = WORKSPACE_DEFAULT_HOST, path = '') {
    if (!userIdentifier || !workspaceSlug) {
        throw new Error('userIdentifier and workspaceSlug are required to construct a workspace reference.');
    }
    return `${userIdentifier}@${host}:${workspaceSlug}${path}`;
}

/**
 * Construct workspace index key from user ID and workspace ID
 * @param {string} userId - User ID
 * @param {string} workspaceId - Workspace ID (12-char nanoid)
 * @returns {string} Index key for internal storage
 */
function constructWorkspaceIndexKey(userId, workspaceId) {
    // Use forward slash separator to match context format: user.id/workspace.id
    return `${userId}/${workspaceId}`;
}

/**
 * Parse workspace index key to extract user ID and workspace ID
 * @param {string} indexKey - Index key from storage
 * @returns {Object|null} Parsed {userId, workspaceId} or null if invalid
 */
function parseWorkspaceIndexKey(indexKey) {
    if (!indexKey || typeof indexKey !== 'string') {
        return null;
    }

    const parts = indexKey.split('/');
    if (parts.length !== 2) {
        return null;
    }

    return {
        userId: parts[0],
        workspaceId: parts[1]
    };
}

/**
 * Workspace Manager (Enhanced with new naming convention)
 */

class WorkspaceManager extends EventEmitter {

    #defaultRootPath;   // Default Root path for all user workspaces managed by this instance (e.g., /users)
    #indexStore;        // Persistent index of all workspaces (key: userId/workspace.id -> workspace data)
    #nameIndex;         // Secondary index for name lookups (key: userId@host:workspaceName -> workspace.id)
    #referenceIndex;    // Tertiary index for full reference lookups (key: userIdentifier@host:workspaceName -> workspace.id)
    #userManager;       // UserManager instance for resolving user identifiers
    #roleManager;       // RoleManager instance for role management

    // Runtime
    #workspaces = new Map(); // Cache for loaded Workspace instances (key: workspace.id -> Workspace)
    #initialized = false; // Add initialized flag

    /**
     * Constructor
     * @param {Object} options - Configuration options
     * @param {string} options.defaultRootPath - Root path where user workspace directories are stored
     * @param {Object} options.indexStore - Initialized Conf instance for the workspace index
     * @param {Object} options.userManager - Initialized UserManager instance
     * @param {Object} [options.roleManager] - RoleManager instance for role integration
     * @param {Object} [options.eventEmitterOptions] - Options for EventEmitter2
     */
    constructor(options = {}) {
        super(options.eventEmitterOptions || {});

        if (!options.defaultRootPath) {
            throw new Error('Workspaces defaultRootPath is required for WorkspaceManager');
        }

        if (!options.indexStore) {
            throw new Error('Index store is required for WorkspaceManager');
        }

        if (!options.userManager) {
            throw new Error('UserManager is required for WorkspaceManager');
        }

        this.#defaultRootPath = path.resolve(options.defaultRootPath); // Ensure absolute path
        this.#indexStore = options.indexStore;
        this.#userManager = options.userManager; // Store userManager instance
        this.#roleManager = options.roleManager; // Store roleManager instance
        this.#nameIndex = new Map(); // In-memory secondary index for name lookups
        this.#referenceIndex = new Map(); // In-memory tertiary index for reference lookups

        debug(`Initializing WorkspaceManager with default rootPath: ${this.#defaultRootPath}`);
    }

    /**
     * Getters
     */

    get userManager() { return this.#userManager; }
    get roleManager() { return this.#roleManager; }

    /**
     * Private helper to construct workspace index key
     * @param {string} userId - User ID
     * @param {string} workspaceId - Workspace ID
     * @returns {string} Index key in format userId/workspaceId
     * @private
     */
    #constructWorkspaceIndexKey(userId, workspaceId) {
        return constructWorkspaceIndexKey(userId, workspaceId);
    }

    /**
     * Private helper to parse workspace index key
     * @param {string} indexKey - Index key in format userId/workspaceId
     * @returns {Object|null} Parsed {userId, workspaceId} or null if invalid
     * @private
     */
    #parseWorkspaceIndexKey(indexKey) {
        return parseWorkspaceIndexKey(indexKey);
    }

    /**
     * Parse workspace reference string
     * @param {string} workspaceRef - Workspace reference in format userIdentifier@host:workspaceSlug[/path]
     * @returns {Object|null} Parsed reference or null if invalid
     */
    parseWorkspaceReference(workspaceRef) {
        return parseWorkspaceReference(workspaceRef);
    }

    /**
     * Parse simple workspace identifier in format user.name/workspace.name
     * @param {string} workspaceIdentifier - Simple workspace identifier
     * @returns {Object|null} Parsed identifier or null if invalid
     */
    parseSimpleWorkspaceIdentifier(workspaceIdentifier) {
        return parseSimpleWorkspaceIdentifier(workspaceIdentifier);
    }

    /**
     * Construct workspace reference string
     * @param {string} userIdentifier - User ID, name, or email
     * @param {string} workspaceSlug - Workspace slug/name
     * @param {string} [host=WORKSPACE_DEFAULT_HOST] - Host (defaults to canvas.local)
     * @param {string} [path=''] - Optional path within workspace
     * @returns {string} Workspace reference string
     */
    constructWorkspaceReference(userIdentifier, workspaceSlug, host = WORKSPACE_DEFAULT_HOST, path = '') {
        return constructWorkspaceReference(userIdentifier, workspaceSlug, host, path);
    }

    /**
     * Initialization
     */
    async initialize() {
        if (this.#initialized) { return true; }

        // Rebuild name and reference indexes from existing workspaces
        await this.#rebuildIndexes();

        // Scan the index for all workspaces
        await this.#scanIndexedWorkspaces();

        // We are OK to go
        this.#initialized = true;
        debug(`WorkspaceManager initialized with ${this.#indexStore.size} workspace(s) in index`);

        // Return the instance
        return this;
    }

    /**
     * Public API - Workspace Lifecycle & Management
     */

    /**
     * Creates a new workspace directory, config file, and adds it to the index.
     * @param {string} userId - The user ID for key prefix (must be user.id, not user.email)
     * @param {string} workspaceName - The desired workspace name (slug-like identifier).
     * @param {Object} options - Additional options for workspace config.
     * @param {string} options.owner - The ULID of the user who owns this workspace.
     * @param {string} [options.rootPath] - Custom root for this workspace path.
     * @param {string} [options.workspacePath] - Absolute path for out-of-tree workspace.
     * @param {string} [options.type='workspace'] - Type of workspace.
     * @param {string} [options.host=WORKSPACE_DEFAULT_HOST] - Host for the workspace reference.
     * @returns {Promise<Object>} The index entry of the newly created workspace.
     */
    async createWorkspace(userId, workspaceName, options = {}) {
        if (!this.#initialized) throw new Error('WorkspaceManager not initialized');
        if (!userId) throw new Error('userId required to create a workspace.');
        if (!workspaceName) throw new Error('Workspace name required to create a workspace.');

        // The provided userId is now treated as an identifier that needs resolution
        const ownerId = await this.#userManager.resolveToUserId(userId);
        if (!ownerId) {
            throw new Error(`Could not resolve user identifier: "${userId}"`);
        }

        // Sanitize the workspace name
        workspaceName = this.#sanitizeWorkspaceName(workspaceName);
        const host = options.host || WORKSPACE_DEFAULT_HOST;

        // Generate unique workspace ID
        const workspaceId = options.id || generateUUID();

        // Check if workspace name already exists for this user on this host
        const referenceKey = this.constructWorkspaceReference(userId, workspaceName, host);
        if (this.#referenceIndex.has(referenceKey)) {
            throw new Error(`Workspace with name "${workspaceName}" already exists for user ${userId} on host ${host}.`);
        }

        // Determine workspace directory path
        let workspaceDir;
        if (options.workspacePath) {
            // Explicit path provided (used for universe and specific cases)
            workspaceDir = options.workspacePath;
        } else {
            // For regular workspaces, place them in user's workspaces subdirectory
            const user = await this.#userManager.getUser(ownerId);
            if (!user || !user.homePath) {
                throw new Error(`Could not determine home path for user ${ownerId}`);
            }
            workspaceDir = path.join(user.homePath, 'workspaces', workspaceName);
        }
        debug(`Using workspace path: ${workspaceDir} for workspace ${workspaceId}`);

        // Validate and create workspace
        if (existsSync(workspaceDir)) {
            console.warn(`Workspace directory "${workspaceDir}" already exists.`);
        }

        try {
            await fsPromises.mkdir(workspaceDir, { recursive: true });
            await this.#createWorkspaceSubdirectories(workspaceDir);
            debug(`Created workspace directory and subdirectories: ${workspaceDir}`);
        } catch (err) {
            throw new Error(`Failed to create workspace directory: ${err.message}`);
        }

        // Create workspace configuration
        const workspaceConfigPath = path.join(workspaceDir, WORKSPACE_CONFIG_FILENAME);
        const isUniverse = options.type === 'universe';
        const configData = {
            id: workspaceId,
            name: isUniverse ? 'universe' : workspaceName,
            label: isUniverse ? 'Universe' : (options.label || workspaceName),
            description: options.description || '',
            owner: ownerId,
            color: isUniverse ? '#ffffff' : (options.color || WorkspaceManager.getRandomColor()),
            type: isUniverse ? 'universe' : 'workspace',
            status: 'inactive',
            host: host, // Add host field to workspace data
            rootPath: workspaceDir,
            configPath: workspaceConfigPath,
            roles: options.roles || [], // Initialize roles array
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            metadata: options.metadata || {},
            tokens: {} // Token-based ACL: { "sha256:hash": { permissions: [], description: "", createdAt: "", expiresAt: null } }
        };

        new Conf({
            configName: path.basename(workspaceConfigPath, '.json'),
            cwd: workspaceDir,
            accessPropertiesByDotNotation: false
        }).store = configData;

        debug(`Created workspace config file: ${workspaceConfigPath}`);

        // Create index entry with user.id prefix
        const indexEntry = {
            ...configData,
            status: WORKSPACE_STATUS_CODES.AVAILABLE,
            lastAccessed: null
        };
        const indexKey = this.#constructWorkspaceIndexKey(ownerId, workspaceId);

        // Use userId/workspaceId as primary key
        this.#indexStore.set(indexKey, indexEntry);

        // Add to reference index for lookups
        this.#referenceIndex.set(referenceKey, workspaceId);

        // Add to name index for backward compatibility and various user identifier lookups
        const nameKey = `${userId}@${host}:${workspaceName}`;
        this.#nameIndex.set(nameKey, workspaceId);

        // Add reference field to the index entry
        indexEntry.reference = referenceKey;

        this.emit('workspace.created', { userId: ownerId, workspaceId, workspaceName, workspace: indexEntry });
        debug(`Workspace created: ${workspaceId} (name: ${workspaceName}) for user ${ownerId} on host ${host}`);
        return indexEntry;
    }

    /**
     * Create universe workspace for a user (special application-level workspace)
     * @param {string} userId - User ID
     * @param {string} userEmail - User email
     * @param {string} universeWorkspacePath - Full path to universe workspace location
     * @returns {Promise<Object>} Created universe workspace
     */
    async createUniverseWorkspace(userId, userEmail, universeWorkspacePath) {
        if (!this.#initialized) throw new Error('WorkspaceManager not initialized');

        debug(`Creating universe workspace for user ${userId} at ${universeWorkspacePath}`);

        return await this.createWorkspace(userId, 'universe', {
            type: 'universe',
            label: 'Universe',
            description: `Personal workspace for ${userEmail}`,
            workspacePath: universeWorkspacePath,
            color: '#ffffff'
        });
    }

    /**
     * Opens a workspace, loading it into memory if not already loaded.
     * @param {string} userId - The owner identifier (can be ID, name, or email).
     * @param {string} workspaceIdentifier - The workspace ID or name.
     * @param {string} requestingUserId - The ULID of the user making the request (for ownership check).
     * @returns {Promise<Workspace|null>} The loaded Workspace instance.
     */
    async openWorkspace(userId, workspaceIdentifier, requestingUserId) {
        if (!this.#initialized) {
            throw new Error('WorkspaceManager not initialized. Cannot open workspace.');
        }
        if (!userId || !workspaceIdentifier) {
            throw new Error(`userId and workspaceIdentifier are required to open a workspace, got userId: ${userId}, workspaceIdentifier: ${workspaceIdentifier}`);
        }

        // Resolve the provided userId (which can be an identifier) to an actual user ID.
        const ownerId = await this.#userManager.resolveToUserId(userId);
        if (!ownerId) {
            debug(`openWorkspace failed: Could not resolve user identifier "${userId}"`);
            return null;
        }

        if (!requestingUserId) {
            requestingUserId = ownerId;
        }

        // Try to parse as workspace reference first
        const parsedRef = this.parseWorkspaceReference(workspaceIdentifier);
        let workspaceId;

        if (parsedRef) {
            // Full reference format: userIdentifier@host:workspaceSlug[/path]
            workspaceId = this.#referenceIndex.get(parsedRef.full.split('/')[0]); // Remove path for lookup
            if (!workspaceId) {
                debug(`openWorkspace failed: No workspace found with reference "${workspaceIdentifier}"`);
                return null;
            }
        } else {
            // Check if it's a workspace ID (either new 12-char format or legacy UUID format)
            const isNewWorkspaceId = workspaceIdentifier.length === 12 && /^[a-zA-Z0-9]+$/.test(workspaceIdentifier);
            const isLegacyWorkspaceId = workspaceIdentifier.length === 36 && /^[a-f0-9-]+$/.test(workspaceIdentifier);

            if (isNewWorkspaceId || isLegacyWorkspaceId) {
                workspaceId = workspaceIdentifier;
            } else {
                // Try to resolve as workspace name for the given user (using original identifier)
                workspaceId = this.resolveWorkspaceId(userId, workspaceIdentifier);
                if (!workspaceId) {
                    debug(`openWorkspace failed: No workspace found with name "${workspaceIdentifier}" for user ${userId}`);
                    return null;
                }
            }
        }

        debug(`Opening workspace: ${workspaceId} (identifier: ${workspaceIdentifier}) for requestingUser: ${requestingUserId}`);

        // Return from cache if available and owner matches
        if (this.#workspaces.has(workspaceId)) {
            debug(`Returning cached Workspace instance for ${workspaceId}`);
            const cachedWs = this.#workspaces.get(workspaceId);
            if (cachedWs.owner !== requestingUserId) {
                console.error(`Ownership mismatch for cached workspace ${workspaceId}. Owner: ${cachedWs.owner}, Requester: ${requestingUserId}`);
                return null;
            }
            return cachedWs;
        }

        // Load from index using the new index key format
        const indexKey = this.#constructWorkspaceIndexKey(ownerId, workspaceId);
        const entry = this.#indexStore.get(indexKey);
        if (!this.#validateWorkspaceEntryForOpen(entry, workspaceId, requestingUserId)) {
            return null; // Validation failed, details logged in helper
        }

        try {
            const conf = new Conf({
                configName: path.basename(entry.configPath, '.json'),
                cwd: path.dirname(entry.configPath)
            });

            const workspace = new Workspace({
                rootPath: entry.rootPath,
                configStore: conf,
                eventEmitterOptions: {
                    wildcard: true,
                    delimiter: '.',
                    newListener: false,
                    maxListeners: 50
                }
            });

            this.#workspaces.set(workspaceId, workspace);
            debug(`Loaded and cached Workspace instance for ${workspaceId}`);
            this.#updateWorkspaceIndexEntry(indexKey, { lastAccessed: new Date().toISOString() });
            return workspace;
        } catch (err) {
            console.error(`openWorkspace failed: Could not load config or instantiate Workspace for ${workspaceId}: ${err.message}`);
            return null;
        }
    }

    /**
     * Closes a workspace, removing it from the memory cache after stopping it.
     * @param {string} userId - The owner identifier (can be ID, name, or email).
     * @param {string} workspaceIdentifier - The workspace ID or name.
     * @param {string} requestingUserId - The ULID of the user making the request.
     * @returns {Promise<boolean>} True if closed or not loaded, false on failure to stop.
     */
    async closeWorkspace(userId, workspaceIdentifier, requestingUserId) {
        if (!this.#initialized) throw new Error('WorkspaceManager not initialized');
        this.#ensureRequiredParams({ userId, workspaceIdentifier: workspaceIdentifier, requestingUserId }, 'closeWorkspace');

        // Resolve the provided userId (which can be an identifier) to an actual user ID.
        const ownerId = await this.#userManager.resolveToUserId(userId);
        if (!ownerId) {
            debug(`closeWorkspace failed: Could not resolve user identifier "${userId}"`);
            return false;
        }

        // Resolve workspace identifier to ID
        let workspaceId;
        // Check if it's a workspace ID (either new 12-char format or legacy UUID format)
        const isNewWorkspaceId = workspaceIdentifier.length === 12 && /^[a-zA-Z0-9]+$/.test(workspaceIdentifier);
        const isLegacyWorkspaceId = workspaceIdentifier.length === 36 && /^[a-f0-9-]+$/.test(workspaceIdentifier);

        if (isNewWorkspaceId || isLegacyWorkspaceId) {
            workspaceId = workspaceIdentifier;
        } else {
            workspaceId = this.resolveWorkspaceId(userId, workspaceIdentifier);
            if (!workspaceId) {
                debug(`closeWorkspace: No workspace found with name "${workspaceIdentifier}" for user ${userId}`);
                return false;
            }
        }

        if (!this.#workspaces.has(workspaceId)) {
            debug(`closeWorkspace: Workspace ${workspaceId} is not loaded in memory.`);
            return true;
        }

        const stopped = await this.stopWorkspace(ownerId, workspaceIdentifier, requestingUserId);
        if (!stopped) {
            // stopWorkspace logs details, but we might want to indicate failure here too
            console.warn(`closeWorkspace: Failed to stop workspace ${workspaceId} before closing. It might still be in memory.`);
            // Depending on desired behavior, we might not delete from cache if stop failed.
            // For now, we proceed with deletion from cache.
        }

        const deleted = this.#workspaces.delete(workspaceId);
        if (deleted) {
            debug(`closeWorkspace: Removed workspace ${workspaceId} from memory cache.`);
            this.emit('workspace.closed', { workspaceId, userId, workspaceIdentifier });
        }
        return deleted; // Or perhaps return `stopped && deleted`
    }

    /**
     * Starts an opened workspace.
     * @param {string} userId - The owner identifier (can be ID, name, or email).
     * @param {string} workspaceIdentifier - The workspace ID or name.
     * @param {string} requestingUserId - The ULID of the user making the request.
     * @returns {Promise<Workspace|null>} The started Workspace instance or null on failure.
     */
    async startWorkspace(userId, workspaceIdentifier, requestingUserId) {
        if (!this.#initialized) throw new Error('WorkspaceManager not initialized');
        if (!requestingUserId) {
            requestingUserId = userId;
        }

        this.#ensureRequiredParams({ userId, workspaceIdentifier: workspaceIdentifier, requestingUserId }, 'startWorkspace');

        // Resolve the provided userId (which can be an identifier) to an actual user ID.
        const ownerId = await this.#userManager.resolveToUserId(userId);
        if (!ownerId) {
            debug(`startWorkspace failed: Could not resolve user identifier "${userId}"`);
            return null;
        }
        if (requestingUserId === userId) { // If they were the same, update requestingUserId to resolved ID
            requestingUserId = ownerId;
        }


        // Resolve workspace identifier to ID
        let workspaceId;
        // Check if it's a workspace ID (either new 12-char format or legacy UUID format)
        const isNewWorkspaceId = workspaceIdentifier.length === 12 && /^[a-zA-Z0-9]+$/.test(workspaceIdentifier);
        const isLegacyWorkspaceId = workspaceIdentifier.length === 36 && /^[a-f0-9-]+$/.test(workspaceIdentifier);

        if (isNewWorkspaceId || isLegacyWorkspaceId) {
            workspaceId = workspaceIdentifier;
        } else {
            workspaceId = this.resolveWorkspaceId(userId, workspaceIdentifier);
            if (!workspaceId) {
                debug(`startWorkspace: No workspace found with name "${workspaceIdentifier}" for user ${userId}`);
                return null;
            }
        }

        debug(`Starting workspace ${workspaceId} (identifier: ${workspaceIdentifier}) for requestingUserId: ${requestingUserId}`);
        let workspace = this.#workspaces.get(workspaceId);

        if (!workspace) {
            debug(`startWorkspace: Workspace ${workspaceId} not found in memory, attempting to open...`);
            workspace = await this.openWorkspace(ownerId, workspaceIdentifier, requestingUserId);
            if (!workspace) {
                debug(`startWorkspace: Could not open workspace ${workspaceIdentifier} for user ${userId}.`);
                return null;
            }
        }

        if (workspace.status === WORKSPACE_STATUS_CODES.ACTIVE) {
            debug(`Workspace ${workspaceId} is already active.`);
            return workspace;
        }

        debug(`Starting workspace ${workspaceId}...`);
        try {
            await workspace.start();
            const indexKey = this.#constructWorkspaceIndexKey(ownerId, workspaceId);
            this.#updateWorkspaceIndexEntry(indexKey, { status: WORKSPACE_STATUS_CODES.ACTIVE, lastAccessed: new Date().toISOString() });

            // Start associated roles
            if (this.#roleManager) {
                try {
                    const roleResults = await this.startWorkspaceRoles(ownerId, workspaceIdentifier, requestingUserId);
                    if (roleResults.length > 0) {
                        debug(`Started ${roleResults.filter(r => r.status === 'started').length}/${roleResults.length} roles for workspace ${workspaceId}`);
                    }
                } catch (roleError) {
                    debug(`Failed to start some workspace roles: ${roleError.message}`);
                    // Don't fail workspace start if roles fail
                }
            }

            debug(`Workspace ${workspaceId} started successfully.`);
            this.emit('workspace.started', { workspaceId, workspace: workspace.toJSON() });
            return workspace;
        } catch (err) {
            console.error(`Failed to start workspace ${workspaceId}: ${err.message}`);
            const indexKey = this.#constructWorkspaceIndexKey(ownerId, workspaceId);
            this.#updateWorkspaceIndexEntry(indexKey, { status: WORKSPACE_STATUS_CODES.ERROR });
            this.emit('workspace.startFailed', { workspaceId, error: err.message });
            return null;
        }
    }

    /**
     * Stops a loaded and active workspace.
     * @param {string} userId - The owner identifier (can be ID, name, or email).
     * @param {string} workspaceIdentifier - The workspace ID or name.
     * @param {string} requestingUserId - The ULID of the user making the request.
     * @returns {Promise<boolean>} True if stopped or already inactive/not loaded, false on failure.
     */
    async stopWorkspace(userId, workspaceIdentifier, requestingUserId) {
        if (!this.#initialized) throw Error('WorkspaceManager not initialized');
        if (!requestingUserId) {
            requestingUserId = userId;
        }
        this.#ensureRequiredParams({ userId, workspaceIdentifier: workspaceIdentifier, requestingUserId }, 'stopWorkspace');

        // Resolve the provided userId (which can be an identifier) to an actual user ID.
        const ownerId = await this.#userManager.resolveToUserId(userId);
        if (!ownerId) {
            debug(`stopWorkspace failed: Could not resolve user identifier "${userId}"`);
            return false;
        }
        if (requestingUserId === userId) { // If they were the same, update requestingUserId to resolved ID
            requestingUserId = ownerId;
        }

        // Resolve workspace identifier to ID
        let workspaceId;
        // Check if it's a workspace ID (either new 12-char format or legacy UUID format)
        const isNewWorkspaceId = workspaceIdentifier.length === 12 && /^[a-zA-Z0-9]+$/.test(workspaceIdentifier);
        const isLegacyWorkspaceId = workspaceIdentifier.length === 36 && /^[a-f0-9-]+$/.test(workspaceIdentifier);

        if (isNewWorkspaceId || isLegacyWorkspaceId) {
            workspaceId = workspaceIdentifier;
        } else {
            workspaceId = this.resolveWorkspaceId(userId, workspaceIdentifier);
            if (!workspaceId) {
                debug(`stopWorkspace: No workspace found with name "${workspaceIdentifier}" for user ${userId}`);
                return false;
            }
        }

        const workspace = this.#workspaces.get(workspaceId);

        if (!workspace) {
            debug(`Workspace ${workspaceId} is not loaded in memory, considered stopped.`);
            // Potentially update index if it was marked ACTIVE but not in memory (e.g. after a crash)
            const indexKey = this.#constructWorkspaceIndexKey(ownerId, workspaceId);
            const entry = this.#indexStore.get(indexKey);
            if (entry && entry.owner === requestingUserId && entry.status === WORKSPACE_STATUS_CODES.ACTIVE) {
                this.#updateWorkspaceIndexEntry(indexKey, { status: WORKSPACE_STATUS_CODES.INACTIVE });
                debug(`Marked workspace ${workspaceId} (not in memory) as INACTIVE in index.`);
            }
            return true;
        }

        if (workspace.owner !== requestingUserId) {
            console.error(`stopWorkspace: User ${requestingUserId} not owner of ${workspaceId}. Workspace owner: ${workspace.owner}`);
            return false;
        }

        if ([WORKSPACE_STATUS_CODES.INACTIVE, WORKSPACE_STATUS_CODES.AVAILABLE].includes(workspace.status)) {
            debug(`Workspace ${workspaceId} is already stopped (status: ${workspace.status}).`);
            return true;
        }

        debug(`Stopping workspace ${workspaceId}...`);
        try {
            // Stop associated roles first
            if (this.#roleManager) {
                try {
                    const roleResults = await this.stopWorkspaceRoles(ownerId, workspaceIdentifier, requestingUserId);
                    if (roleResults.length > 0) {
                        debug(`Stopped ${roleResults.filter(r => r.status === 'stopped').length}/${roleResults.length} roles for workspace ${workspaceId}`);
                    }
                } catch (roleError) {
                    debug(`Failed to stop some workspace roles: ${roleError.message}`);
                    // Continue with workspace stop even if roles fail
                }
            }

            await workspace.stop();
            const indexKey = this.#constructWorkspaceIndexKey(ownerId, workspaceId);
            this.#updateWorkspaceIndexEntry(indexKey, { status: WORKSPACE_STATUS_CODES.INACTIVE }, requestingUserId);
            debug(`Workspace ${workspaceId} stopped successfully.`);
            this.emit('workspace.stopped', { workspaceId });
            return true;
        } catch (err) {
            console.error(`Failed to stop workspace ${workspaceId}: ${err.message}`);
            const indexKey = this.#constructWorkspaceIndexKey(ownerId, workspaceId);
            this.#updateWorkspaceIndexEntry(indexKey, { status: WORKSPACE_STATUS_CODES.ERROR }, requestingUserId);
            this.emit('workspace.stopFailed', { workspaceId, error: err.message });
            return false;
        }
    }

    /**
     * Removes a workspace from the index and optionally deletes its data.
     * @param {string} userId - The owner identifier (can be ID, name, or email).
     * @param {string} workspaceIdentifier - The workspace ID or name.
     * @param {string} requestingUserId - The ULID of the user making the request.
     * @param {boolean} [destroyData=false] - Whether to delete the workspace directory.
     * @returns {Promise<boolean>} True if successful, false otherwise.
     */
    async removeWorkspace(userId, workspaceIdentifier, requestingUserId, destroyData = false) {
        if (!this.#initialized) throw new Error('WorkspaceManager not initialized');

        // Resolve the provided userId (which can be an identifier) to an actual user ID.
        const ownerId = await this.#userManager.resolveToUserId(userId);
        if (!ownerId) {
            debug(`removeWorkspace failed: Could not resolve user identifier "${userId}"`);
            return false;
        }

        if (!requestingUserId) {
            requestingUserId = ownerId;
        }
        if (requestingUserId === userId) {
             requestingUserId = ownerId;
        }

        this.#ensureRequiredParams({ userId, workspaceIdentifier: workspaceIdentifier, requestingUserId }, 'removeWorkspace');

        // Resolve workspace identifier to ID
        let workspaceId;
        const parsedRef = this.parseWorkspaceReference(workspaceIdentifier);

        if (parsedRef) {
            // Full reference format
            workspaceId = this.resolveWorkspaceIdFromReference(workspaceIdentifier);
        } else {
            // Check if it's a workspace ID (either new 12-char format or legacy UUID format) or name
            const isNewWorkspaceId = workspaceIdentifier.length === 12 && /^[a-zA-Z0-9]+$/.test(workspaceIdentifier);
            const isLegacyWorkspaceId = workspaceIdentifier.length === 36 && /^[a-f0-9-]+$/.test(workspaceIdentifier);

            if (isNewWorkspaceId || isLegacyWorkspaceId) {
                workspaceId = workspaceIdentifier;
            } else {
                workspaceId = this.resolveWorkspaceId(userId, workspaceIdentifier);
                if (!workspaceId) {
                    debug(`removeWorkspace: No workspace found with name "${workspaceIdentifier}" for user ${userId}`);
                    return false;
                }
            }
        }

        debug(`Removing workspace: ${workspaceId} (identifier: ${workspaceIdentifier}), destroyData: ${destroyData}, requested by ${requestingUserId}`);

        // Prevent removal of universe workspace
        if (this.#isUniverseWorkspace(workspaceId)) {
            throw new Error('Cannot remove the universe workspace');
        }

        // Find workspace entry using the new index key format
        const indexKey = this.#constructWorkspaceIndexKey(ownerId, workspaceId);
        const entry = this.#indexStore.get(indexKey);
        if (!entry) {
            console.warn(`removeWorkspace failed: Workspace ${workspaceId} not found in index.`);
            return false;
        }
        if (entry.owner !== requestingUserId) {
            console.error(`removeWorkspace failed: User ${requestingUserId} is not the owner of ${workspaceId}. Owner: ${entry.owner}`);
            return false;
        }

        // Attempt to stop and remove from cache first
        if (this.#workspaces.has(workspaceId)) {
            const stopped = await this.stopWorkspace(userId, workspaceIdentifier, requestingUserId);
            if (!stopped) {
                console.error(`removeWorkspace: Could not stop workspace ${workspaceId} before removal. Proceeding with index removal.`);
                // Decide if we should abort or continue. For now, continue.
            }
            this.#workspaces.delete(workspaceId);
            debug(`Removed workspace ${workspaceId} from memory cache during removal process.`);
        }

        let deletionError = null;
        if (destroyData && entry.rootPath) {
            try {
                debug(`Destroying workspace data at ${entry.rootPath}`);
                if (existsSync(entry.rootPath)) {
                    await fsPromises.rm(entry.rootPath, { recursive: true, force: true });
                    debug(`Workspace directory deleted: ${entry.rootPath}`);
                } else {
                    debug(`Workspace directory ${entry.rootPath} not found for destruction.`);
                }
            } catch (error) {
                deletionError = error;
                console.error(`Failed to delete workspace directory ${entry.rootPath}: ${error.message}`);
                // Do not re-throw yet, ensure index is cleaned up.
            }
        }

        // Remove from reference index
        if (entry.reference) {
            this.#referenceIndex.delete(entry.reference);
        }

        // Remove from name index
        const nameKey = `${userId}@${entry.host || WORKSPACE_DEFAULT_HOST}:${entry.name}`;
        this.#nameIndex.delete(nameKey);

        // Remove from index store using the correct key
        this.#indexStore.delete(indexKey);
        this.emit('workspace.removed', {
            userId: ownerId,
            workspaceId,
            workspaceIdentifier,
            requestingUserId,
            destroyData,
            success: !deletionError, // Success is true if data destruction didn't fail (or wasn't attempted)
            error: deletionError ? deletionError.message : null
        });
        debug(`Workspace ${workspaceId} removed from index for owner ${ownerId}.`);
        return !deletionError; // Return based on data destruction outcome if attempted
    }

    /**
     * Public API - Workspace Information & Configuration
     */

    /**
     * Gets all workspace entries from the index (for internal use)
     * @returns {Object} All workspace entries from the index store, with workspaceId as keys
     */
    getAllWorkspaces() {
        const allEntries = this.#indexStore?.store || {};
        const result = {};

        for (const [indexKey, entry] of Object.entries(allEntries)) {
            const parsed = this.#parseWorkspaceIndexKey(indexKey);
            if (parsed) {
                // Use workspaceId as key for backward compatibility
                result[parsed.workspaceId] = entry;
            }
        }

        return result;
    }

    /**
     * Gets all workspace entries from the index with full index keys (for internal use)
     * @returns {Object} All workspace entries from the index store, with userId/workspaceId as keys
     */
    getAllWorkspacesWithKeys() {
        return this.#indexStore?.store || {};
    }

    /**
     * Resolves a workspace ID from a workspace name and user identifier
     * @param {string} userIdentifier - The user ID, name, or email
     * @param {string} workspaceName - The workspace name
     * @param {string} [host=WORKSPACE_DEFAULT_HOST] - Host (defaults to canvas.local)
     * @returns {string|null} The workspace ID if found, null otherwise
     */
    resolveWorkspaceId(userIdentifier, workspaceName, host = WORKSPACE_DEFAULT_HOST) {
        const nameKey = `${userIdentifier}@${host}:${workspaceName}`;
        return this.#nameIndex.get(nameKey) || null;
    }

    /**
     * Resolves a workspace ID from a workspace reference
     * @param {string} workspaceRef - Workspace reference in format userIdentifier@host:workspaceSlug[/path]
     * @returns {string|null} The workspace ID if found, null otherwise
     */
    resolveWorkspaceIdFromReference(workspaceRef) {
        const parsedRef = this.parseWorkspaceReference(workspaceRef);
        if (!parsedRef) {
            return null;
        }

        const baseRef = this.constructWorkspaceReference(parsedRef.userIdentifier, parsedRef.workspaceSlug, parsedRef.host);
        return this.#referenceIndex.get(baseRef) || null;
    }

    /**
     * Resolves a workspace ID from a simple workspace identifier
     * @param {string} workspaceIdentifier - Simple identifier in format user.name/workspace.name
     * @returns {Promise<string|null>} The workspace ID if found, null otherwise
     */
    async resolveWorkspaceIdFromSimpleIdentifier(workspaceIdentifier) {
        const parsed = this.parseSimpleWorkspaceIdentifier(workspaceIdentifier);
        if (!parsed) {
            return null;
        }

        // First resolve the user identifier to a user ID
        const userId = await this.#userManager.resolveToUserId(parsed.userIdentifier);
        if (!userId) {
            return null;
        }

        // Then try to resolve the workspace by name
        return this.resolveWorkspaceId(userId, parsed.workspaceIdentifier);
    }

    /**
     * Construct a simple resource address from workspace data
     * @param {Object} workspace - Workspace object with owner and name
     * @returns {Promise<string|null>} Resource address in format user.name/workspace.name
     */
    async constructResourceAddress(workspace) {
        if (!workspace || !workspace.owner || !workspace.name) {
            return null;
        }

        try {
            // Get user info to construct the address
            const user = await this.#userManager.getUser(workspace.owner);
            if (!user || !user.name) {
                return null;
            }

            return `${user.name}/${workspace.name}`;
        } catch (error) {
            return null;
        }
    }

    /**
     * Gets a workspace by ID directly
     * @param {string} workspaceId - The workspace ID
     * @param {string} requestingUserId - The ULID of the user making the request
     * @returns {Promise<Workspace|null>} The loaded Workspace instance
     */
    async getWorkspaceById(workspaceId, requestingUserId) {
        if (!this.#initialized) {
            throw new Error('WorkspaceManager not initialized. Cannot get workspace by ID.');
        }
        if (!workspaceId) {
            throw new Error('workspaceId is required to get workspace by ID');
        }

        // Search for workspace in index by workspaceId across all users
        const allEntries = this.#indexStore.store;
        let entry = null;
        let foundIndexKey = null;

        for (const [indexKey, workspaceEntry] of Object.entries(allEntries)) {
            const parsed = this.#parseWorkspaceIndexKey(indexKey);
            if (parsed && parsed.workspaceId === workspaceId) {
                entry = workspaceEntry;
                foundIndexKey = indexKey;
                break;
            }
        }

        if (!entry) {
            debug(`getWorkspaceById: Workspace ${workspaceId} not found in index`);
            return null;
        }

        // Check ownership if requesting user is provided
        if (requestingUserId && entry.owner !== requestingUserId) {
            debug(`getWorkspaceById: User ${requestingUserId} is not the owner of workspace ${workspaceId}`);
            return null;
        }

        // Return from cache if available
        if (this.#workspaces.has(workspaceId)) {
            debug(`Returning cached Workspace instance for ${workspaceId}`);
            return this.#workspaces.get(workspaceId);
        }

        // Load workspace
        try {
            const conf = new Conf({
                configName: path.basename(entry.configPath, '.json'),
                cwd: path.dirname(entry.configPath)
            });

            const workspace = new Workspace({
                rootPath: entry.rootPath,
                configStore: conf,
                eventEmitterOptions: {
                    wildcard: true,
                    delimiter: '.',
                    newListener: false,
                    maxListeners: 50
                }
            });

            this.#workspaces.set(workspaceId, workspace);
            debug(`Loaded and cached Workspace instance for ${workspaceId}`);
            this.#updateWorkspaceIndexEntry(foundIndexKey, { lastAccessed: new Date().toISOString() });
            return workspace;
        } catch (err) {
            console.error(`getWorkspaceById failed: Could not load config or instantiate Workspace for ${workspaceId}: ${err.message}`);
            return null;
        }
    }

    /**
     * Gets a workspace by name (resolves to ID first)
     * @param {string} userId - The user ID, name, or email
     * @param {string} workspaceName - The workspace name
     * @param {string} requestingUserId - The ULID of the user making the request
     * @returns {Promise<Workspace|null>} The loaded Workspace instance
     */
    async getWorkspaceByName(userId, workspaceName, requestingUserId) {
        if (!this.#initialized) {
            throw new Error('WorkspaceManager not initialized. Cannot get workspace by name.');
        }
        if (!userId || !workspaceName) {
            throw new Error('userId and workspaceName are required to get workspace by name');
        }

        // Resolve workspace ID from name
        const workspaceId = this.resolveWorkspaceId(userId, workspaceName);
        if (!workspaceId) {
            debug(`getWorkspaceByName: No workspace found with name "${workspaceName}" for user ${userId}`);
            return null;
        }

        // Resolve user identifier to ID for getWorkspaceById call
        const ownerId = await this.#userManager.resolveToUserId(userId);
        if (!ownerId) {
            debug(`getWorkspaceByName: Could not resolve user identifier "${userId}"`);
            return null;
        }


        // Get workspace by ID
        return this.getWorkspaceById(workspaceId, requestingUserId || ownerId);
    }

    /**
     * Checks if a workspace instance is currently loaded in memory.
     * @param {string} ownerId - The owner identifier (e.g., userId) used for key construction.
     * @param {string} workspaceId - The workspace ID (short name).
     * @param {string} requestingUserId - The ULID of the user making the request (for ownership check).
     * @returns {Promise<boolean>} True if the workspace instance is in the memory cache and owned by the requesting user.
     */
    async isOpen(ownerId, workspaceId, requestingUserId) {
        if (!requestingUserId) {
            requestingUserId = ownerId;
        }
        this.#ensureRequiredParams({ ownerId, workspaceId, requestingUserId }, 'isOpen');
        const resolvedOwnerId = await this.#userManager.resolveToUserId(ownerId);
        if (!resolvedOwnerId) return false;
        const workspaceKey = `${resolvedOwnerId}/${workspaceId}`;
        const ws = this.#workspaces.get(workspaceKey);
        return !!ws && ws.owner === requestingUserId; // Check against the stored ULID owner
    }

    /**
     * Checks if a workspace instance is currently loaded AND active (started).
     * @param {string} ownerId - The owner identifier (e.g., userId) used for key construction.
     * @param {string} workspaceId - The workspace ID (short name).
     * @param {string} requestingUserId - The ULID of the user making the request (for ownership check).
     * @returns {Promise<boolean>} True if the workspace instance is in cache, active, and owned by the user.
     */
    async isActive(ownerId, workspaceId, requestingUserId) {
        if (!requestingUserId) {
            requestingUserId = ownerId;
        }
        this.#ensureRequiredParams({ ownerId, workspaceId, requestingUserId }, 'isActive');
        const resolvedOwnerId = await this.#userManager.resolveToUserId(ownerId);
        if (!resolvedOwnerId) return false;
        const workspaceKey = `${resolvedOwnerId}/${workspaceId}`;
        const workspace = this.#workspaces.get(workspaceKey);
        return !!workspace && workspace.owner === requestingUserId && workspace.status === WORKSPACE_STATUS_CODES.ACTIVE;
    }

    /**
     * Lists all workspaces for a given userId (owned and shared)
     * @param {string} userId - The user ID
     * @param {string} [host=WORKSPACE_DEFAULT_HOST] - Host to filter by (defaults to canvas.local)
     * @returns {Promise<Array<Object>>} An array of workspace index entry objects.
     */
    async listUserWorkspaces(userId, host = WORKSPACE_DEFAULT_HOST) {
        if (!this.#initialized) throw new Error('WorkspaceManager not initialized');
        if (!userId) return [];

        const accessingUserId = await this.#userManager.resolveToUserId(userId);
        if (!accessingUserId) return [];

        // Get the user's email for checking shared workspaces
        let userEmail = null;
        try {
            const user = await this.#userManager.getUser(accessingUserId);
            userEmail = user.email;
        } catch (error) {
            debug(`Failed to resolve user email for ${accessingUserId}: ${error.message}`);
        }

        const prefix = `${accessingUserId}/`;
        debug(`Listing workspaces for userId ${accessingUserId} on host ${host}`);

        const allWorkspaces = this.#indexStore.store;
        const userWorkspaceEntries = [];
        const processedWorkspaceIds = new Set();

        // 1. Get owned workspaces
        for (const key in allWorkspaces) {
            if (key.startsWith(prefix)) {
                const workspaceEntry = allWorkspaces[key];
                if (workspaceEntry && typeof workspaceEntry === 'object' && workspaceEntry.id) {
                    // More flexible host filtering - if workspace has no host field, assume it's the default host
                    const workspaceHost = workspaceEntry.host || WORKSPACE_DEFAULT_HOST;
                    if (!host || workspaceHost === host) {
                        // Resolve owner ID to user email
                        try {
                            const ownerUser = await this.#userManager.getUser(workspaceEntry.owner);
                            const workspaceWithOwnerEmail = {
                                ...workspaceEntry,
                                ownerEmail: ownerUser.email
                            };
                            userWorkspaceEntries.push(workspaceWithOwnerEmail);
                            processedWorkspaceIds.add(workspaceEntry.id);
                        } catch (error) {
                            debug(`Failed to resolve owner email for workspace ${workspaceEntry.id}: ${error.message}`);
                            // Fallback to original entry if user resolution fails
                            userWorkspaceEntries.push(workspaceEntry);
                            processedWorkspaceIds.add(workspaceEntry.id);
                        }
                    }
                }
            }
        }

        // 2. Get shared workspaces (if we have user's email)
        if (userEmail) {
            for (const key in allWorkspaces) {
                // Skip already processed workspaces (owned ones)
                if (key.startsWith(prefix)) continue;

                const workspaceEntry = allWorkspaces[key];
                if (workspaceEntry && typeof workspaceEntry === 'object' && workspaceEntry.id) {
                    // Skip if already processed
                    if (processedWorkspaceIds.has(workspaceEntry.id)) continue;

                    // Check if this workspace is shared with the user via email
                    const acl = workspaceEntry.acl || {};
                    const users = acl.users || {};

                    if (users[userEmail]) {
                        // More flexible host filtering
                        const workspaceHost = workspaceEntry.host || WORKSPACE_DEFAULT_HOST;
                        if (!host || workspaceHost === host) {
                            try {
                                const ownerUser = await this.#userManager.getUser(workspaceEntry.owner);
                                const sharedWorkspace = {
                                    ...workspaceEntry,
                                    ownerEmail: ownerUser.email,
                                    type: 'shared', // Mark as shared type
                                    isShared: true,
                                    sharedVia: users[userEmail]
                                };
                                userWorkspaceEntries.push(sharedWorkspace);
                                processedWorkspaceIds.add(workspaceEntry.id);
                            } catch (error) {
                                debug(`Failed to resolve owner email for shared workspace ${workspaceEntry.id}: ${error.message}`);
                                // Fallback to original entry if user resolution fails
                                userWorkspaceEntries.push({
                                    ...workspaceEntry,
                                    type: 'shared',
                                    isShared: true,
                                    sharedVia: users[userEmail]
                                });
                                processedWorkspaceIds.add(workspaceEntry.id);
                            }
                        }
                    }
                }
            }
        }

        debug(`Found ${userWorkspaceEntries.length} workspaces for userId ${accessingUserId} on host ${host} (owned and shared)`);
        return userWorkspaceEntries;
    }

    /**
     * Gets a loaded Workspace instance from memory. Alias for openWorkspace.
     * @param {string} userId - The owner identifier.
     * @param {string} workspaceId - The workspace ID.
     * @param {string} requestingUserId - The ULID of the user making the request.
     * @returns {Promise<Workspace|null>} The loaded Workspace instance.
     */
    async getWorkspace(userId, workspaceId, requestingUserId) {
        // This is a convenience method, we gonna refactor it eventually
        // No try..catch here as both implementations throw like crazy :)
        const workspace = await this.openWorkspace(userId, workspaceId, requestingUserId);
        if (!workspace) {
            debug(`getWorkspace failed: Could not open workspace ${userId}/${workspaceId}.`);
            return null;
        }

        // Lets try to start that thing
        await this.startWorkspace(userId, workspaceId, requestingUserId);
        return workspace;
    }

    /**
     * Checks if a workspace exists in the index for the given owner and user.
     * @param {string} userId - The owner identifier.
     * @param {string} workspaceIdentifier - The workspace ID or name.
     * @param {string} requestingUserId - The ULID of the user making the request.
     * @returns {Promise<boolean>} True if the workspace exists and is owned by the user.
     */
    async hasWorkspace(userId, workspaceIdentifier, requestingUserId) {
        if (!this.#initialized) { throw new Error('WorkspaceManager not initialized'); }
        const ownerId = await this.#userManager.resolveToUserId(userId);
        if (!ownerId) return false;

        if (!requestingUserId) {
            requestingUserId = ownerId;
        } else {
            const resolvedRequesterId = await this.#userManager.resolveToUserId(requestingUserId);
            if (!resolvedRequesterId) return false;
            requestingUserId = resolvedRequesterId;
        }

        this.#ensureRequiredParams({ userId: ownerId, workspaceIdentifier, requestingUserId }, 'hasWorkspace', false); // Allow missing requestingUserId for a general check if needed, but enforce for ownership check

        try {
            // Resolve workspace identifier to ID (handle both IDs and names)
            let workspaceId;

            // Check if it's a workspace ID (either new 12-char format or legacy UUID format)
            const isNewWorkspaceId = workspaceIdentifier.length === 12 && /^[a-zA-Z0-9]+$/.test(workspaceIdentifier);
            const isLegacyWorkspaceId = workspaceIdentifier.length === 36 && /^[a-f0-9-]+$/.test(workspaceIdentifier);

            if (isNewWorkspaceId || isLegacyWorkspaceId) {
                workspaceId = workspaceIdentifier;
            } else {
                // Try to resolve as workspace name
                workspaceId = this.resolveWorkspaceId(userId, workspaceIdentifier);
                if (!workspaceId) {
                    debug(`hasWorkspace: No workspace found with name "${workspaceIdentifier}" for user ${userId}`);
                    return false;
                }
            }

            const workspaceKey = `${ownerId}/${workspaceId}`;
            debug(`Checking if workspace exists: ${workspaceKey} for user ${requestingUserId}`);
            const entry = this.#indexStore.get(workspaceKey);
            return !!entry && (!requestingUserId || entry.owner === requestingUserId); // If requestingUserId is provided, check ownership
        } catch (error) {
            console.error(`Error checking workspace: ${error.message}`);
            return false;
        }
    }

    /**
     * Retrieves the configuration object for a workspace from its config file.
     * @param {string} userId - The owner identifier.
     * @param {string} workspaceId - The workspace ID.
     * @param {string} requestingUserId - The ULID of the user making the request.
     * @returns {Promise<Object|null>} The workspace configuration object or null.
     */
    async getWorkspaceConfig(userId, workspaceId, requestingUserId) {
        if (!this.#initialized) { throw new Error('WorkspaceManager not initialized'); }

        const ownerId = await this.#userManager.resolveToUserId(userId);
        if (!ownerId) return null;

        if (!requestingUserId) {
            requestingUserId = ownerId;
        } else {
            const resolvedRequesterId = await this.#userManager.resolveToUserId(requestingUserId);
            if (!resolvedRequesterId) return null;
            requestingUserId = resolvedRequesterId;
        }
        this.#ensureRequiredParams({ userId: ownerId, workspaceId, requestingUserId }, 'getWorkspaceConfig');

        const workspaceKey = `${ownerId}/${workspaceId}`;
        const entry = this.#indexStore.get(workspaceKey);

        if (!entry) {
            console.warn(`getWorkspaceConfig failed: Workspace ${workspaceKey} not found in index.`);
            return null;
        }
        if (entry.owner !== requestingUserId) {
             console.warn(`getWorkspaceConfig failed: User ${requestingUserId} not owner of ${workspaceKey}.`);
             return null;
        }
        if (!entry.configPath || !existsSync(entry.configPath)) {
            console.warn(`Config file path in index for ${workspaceKey} does not exist: ${entry.configPath}`);
            return null;
        }
        try {
            const conf = new Conf({
                configName: path.basename(entry.configPath, '.json'),
                cwd: path.dirname(entry.configPath)
            });
            return conf.store;
        } catch (err) {
            console.error(`Failed to load workspace config for ${workspaceKey} from ${entry.configPath}: ${err.message}`);
            return null;
        }
    }

    /**
     * Updates the configuration file of a workspace and its index entry.
     * @param {string} userId - The owner identifier.
     * @param {string} workspaceId - The workspace ID.
     * @param {string} requestingUserId - The ULID of the user making the request.
     * @param {Object} updates - An object containing keys and values to update.
     * @returns {Promise<boolean>} True if successful, false otherwise.
     */
    async updateWorkspaceConfig(userId, workspaceId, requestingUserId, updates) {
        if (!this.#initialized) { throw new Error('WorkspaceManager not initialized'); }
        const ownerId = await this.#userManager.resolveToUserId(userId);
        if (!ownerId) return false;

        if (!requestingUserId) {
            requestingUserId = ownerId;
        } else {
            const resolvedRequesterId = await this.#userManager.resolveToUserId(requestingUserId);
            if (!resolvedRequesterId) return false;
            requestingUserId = resolvedRequesterId;
        }
        this.#ensureRequiredParams({ userId: ownerId, workspaceId, requestingUserId, updates }, 'updateWorkspaceConfig');

        const workspaceKey = `${ownerId}/${workspaceId}`;
        const entry = this.#indexStore.get(workspaceKey);

        if (!entry) {
            console.warn(`Update config failed: Workspace ${workspaceKey} not found in index.`);
            return false;
        }
        if (entry.owner !== requestingUserId) {
            console.warn(`Update config failed: User ${requestingUserId} not owner of ${workspaceKey}.`);
            return false;
        }
        if (!entry.configPath || !existsSync(entry.configPath)) {
            console.warn(`Update config failed: Config file path for ${workspaceKey} not found or does not exist: ${entry.configPath}`);
            return false;
        }

        const disallowedKeys = ['id', 'owner', 'userId', 'created', 'rootPath', 'configPath', 'type']; // type should be immutable after creation ideally
        const validUpdates = {};
        let hasValidUpdates = false;
        for (const key in updates) {
            if (!disallowedKeys.includes(key)) {
                validUpdates[key] = updates[key];
                hasValidUpdates = true;
            } else {
                console.warn(`Update config for ${workspaceKey}: Disallowed key "${key}" was ignored.`);
            }
        }

        if (!hasValidUpdates) {
            debug(`Update config called for ${workspaceKey} with no valid updates provided.`);
            return true; // No valid updates, but not an error.
        }

        try {
            const conf = new Conf({
                configName: path.basename(entry.configPath, '.json'),
                cwd: path.dirname(entry.configPath)
            });

            let changed = false;
            for (const key in validUpdates) {
                // Special handling for color validation if it's being updated
                if (key === 'color' && !WorkspaceManager.validateWorkspaceColor(validUpdates[key])) {
                    console.warn(`Invalid color "${validUpdates[key]}" for workspace ${workspaceKey} during update. Ignoring color update.`);
                    continue; // Skip this update
                }
                if (key === 'name' && validUpdates[key]) {
                    // If name is changing, we need to update the indexes
                    const oldNameKey = `${entry.owner}@${entry.host || WORKSPACE_DEFAULT_HOST}:${entry.name}`;
                    const newNameKey = `${entry.owner}@${entry.host || WORKSPACE_DEFAULT_HOST}:${validUpdates[key]}`;
                    const oldRefKey = entry.reference;
                    const newRefKey = this.constructWorkspaceReference(entry.owner, validUpdates[key], entry.host);

                    this.#nameIndex.delete(oldNameKey);
                    this.#nameIndex.set(newNameKey, workspaceId);

                    this.#referenceIndex.delete(oldRefKey);
                    this.#referenceIndex.set(newRefKey, workspaceId);

                    validUpdates.reference = newRefKey; // Update reference in config
                }
                if (conf.get(key) !== validUpdates[key]) {
                    conf.set(key, validUpdates[key]);
                    changed = true;
                }
            }

            if (changed) {
                conf.set('updatedAt', new Date().toISOString());

                // Update relevant fields in the index entry
                const indexUpdates = { lastAccessed: new Date().toISOString() };
                if (validUpdates.label !== undefined) indexUpdates.label = validUpdates.label;
                if (validUpdates.color !== undefined && WorkspaceManager.validateWorkspaceColor(validUpdates.color)) indexUpdates.color = validUpdates.color;
                if (validUpdates.description !== undefined) indexUpdates.description = validUpdates.description;
                if (validUpdates.roles !== undefined && Array.isArray(validUpdates.roles)) indexUpdates.roles = validUpdates.roles;
                if (validUpdates.acl !== undefined) indexUpdates.acl = validUpdates.acl; // Assuming ACL structure is validated elsewhere or trusted

                this.#updateWorkspaceIndexEntry(workspaceKey, indexUpdates);
                this.emit('workspace.config.updated', { workspaceKey, updates: validUpdates });
                debug(`Workspace config updated for ${workspaceKey}`);
            }
            return true;
        } catch (err) {
            console.error(`Failed to load/update workspace config for ${workspaceKey} at ${entry.configPath}: ${err.message}`);
            return false;
        }
    }

    /**
     * Role Management Methods
     */

    /**
     * Associate a role with this workspace
     * @param {string} userId - User ID
     * @param {string} workspaceId - Workspace ID
     * @param {string} roleId - Role ID to associate
     * @param {string} requestingUserId - User making the request
     * @returns {Promise<boolean>} Success status
     */
    async associateRole(userId, workspaceId, roleId, requestingUserId) {
        if (!this.#roleManager) {
            throw new Error('RoleManager not available for role association');
        }

        const ownerId = await this.#userManager.resolveToUserId(userId);
        if (!ownerId) {
            throw new Error(`Could not resolve user identifier: "${userId}"`);
        }

        // Check workspace ownership
        const indexKey = this.#constructWorkspaceIndexKey(ownerId, workspaceId);
        const entry = this.#indexStore.get(indexKey);
        if (!entry || entry.owner !== requestingUserId) {
            throw new Error('Permission denied to associate role with workspace');
        }

        // Initialize roles array if not exists
        if (!entry.roles) {
            entry.roles = [];
        }

        // Check if already associated
        if (entry.roles.includes(roleId)) {
            debug(`Role ${roleId} already associated with workspace ${workspaceId}`);
            return true;
        }

        // Add role association
        entry.roles.push(roleId);
        entry.updatedAt = new Date().toISOString();
        this.#indexStore.set(indexKey, entry);

        this.emit('workspace.role.associated', { workspaceId, roleId, userId: ownerId });
        debug(`Role ${roleId} associated with workspace ${workspaceId}`);
        return true;
    }

    /**
     * Disassociate a role from this workspace
     * @param {string} userId - User ID
     * @param {string} workspaceId - Workspace ID
     * @param {string} roleId - Role ID to disassociate
     * @param {string} requestingUserId - User making the request
     * @returns {Promise<boolean>} Success status
     */
    async disassociateRole(userId, workspaceId, roleId, requestingUserId) {
        const ownerId = await this.#userManager.resolveToUserId(userId);
        if (!ownerId) {
            throw new Error(`Could not resolve user identifier: "${userId}"`);
        }

        // Check workspace ownership
        const indexKey = this.#constructWorkspaceIndexKey(ownerId, workspaceId);
        const entry = this.#indexStore.get(indexKey);
        if (!entry || entry.owner !== requestingUserId) {
            throw new Error('Permission denied to disassociate role from workspace');
        }

        if (!entry.roles || !entry.roles.includes(roleId)) {
            debug(`Role ${roleId} not associated with workspace ${workspaceId}`);
            return true;
        }

        // Remove role association
        entry.roles = entry.roles.filter(id => id !== roleId);
        entry.updatedAt = new Date().toISOString();
        this.#indexStore.set(indexKey, entry);

        this.emit('workspace.role.disassociated', { workspaceId, roleId, userId: ownerId });
        debug(`Role ${roleId} disassociated from workspace ${workspaceId}`);
        return true;
    }

    /**
     * Get roles associated with a workspace
     * @param {string} userId - User ID
     * @param {string} workspaceId - Workspace ID
     * @param {string} requestingUserId - User making the request
     * @returns {Promise<Array>} Array of role IDs
     */
    async getWorkspaceRoles(userId, workspaceId, requestingUserId) {
        const ownerId = await this.#userManager.resolveToUserId(userId);
        if (!ownerId) return [];

        const indexKey = this.#constructWorkspaceIndexKey(ownerId, workspaceId);
        const entry = this.#indexStore.get(indexKey);

        if (!entry || entry.owner !== requestingUserId) {
            return [];
        }

        return entry.roles || [];
    }

    /**
     * Start all roles associated with a workspace
     * @param {string} userId - User ID
     * @param {string} workspaceId - Workspace ID
     * @param {string} requestingUserId - User making the request
     * @returns {Promise<Array>} Array of started role results
     */
    async startWorkspaceRoles(userId, workspaceId, requestingUserId) {
        if (!this.#roleManager) {
            debug('RoleManager not available, skipping role start');
            return [];
        }

        const roleIds = await this.getWorkspaceRoles(userId, workspaceId, requestingUserId);
        const results = [];

        for (const roleId of roleIds) {
            try {
                const role = await this.#roleManager.startRole(roleId, requestingUserId);
                results.push({ roleId, status: 'started', role });
                debug(`Started role ${roleId} for workspace ${workspaceId}`);
            } catch (error) {
                results.push({ roleId, status: 'failed', error: error.message });
                debug(`Failed to start role ${roleId} for workspace ${workspaceId}: ${error.message}`);
            }
        }

        return results;
    }

    /**
     * Stop all roles associated with a workspace
     * @param {string} userId - User ID
     * @param {string} workspaceId - Workspace ID
     * @param {string} requestingUserId - User making the request
     * @returns {Promise<Array>} Array of stopped role results
     */
    async stopWorkspaceRoles(userId, workspaceId, requestingUserId) {
        if (!this.#roleManager) {
            debug('RoleManager not available, skipping role stop');
            return [];
        }

        const roleIds = await this.getWorkspaceRoles(userId, workspaceId, requestingUserId);
        const results = [];

        for (const roleId of roleIds) {
            try {
                await this.#roleManager.stopRole(roleId, requestingUserId);
                results.push({ roleId, status: 'stopped' });
                debug(`Stopped role ${roleId} for workspace ${workspaceId}`);
            } catch (error) {
                results.push({ roleId, status: 'failed', error: error.message });
                debug(`Failed to stop role ${roleId} for workspace ${workspaceId}: ${error.message}`);
            }
        }

        return results;
    }

    /**
     * Get role mount path for workspace
     * @param {string} userId - User ID
     * @param {string} workspaceId - Workspace ID
     * @returns {Promise<string|null>} Role mount path or null
     */
    async getWorkspaceRolePath(userId, workspaceId) {
        const ownerId = await this.#userManager.resolveToUserId(userId);
        if (!ownerId) return null;

        const indexKey = this.#constructWorkspaceIndexKey(ownerId, workspaceId);
        const entry = this.#indexStore.get(indexKey);

        if (!entry) return null;

        return path.join(entry.rootPath, WORKSPACE_DIRECTORIES.roles);
    }

    /**
     * Static Utility Methods
     */

    /**
     * Parse remote workspace reference format: user.email@host:workspace.name
     * @param {string} remoteRef - Remote workspace reference
     * @returns {Object|null} Parsed remote workspace info or null if invalid
     * @static
     */
    static parseRemoteWorkspaceRef(remoteRef) {
        if (!remoteRef || typeof remoteRef !== 'string') {
            return null;
        }

        // Format: user.email@host:workspace.name
        const match = remoteRef.match(/^([^@]+)@([^:]+):(.+)$/);
        if (!match) {
            return null;
        }

        const [, userEmail, host, workspaceName] = match;

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(userEmail)) {
            return null;
        }

        return {
            userEmail,
            host,
            workspaceName,
            original: remoteRef
        };
    }

    /**
     * Resolve remote workspace reference to internal format
     * @param {string} remoteRef - Remote workspace reference
     * @param {Function} userResolver - Function to resolve user.email to user.id
     * @param {Function} workspaceResolver - Function to resolve workspace.name to workspace.id
     * @returns {Promise<Object|null>} Resolved remote workspace info or null if invalid
     * @static
     */
    static async resolveRemoteWorkspaceRef(remoteRef, userResolver, workspaceResolver) {
        const parsed = WorkspaceManager.parseRemoteWorkspaceRef(remoteRef);
        if (!parsed) {
            return null;
        }

        try {
            // Resolve user email to user ID
            const userId = await userResolver(parsed.userEmail);
            if (!userId) {
                debug(`Failed to resolve user email to ID: ${parsed.userEmail}`);
                return null;
            }

            // Resolve workspace name to workspace ID
            const workspaceId = await workspaceResolver(userId, parsed.workspaceName);
            if (!workspaceId) {
                debug(`Failed to resolve workspace name to ID: ${parsed.workspaceName} for user ${userId}`);
                return null;
            }

            return {
                ...parsed,
                userId,
                workspaceId,
                resolved: `${userId}@${parsed.host}:${workspaceId}`
            };
        } catch (error) {
            debug(`Error resolving remote workspace reference: ${error.message}`);
            return null;
        }
    }

    /**
     * Get a random color for workspace
     * @returns {string} Random color
     * @static
     */
    static getRandomColor() {
        return randomcolor({
            luminosity: 'light',
            format: 'hex',
        });
    }

    /**
     * Validate workspace color
     * @param {string} color - Color to validate
     * @returns {boolean} True if color is a valid hex color, false otherwise
     * @static
     */
    static validateWorkspaceColor(color) {
        if (typeof color !== 'string') {
            debug('Workspace color must be a string');
            return false;
        }
        // Basic hex color regex (allows #rgb, #rrggbb, #rgba, #rrggbbaa)
        // For this context, let's stick to #rgb or #rrggbb
        if (!color.match(/^#(?:[0-9a-fA-F]{3}){1,2}$/)) {
            debug(`Workspace color must be a valid hex color (e.g., #RRGGBB or #RGB). Received: ${color}`);
            return false;
        }
        return true;
    }

    /**
     * Private Methods
     */

    /**
     * Rebuilds the name and reference indexes from existing workspaces in the index store
     * @private
     */
    async #rebuildIndexes() {
        this.#nameIndex.clear();
        this.#referenceIndex.clear();
        const allWorkspaces = this.#indexStore.store;

        for (const [indexKey, workspaceEntry] of Object.entries(allWorkspaces)) {
            const parsed = this.#parseWorkspaceIndexKey(indexKey);
            if (workspaceEntry && workspaceEntry.name && parsed) {
                const host = workspaceEntry.host || WORKSPACE_DEFAULT_HOST;
                const ownerId = parsed.userId; // This is the actual user ID

                const nameKey = `${ownerId}@${host}:${workspaceEntry.name}`;
                this.#nameIndex.set(nameKey, parsed.workspaceId);

                // Add reference index entry
                if (workspaceEntry.reference) {
                    this.#referenceIndex.set(workspaceEntry.reference, parsed.workspaceId);
                } else {
                    // Create reference for legacy workspaces
                    const reference = constructWorkspaceReference(ownerId, workspaceEntry.name, host);
                    this.#referenceIndex.set(reference, parsed.workspaceId);
                    // TODO: Should we add this back to the config file?
                }
            }
        }

        debug(`Rebuilt name and reference indexes with ${this.#nameIndex.size} workspace name mappings`);
    }

    #sanitizeWorkspaceName(workspaceName) {
        if (!workspaceName) return 'untitled';
        let sanitized = workspaceName.toString().toLowerCase().trim();

        // Remove all special characters except "_", "-"
        sanitized = sanitized.replace(/[^a-z0-9-_]/g, '');

        // Replace spaces with hyphens
        sanitized = sanitized.replace(/\s+/g, '-');

        // Return the sanitized workspaceName
        return sanitized;
    }

    /**
     * Pre-creates all subdirectories defined in WORKSPACE_DIRECTORIES.
     * @param {string} workspaceDir - The workspace directory path.
     * @returns {Promise<void>}
     * @private
     */
    async #createWorkspaceSubdirectories(workspaceDir) {
        debug(`Creating subdirectories for workspace at ${workspaceDir}`);
        for (const subdirKey in WORKSPACE_DIRECTORIES) {
            const subdirPath = path.join(workspaceDir, WORKSPACE_DIRECTORIES[subdirKey]);
            try {
                await fsPromises.mkdir(subdirPath, { recursive: true });
                debug(`Created subdirectory: ${subdirPath}`);

                // Create run directory for Unix sockets in var directory
                if (subdirKey === 'var') {
                    const runPath = path.join(subdirPath, 'run');
                    await fsPromises.mkdir(runPath, { recursive: true });
                    debug(`Created socket directory: ${runPath}`);
                }
            } catch (err) {
                // Log error but don't necessarily fail the whole workspace creation
                console.error(`Failed to create subdirectory ${subdirPath}: ${err.message}`);
            }
        }
    }

    /**
     * Performs the initial scan of workspaces listed in the index.
     * Re-validates all workspace paths and updates statuses accordingly.
     * Recovers workspaces that were NOT_FOUND or ERROR if paths are now valid.
     * Does NOT load workspaces into memory.
     * @private
     */
    async #scanIndexedWorkspaces() {
        debug('Performing initial workspace scan...');
        const allWorkspaces = this.#indexStore.store;
        let statusChanges = 0;

        for (const indexKey in allWorkspaces) {
            const workspaceEntry = allWorkspaces[indexKey];
            const parsed = this.#parseWorkspaceIndexKey(indexKey);

            // Basic validation of the entry structure
            if (!workspaceEntry || typeof workspaceEntry !== 'object' || !workspaceEntry.id || !parsed) {
                debug(`Skipping invalid or incomplete workspace entry for key: ${indexKey}`);
                continue;
            }

            const workspaceId = parsed.workspaceId;
            const currentStatus = workspaceEntry.status;

            // Skip permanently removed/destroyed workspaces
            if ([WORKSPACE_STATUS_CODES.REMOVED, WORKSPACE_STATUS_CODES.DESTROYED].includes(currentStatus)) {
                debug(`Workspace ${workspaceId} is ${currentStatus}, skipping scan.`);
                continue;
            }

            debug(`Scanning workspace ${workspaceId} (Name: ${workspaceEntry.name}, Status: ${currentStatus})`);

            // Determine new status based on filesystem state
            let newStatus;
            const rootPathExists = workspaceEntry.rootPath && existsSync(workspaceEntry.rootPath);
            const configPathExists = workspaceEntry.configPath && existsSync(workspaceEntry.configPath);

            if (!rootPathExists) {
                // Workspace directory missing
                newStatus = WORKSPACE_STATUS_CODES.NOT_FOUND;
                debug(`Workspace ${workspaceId} path not found: ${workspaceEntry.rootPath}`);
            } else if (!configPathExists) {
                // Workspace directory exists but config missing
                newStatus = WORKSPACE_STATUS_CODES.ERROR;
                debug(`Workspace ${workspaceId} config not found: ${workspaceEntry.configPath}`);
            } else {
                // Both paths exist - workspace is valid
                // Preserve ACTIVE/INACTIVE status if set, otherwise mark as AVAILABLE
                if ([WORKSPACE_STATUS_CODES.ACTIVE, WORKSPACE_STATUS_CODES.INACTIVE].includes(currentStatus)) {
                    newStatus = WORKSPACE_STATUS_CODES.INACTIVE; // Reset ACTIVE to INACTIVE on startup
                } else {
                    newStatus = WORKSPACE_STATUS_CODES.AVAILABLE;
                }

                // Log recovery if workspace was previously in error state
                if ([WORKSPACE_STATUS_CODES.NOT_FOUND, WORKSPACE_STATUS_CODES.ERROR].includes(currentStatus)) {
                    debug(`Workspace ${workspaceId} recovered: ${currentStatus} -> ${newStatus}`);
                }
            }

            // Update status if changed
            if (newStatus !== currentStatus) {
                this.#updateWorkspaceIndexEntry(indexKey, { status: newStatus });
                statusChanges++;
                debug(`Updated workspace ${workspaceId} status: ${currentStatus} -> ${newStatus}`);
            }
        }

        if (statusChanges > 0) {
            debug(`Workspace scan complete. Updated ${statusChanges} workspace status(es).`);
        } else {
            debug('Workspace scan complete. No status changes needed.');
        }
    }

    /**
     * Validates a workspace index entry for opening.
     * @param {Object} entry - The workspace index entry.
     * @param {string} workspaceId - The ID of the workspace.
     * @param {string} requestingUserId - The ULID of the user making the request.
     * @returns {boolean} True if valid, false otherwise.
     * @private
     */
    #validateWorkspaceEntryForOpen(entry, workspaceId, requestingUserId) {
        if (!entry) {
            debug(`openWorkspace failed: Workspace ${workspaceId} not found in index.`);
            return false;
        }
        if (entry.owner !== requestingUserId) {
            console.warn(`openWorkspace failed: User ${requestingUserId} is not the owner of workspace ${workspaceId}. Stored owner: ${entry.owner}`);
            return false;
        }
        if (!entry.rootPath || !existsSync(entry.rootPath)) {
            console.warn(`openWorkspace failed: Workspace ${workspaceId} rootPath is missing or does not exist: ${entry.rootPath}`);
            // Find the correct index key for this workspace
            const allEntries = this.#indexStore.store;
            for (const [indexKey, workspaceEntry] of Object.entries(allEntries)) {
                const parsed = this.#parseWorkspaceIndexKey(indexKey);
                if (parsed && parsed.workspaceId === workspaceId) {
                    this.#updateWorkspaceIndexEntry(indexKey, { status: WORKSPACE_STATUS_CODES.NOT_FOUND });
                    break;
                }
            }
            return false;
        }
        if (!entry.configPath || !existsSync(entry.configPath)) {
            console.warn(`openWorkspace failed: Workspace ${workspaceId} configPath is missing or does not exist: ${entry.configPath}`);
            // Find the correct index key for this workspace
            const allEntries = this.#indexStore.store;
            for (const [indexKey, workspaceEntry] of Object.entries(allEntries)) {
                const parsed = this.#parseWorkspaceIndexKey(indexKey);
                if (parsed && parsed.workspaceId === workspaceId) {
                    this.#updateWorkspaceIndexEntry(indexKey, { status: WORKSPACE_STATUS_CODES.ERROR });
                    break;
                }
            }
            return false;
        }
        const validOpenStatuses = [
            WORKSPACE_STATUS_CODES.AVAILABLE,
            WORKSPACE_STATUS_CODES.INACTIVE,
            WORKSPACE_STATUS_CODES.ACTIVE, // Can re-open an active one (returns from cache or re-validates)
            // WORKSPACE_STATUS_CODES.ERROR, // Should we allow opening an errored workspace? Perhaps if paths are now valid.
        ];
        if (!validOpenStatuses.includes(entry.status)) {
            console.warn(`openWorkspace failed: Workspace ${workspaceId} status is invalid (${entry.status}). Must be one of: ${validOpenStatuses.join(', ')}.`);
            // Don't change status here, as it might be a temporary issue or a state we don't want to override.
            return false;
        }
        return true;
    }

    /**
     * Helper to update a workspace's entry in the index store.
     * Ensures owner check if requestingUserId is provided for sensitive updates.
     * @param {string} indexKey - The index key (userId/workspaceId) of the workspace in the index.
     * @param {Object} updates - Key-value pairs to update in the index entry.
     * @param {string} [requestingUserId] - Optional. If provided, validates ownership before certain updates.
     * @private
     */
    #updateWorkspaceIndexEntry(indexKey, updates, requestingUserId = null) {
        const currentEntry = this.#indexStore.get(indexKey);
        if (!currentEntry) {
            debug(`Cannot update index for ${indexKey}: entry not found.`);
            return;
        }

        // If requestingUserId is provided (typically for status changes like stop/start),
        // ensure the action is performed by the owner.
        if (requestingUserId && currentEntry.owner !== requestingUserId) {
            console.error(`Index update for ${indexKey} denied: User ${requestingUserId} is not the owner. Owner: ${currentEntry.owner}`);
            return;
        }

        const updatedEntry = { ...currentEntry, ...updates, updatedAt: new Date().toISOString() };
        this.#indexStore.set(indexKey, updatedEntry);
        debug(`Updated index entry for ${indexKey} with: ${JSON.stringify(updates)}`);
    }

    /**
     * Ensures that all required parameters are provided for a method.
     * @param {Object} params - An object where keys are param names and values are their values.
     * @param {string} methodName - The name of the method calling this helper (for error messages).
     * @param {boolean} [allRequired=true] - Whether all params in the object are required.
     * @throws {Error} if any required parameter is missing.
     * @private
     */
    #ensureRequiredParams(params, methodName, allRequired = true) {
        for (const paramName in params) {
            const value = params[paramName];
            if (allRequired || value !== undefined) { // If not allRequired, only check if value is explicitly undefined
                 if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
                    if (paramName === 'updates' && typeof value === 'object' && Object.keys(value).length > 0) continue; // Allow empty updates object if not strictly required
                    throw new Error(`${methodName} requires ${paramName}.`);
                }
            }
        }
    }

    /**
     * Checks if a workspace is the universe workspace
     * @param {string} workspaceId - The workspace ID to check
     * @returns {boolean} True if the workspace is the universe workspace
     * @private
     */
    #isUniverseWorkspace(workspaceId) {
        // Search for workspace in index by workspaceId across all users
        const allEntries = this.#indexStore.store;
        for (const [indexKey, workspaceEntry] of Object.entries(allEntries)) {
            const parsed = this.#parseWorkspaceIndexKey(indexKey);
            if (parsed && parsed.workspaceId === workspaceId) {
                return workspaceEntry.type === 'universe';
            }
        }
        return false;
    }

    /**
     * Get universe workspace for a user
     * @param {string} userId - User ID
     * @returns {Promise<Object|null>} Universe workspace or null
     */
    async getUniverseWorkspace(userId) {
        const workspaces = await this.listUserWorkspaces(userId);
        return workspaces.find(ws => ws.type === 'universe') || null;
    }
}

export default WorkspaceManager;
export {
    WORKSPACE_STATUS_CODES,
    WORKSPACE_DIRECTORIES,
};
