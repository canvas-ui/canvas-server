We need to start refactoring our application as follows:

#1 Auth:
- Should auth be part of src/transports or src/core or a separate top-level dir or something else?
- We should support the following auth mechanisms (a more appropriate module may be needed)
  - local user.email + password,
  - access tokens a-la github
  - IMAP based auth (we should be able to auto-create users based on authenticating against a remote mail server)
  - LDAP
  - oauth2 to integrate with google and microsofts o365 accounts

- Special consideration for access tokens:
  - Users(user homes) should be movable between canvas-server instances same as agents and workspaces, hence, access tokens should be placed within users config/user.json or acl.json or access.json or tokens.json whatever would be more appropriate
  - Every resource the user creates(workspace, role, context, agent) should by default allow access using his auth token(question is whether to generate one per resource or use a global one, I'm more inclined to generate a per-resource token instead)
  - Therefore, when a user moves his home to a different instance, he should still be able to access workspaces define in his ./config/workspaces.json since he took his tokens with him
  - Auth module should therefore read out tokens for each initialized user from his home workspace

- All auth mechanisms should have a example configuration in ./server/config
- local user email + pass and tokens are default and can not be disabled

=> DONE

#2 Core Modules Architecture

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
```

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

Workspace
- Services
    - Home
    - Dotfiles
    - Storage?

- Services
    - Roles DI
    - Agents DI

- Managers

- Parameters
  - rootPath
  - configPath
  - config
  - id
  - name
  - label
  - icon
  - description
  - color
  - type
  - owner
  - acl - maybe we should rename it to permissions in the future (lets add a TOOD for now)

- Runtime
  - status
  - stats
  - size
  - lastAccessed

- Data/Services
  - db (this is a db and and index)
  - data (this should use a facade in front of stored, imap, chat and git modules)
  - tree (tree abstraction)
  - roles
  - agents
  // Not sure where and how to deal with those
  - dotfiles
  - home


