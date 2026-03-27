# Workspace / Agent Runtime TODO


## API

```
/workspaces
    /:workspaceNameOrId
        /contexts/:contextId/documents
        /trees/:treeNameOrTreeId/
        /documents
        /agents
        /roles
        /services
```

## Goal

Move Workspaces, Agents and Role-like workers toward a common runtime model:

- `canvas-server` stays the control plane
- `workspace-runtime` becomes the per-workspace data plane
- `agent-runtime` becomes the per-agent data plane
- runtime may run as:
  - local process
  - Docker container
- same runtime contract in both modes

## Why

- isolate crashes, leaks and bad workers
- isolate mounts, secrets, network access and resources
- allow local download + run of a workspace
- unify Roles / Agents / Workspaces under one lifecycle model
- reduce in-process coupling inside `canvas-server`

## Non-goals

- do not Dockerize the current in-process architecture as-is
- do not leak reverse-proxy path prefixes into runtimes
- do not require Bun for everything if some runtimes need Node
- do not start with full workspace migration first

## Core decisions

- `canvas-server` owns:
  - auth
  - ACL
  - runtime lifecycle
  - discovery / routing
  - reverse proxy
  - event fan-in / fan-out
  - aggregate UI API
- runtime owns:
  - workspace/agent local state
  - storage access
  - background workers
  - service-specific logic
  - local API
- runtime API should be root-relative:
  - `/health`
  - `/info`
  - `/documents`
  - `/services/...`
  - `/events` or `/stream`
- external path prefixing belongs to proxy/control-plane, not runtime
- prefer HTTP over Unix sockets first
- only use TCP when remote / cross-host access is needed
- only use gRPC if plain HTTP becomes an actual bottleneck

## Runtime contract

- define runtime manifest
  - `id`
  - `type`
  - `version`
  - `apiVersion`
  - `capabilities`
  - `mounts`
  - `env`
  - `healthcheck`
  - `transport`
- define lifecycle contract
  - create
  - start
  - stop
  - restart
  - destroy
  - inspect
  - logs
- define health contract
  - liveness
  - readiness
  - degraded
  - error state
- define event envelope
  - `event`
  - `runtimeId`
  - `workspaceId` / `agentId`
  - `timestamp`
  - `payload`
  - `traceId`

## Launcher abstraction

- create one launcher interface
  - `process`
  - `docker`
  - future: `k8s` if ever needed
- launchers should handle:
  - env injection
  - mounts
  - sockets / ports
  - stdout/stderr capture
  - restart policy
  - cleanup

## Workspace runtime

- define `workspace-runtime`
  - per-workspace API
  - per-workspace workers/services
  - isolated process
  - optional isolated container
- mount workspace root into runtime
- expose workspace API over:
  - Unix socket locally
  - optionally HTTP port for dev/debug
- move these first:
  - IMAP ingestion
  - Graph ingestion
  - chat/background workers
- move these later:
  - core workspace DB API
  - hooks execution
  - full document/context operations

## Agent runtime

- define `agent-runtime`
  - local API
  - prompt/tool execution
  - model/provider connectors
  - streaming output channel
- support process mode and Docker mode
- expose control endpoints
  - run
  - stop
  - status
  - logs
  - stream/events
- make runtime framework-agnostic
  - wrapper around nanoclaw / zeroclaw / other
  - framework should sit behind our contract, not define it

## Transport / IPC

- default same-host transport:
  - HTTP over Unix socket
- support:
  - request/response
  - event stream
  - log stream
  - health checks
- evaluate later:
  - gRPC
  - raw IPC
  - message bus

## Security / isolation

- per-runtime mounts must be explicit
- per-runtime env must be explicit
- per-runtime secrets should be scoped, not inherited wholesale
- lock down network access per runtime where possible
- add CPU / memory / restart limits for Docker mode
- define trust model for local process mode vs container mode

## Events

- stop relying on implicit EventEmitter propagation across boundaries
- define explicit event contracts for:
  - `document.inserted`
  - `document.updated`
  - `document.deleted`
  - `service.status.changed`
  - `runtime.health.changed`
- support:
  - retries
  - dedupe/idempotency
  - trace IDs
  - schema versioning

## Local UX

- user should be able to:
  - download workspace
  - run local workspace runtime
  - talk to it via CLI + REST API
- local runtime should not need `canvas-server` for basic operation
- local runtime should optionally register behind `canvas-server` when connected

## Phased rollout

### Phase 1

- define runtime contract
- define launcher abstraction
- define proxy/routing model
- define event envelope

### Phase 2

- extract one worker first
- best candidate: IMAP service
- prove:
  - lifecycle
  - health
  - socket transport
  - logs
  - proxying
  - auth handoff

### Phase 3

- move agent runtime to the same model
- unify process/container launch
- add stream/control endpoints

### Phase 4

- move remaining workspace workers/services
- evaluate whether full workspace DB runtime split is worth it

### Phase 5

- optionally move full workspace core behind `workspace-runtime`
- only if the contract is stable and the payoff is real

## Open questions

- Bun vs Node per runtime: where does Bun actually help, and where does it just annoy native deps?
- should hooks stay in `canvas-server` or move into workspace-runtime?
- do we want one runtime per workspace, or workspace-runtime + separate worker runtimes?
- should events be pulled via stream or pushed via broker?
- how much of the current Workspace API should remain aggregate/proxied by `canvas-server`?
- do we want local runtimes to be first-class peers, or just offline/dev mode?
- when do we need remote cross-host runtime support?

## Sanity rules

- simple contract first
- process mode before clever orchestration
- sockets before gRPC
- one extracted service before full migration
- no hidden prefix hacks
- no magic runtime coupling via shared assumptions
