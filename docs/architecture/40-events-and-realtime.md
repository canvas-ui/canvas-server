# Events & realtime (WebSocket model)

## Event sources

- **Contexts** are the main event source for realtime UI updates.
- `ContextManager` is explicitly configured with EventEmitter2 wildcard support so transports can listen on `"**"`.

Entry points:

- Core: `src/core/context/index.js`, `src/core/context/lib/Context.js`
- Transport: `src/transports/websocket/*`, plus event relays in `src/transports/index.js`
- Discussion/notes: `docs/websocket-architecture-refactor.md`

## Model

- A `Context` emits domain events (dot-delimited, e.g. `context.created`, `context.url.set`).
- `ContextManager` forwards context instance events upward using wildcard forwarding, enriching payloads with `contextId`.
- The transport layer broadcasts selected events to socket.io clients (today: some events are manually bridged).

## Naming guidance (keep it boring)

- Prefer `scope.object.verb` (dot notation) for manager/context events.
- If/when you also emit colon-delimited events (legacy), pick one direction and standardize; mixed styles are how refactors go to die.

## Boundary rules

- **Core emits events**; **transport forwards** them.
- Don’t “rename” events per consumer in the WS layer. If you need aliasing, do it once and document it.

