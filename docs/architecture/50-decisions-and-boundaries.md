# Decisions & boundaries (write **why**, not what)

This file is intentionally opinionated. If a decision doesn’t protect sanity, it’s not a decision, it’s a vibe.

## D1: Global managers, per-entity data

- **Why**: singletons avoid “N copies of the truth” (N docker clients, N indexes, N inconsistent caches).
- **Boundary**: Managers are the only place allowed to enforce ACL and lifecycle.

## D2: User homes are portable; server indexes are disposable-ish

- **Why**: makes migration and backups actually possible; supports “copy folder → user works”.
- **Boundary**:
  - user data lives in `{user_home}` / `{workspace}` / `{agent}`
  - server-only secrets/runtime state live in `{server_home}`

## D3: Universe workspace exists

- **Why**: every user needs a stable place for personal state; treating it as a workspace keeps the model uniform.
- **Boundary**: Universe is special in *meaning*, not in “special-case code everywhere”.

## D4: Hybrid token storage (user tokens + resource tokens)

- **Why**: portability + sharability without inventing a central ACL database that becomes everyone’s problem.
- **Boundary**: tokens “travel” with the thing they grant access to.

## D5: Realtime uses event forwarding, not “custom per-client protocols”

- **Why**: event relays scale linearly in code size; custom WS glue code scales quadratically with consumers.
- **Boundary**: core emits, transport forwards. Don’t bury business logic in WS handlers.

## Open questions / please confirm

Resolved (as of Dec 2025):

- **User identity is `user.id` (internal), email is for home paths (ops)**:
  - **Why**: we want stable internal identifiers, but also want user homes to be human-browsable (and mountable via SMB or similar) without UUID soup.
  - **Boundary**: only the “user home filesystem layout” uses email; everything else should use `user.id`.
- **We prefer names over IDs for UX/CLI**:
  - **Why**: humans can remember `user.name@remote:workspace` much more easily than UUID soup.
  - **Status**: this may evolve, but the direction is “human addresses first”.
- **`CANVAS_DISABLE_API` / `CANVAS_DISABLE_WEB` exist for Electron minimal mode**:
  - **Why**: embed a local server instance without exposing unnecessary surfaces.
- **Docs updated**:
  - stale `src/api/...` references were updated to `src/transports/...` where applicable.
