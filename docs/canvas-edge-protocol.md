# canvas-edge protocol (draft)

Status: v1 tunnel implemented 2026-07-28 (`src/edge/` + `src/transports/websocket/channels/edge.js`);
REST-layer routing to remote workspaces not yet wired.

Implementation notes vs. the sketch below:
- Frames are socket.io events (`edge:req`, `edge:res`, `edge:chunk`, `edge:end`,
  `edge:err`, `edge:abort`, `edge:event`, `edge:announce`/`edge:announced`)
  rather than `{t: …}` envelopes — same shapes, idiomatic transport.
- Pairing reuses `POST /rest/v2/auth/devices/register` verbatim
  (`EdgeClient.pair()`); no new endpoint was needed.
- Client: `src/edge/EdgeClient.js` (connect/announce/waitForAnnounce,
  inject-dispatch, forwardEvents, close). Server: `EdgeRegistry`
  (`src/edge/registry.js`, decorated as `fastify.edges`) assembles proxy
  responses; the channel handler relays `edge:event` through WorkspaceManager.

## What canvas-edge is

A small reusable module with two jobs:

1. **Local runtime** — serve the minimal Canvas API on localhost for whatever the
   binary hosts (a workspace, an agent, …).
2. **Tunnel client** — dial out to a canvas-server instance, auto-register, and
   keep an open channel over which the server proxies user requests back, so a
   remote workspace/agent behaves as if it were server-local.

The same module backs multiple binaries: `ws` (drop into a folder → indexed
workspace), `hi` / `canvas-agentd` (local agent + optional tauri/web UI, exports
an OpenAI-compatible endpoint). One code path: the tunnel replays requests into
the same local HTTP app the binary already serves on localhost.

The `ws` runtime's local API is a strict subset of the server's REST surface —
`/rest/v2/workspaces/*` (contexts are workspace-scoped, so this covers most
functionality). Subset means *same route handlers, smaller registration*, never
reimplemented routes.

## Design constraints

- **Proxy-first.** The server is the single public API surface; it forwards
  requests over the tunnel. Direct client→edge connection is a later
  optimization and must not change the registration model.
- **Outbound-only.** The edge never requires an open inbound port. NAT/firewall
  traversal comes for free.
- **Maximum reuse.** Transport is the existing socket.io layer
  (`src/transports/websocket/`) with one new `edge` channel; auth is the
  existing `canvas-*` device/API tokens; no new daemons, brokers, or native
  deps (must survive `bun build --compile`).

## Identity & registration

An edge instance **is a device**. Reuses `src/core/device` + device tokens.

First run (pairing):
1. User provides a canvas-server URL + their API token (flag, env var, or
   pairing URL). Edge generates a stable instance id (uuid, persisted).
2. Edge connects and emits `edge:register` authenticated with the user token,
   announcing itself (see below).
3. Server creates/updates a device record, issues a **device token** scoped to
   that user, returns it. Edge persists `{serverUrl, deviceToken, instanceId}`
   in its local state dir and never needs the user token again.

Subsequent runs: connect with the device token, emit `edge:announce`, done.
Revocation = deleting the device token server-side; the edge falls back to
local-only mode and keeps retrying pairing-required.

## Announce payload

```jsonc
{
  "instanceId": "uuid",
  "runtime": "ws | agentd | custom",
  "version": "x.y.z",
  "caps": ["proxy", "streaming"],
  "exports": [
    // what this edge hosts; server merges these into the user's tree
    { "type": "workspace", "id": "universe", "name": "…" },
    { "type": "agent", "id": "hi", "api": "openai-v1" }
  ]
}
```

The server registers each export in the corresponding registry (workspace
manager, agent manager) marked `remote: <instanceId>`, so existing listing/
routing code treats them uniformly with local ones.

## Proxying

All traffic is HTTP request/response frames over the `edge` channel. The server
resolves a request targeting a remote export, forwards it, and streams the
answer back to the original client.

```jsonc
// server → edge
{ "t": "req",  "id": "r1", "method": "GET", "path": "/rest/v2/…", "headers": {…}, "body?": "…" }
// edge → server (status+headers first, then zero or more chunks)
{ "t": "res",  "id": "r1", "status": 200, "headers": {…} }
{ "t": "chunk","id": "r1", "seq": 0, "data": "<base64|utf8>" }
{ "t": "end",  "id": "r1" }
{ "t": "err",  "id": "r1", "code": "…", "message": "…" }
// either side may cancel
{ "t": "abort","id": "r1" }
```

- Chunked frames make SSE (agent/LLM streaming) and media (play a song from a
  remote workspace) work without special cases; request bodies stream the same
  way when large (`t: "req"` with `stream: true`, then chunks).
- The edge handles a `req` by dispatching it into its own local fastify
  instance (`app.inject()` or equivalent) — the tunnel and localhost serve
  identical APIs by construction.
## Events (edge → server)

The reverse of proxying, and what makes remote workspaces indistinguishable to
webui/PWA clients. The edge attaches a wildcard listener to its local workspace
emitter and forwards over the tunnel:

```jsonc
{ "t": "event", "name": "workspace:document:inserted", "payload": { … } }
```

The server re-emits these through WorkspaceManager. Because the websocket
workspace channel already fans out *all* manager events per-socket with an ACL
check (`channels/workspace.js` wildcard listener), remote events reach every
connected client with zero client-side changes.

v1 forwards all events unconditionally (single-user workspace volume is
trivial). If an edge ever hosts something chatty, add `sub`/`unsub` control
frames so the server tells the edge which workspace ids have interested
clients — an optimization, not a protocol change.

Full websocket-over-tunnel (arbitrary bidirectional sockets) stays out of
scope for v1.

## Liveness & reconnect

- socket.io ping/pong is the heartbeat; no custom keepalive.
- On disconnect the server marks the edge's exports `unreachable` (kept in the
  tree, greyed out), fails in-flight `req`s with `err: EDGE_GONE`.
- Edge reconnects with exponential backoff + jitter, re-announces. Announce is
  idempotent — it is the full desired state, the server reconciles.

## Later (explicitly not v1)

- **Direct connect**: server hands the client the edge's advertised LAN URL +
  a short-lived token; client falls back to proxy transparently.
- Edge→edge channels, multi-server registration, binary msgpack framing.

## Module shape

`canvas-edge` exports:
- `EdgeClient({serverUrl, tokenStore, localApp, announce})` — tunnel client,
  reconnect loop, req→localApp dispatch. Used by ws/agentd runtimes.
- Server side: one socket.io channel handler (`transports/websocket/channels/edge.js`)
  + an `EdgeProxy` that the REST layer consults when a target is `remote:*`.
