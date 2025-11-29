We need to start refactoring our application as follows:

#1 Auth:
- We should support the following auth mechanisms (a more appropriate module may be needed)
  - local user.email + password,
  - access tokens a-la github
  - IMAP based auth (we should be able to auto-create users based on authenticating against a remote mail server)
  - LDAP
  - oauth2 to integrate with google and microsofts o365 accounts

- Special consideration for access tokens:
  - Users(user homes) should be movable between canvas-server instances, hence, access tokens should be placed within users home/config/user.json or acl.json or access.json or tokens.json whatever would be more appropriate
  - Every resource the user creates(workspace, role, context, agent) should by default allow access using his auth token(question is whether to generate one per resource or use a global one, I'm more inclined to generate a per-resource token instead)
  - Therefore, when a user moves his home to a different instance, he should still be able to access workspaces define in his ./config/workspaces.json since he took his tokens with him
  - Auth module should therefore read out tokens for each initialized user from his home workspace

- All auth mechanisms should have a example configuration in ./server/config
- local user email + pass and tokens are default and can not be disabled


#2 Core modules:
- User manager
  - Scope: Global
  - UserManager should register a user and create a home drive for him
  - Home drive path defaults to env.server.home/$user.email, we should require this parameter to be set by a higher-level module/Server.js, lets not do any guesswork / assumptions or use default paths in the core modules
  - The actuall home drive should be a special workspace of type Universe (type: universe, color: #fff, name: Universe, description: "..and then there was geometry" that immutable in terms of name and parameters
  - All user roles should be placed in the universe workspace in ./roles
  - All user workspaces should be placed in the universe workspace in ./workspaces
  - User config should be placed in ./config

- Context manager
  - Scope: User -> to move to src/core/user?
- Workspace manager
  - Scope: Global, User
- Role manager
  - Scope: Global, User, Workspace
- Agent manager
  - Scope: Global, User, Workspace
- Device manager (to assess)
  - Scope: User, Workspace

Workspace Local
- Services
    - Home
    - Dotfiles
    - Storage?

- Services
    - Roles DI from User
    - Agents DI from User

- Managers


Workspace
// Parameters
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

// Runtime
- status
- stats
- size
- lastAccessed

// Data/Services
- tree
- documents
- roles
- dotfiles
- home
- agents
