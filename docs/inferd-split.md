# Inference runs out of process

`canvas-inferd` is a **daemon**, not a library. canvas-server links no inference
code, has no model runtime in its dependency tree, and reaches inference over a
unix socket.

## Why

Inference is the only part of Canvas that drags native code — onnxruntime,
transformers.js — into a dependency tree, and it drags it badly:

- **Two ONNX versions cannot share one process.** fastembed builds against ORT
  1.21, transformers.js against 1.24; both load `libonnxruntime.so.1` as a
  process global. While inferd was linked into canvas-server, canvas-server had
  to pin ORT at its own root to arbitrate a conflict between two libraries it
  never called. inferd already spawned CLIP in a child process for the same
  reason — the process boundary existed, it was just in the wrong place.
- **A model worker crash was an API crash.** OOM or a native abort inside a
  vision model took the whole server with it.
- **A GPU download could fail the deploy.** onnxruntime-node's postinstall
  fetches CUDA binaries from a Microsoft CDN; on linux/x64 the 1.24 script asks
  for them unconditionally. A blocked egress path failed `npm ci` for the API
  server over a GPU library it never used.

None of those are canvas-server's business. They are all inference's business,
and they now live where inference lives.

## Shape

```
canvas-server                         canvas-inferd (own process)
  InferdClient  ── unix socket ──────  InferdDaemon
   · workspace adapters                 · Inferd (models, queue, router)
   · document bytes                     · ImageSummaryRun
   · vector storage (synapsd)           · ONNX / transformers.js / model cache
```

The socket carries a **symmetric** peer, not a request/response API, because the
work is genuinely two-way: the server enqueues a document, the daemon asks back
for its bytes, then hands vectors back for storage. The server owns the data;
the daemon owns the models; neither is a pure client of the other.

Wire format is length-prefixed JSON with tagged `Buffer` / `Float32Array`
(`rpc/codec.js`). Both sides implement it — canvas-server's copy under
`src/services/inferd/rpc-*.js` is deliberate duplication, because importing it
would put the whole native tree back.

## Installing it

canvas-server does **not** pull canvas-inferd. That is the point — a dependency
would put the native model tree back. It is installed and supervised separately:

```
sudo ./scripts/install-inferd-ubuntu.sh        # binary + cache + config + unit
sudo ./scripts/install-ubuntu.sh -i            # ...or as part of a server install
```

That script owns the whole inference side of a deployment: it installs the
binary globally (`github:canvas-ui/canvas-inferd#main`), creates the model cache
under `<root>/server/inferd/models`, writes a starter
`<root>/server/config/inferd.json` if there is none, and writes, enables and
starts `canvas-inferd.service`. Re-running it is safe; `--unit-only` refreshes
just the unit, `--force-unit` rewrites an existing one, and `--cuda` opts back
into onnxruntime-node's CUDA download (skipped by default, because on a CPU box
it is a slow download of something never loaded and on a box with blocked egress
it fails the install outright).

The config file is not optional even when empty: the unit passes `--config`, and
the daemon exits if that path is unreadable.

Settings resolve **flag > environment variable > `.env` > default**. The `.env`
is the same file `install-docker.sh` / `install-local.sh` write, read with the
same helper (`scripts/lib/install-common.sh`, which treats it as data and never
sources it), so an existing deployment is picked up instead of a second one
being invented beside it: `CANVAS_HOST_SERVER_HOME` decides where the config and
model cache land, `OLLAMA_HOST` seeds the starter config, `CANVAS_INFERD_ENABLED=false`
makes the script do nothing (`--enable` overrides it and writes the key back as
true), and `CANVAS_INFERD_SOCKET` / `_CACHE_DIR` / `_CONFIG` / `CANVAS_INFERD_BRANCH`
are honoured if present. `--env-file` points at another one, `--no-env` ignores it.

`scripts/install-ubuntu.sh` delegates to it — with `-i` for a full install,
otherwise only to refresh the unit when the binary is already on PATH, and it
skips with a note when it is not. `scripts/update-git.sh` restarts the unit when
present. None of those steps can fail the deploy: a box without inference is a
supported configuration.

pm2 or any other supervisor works equally well — the daemon is a plain process
with a socket, no orchestration assumptions.

## The socket

Unix domain socket only. Both packages resolve the default with the SAME rule
(`socket-path.js`, duplicated verbatim in each so neither depends on the other):

1. `CANVAS_INFERD_SOCKET` — explicit, wins on both sides
2. `$XDG_RUNTIME_DIR/canvas/inferd.sock` — per-user runtime dir (dev, desktop)
3. `/run/canvas/inferd.sock` — system service (`RuntimeDirectory=canvas`)

The rule is pure — no filesystem probing — because a rule that depends on what a
process can write resolves differently for two processes, and the pair then
silently never meets. Either side can be pointed elsewhere explicitly
(`--socket` on the daemon, `CANVAS_INFERD_SOCKET` for the server).

There is **no TCP listener**. A remote daemon has to be reached by forwarding
the socket (`ssh -L`, a sidecar, socat). Opening a port would need
authentication and transport security on a channel that currently carries raw
document bytes, and unix-socket file permissions do that job for free on one
host. Note this is rarely the thing you want anyway: pointing inference at a
remote GPU is already a *provider* setting (below), not a daemon move.

## Operating it

| | |
|---|---|
| Run | `canvas-inferd --socket /run/canvas/inferd.sock [--config inferd.json]` |
| Server points at it | `CANVAS_INFERD_SOCKET`, else the shared default above |
| Dev convenience | `CANVAS_INFERD_SPAWN=true` — the server starts the daemon itself |
| Deploy | its own systemd unit; `scripts/update-git.sh` restarts it if present |

### When the daemon is not there

| | |
|---|---|
| Server boot | succeeds, with a warning naming the socket |
| Documents | index normally; nothing embeds |
| Search | keyword/FTS works; dense search degrades |
| inferd API routes | `503` with `retryable: true`, not a 500 |
| Recovery | client retries with backoff and **re-registers every workspace**, so a daemon restart heals without restarting the server |

## One daemon per host, providers per workspace

The daemon is **server-wide**, not per-workspace: one process per host, with
workspaces registered into it. What is already per-workspace (and already
editable in the web UI, Workspace Settings → embedding) is the **provider** each
space uses — `onnx`/`clip`/`blip` for local models, or an `openai`-compatible
`baseUrl` for Ollama, vLLM or any remote GPU host. So "point this workspace at
that GPU box" is a supported, UI-driven setting today; it just targets a
provider endpoint rather than a different daemon.

Per-workspace *daemon* selection is not implemented and is a different feature —
it would only matter for isolating tenants onto separate model processes, not
for routing work to different hardware.

**Inference is optional and stays optional.** With no daemon reachable the
server boots normally, logs a warning, and runs store-only: dense search
degrades to FTS, nothing embeds. The client retries with backoff and
**re-registers every workspace** when the daemon returns, so a daemon restart
heals without restarting the server.

## What moved, and what did not

Moved to inferd — all of it model knowledge:
- the captioning run (loop, consecutive-failure limit, `workerDead` abort,
  progress state) — was ~140 lines inside `Workspace`
- config validation, redaction and endpoint (SSRF) checks, so the routes need no
  inferd import
- the ORT version pin, now inferd's own problem to solve in its own tree

Stayed in canvas-server — all of it data knowledge:
- `resolveEmbeddingInput` — reading a document's bytes and text
- `storeDocumentEmbeddings` — the sink vectors land in (synapsd/LanceDB)
- which documents are images, and where a caption is stored
- document events; the server is the event source, so enqueue-on-change is
  plumbing that has to live here. *Which* space and model a document routes to
  was already inferd's router and stayed there.
