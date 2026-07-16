---
name: project-architecture-conventions
description: "Cross-cutting canvas-server architecture rules distilled from completed refactors (consumer-agnostic synapsd, lib/ injection, post-commit bitmap deferral, checksum identity)"
metadata:
  type: project
---

Rules distilled from completed work (the original journals were dropped 2026-07-16; git history has the details):

- **synapsd is consumer-agnostic** (user rule): no app policy and no consumer names (fastify/FUSE/web-ui/home-indexer) in its code OR comments. App policy (e.g. note title-from-H1) lives in the consumer.
- **Workspace sub-features go into `core/workspace/lib/` as injected-dependency classes** (WorkspaceStoredIndex, WorkspaceTokens pattern), not into Workspace.js - it stays an orchestrator. Long-term goal: workspace runtime self-contained/standalone.
- **Bitmap membership writes are deferred post-commit** (`#withDeferredMembership` in synapsd index.js): ticks buffer during the LMDB tx and flush only after commit, so rollback can't leave phantom ticks (was a silent-corruption bug, fixed 2026-06-24). Any new transaction callsite must use the same wrapper.
- **One doc per checksum**: `checksumArray[0]` is the primary identity; re-found blobs merge locations, never duplicate. sha256-only is the target (v3); all checksums in the array are indexed, which is what makes algorithm switches dedup-safe.
- **putMany in-place-mutation pitfall**: `existing.update(doc)` mutates and returns the SAME instance - any prev-state snapshot (checksums, features, facets, timelines) MUST be taken BEFORE calling it, or stale-key unticks silently no-op. Has bitten at least three times.
- **id-preserving updates**: putMany dedup is id-first (supplied id -> update in place), checksum fallback second. Doc ids are GC'd and reused (free-id pool) - never cache doc-id-keyed data without a content-addressed ETag (the stale-thumbnail lesson).
