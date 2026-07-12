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
    var: 'var', // Unix sockets + runtime state
    varHooks: 'var/hooks', // hook/rule run log (runs.jsonl)
    varTmp: 'var/tmp', // scratch space for hook scripts (CANVAS_WORK_DIR)
};

const WORKSPACE_GIT_BARE_DIR = 'bare.git';

// Default sync exclusions for enumerable file backends (workspace:home).
// Merged with the per-backend `exclude` list from workspace config; applied
// identically to the live watcher and to list()/scan() resyncs. Patterns
// ending in /** also prune the directory itself (see stored FileBackend).
const DEFAULT_SYNC_EXCLUSIONS = [
    '**/.*',            // dotfiles (also covers .git, .cache, browser profiles…)
    '**/.*/**',         // …and everything below dotdirs
    '**/node_modules/**',
    '**/__pycache__/**',
    '**/bower_components/**',
    '**/vendor/bundle/**', // ruby gems
    '**/target/debug/**',  // cargo
    '**/target/release/**',
    '**/*.swp',
    '**/*.tmp',
    '**/Cache/**',
    '**/Caches/**',
    '**/CachedData/**',
];

const WORKSPACE_DATA_BACKENDS = {
    'workspace:home': {
        enabled: true,
        supported: true,
        driver: 'file',
        root: '{WORKSPACE_ROOT}/home',
        watch: true,
        resync: true,
        // User-defined glob exclusions, merged on top of DEFAULT_SYNC_EXCLUSIONS.
        exclude: [],
        // readOnly: true blocks byte-deletion on the backend (Destroy degrades
        // to reference-drop) even when the driver itself supports delete.
        readOnly: false,
    },
    // Local content-addressable blob store (cacache). The default managed data
    // target for users without an external object store: dump blobs, care only
    // about the synapsd virtual tree. Bytes are checksum-keyed + deduped +
    // integrity-checked; locations written as stored://workspace:data/<key>.
    // Structural (always-on): the blob target every connector persists into.
    // No readOnly knob — the store is managed and never exported/edited directly.
    'workspace:data': {
        enabled: true,
        supported: true,
        driver: 'cacache',
        root: '{WORKSPACE_ROOT}/data',
        managed: true,
        watch: false,
        resync: false,
    },
    'stored.cache': {
        enabled: true,
        supported: true,
        root: '{WORKSPACE_ROOT}/cache',
    },
    // Future external object store (opt-in alternative to workspace:data).
    s3: {
        enabled: false,
        supported: false,
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
    DEFAULT_SYNC_EXCLUSIONS,
    WORKSPACE_DEFAULT_HOST,
    WORKSPACE_CONFIG_FILENAME,
    WORKSPACE_DIRECTORIES,
    WORKSPACE_GIT_BARE_DIR,
    WORKSPACE_STATUS_CODES,
    WORKSPACE_DATA_BACKENDS,
    WORKSPACE_SERVICES,
    WORKSPACE_CONFIG_TEMPLATE,
};
