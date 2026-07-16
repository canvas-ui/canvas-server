# Context-switch test matrix

Goal: every integration bound to a context follows a context URL change seamlessly - fast, reliable, no stale data, no manual refresh. This is the de-facto core feature; it must survive rapid switching, workspace boundaries, reconnects and restarts.

## Targets (pass/fail thresholds)

| Metric | Target |
|---|---|
| Propagation latency (URL set -> client shows new path's data), LAN | < 1s |
| Propagation latency, remote/public instance | < 2s |
| Rapid switching (5 switches, 500ms apart) | all clients converge on the LAST url, no flicker-lock, no crash |
| Recovery after ws reconnect | client re-syncs within 5s without manual action |
| Wrong/stale data shown at any point | never (empty-while-loading is OK, old context's docs are NOT) |

## Drive the switch

```bash
# set url (the switch)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"universe://work/reports"}' http://127.0.0.1:8001/rest/v2/contexts/default/url

# read back
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8001/rest/v2/contexts/default/url
```

Event to watch on the socket: `context.url.set {id, url, previousUrl}` (channel `context:<id>`), followed by document events for the new scope. A raw socket.io sniffer (node socket.io-client, subscribe to the context channel, log timestamps) is the cheapest latency probe - run it beside the real clients.

## Matrix A - switch scenarios x integrations

Integrations: **webui** (context page, bound canvases), **browser ext** (bound mode), **canvas-fuse context mount** (Notes/ + Files/), **Obsidian** (vault on the fuse mount), **CLI** (`context get/set`).

For every cell record: latency (s), correct data (y/n), notes.

| # | Scenario | webui | ext | fuse | Obsidian | CLI |
|---|---|---|---|---|---|---|
| A1 | Path switch, same workspace (`ws://a/b` -> `ws://a/c`) | | | | | |
| A2 | Deep path switch (`ws://x` -> `ws://a/b/c/d`) | | | | | |
| A3 | Cross-WORKSPACE switch (`ws1://...` -> `ws2://...`) | | | | | |
| A4 | Switch to path that does not exist yet (should create? error? - document actual) | | | | | |
| A5 | Switch to a path whose leaf is a CANVAS (stored querySpec must fold into reads) | | | | | |
| A6 | Switch to context with stored filter binding (features/filters follow, e.g. t:crud:created:today) | | | | | |
| A7 | Switch back and forth A->B->A (caches must not serve B's data under A) | | | | | |
| A8 | Rapid: 5 switches 500ms apart (A->B->C->D->E) - converge on E | | | | | |
| A9 | Two clients switch the SAME context concurrently (last-write-wins; both converge) | | | | | |
| A10 | Switch while a document insert into the OLD path is in flight | | | | | |

## Matrix B - failure and lifecycle cases

| # | Scenario | Expected | Result |
|---|---|---|---|
| B1 | Switch to a workspace that is STOPPED | clean coded error (503/retryable or auto-start - document actual); client does NOT wedge; recovers when ws starts | |
| B2 | Target workspace starting up mid-switch (race) | eventual consistency, no duplicate trees, no error toast storm | |
| B3 | Server restart while clients bound | all clients resubscribe + resync (fuse: supervisor retry; ext: sync engine; webui: socket reconnect) | |
| B4 | Network blip (kill ws for 10s, restore) | resync within 5s, no zombie subscriptions to old context | |
| B5 | Token expiry mid-session (JWT) | clean re-auth path, no redirect loop, no silent dead binding | |
| B6 | Context DELETED while clients bound | clients surface it (not infinite spinner) | |
| B7 | Context locked / ACL: second user without access tries to follow | 403 coded, no data leak | |
| B8 | Switch during heavy ingest (embed queue busy, event storm) | switch latency still within target; no stale-fetch clobber (fetchSeq guard) | |
| B9 | Workspace-channel events for OWNER-authed sockets (regression: validateWorkspaceAccess owner bug) | owner receives events on workspace:<id> | |
| B10 | fuse: rm/edit in the OLD context right before switch | write lands in old context, view updates to new; no cross-write | |

## Matrix C - dotfiles (optional support)

| # | Scenario | Expected | Result |
|---|---|---|---|
| C1 | Context with dotfiles bound: switch IN | dotfiles activate (symlinks/checkout applied) | |
| C2 | Switch OUT | previous dotfiles deactivate/restore; no orphan symlinks | |
| C3 | Switch between two contexts with CONFLICTING dotfiles (same target path) | deterministic winner, no merged/corrupt state | |
| C4 | Dotfile activation failure (target dir missing/readonly) | switch still completes; dotfile error surfaced, not fatal | |
| C5 | dot init edge: target dir exists but not a valid bare repo | clean error (known past bug: silent "already initialized" no-op) | |

## Known-weak seams to watch (from past sessions)

- Workspace errors are NOT coded yet (context errors are) - "Access denied" may mask "not ready" on the workspace branch. B1/B2 will hit this.
- webui socket-driven refresh historically invalidated only the currently-viewed path's cache - watch A7/A10 for stale lists.
- Browser ext sync-engine needed tree-ref threading separately from api-client (v2.8.4 bug class) - watch A3/A5 in bound mode.
- fuse ws supervisor retries initial connect with backoff - B2/B3 should confirm it converges, not just eventually resyncs via the 30s loop.
- Rapid-switch: fuse serializes refresh vs write flushes behind a mutex - A8 + B10 is the stress for it.

## Log sheet

Date / build / server (local|public) / client versions. One row per cell failure with repro steps; wins go straight to the checkboxes above.
