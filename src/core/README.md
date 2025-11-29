# Canvas Server Core modules

## Guiding Principles

- "Managers are singletons, Resources are multi-tenant"
- One global manager per resource type (User, Workspace, Context, Role, Agent)
- ACL enforcement happens at manager level
- Data isolation happens at storage level
- User homes are portable, server indexes are ephemeral

## Manager Scoping

### User Manager

- **Scope:** Global Singleton (Server-level)
- **Responsibility:** Manage all users and their home directories
- **Initialization:** Server.js passes env.user.home (no defaults in core modules)
- **User Home Structure:**
  - Home is a special "Universe" workspace (type: universe, immutable name/description,type)
  - Description: "..and then there was geometry"
  - Color: #ffffff
  - Structure:
    - ./config/         - User configuration (tokens, contexts, workspace refs)
    - ./agents/         - All user agents
    - ./workspaces/     - All user workspaces
    - ./roles/          - User-level role configurations (optional)

### Workspace Manager

- **Scope:** Global Singleton (Server-level)
- **Responsibility:** Manage all workspaces for all users
- **Initialization:** Server.js
- **Features:**
  - Creates user Universe workspaces
  - Manages workspace sharing across users
  - Single source of truth for all workspaces
  - Supports workspace portability (export/import)

### Context Manager

- **Scope:** Global Singleton (Server-level)
- **Responsibility:** Manage user-global contexts that span workspaces
- **Context Behavior:**
  - User-scoped but cross-workspace
  - Apps bind to contexts and follow focus changes
  - Example: universe://work/customer-foo → customer-bar switches context
- **Storage:**
  - Index: server/db/contexts.json
  - User data: {user_home}/config/contexts.json
- **ACL:** Contexts inherit user-level ACL

### Role Manager

- **Scope:** Global Singleton (Server-level)
- **Responsibility:** Manage Docker-based roles for all users
- **Docker Strategy:**
  - Single Docker runtime connection per server
  - Multi-tenancy via container isolation
  - Future: Support VM with Docker per user (advanced deployments)
- **Storage:**
  - Index: server/db/roles.json (runtime state)
  - Config: {workspace}/roles/ (per-workspace role configs)

### Agent Manager

- **Scope:** Global Singleton (Server-level)
- **Responsibility:** Manage autonomous agents for all users
- **Features:**
  - Agents have own authentication (tokens, workspace access)
  - Agents are accessed like workspaces (ACL checks)
  - Agents can access external services and user workspaces
- **Storage:**
  - Index: server/db/agents.json (global index)
  - Data: {user_home}/agents/{agent-name}/ (per-user, portable)
  - Natural path prefixing via user email (no UUID conflicts)

### Device Manager

- **Status:** DESCOPED (to be assessed in future)

## Storage Strategy

### Server-Level (Ephemeral Indexes)
```
server/db/
├── users.json         - User index (rebuilt from user homes)
├── workspaces.json    - Workspace index (rebuilt from user homes)
├── contexts.json      - Context index (rebuilt from user configs)
├── roles.json         - Role runtime state (not portable)
├── agents.json        - Agent index (rebuilt from user homes)
├── passwords.json     - Password hashes (security: never export)
└── rateLimits.json    - Rate limit state (ephemeral)

### User-Level (Portable)
```
{user_home}/                         # e.g., server/users/user@example.com/
├── config/
│   ├── agents.json                 ✅ User's agent references
│   ├── tokens.json                 ✅ User's global API tokens
│   ├── contexts.json               ✅ User's context definitions
│   └── workspaces.json             ✅ User's workspace references
├── workspaces/
│   ├── universe/                   ✅ User's home workspace
│   │   ├── config/workspace.json
│   │   ├── db/                     (synapsd data)
│   │   ├── home/                   (user files)
│   │   └── roles/                  (user-level roles)
│   └── {workspace-name}/           ✅ User's other workspaces
│       ├── config/
│       │   └── workspace.json      (includes acl.tokens)
│       ├── db/                     (workspace data)
│       ├── home/                   (workspace files)
│       └── roles/                  (workspace roles)
└── agents/
    └── {agent-name}/               ✅ User's agents (portable)
        ├── config/
        │   └── agent.json          (includes agent tokens, ACL)
        ├── data/                   (agent data)
        └── runtime/                (agent runtime state)
```

## Design Patterns

### Pattern 1: Global Manager, Per-Entity Data
```javascript
// Global manager instance
const workspace = await workspaceManager.get(workspaceId);

// Data stored per-entity in their own directories
workspace.config        // → workspace/config/workspace.json
workspace.acl.tokens    // → same file, acl.tokens property
```

### Pattern 2: Scoped Queries via Manager
```javascript
// Global manager, user-scoped queries
const userWorkspaces = await workspaceManager.listByOwner(userId);
const userContexts = await contextManager.listByUser(userId);
const userRoles = await roleManager.listByOwner(userId);
const userAgents = await agentManager.listByOwner(userId);
```

### Pattern 3: ACL Enforcement at Manager Level
```javascript
// Manager methods enforce access control
await roleManager.start(roleId, requestingUserId);           // checks ownership
await workspaceManager.delete(workspaceId, requestingUserId); // checks ACL
await agentManager.access(agentId, requestingUserId);        // checks permissions
```

## User Portability (Export/Import)

### What Travels (User Home Export)

```bash
# Export user home = complete portable package
tar -czf user-export.tar.gz server/users/user@example.com/

# Includes:
✅ All workspaces (including Universe)
✅ All agents
✅ All workspace tokens (acl.tokens in workspace.json)
✅ All agent tokens (acl.tokens in agent.json)
✅ All user tokens (config/tokens.json)
✅ All contexts (config/contexts.json)
✅ All workspace data (db/)
✅ All agent data
✅ All user files (home/)
✅ All role configs (roles/)
```

### What Stays on Server (Not Portable)

```
❌ Password hashes (server/db/passwords.json) - security best practice
❌ Active Docker containers - restart on new server
❌ Server indexes - rebuilt automatically on import
❌ Rate limits - ephemeral data
❌ Runtime state - regenerated
```

### Migration Flow

```
LAB Server → Export → PROD Server

1. Export:  tar -czf user.tar.gz {user_home}/
2. Transfer: scp user.tar.gz prod-server:/tmp/
3. Import:  tar -xzf user.tar.gz -C {prod_server_user_home}/
4. Scan:    Server auto-discovers on startup OR POST /admin/users/import
5. Auth:
   - LDAP/IMAP users: Re-authenticate (auto-links to existing home)
   - Local users: Password reset required
   - Token users: Work immediately (tokens traveled with home)
```

### Re-indexing on Import

```javascript
// Server rebuilds ephemeral indexes from portable data
UserManager.scan()        // → Rebuilds server/db/users.json from user homes
WorkspaceManager.scan()   // → Rebuilds server/db/workspaces.json from user/workspaces/
ContextManager.scan()     // → Rebuilds server/db/contexts.json from user/config/contexts.json
AgentManager.scan()       // → Rebuilds server/db/agents.json from user/agents/
```

## Anti-Patterns (What NOT to Do)

### ❌ Per-User Manager Instances

```javascript
// DON'T DO THIS!
user.workspaceManager = new WorkspaceManager(...);
user.contextManager = new ContextManager(...);
user.roleManager = new RoleManager(...);

// Problems:
// - Multiple Docker clients = resource waste
// - Multiple indexes = data inconsistency
// - Cross-user operations = nightmare
// - Violates single source of truth
```

### ❌ Mixing Portable and Server-Specific Data

```javascript
// DON'T store user data in server-level files
server/db/user-{id}-tokens.json  // ❌ Should be in user home

// DO use proper separation
{user_home}/config/tokens.json   // ✅ Travels with user
server/db/passwords.json          // ✅ Server-specific (security)
```

### ❌ Hardcoded Paths in Core Modules

```javascript
// DON'T assume paths
const userHome = '/var/canvas/users/';  // ❌

// DO accept from higher level
constructor({ rootPath }) {             // ✅
  this.rootPath = rootPath;
}
```
