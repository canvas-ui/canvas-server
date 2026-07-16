---
name: project-canvas-fuse
description: "canvas-fuse Rust FUSE client (own repo, submoduled src/ui/fuse) - durable design decisions + hard-won gotchas (condensed 2026-07-16)"
metadata:
  type: project
---

canvas-fuse (Rust, fuser) lives in its own repo, submoduled at `src/ui/fuse`. Context mounts (`mount -c <ctx>`) and workspace mounts (`-w <ws>`, trees as top-level dirs) both work, live-updating via socket.io. Condensed from the 2026-06 build journal; implementation details live in the fuse repo.

**Durable decisions:**
- `rm` in a context mount = DETACH (never destroy) - FUSE can't distinguish rm from shift+delete, doc survives in DB.
- Note title-from-H1 is CONSUMER policy (lives in canvas-fuse writes.rs), never in synapsd.
- synapsd updates PRESERVE the supplied doc id (putMany id-first dedup) - bitmaps key by id, identity churn would invalidate every layer tick. This was fixed server-side for fuse.
- Layout/state per docs/client-spec.md is the target; fuse still uses interim `~/.canvas/<remote>/fuse/...` paths (migration to `~/.canvas/remotes/<key>/state/...` pending).

**Gotchas (Rust/FUSE/transport):**
- canvas-server socket.io is websocket-only - rust_socketio must set `TransportType::Websocket`.
- rust_socketio auto-reconnect thread outlives disconnect() - daemon must `std::process::exit(0)` after unmount.
- parking_lot guard in if-let scrutinee (or a `lock().method()` in a for-loop iterator expr) self-deadlocks the single FUSE thread.
- POSIX rename: dst name must end up with SRC's ino or the kernel dentry points at a dead ino until TTL.
- Kernel (tested Linux 7.0): FUSE notify_delete emits NO IN_DELETE to parent-dir watchers (lost in ~5.3 refactor) - file-manager listings need a desktop-app nudge; new entries are never push-notified.
- fuser built default-features=false (fusermount3, no libfuse link) + `abi-7-31` for Notifier; static musl works; CI vendors OpenSSL (rust_socketio hardcodes native-tls).

**Pending:** real-Obsidian validation (only save-pattern simulation done); client-spec path alignment.

Related: [[project-client-spec]], [[project-storage-url-scheme]], [[project-layerindex-naming]]
