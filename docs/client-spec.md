# Canvas Client Spec — local on-device data layout

**Status:** draft v0.1 · **Applies to:** 
- canvas-cli
- canvas-fuse
- canvas-desktop
- canvas-shell

A single, shared description of how every Canvas client stores data on a device.
The goal is that all clients resolve the *same* paths for the *same* remote, so
they interoperate (shared remote registry, shared device identity) and never
collide (e.g. two clients opening one single-writer database).

This is the source of truth. Clients implement it; they do not invent their own
layout. A library cannot be shared across Node (cli), Rust (fuse, desktop) and
bash (shell), so the **spec** is the common denominator, with thin per-language
path resolvers (`canvas-paths` Rust crate for fuse+desktop, a node module for
cli, sourced functions for shell).

---

## 1. Root: `$CANVAS_USER_HOME`

All client state lives under one root, resolved in this order:

1. `$CANVAS_USER_HOME` if set (absolute path).
2. `~/.canvas`

The `USER` infix is load-bearing: the server pairs `CANVAS_USER_HOME` with
`CANVAS_SERVER_HOME` (`src/env.js`), and a bare `CANVAS_HOME` would be
ambiguous between the two on a host running both.

One root keeps the install cohesive — easy to back up, sync, or wipe — at the
cost of not following XDG base dirs. That is a deliberate trade (cf. `~/.docker`,
`~/.aws`). The one exception is ephemeral runtime sockets; see §6.

A `manifest.json` at the root records the layout version:

```json
{ "version": 1, "createdAt": "2026-06-13T10:00:00Z" }
```

Clients read `version` and refuse (or migrate) on mismatch. Bump on any
breaking layout change.

---

## 2. Lifecycle axes

Every path belongs to exactly one of four lifecycles. This is the rule that
prevents the "same entity in two places" problem:

| Axis     | Meaning                                              | Safe to delete? |
|----------|------------------------------------------------------|-----------------|
| `config` | Durable, small, may be hand-edited. Survives a wipe. | No              |
| `cache`  | Reconstructible from the server.                     | Yes, always     |
| `state`  | Device-authoritative, not re-fetchable, not config.  | Loses local data|
| `var`    | Ephemeral runtime: logs, sockets, pidfiles.          | Yes, when idle  |

`var` is a sibling of `cache`, never nested under it. "Device-local but not a
server mirror" (sticky-name databases, agent/role runtime working dirs) is
`state`, not `cache`.

---

## 3. Layout

```
$CANVAS_USER_HOME/
  manifest.json                    # { version }
  config/                          # durable, hand-editable
    remotes.json                   # remote registry — the join key (see §4, §5)
    device.json                    # this device's stable identity (see §4)
    clients/
      cli.json                     # { dotfilesDir: "dotfiles", hooksDir: "hooks" } — in-repo paths
      fuse.json
      desktop.json
      shell.json
  remotes/
    <remote-key>/                  # one dir per remote, key per §5
      cache/                       # reconstructible from this remote — wipeable
        workspaces/<wsid>/
          data/
          git/                       # workspace git clone (bare remote: /workspaces/:id/git)
            dotfiles/
            hooks/
          blobs/                   # content-addressed (cacache-compatible)
        contexts/<ctxid>/
      state/                       # device-authoritative, not re-fetchable
        contexts/<ctxid>/
          names.redb               # canvas-fuse sticky filename map
        agents/<id>/runtime/
        roles/<id>/runtime/
      index/                       # cached listings (derived, refreshable)
        workspaces.json
        contexts.json
        agents.json
        roles.json
  var/
    log/                           # <client>.log
    run/                           # pidfiles, mount registry, fallback sockets (§6)
```

Notes:

- **Everything that mirrors or belongs to a remote is under `remotes/<key>/`.**
  Workspaces, contexts, agents, roles all belong to a remote — there is no
  global tier for them. Within a remote, `cache/` vs `state/` separates "what
  the server says" from "what this device is doing."
- `index/` holds cross-entity listings for a remote (a client can list roles
  without walking dirs or hitting the network). It is cache, never config.
- Per-client config is namespaced under `config/clients/`. Anything shared
  across clients (`remotes.json`, `device.json`) sits directly in `config/`.

---

## 4. Shared files & ownership

Two files are read by all clients. Ownership must be explicit to avoid
clobbering:

| File                  | Readers      | Writer (authoritative)        |
|-----------------------|--------------|-------------------------------|
| `config/remotes.json` | all clients  | **canvas-cli** (or local daemon) |
| `config/device.json`  | all clients  | first client to register the device; thereafter read-only |
| `config/clients/*.json` | owning client | owning client only          |

Rules:

- A client that is **not** the authoritative writer of `remotes.json` MUST NOT
  rewrite it wholesale. If a non-cli client needs to add a remote, it does so
  via the cli or a future local daemon, or appends under an advisory file lock
  (`flock` on `remotes.json`). Concurrent wholesale writes are forbidden.
- `device.json` carries the device's stable local identity (a generated
  `deviceId` and friendly name). Per-remote **device tokens** are not here —
  they live in `remotes.json` under each remote's `device` block (a device is
  registered, and tokened, per remote).
- `remotes.json` is the existing canvas-cli format; this spec does not change
  it, only formalizes that its keys are the `<remote-key>` used in §5.

---

## 5. Remote key (canonicalization)

The directory name under `remotes/` MUST equal the key used in
`config/remotes.json`, so config → cache → state all join on the same string.

**Canonical key:** the `remotes.json` object key as authored by the user/cli,
e.g. `idnc_sk@canvas`, `admin@local`, `me@idnc.sk`.

**Filesystem sanitization** (applied identically by every client):

1. Take the remote key string.
2. Replace any character not in `[A-Za-z0-9._@-]` with `_`.
3. Trim leading/trailing `.` and `_`.
4. If the result is empty, use `default`.

The set keeps `@`, `.`, `-`, `_` (all valid in directory names on Linux/macOS)
so `idnc_sk@canvas` and `me@idnc.sk` survive unchanged.

**Deriving a key without `--remote`:** when a client is invoked with an explicit
`--server URL` and no named remote, derive the key from the URL host: strip the
scheme, take up to the first `/`, sanitize as above (`https://canvas.idnc.sk`
→ `canvas.idnc.sk`). A named remote always wins over a derived one.

---

## 6. Runtime sockets

Unix sockets (for a local daemon other clients dial) and pidfiles resolve in
this order:

1. `$XDG_RUNTIME_DIR/canvas/` if `$XDG_RUNTIME_DIR` is set (tmpfs, 0700,
   per-user, auto-cleaned on logout — the correct home for sockets).
2. `$CANVAS_USER_HOME/var/run/` otherwise.

When falling back to `var/run`, the creating client owns **stale socket
cleanup** (unlink on startup if no live listener), since this path is not
auto-cleaned. Sockets are `0600`/`0700`; never world-accessible.

Logs always go to `$CANVAS_USER_HOME/var/log/<client>.log` regardless of
`XDG_RUNTIME_DIR` (logs are not ephemeral runtime).

---

## 7. Concurrency

- **Single-writer databases** (e.g. canvas-fuse `names.redb`) live under a
  path unique enough that two normal invocations don't collide. Per the layout,
  a single-context fuse mount uses
  `remotes/<key>/state/contexts/<ctxid>/names.redb`, so mounting different
  contexts never shares a database. Mounting the *same* context twice
  concurrently is the one case that legitimately contends; that is expected and
  should surface a clear "already in use" error, not corruption.
- `remotes.json` writes: advisory `flock`, single authoritative writer (§4).

---

## 8. Examples

`canvas-fuse mount --remote idnc_sk@canvas -c mbag ~/Contexts/MBAG`:

- sticky-name db → `~/.canvas/remotes/idnc_sk@canvas/state/contexts/mbag/names.redb`
- log           → `~/.canvas/var/log/canvas-fuse.log`
- mount registry→ `~/.canvas/var/run/` (or `$XDG_RUNTIME_DIR/canvas/`)

`canvas-cli` listing roles for `admin@local`, offline:

- reads `~/.canvas/remotes/admin@local/index/roles.json`

All four clients sharing one remote read the identical
`~/.canvas/config/remotes.json`.

---

## 9. Reference implementation & rollout

- **canvas-fuse** is the first consumer: its per-mount data dir
  (`runtime::mount_data_dir`) implements §3/§5 and is the reference for the
  Rust path resolver.
- Extract a **`canvas-paths` Rust crate** from it, shared by canvas-fuse and
  canvas-desktop.
- canvas-cli gets a Node module implementing the same rules; canvas-shell a set
  of sourced bash functions.
- Migration: clients on `manifest.version < current` move legacy paths (e.g.
  the interim `~/.canvas/<remote>/fuse/contexts/<ctx>/`) into the v1 layout on
  first run, then write the new `manifest.json`.

---

## 10. Open questions

- Does a **local daemon** become the single writer for `remotes.json` and the
  socket owner, or stays cli? (Affects §4, §6.)
- `device.json` identity: one device id shared across remotes, or per-remote?
  (Leaning shared — one physical device — with per-remote tokens in
  `remotes.json`.)
- Should `cache/` carry its own TTL/eviction policy, or is wipe-only enough for
  MVP? (Blobs under `cache/.../blobs` can grow.)
