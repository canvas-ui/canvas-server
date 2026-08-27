# Team workspaces — sharing by e-mail and directory group

Canvas is single-user by construction: every account owns a private
`universe` workspace plus any number of ordinary workspaces, and contexts are
per user. Team workloads are layered on top of that with **workspace
members**: the owner of a workspace (the "team admin") shares it with
teammates by e-mail or by directory group, and the workspace then appears in
each teammate's workspace list on the same instance.

Nothing about the storage layout changes. A shared workspace keeps living
under its owner's home; only access resolution knows about members.

## Principals

`workspace.json` → `acl`:

```json
{
  "acl": {
    "tokens": { "sha256:…": { "permissions": ["read"], "expiresAt": null } },
    "users":  { "jane@corp.tld": { "permissions": ["read", "write"], "description": "", "grantedAt": "…", "grantedBy": "<ownerId>" } },
    "groups": { "cn=team-a,ou=groups,dc=corp,dc=tld": { "permissions": ["read"], "grantedAt": "…", "grantedBy": "<ownerId>" } }
  }
}
```

| Principal | Key | Matches |
|---|---|---|
| user | e-mail (lower-cased) | the account with that e-mail — **the account need not exist yet**; on an LDAP instance it is auto-created on first login and the share is already waiting |
| group | directory group, full DN or just the CN | any user whose `groups` contain that DN, or whose CN equals it (case-insensitive) |
| token | sha256 of a `canvas-workspace-*` token | the token bearer (unchanged) |

Permissions are `read` < `write` < `admin` (write implies read, admin implies
both). The owner always holds all three. When several group grants match, the
widest wins; an e-mail grant takes precedence over group grants.

The `universe` workspace can never be shared or transferred.

## Where groups come from

* **LDAP / AD** — `memberOf` (configurable per server as
  `strategies.ldap.servers.<name>.groupAttribute`) is read on every login
  and written to the user record (`user.groups`). Revoking someone in the
  directory takes effect at their next login.
* **Local accounts** — an admin sets `groups` with
  `PUT /rest/v2/admin/users/:userId { "groups": ["team-a"] }`.

`GET /rest/v2/auth/me` returns the caller's `groups`, so a user can see which
team shares apply to them.

## Team admin handover

Teams manage themselves: the owner of a team workspace grants and revokes
members. The instance admin only steps in when the team admin leaves:

```
PUT /rest/v2/admin/workspaces/:workspaceId/owner   { "owner": "<userId or e-mail>" }
```

Ownership, the index entry and the `user@host:name` reference move; the data
stays where it is; grants travel with the workspace.

## REST

```
GET    /rest/v2/workspaces/:id/members                   any member or owner
POST   /rest/v2/workspaces/:id/members                   owner   { "email": "…" | "group": "…", "permissions": ["read"], "description": "…" }
PUT    /rest/v2/workspaces/:id/members/:principal        owner   { "permissions": ["read","write"] }
DELETE /rest/v2/workspaces/:id/members/:principal        owner
```

`:principal` is `user:<email>` or `group:<name>` (URL-encoded).

Listings (`GET /rest/v2/workspaces`) mark shared entries with
`type: "shared"`, `isShared: true`, `ownerEmail` and
`sharedVia: { type: "user"|"group", principal, permissions }`.

## How access is enforced

`WorkspaceManager.resolveWorkspaceAccess(workspaceId, userId)` is the single
source of truth; everything else calls it:

* `getWorkspace(id, userId, { permission })` admits members (default
  permission `read`), so every route that resolves a workspace itself works
  for members;
* the workspace ACL middleware (`requireWorkspaceRead/Write/Admin`) resolves
  members for JWT **and** `canvas-*` user tokens — web UI, CLI and FUSE alike;
* a plugin-level preHandler on `/rest/v2/workspaces/:id/*` refuses unsafe
  methods for read-only members before the handler runs (search-style POSTs
  count as reads);
* WebDAV honours the same resolution (`PROPFIND`/`GET` for read, the rest
  needs `write`);
* `resolveWorkspaceId(userId, name)` falls back to shared workspaces, so a
  team workspace is addressable by name; a user's own name always wins, and
  a shared name never blocks creating their own workspace of that name.

Contexts stay user-centric. A teammate creates their own context on the
shared workspace; sharing a context itself still uses the existing
`/contexts/:id/shares` e-mail flow.

## Known limits (MVP)

* Context-level document operations run inside the context owner's context
  object, which holds the workspace instance directly — a read-only member's
  own context is not write-clamped at that layer. Use `read` shares for
  browsing, `write` for collaboration; a strict read-only guarantee is on the
  list.
* No organisation / team entities. Teams are directory groups (or admin-set
  groups on local accounts) — enough to let each team admin run their own
  workspaces without an instance admin in the loop.
* Share changes are picked up on the next listing; there is no push event to
  the sharee's UI yet (`workspace.member.granted/revoked` are emitted server
  side).
