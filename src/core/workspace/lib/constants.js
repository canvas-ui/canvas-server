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

// Hidden per-workspace internals dir used by the `home` layout. Everything the
// workspace needs to run (config, db, cache, data, git, var, roles) lives
// below it, so the workspace ROOT can be handed to the user as a plain folder.
const WORKSPACE_INTERNAL_DIRNAME = '.workspace';

/**
 * Folder-structure variants a workspace can be created with. Recorded in
 * workspace.json as `layout`, fixed at creation time (both are fully supported
 * at runtime — every path still resolves through `internals`/`services`, this
 * only decides the DEFAULTS those maps are seeded with).
 *
 *  full — the classic layout. Every runtime dir is a visible child of the
 *         workspace root, the user's drive is `$WORKSPACE_ROOT/home`:
 *           $WS/workspace.json
 *           $WS/{home,data,db,cache,git,var,config,roles}
 *
 *  home — workspace-as-a-roaming-profile. The workspace ROOT *is* the user's
 *         home drive (what WebDAV exports, what `workspace:home` indexes), and
 *         everything else hides in `$WORKSPACE_ROOT/.workspace/`:
 *           $WS/**                      <- the user's files, nothing else
 *           $WS/.workspace/workspace.json
 *           $WS/.workspace/{data,db,cache,git,var,config,roles}
 *         `.workspace` is always excluded from the indexed backends (see
 *         WORKSPACE_INTERNAL_EXCLUSIONS), so the workspace never indexes itself.
 */
const WORKSPACE_LAYOUTS = {
    FULL: 'full',
    HOME: 'home',
};

const WORKSPACE_DEFAULT_LAYOUT = WORKSPACE_LAYOUTS.FULL;

function normalizeWorkspaceLayout(layout) {
    return layout === WORKSPACE_LAYOUTS.HOME ? WORKSPACE_LAYOUTS.HOME : WORKSPACE_DEFAULT_LAYOUT;
}

// Default on-disk layout, relative to the workspace root. Every entry is an
// override point: a workspace.json `directories` map can remap any of these
// (absolute, workspace-relative, or a `{WORKSPACE_ROOT}` template) — e.g. stash
// all runtime dirs under `.workspace/` and leave the root itself as the user's
// home (which is exactly what the `home` layout below does). Resolved through
// Workspace#resolveDir; nothing here is a hidden dir.
const WORKSPACE_DIRECTORIES = {
    db: 'db',
    config: 'config',
    cache: 'cache',
    data: 'data',
    home: 'home',
    // Stored's runtime root (its metadata index; the blob cache is redirected to
    // `cache` above). Nested under db/, NOT a hidden `.stored/` — see
    // WorkspaceStoredIndex.start() and its one-time migration off the old path.
    stored: 'db/stored',
    git: 'git',
    hooks: 'git/hooks',
    roles: 'roles',
    var: 'var', // Unix sockets + runtime state
    varHooks: 'var/hooks', // hook/rule run log (runs.jsonl)
    varTmp: 'var/tmp', // scratch space for hook scripts (CANVAS_WORK_DIR)
};

// `home` layout equivalent of WORKSPACE_DIRECTORIES: the same set of dirs,
// tucked under `.workspace/` — except `home`, which IS the workspace root.
const WORKSPACE_DIRECTORIES_HOME = Object.fromEntries(
    Object.entries(WORKSPACE_DIRECTORIES).map(([key, rel]) => [
        key,
        key === 'home' ? '.' : `${WORKSPACE_INTERNAL_DIRNAME}/${rel}`,
    ]),
);

/** Default dir map (relative to the workspace root) for a layout. */
function workspaceDirectories(layout) {
    return normalizeWorkspaceLayout(layout) === WORKSPACE_LAYOUTS.HOME
        ? WORKSPACE_DIRECTORIES_HOME
        : WORKSPACE_DIRECTORIES;
}

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

// Structural exclusions prepended to every enumerable file backend's ignore
// list, on top of DEFAULT_SYNC_EXCLUSIONS and regardless of layout. In the
// `home` layout the home backend's root IS the workspace root, so without this
// the workspace would index its own db/cache/git. Dotfiles are excluded by
// default anyway; these are the load-bearing patterns, spelled out so they
// survive any future relaxation of the dotfile rule.
const WORKSPACE_INTERNAL_EXCLUSIONS = [
    WORKSPACE_INTERNAL_DIRNAME,
    `${WORKSPACE_INTERNAL_DIRNAME}/**`,
];

// Workspace INTERNALS — the non-service runtime dirs a workspace.json
// `internals` map can remap (absolute, workspace-relative, or a
// `{WORKSPACE_ROOT}` template). Storage locations (home/data/cache) are NOT
// here — those belong to services.stored.
const WORKSPACE_INTERNALS = {
    db: '{WORKSPACE_ROOT}/db',
    config: '{WORKSPACE_ROOT}/config',
    var: '{WORKSPACE_ROOT}/var',
    tmp: '{WORKSPACE_ROOT}/var/tmp',
};

// Same map for the `home` layout — every internal dir under `.workspace/`.
const WORKSPACE_INTERNALS_HOME = {
    db: `{WORKSPACE_ROOT}/${WORKSPACE_INTERNAL_DIRNAME}/db`,
    config: `{WORKSPACE_ROOT}/${WORKSPACE_INTERNAL_DIRNAME}/config`,
    var: `{WORKSPACE_ROOT}/${WORKSPACE_INTERNAL_DIRNAME}/var`,
    tmp: `{WORKSPACE_ROOT}/${WORKSPACE_INTERNAL_DIRNAME}/var/tmp`,
};

/** `internals` defaults for a layout. */
function workspaceInternals(layout) {
    return normalizeWorkspaceLayout(layout) === WORKSPACE_LAYOUTS.HOME
        ? WORKSPACE_INTERNALS_HOME
        : WORKSPACE_INTERNALS;
}

// Storage backends only (services.stored.backends default). stored's cache is
// NOT a backend — it is a first-class stored property (services.stored.cache).
const WORKSPACE_STORAGE_BACKENDS = {
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
    // Future external object store (opt-in alternative to workspace:data).
    s3: {
        enabled: false,
        supported: false,
    },
};

// services.stored default — stored is STORAGE ONLY: its metadata index
// (`root`), its in-workspace working store (`cache`: thumbnails + future S3
// pull-through + the stored.syncd staging area), sync policies, and the data
// backends map. Not a feature toggle; always on.
const WORKSPACE_STORED_DEFAULT = {
    root: '{WORKSPACE_ROOT}/db/stored',
    cache: '{WORKSPACE_ROOT}/cache',
    sync: { policies: [] },
    backends: { ...WORKSPACE_STORAGE_BACKENDS },
};

/**
 * `services.stored.backends` defaults for a layout. The `home` layout points
 * workspace:home at the workspace root itself (that root is the roaming drive)
 * and moves the managed blob store into `.workspace/data`.
 */
function workspaceStorageBackends(layout) {
    const backends = structuredClone(WORKSPACE_STORAGE_BACKENDS);
    if (normalizeWorkspaceLayout(layout) !== WORKSPACE_LAYOUTS.HOME) { return backends; }
    backends['workspace:home'].root = '{WORKSPACE_ROOT}';
    backends['workspace:data'].root = `{WORKSPACE_ROOT}/${WORKSPACE_INTERNAL_DIRNAME}/data`;
    return backends;
}

/** `services.stored` defaults for a layout. */
function workspaceStoredDefault(layout) {
    const dirs = workspaceDirectories(layout);
    return {
        ...structuredClone(WORKSPACE_STORED_DEFAULT),
        root: `{WORKSPACE_ROOT}/${dirs.stored}`,
        cache: `{WORKSPACE_ROOT}/${dirs.cache}`,
        backends: workspaceStorageBackends(layout),
    };
}

// Available workspace services
const WORKSPACE_SERVICES = {
    stored: { ...WORKSPACE_STORED_DEFAULT },
    dotfiles: {
        enabled: false,
    },
    git: {
        enabled: false,
        root: '{WORKSPACE_ROOT}/git',
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

/** `services` defaults for a layout (stored + git roots follow the layout). */
function workspaceServices(layout) {
    const dirs = workspaceDirectories(layout);
    const services = structuredClone(WORKSPACE_SERVICES);
    services.stored = workspaceStoredDefault(layout);
    services.git.root = `{WORKSPACE_ROOT}/${dirs.git}`;
    return services;
}

// How this server relates to a workspace directory. Index-only — never
// written into workspace.json (a transplanted dir must not carry the previous
// server's origin classification with it).
// - local: lives under the owner's Workspaces/ dir, discovered by scan
// - foreign-local: arbitrary absolute path on this machine, registered via API
// - remote: hosted by another canvas-server (host != canvas.local); entries
//   are representable but resolution is not implemented yet
const WORKSPACE_ORIGINS = {
    LOCAL: 'local',
    FOREIGN_LOCAL: 'foreign-local',
    REMOTE: 'remote',
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
    layout: WORKSPACE_DEFAULT_LAYOUT, // 'full' | 'home' — see WORKSPACE_LAYOUTS
    color: null,
    icon: null, // URL string
    homeScreen: {}, // Arbitrary JSON for UI defaults
    description: '',
    links: {}, // Portable, workspace-scoped linked resources (by type)
    acl: {
        tokens: {} // Token-based ACL: { "sha256:hash": { permissions: [], description: "", createdAt: "", expiresAt: null } }
    },
    roles: [], // Associated role IDs
    internals: { ...WORKSPACE_INTERNALS },
    services: { ...WORKSPACE_SERVICES }, // stored (storage) + feature toggles
    created: null,
    updated: null,
};

export {
    DEFAULT_SYNC_EXCLUSIONS,
    WORKSPACE_DEFAULT_HOST,
    WORKSPACE_CONFIG_FILENAME,
    WORKSPACE_INTERNAL_DIRNAME,
    WORKSPACE_INTERNAL_EXCLUSIONS,
    WORKSPACE_LAYOUTS,
    WORKSPACE_DEFAULT_LAYOUT,
    normalizeWorkspaceLayout,
    workspaceDirectories,
    workspaceInternals,
    workspaceStorageBackends,
    workspaceStoredDefault,
    workspaceServices,
    WORKSPACE_DIRECTORIES,
    WORKSPACE_DIRECTORIES_HOME,
    WORKSPACE_INTERNALS_HOME,
    WORKSPACE_GIT_BARE_DIR,
    WORKSPACE_ORIGINS,
    WORKSPACE_STATUS_CODES,
    WORKSPACE_INTERNALS,
    WORKSPACE_STORAGE_BACKENDS,
    WORKSPACE_STORED_DEFAULT,
    WORKSPACE_SERVICES,
    WORKSPACE_CONFIG_TEMPLATE,
};
