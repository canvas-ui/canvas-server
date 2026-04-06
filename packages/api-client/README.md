# @canvas/api-client

Universal API client for [Canvas Server](../../README.md) — REST and WebSocket in one package.

Runs without modification in **Node 18+**, **Electron**, **browsers**, and **browser extensions**. No polyfills required. Uses the platform-native `fetch` API and lazy-loads `socket.io-client` only when a WebSocket connection is actually requested, so bundlers can tree-shake it out for consumers that never need real-time events.

---

## Contents

- [Installation](#installation)
- [Authentication](#authentication)
  - [Token auth](#token-auth-preferred-for-cli--automation)
  - [Password auth](#passwordcredential-auth-interactive)
  - [Auth strategies](#auth-strategies-local-ldap-imap)
  - [Minting a persistent token](#minting-a-persistent-api-token)
- [REST API](#rest-api)
  - [Workspaces](#workspaces)
  - [Contexts](#contexts)
  - [Agents & streaming](#agents--streaming)
  - [Admin](#admin)
- [WebSocket / real-time events](#websocket--real-time-events)
- [Error handling](#error-handling)
- [REST-only usage (browser extension)](#rest-only-usage-browser-extension)
- [Response shape](#response-shape)
- [Build target notes](#build-target-notes)

---

## Installation

Inside the monorepo the package is available as a workspace dependency:

```jsonc
// package.json of your CLI / Electron / extension package
{
  "dependencies": {
    "@canvas/api-client": "workspace:*"
  }
}
```

`socket.io-client` is listed as a regular dependency and will be installed automatically. If you are building a bundle where WebSocket support is not needed (e.g. a browser extension that only uses REST), your bundler will drop it via tree-shaking as long as you never call `client.socket.connect()`.

---

## Authentication

### Token auth (preferred for CLI / automation)

Pass a pre-existing API token directly. No network call is made at construction time.

```js
import CanvasClient from '@canvas/api-client';

const client = new CanvasClient({
  baseUrl: 'http://localhost:8001',
  token: 'canvas-a0ca1d5ce7da…',
});

// Ready immediately — all requests use this token
const { data: workspaces } = await client.workspaces.list();
```

You can also set or rotate the token at any point:

```js
client.setToken('canvas-newtoken…');
client.setToken(null); // unauthenticated
```

### Password/credential auth (interactive)

Use `authenticate()` as the single entry point for credential-based login.
It posts to `POST /auth/login`, receives a short-lived JWT, and stores it automatically.

```js
const client = new CanvasClient({ baseUrl: 'http://localhost:8001' });

await client.authenticate({ email: 'alice@example.com', password: 'secret' });

// Client is now authenticated — use it normally
const { data: me } = await client.auth.me();
```

`authenticate()` also accepts a token directly, so callers can use a single code path regardless of how the token was obtained:

```js
await client.authenticate({ token: storedToken });          // no network call
await client.authenticate({ email, password });             // POST /auth/login
await client.authenticate({ email, password, strategy });   // explicit backend
```

### Auth strategies (local, LDAP, IMAP)

The server supports four authentication backends. The client passes the strategy name through; the server handles all backend communication.

| Strategy | When to use |
|---|---|
| `'auto'` *(default)* | Server picks based on the user's stored `authMethod` and domain config. Safe default. |
| `'local'` | Password is stored in Canvas Server. |
| `'ldap'` | Delegated to the LDAP/Active Directory server configured on the server. |
| `'imap'` | Delegated to the IMAP server configured for the user's email domain. |

```js
// Explicit LDAP login
await client.authenticate({ email, password, strategy: 'ldap' });

// Pre-configure a default strategy for a deployment where only LDAP is available.
// Every subsequent authenticate({ email, password }) call uses LDAP without
// you having to pass strategy each time.
const client = new CanvasClient({
  baseUrl: 'https://canvas.corp.example',
  defaultStrategy: 'ldap',
});
await client.authenticate({ email, password });
```

To discover which strategies are enabled on a given server before presenting a login form:

```js
const { data: config } = await client.auth.config();
// config.strategies.ldap.enabled
// config.strategies.imap.enabled
// config.strategies.imap.domains  → ['corp.example', 'subsidiary.example']
// config.strategies.local.passwordPolicy
```

### Minting a persistent API token

JWTs returned by `/auth/login` are short-lived. For CLI tools and automation, exchange the JWT for a persistent API token immediately after login:

```js
await client.authenticate({ email, password });

const { data: apiToken } = await client.auth.tokens.create({
  name: 'canvas-cli on my-laptop',
  type: 'api',
});

// Store apiToken.token — it starts with "canvas-" and never expires by default.
// Use it as the token option in future CanvasClient constructors.
persistToken(apiToken.token);
```

---

## REST API

All resource methods return a promise that resolves to:

```js
{ data, count, totalCount, message }
```

`data` is the unwrapped payload from the server's response envelope. See [Response shape](#response-shape) for details.

### Workspaces

```js
// List / get
const { data: workspaces } = await client.workspaces.list();
const { data: ws }         = await client.workspaces.get(workspaceId);

// Create / update / delete
const { data: ws } = await client.workspaces.create({ name: 'research', label: 'Research' });
await client.workspaces.update(workspaceId, { label: 'Updated label' });
await client.workspaces.delete(workspaceId);

// Lifecycle
const { data: status } = await client.workspaces.getStatus(workspaceId);
await client.workspaces.start(workspaceId);
await client.workspaces.stop(workspaceId);

// Documents
const { data: docs } = await client.workspaces.documents.query(workspaceId, { filter: '...' });
await client.workspaces.documents.insert(workspaceId, [{ title: 'Note', body: '…' }]);
const { data: doc }  = await client.workspaces.documents.get(workspaceId, docId);
await client.workspaces.documents.delete(workspaceId, docId);

// Trees & bitmaps
const { data: trees } = await client.workspaces.trees.list(workspaceId);
const { data: bitmaps } = await client.workspaces.bitmaps.list(workspaceId);

// Services
await client.workspaces.services.enable(workspaceId, 'neurald');
await client.workspaces.services.disable(workspaceId, 'neurald');
const { data: cfg } = await client.workspaces.services.getConfig(workspaceId, 'neurald');
await client.workspaces.services.setConfig(workspaceId, 'neurald', { model: 'gpt-4o' });
```

### Contexts

Contexts represent a user's current position within a workspace tree, addressed by a `universe://` URL.

```js
// List / get / create
const { data: contexts } = await client.contexts.list();
const { data: ctx }      = await client.contexts.get(contextId);
const { data: ctx }      = await client.contexts.create({
  workspaceId,
  treeId,
  url: 'universe://music/concerts',
});

// Navigate to a different URL within the same context
await client.contexts.navigate(contextId, 'universe://music/concerts/2024');

// Documents at the current context URL
const { data: docs } = await client.contexts.documents.query(contextId);
await client.contexts.documents.insert(contextId, [{ title: 'Setlist' }]);
```

### Agents & streaming

```js
// Create an agent
const { data: agent } = await client.agents.create({
  provider: 'anthropic',
  model: 'claude-opus-4-6',
});

// One-shot chat (waits for full response)
const { data: reply } = await client.agents.chat(agentId, 'Summarise my recent notes');

// Streaming chat — async generator, yields SSE chunks as they arrive
for await (const chunk of client.agents.chatStream(agentId, 'Write a haiku')) {
  process.stdout.write(chunk.delta ?? '');
}

// MCP tools
const { data: tools } = await client.agents.mcp.tools(agentId);
const { data: result } = await client.agents.mcp.call(agentId, 'read_file', { path: '/etc/hosts' });
```

### Admin

```js
// Users
const { data: users }    = await client.admin.users.list();
const { data: user }     = await client.admin.users.create({ name, email, password });
await client.admin.users.update(userId, { status: 'disabled' });

// All workspaces (server-wide view)
const { data: allWs } = await client.admin.workspaces.list();

// Logs
const { data: logs } = await client.admin.logs.get({ level: 'error', limit: 100 });
```

---

## WebSocket / real-time events

The WebSocket client is lazy: `socket.io-client` is only imported when `connect()` is first called. If you never call it, the socket code is not included in your bundle.

```js
// Connect (resolves once the handshake completes)
await client.socket.connect();

// Subscribe to a channel
client.socket.subscribe(`workspace:${workspaceId}`);
client.socket.subscribe(`context:${contextId}`);

// Listen for events
client.socket.on('workspace.documents.inserted', ({ workspaceId, documents }) => {
  console.log('New docs:', documents.length);
});

client.socket.on('context.url.set', ({ contextId, url }) => {
  console.log('Context navigated to', url);
});

// Unsubscribe / disconnect
client.socket.unsubscribe(`workspace:${workspaceId}`);
client.socket.disconnect();
```

### Workspace events

| Event | Payload |
|---|---|
| `workspace.status.changed` | `{ workspaceId, status }` |
| `workspace.created` / `workspace.updated` / `workspace.deleted` | `{ workspace }` |
| `workspace.documents.inserted` / `workspace.documents.updated` | `{ workspaceId, documents }` |
| `workspace.documents.removed` / `workspace.documents.deleted` | `{ workspaceId, documentIds }` |
| `workspace.tree.path.inserted` / `workspace.tree.path.removed` | `{ workspaceId, path }` |

### Context events

| Event | Payload |
|---|---|
| `context.url.set` | `{ contextId, url }` |
| `context.updated` / `context.locked` / `context.unlocked` | `{ context }` |
| `document.inserted` / `document.removed` | `{ contextId, document }` |

### Agent events (real-time streaming alternative)

```js
client.socket.subscribeAgent(agentId);

client.socket.on('agent:chat:chunk', ({ agentId, delta }) => {
  process.stdout.write(delta);
});

client.socket.on('agent:chat:done', ({ agentId }) => {
  console.log('\n[done]');
});
```

---

## Error handling

All failures throw a `CanvasApiError`:

```js
import { CanvasApiError } from '@canvas/api-client';

try {
  await client.workspaces.get('nonexistent');
} catch (err) {
  if (err instanceof CanvasApiError) {
    console.error(err.statusCode); // HTTP status, e.g. 404
    console.error(err.message);    // server message
    console.error(err.body);       // raw response body, or null
  }
}
```

Network failures (no server, timeout) also throw `CanvasApiError` with `statusCode: 0`.

---

## REST-only usage (browser extension)

Import `HttpClient` directly if you only need REST and want to keep the bundle minimal. `SocketClient` and `socket.io-client` will be excluded by the bundler automatically.

```js
import { HttpClient, CanvasApiError } from '@canvas/api-client';

let token = loadStoredToken();

const http = new HttpClient({
  baseUrl: 'http://localhost:8001/rest/v2',
  getToken: () => token,
});

const { data: me } = await http.get('/auth/me');
```

---

## Response shape

The server wraps all responses in an envelope. The client unwraps it automatically:

```js
// Server sends:
// { status: 'success', statusCode: 200, message: '...', payload: [...], count: 5, totalCount: 42 }

// Client returns:
const { data, count, totalCount, message } = await client.workspaces.list();
//       ^^^^  data = payload
```

On error the server sends `status: 'error'` and the client throws `CanvasApiError` rather than returning.

---

## Build target notes

| Target | Notes |
|---|---|
| **Node 18+** | `fetch` and `AbortSignal.timeout` are built in. No polyfills needed. |
| **Electron** | Works out of the box in both main and renderer processes. |
| **Browser / web app** | Works in any modern browser. `fetch` is native. |
| **Browser extension** | Use `HttpClient` directly to avoid bundling `socket.io-client`. CSP on some extension hosts may restrict WebSocket connections — check your manifest. |

The package is ESM-only (`"type": "module"`). If you need CJS interop, use a bundler (Vite, esbuild, webpack) to produce a CommonJS output.
