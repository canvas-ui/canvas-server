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
    cache: 'cache',
    data: 'data',
    home: 'home',
    git: 'git',
    hooks: 'git/hooks',
    roles: 'roles',
    var: 'var', // For Unix sockets
};

const WORKSPACE_GIT_BARE_DIR = 'bare.git';

const WORKSPACE_DATA_BACKENDS = {
    'workspace:home': {
        enabled: true,
        supported: true,
        driver: 'file',
        root: '{WORKSPACE_ROOT}/home',
        watch: true,
        resync: true,
        indexIncoming: true,
        incomingPathMode: 'sourceDirectories',
    },
    'fs:data': {
        enabled: true,
        supported: true,
        driver: 'file',
        root: '{WORKSPACE_ROOT}/data',
        managed: true,
        watch: false,
        resync: false,
        indexIncoming: false,
    },
    // Content-addressable blob store (cacache). Optional, opt-in alternative
    // managed data target — bytes deduped + integrity-checked. Disabled by
    // default; locations written as stored://workspace:data/<key>.
    'workspace:data': {
        enabled: false,
        supported: true,
        driver: 'cacache',
        root: '{WORKSPACE_ROOT}/data/blobs',
        managed: true,
        watch: false,
        resync: false,
        indexIncoming: false,
    },
    'stored.cache': {
        enabled: true,
        supported: true,
        root: '{WORKSPACE_ROOT}/cache',
    },
    s3: {
        enabled: false,
        supported: false,
    },
    imap: {
        enabled: false,
        supported: true,
        indexIncoming: true,
    },
};

// Available workspace services
const WORKSPACE_SERVICES = {
    dotfiles: {
        enabled: false,
    },
    git: {
        enabled: false,
    },
    imap: {
        enabled: false,
    },
    imapSync: {
        enabled: false,
    },
    home: {
        enabled: true,
        transports: ['webdav'], // Available: 'webdav', 's3' (future)
    },
    webdav: {
        enabled: true,
        backend: 'workspace:home',
    },
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
    icon: null, // URL string
    homeScreen: {}, // Arbitrary JSON for UI defaults
    description: '',
    links: {}, // Portable, workspace-scoped linked resources (by type)
    acl: {
        tokens: {} // Token-based ACL: { "sha256:hash": { permissions: [], description: "", createdAt: "", expiresAt: null } }
    },
    roles: [], // Associated role IDs
    dataBackends: { ...WORKSPACE_DATA_BACKENDS },
    services: { ...WORKSPACE_SERVICES }, // Feature toggles
    created: null,
    updated: null,
};

export {
    WORKSPACE_DEFAULT_HOST,
    WORKSPACE_CONFIG_FILENAME,
    WORKSPACE_DIRECTORIES,
    WORKSPACE_GIT_BARE_DIR,
    WORKSPACE_STATUS_CODES,
    WORKSPACE_DATA_BACKENDS,
    WORKSPACE_SERVICES,
    WORKSPACE_CONFIG_TEMPLATE,
};
