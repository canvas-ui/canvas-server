# Auth architecture (what we trust, where tokens live)

## Mechanisms

Canvas Server uses multiple authentication mechanisms:

- **JWT session**: primarily for the Web UI.
- **API tokens**: primarily for CLI, scripts, extensions, automation.
- **Device tokens**: integration-style auth (where applicable).
- **LDAP/IMAP**: optional login strategies (depending on config + deps).

Entry points:

- `src/transports/auth/service.js` (token/password management, config)
- `src/transports/auth/strategies.js` (Fastify verification functions)
- `src/transports/routes/auth.js` (REST endpoints)

## Token storage strategy (hybrid)

Goal: **portability without leaking server-only secrets**.

- **User-level tokens**: stored in `{user_home}/config/tokens.json`
  - portable with the user home directory
  - used for global access as that user
- **Resource-level tokens**: stored with the resource
  - example: workspace tokens live inside `workspace.json` under `acl.tokens`
  - portable with the workspace folder (good for sharing/moving)

See: `docs/AUTH_IMPLEMENTATION_SUMMARY.md`

## Boundary rules (aka “don’t ruin your future self”)

- **Routes verify auth, managers enforce ACL**.
- **Never put user-portable tokens into `{server_home}/db/`**.
- **Never export password hashes by accident** (`server/db/passwords.json` is intentionally server-only).

