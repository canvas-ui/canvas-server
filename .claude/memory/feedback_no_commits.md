---
name: feedback-no-commits
description: "NEVER commit or push in this project — user's scripts handle submodule commits"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c917c317-78d4-441e-ab0f-58e6e4adcbbb
---

Never `git commit` or `git push` in canvas-server or any of its submodules (src/ui/web etc.), even after completing work. Leave all changes as uncommitted working-tree modifications.

**Why:** The user has a set of scripts that manage submodule commits/refs ("Update submodule web" commits). On 2026-07-12 my direct commits to the web submodule's `main` were silently discarded when the user's script checked out the parent-recorded submodule ref (detached HEAD), reverting the working tree and appearing to "lose" finished work (recoverable via reflog, but confusing and dangerous).

**How to apply:** Finish edits, build/verify, then STOP — report what changed and let the user commit/push via their scripts. If work spans a session boundary, note the uncommitted state rather than committing.
