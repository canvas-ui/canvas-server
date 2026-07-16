---
name: feedback-version-bumps
description: Always bump the semver version of the component being worked on, scoped to the size of the change
metadata:
  type: feedback
---

Always bump the version number in the `package.json` (or Cargo.toml for canvas-fuse) of the component the session's work landed in - server root, synapsd, stored, embedd, web UI, browser extension, CLI, fuse - as part of finishing the work.

**Why:** user request (2026-07-16). The project follows semver; version bumps are how deploys and submodule pointer updates are tracked (e.g. server ping reports version, browser ext versions its releases).

**How to apply:** pick the bump by scope of the change - patch for fixes/internal cleanups, minor for new features/endpoints/UI capabilities, major for breaking API/schema changes. Bump only the component(s) actually touched, in the same working tree as the change (do NOT commit - see [[feedback-no-commits]]). If a change spans a submodule and the server (e.g. synapsd + routes), bump both.
