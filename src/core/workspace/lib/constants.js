/**
 * Constants
 */

// Default host for local workspaces
const WORKSPACE_DEFAULT_HOST = 'canvas.local';

// Workspace reference format: [user_identifier]@[host]:[workspace_slug][/optional_path...]
// Examples:
// - user.id@canvas.local:my-project
// - user.name@canvas.local:my-project
// - user.email@remote.server.com:shared-workspace/subfolder
const WORKSPACE_CONFIG_FILENAME = 'workspace.json';

// Lets adhere to the "You aint gonna need it" principle here
const WORKSPACE_DIRECTORIES = {
    db: 'db',
    config: 'config',
    home: 'home',
    roles: 'roles',
    var: 'var', // For Unix sockets
};

const WORKSPACE_STATUS_CODES = {
    AVAILABLE: 'available', // Workspace dir exists, config readable
    NOT_FOUND: 'not_found', // Workspace dir/config specified in index not found
    ERROR: 'error', // Config invalid, FS issues, etc.
    ACTIVE: 'active', // Workspace is loaded and started (db connected)
    INACTIVE: 'inactive', // Workspace is loaded but not started
    REMOVED: 'removed', // Marked for removal, ignored on scan
    DESTROYED: 'destroyed', // Workspace dir deleted by user
};

const WORKSPACE_CONFIG_TEMPLATE = {
    id: null, // Set to 12-char nanoid (opaque identifier)
    name: null, // User-defined slug-like name
    owner: null, // User ID (email)
    type: 'workspace', // "workspace" or "universe" (user home directory)
    label: 'Workspace',
    color: null,
    description: '',
    acl: {
        tokens: {} // Token-based ACL: { "sha256:hash": { permissions: [], description: "", createdAt: "", expiresAt: null } }
    },
    roles: [], // Associated role IDs
    created: null,
    updated: null,
};

export {
    WORKSPACE_DEFAULT_HOST,
    WORKSPACE_CONFIG_FILENAME,
    WORKSPACE_DIRECTORIES,
    WORKSPACE_STATUS_CODES,
};
