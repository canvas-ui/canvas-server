---
name: project_synapsd_query_session
description: "synapsd QuerySession v1 exists but is DEAD CODE in the request path - staged infra for canvas-agentd, wired to no transport"
metadata:
  type: project
---

synapsd QuerySession v1 (`synapsd/src/session/QuerySession.js`, `openSession()` factory) is implemented and tested (8/8) but wired to NO transport, NO websocket channel, NO web client - do not chase session lifecycle for search bugs. It is staged infrastructure for canvas-agentd + the hierarchical vector tree.

Durable API facts it introduced (these ARE live):
- `resolveCandidates(spec)` returns `{bitmap, keys, collectionKeys, coarse}` - collectionKeys are real bitmap keys (collection vocabulary) for precise invalidation; `coarse=true` marks temporal/geo BSI operands with no stable key.
- `membership.changed` event fires post-commit, BEFORE document.inserted.
- `db.searchRefined(queries[], baseSpec, opts)` - stateless AND-narrowing text-query stack (the live refine feature; repeated `?q=` param, web chips).

Related: [[project_compound_query_design]], [[project_synapsd_search_ranking]]
