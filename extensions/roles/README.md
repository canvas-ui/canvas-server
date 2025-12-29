# Simplified Canvas Role Architecture

## 🎯 **Final Role Types**

The Canvas architecture now uses just two clean role types:

1. **Global Roles**: Server-wide containers (MinIO, WebDAV, etc.)
2. **Workspace Roles**: Workspace-scoped containers (including universe workspace)

**Key Insight**: Since all roles are tied to a workspace, the naming is now perfectly clear. If you want user-level functionality, simply create a workspace role in the universe workspace. This leaves the door open for potential "user" roles in the future without requiring refactoring.

## 🎯 **Directory Structure**

```
server/users/user.email/           # Clean user home directory
├── workspaces/                    # All workspaces contained here
│   ├── universe/                  # Special personal workspace  
│   │   ├── workspace.json         # Universe workspace config
│   │   ├── var/run/              # Unix sockets for workspace roles
│   │   ├── roles/                # Workspace role data storage
│   │   ├── db/                   # Database files
│   │   ├── config/               # Configuration files
│   │   └── home/                 # User files
│   ├── project-alpha/            # Regular workspace
│   │   ├── workspace.json        # Workspace configuration
│   │   ├── var/run/              # Unix sockets for workspace roles
│   │   ├── roles/                # Workspace role data storage
│   │   ├── db/                   # Workspace database
│   │   └── ...                   # Project files
│   └── another-project/          # Another workspace
│       ├── workspace.json
│       ├── var/run/
│       └── ...
└── [user files]                  # User home stays clean
```

## ✅ **Simplified Implementation**

### **1. Role Types (Final)**
- **Global Roles**: Server-wide containers with network access
- **Workspace Roles**: Workspace-scoped containers with Unix socket communication
- **Role Classes**: `GlobalRole` and `WorkspaceRole` (clean naming)

### **2. WorkspaceRole Class**
- Replaces both previous `UserRole` and `LocalRole` classes
- Always requires a `workspaceId` (including universe workspace)
- Consistent socket and volume handling for all workspace roles

### **3. Volume Mapping (Final)**
- **server:**: Server data paths (global roles only)
- **workspace:**: Workspace-relative paths (workspace roles only)
- **role:**: Role-specific data storage
- **socket:**: Unix socket directory

### **4. Role Creation (Final)**
```javascript
// Role types: 'global' | 'workspace'
const roleConfig = {
    type: 'workspace',    // Clean, descriptive naming
    workspaceId: 'uuid'   // Required for all workspace roles
};
```

## 🔧 **Usage Examples**

```javascript
// Create user and universe workspace
const userHomePath = 'server/users/john.doe@example.com';
const universeWorkspacePath = path.join(userHomePath, 'workspaces', 'universe');
const universe = await workspaceManager.createUniverseWorkspace(
    'user123', 
    'john.doe@example.com', 
    universeWorkspacePath
);

// Create regular workspace (in workspaces subdirectory)
const projectWorkspace = await workspaceManager.createWorkspace(
    'user123', 
    'project-alpha'
    // Automatically placed at: server/users/john.doe@example.com/workspaces/project-alpha/
);

// "User-level" role (workspace role in universe workspace)
const llmAgent = await roleManager.createRole('llm-agent', {
    name: 'personal-assistant',
    type: 'workspace',                // Clean naming
    workspaceId: universe.id          // Universe workspace ID
    // Socket: server/users/john.doe@example.com/workspaces/universe/var/run/role123-api.sock
    // Data: server/users/john.doe@example.com/workspaces/universe/roles/role123/
});

// Workspace role (workspace role in specific workspace)
const devEnv = await roleManager.createRole('dev-environment', {
    name: 'alpha-dev-env',
    type: 'workspace',                // Same type as above
    workspaceId: projectWorkspace.id  // Specific workspace ID
    // Socket: server/users/john.doe@example.com/workspaces/project-alpha/var/run/role456-api.sock
    // Data: server/users/john.doe@example.com/workspaces/project-alpha/roles/role456/
});

// Global role (server-wide)
const minioStorage = await roleManager.createRole('minio', {
    name: 'storage-server',
    type: 'global'                    // No workspaceId needed
    // Network access, no socket restrictions
});
```

The universe workspace now serves as the "personal workspace" where user-level roles live, making the architecture both cleaner and more intuitive.
