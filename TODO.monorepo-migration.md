# Monorepo migration

Consolidate ten repositories into five, extract the shared client packages that
do not exist yet, and move the licence boundary from "everything AGPL" to
"permissive integrations, closed core".

Status: **in progress**. Slice 1 executed 2026-08-08 — Phase 1 (pnpm scaffold),
Phase 2 (all three shared packages), and the cli folded in early as the Phase 3
pilot (subtree, history intact, repointed onto the shared api-client, binary
verified under Bun). Slice 2 executed 2026-08-09 — shell, desktop and
browser-extension folded in and building; Phase 3 now lacks only the web
fold and the per-client repoints. Decisions locked: pnpm 10 for the monorepo (server stays
npm), changesets, canvas-electron dropped, monorepo repo stays public,
packages stay AGPL until Phase 6.

**Naming (decided 2026-08-08): the product brands as Canvas OS; the npm scope
is `@augmentd-labs`** — superseding the earlier `@canvas-os` npm plan from the
same day. The `augmentd-labs` npm org + GitHub org exist (created 2026-08-08,
Augmentd s.r.o.'s Labs umbrella for all experimental packages); everything
publishes under that one scope, so the "claim `canvas-os` on npm" action is
dropped. Since scope = package-name prefix, the Slice 1 packages named
`@canvas-os/*` need a rename sweep to `@augmentd-labs/canvas-*` (still free — nothing
is published; manifests + cli imports + the `file:`/tarball references in this
doc). Product/branding remains Canvas OS; only the npm namespace is Labs.

- [x] Rename sweep `@canvas-os/*` → `@augmentd-labs/canvas-*` across monorepo
      manifests and imports (2026-08-08: 31 files + lockfile; tests green,
      cli smoke OK; no `@canvas-os` npm org was ever created)

GitHub org stays `canvas-ui` for now; if it is renamed
later (os-canvas or similar), immediately re-register `canvas-ui` as a
placeholder org — org redirects die the moment someone claims the old login,
and every `.gitmodules`/remote/`repository` field still says canvas-ui.

Noticed during Slice 1 (pre-existing, not fixed here):

- The cli resolves its home dir from `CANVAS_USER_HOME` (`src/core/paths.js:15`)
  while `docs/client-spec.md` §1 specifies `$CANVAS_HOME`. One of them is wrong.
- `embedd` imports `onnxruntime-node` (`src/providers/onnx.worker.js:27`)
  without declaring it — it rides the server root's dependency. Must be added
  to embedd's manifest at Phase 4 extraction or the package breaks standalone.

---

## Why

- **`api-client` does not exist.** It is declared as an npm workspace in the
  root manifest but there is no such directory. Meanwhile the REST surface is
  reimplemented in every client — measured in lines it is worse than the file
  counts suggested: cli 289 (one file), extension 888, desktop 144, and web
  ~5,200 across 16 files with ~164 scattered `.payload` unwrap sites. Schema
  handling is duplicated the same way (41 files in web, 17 in cli, 8 in the
  extension). A shared package cannot exist across ten repositories without
  publishing to npm first, which is why it never got built.
  *(Slice 1: `@canvas-os/api-client` now exists in the monorepo; cli consumes it.)*
- **Cross-package changes are not atomic.** A change to the API contract touches
  the server and four clients, in five repositories, with no single commit and
  no single CI run that proves the set is consistent.
- **The licence split needs a home.** Permissive integrations and a closed core
  are two different publishing pipelines. Deciding that per repository across
  ten repositories is how closed code eventually ends up in a public artifact.

npm workspaces are already declared in the root manifest, so half of this is
already the intended shape; the submodules are the half fighting it.

---

## Target topology

```
canvas                  Apache-2.0    monorepo (public — decided Slice 1)
  apps/
    web                               ← canvas-web
    cli                               ← canvas-cli (bun for build/compile)
    desktop                           ← canvas-desktop (tauri)
    browser-extension                 ← canvas-browser-extensions
    shell                             ← canvas-shell
  packages/
    protocol                          ← wire contracts + transport adapters, new
    api-client                        ← ergonomic client over protocol, new
    schemas                           ← extracted, new
    plugin-api                        ← integration/adapter interfaces, new
    embedd                            ← src/services/embedd
    messaging                         ← src/services/messaging
    voice                             ← src/services/voice

canvas-stored           Apache-2.0    standalone, ad-hoc reuse
canvas-fuse             Apache-2.0    standalone (Rust — no npm workspace fit)
canvas-synapsd          closed        standalone, ad-hoc reuse
canvas-server           closed        src/{core,transports,utils} · agentd · edge
```

Ten repositories become five. SynapsD and StoreD stay standalone deliberately:
a package you drop into a throwaway experiment should not drag a monorepo behind
it.

Keep `edge` structurally separable inside `canvas-server` — a slim open runtime
may be spun out later, and that is far easier if it never grows tendrils into the
rest of the server.

### Why `protocol` and `api-client` are separate

`protocol` is the wire: contracts plus the websocket/gRPC/ipc adapters.
`api-client` is the ergonomic layer built on top of it. Splitting them matters
because fuse, shell and the browser extension may want the wire without the full
client, and because the **closed server needs the contract but not the client**.

That last point is the one that makes the licence split work: the contract lives
in an Apache-2.0 package, and `canvas-server` imports it. Permissive code flowing
into closed code is exactly the arrangement Apache-2.0 permits, which is why the
contract must not live in the closed repository.

**Naming hazard.** `packages/protocol` and `canvas-server/src/transports` will
both plausibly be called "transports". Keep the distinction deliberate:
`packages/protocol` is the shared *contract* and its client-side adapters;
`src/transports` is the server's fastify/socket.io *implementation* of that
contract. Two things named transports meaning different things is a bill that
comes due later.

### `src/services` stops existing

That folder currently holds neurald, stored and synapsd, and they land on three
different sides of the line:

    synapsd   → closed, standalone repository
    stored    → Apache-2.0, standalone repository
    neurald   → agentd, closed, stays inside canvas-server

They become dependencies rather than subdirectories, which leaves
`canvas-server` with five cross-repository dependencies: `canvas-synapsd`,
`canvas-stored`, `@augmentd-labs/canvas-embedd`, `@augmentd-labs/canvas-messaging` and `@augmentd-labs/canvas-voice`. See
[Tooling and distribution](#tooling-and-distribution) — the two standalone repos
can be git dependencies, the three monorepo packages cannot.

### Two things deliberately absent

**No `packages/utils`.** Generic utility packages become dumping grounds, and
there would be two of them: this one plus `canvas-server/src/utils` (log,
documentId, id, jim, list-order, backend-documents, device-features). Helpers
then drift between them with no canonical home. Create narrow, named packages if
something genuinely needs sharing, and leave server-only helpers where they are.

**No `mobile` or `electron` directories** until they contain code. Electron is
already expected not to survive and mobile does not exist. Empty scaffolding
rots and misleads about what the project actually is.

---

## Licensing: amendments required

The current state on `dev` (v2.3.0) describes a **different model** to the target:
every component AGPL, with `canvas-server` / `synapsd` / `stored` / `neurald` /
`canvas-web` additionally dual-licensed, and the remaining clients AGPL-only
forever. That model is superseded. Every item below is a delta from what is
currently committed.

### Why the change

AGPL is copyleft: anything that links it must itself be AGPL. A closed
`canvas-server` importing AGPL `stored` and `embedd` would be a copyleft
violation but for the fact that a single author holds the copyright and cannot
infringe himself. That works today and breaks the first time an outside
contributor lands a commit in an AGPL package the closed core consumes — at
which point the fix is reverting their work.

Apache-2.0 on the open layer removes the problem at the root rather than
managing it in perpetuity.

### Licence assignments

| Component | Now | Target | Note |
|---|---|---|---|
| `canvas-web` | AGPL [dual] | **Apache-2.0** | moves from engine to open client |
| `canvas-cli` | AGPL only | **Apache-2.0** | |
| `canvas-desktop` | AGPL only | **Apache-2.0** | |
| `canvas-browser-extensions` | AGPL only | **Apache-2.0** | |
| `canvas-shell` | AGPL only | **Apache-2.0** | |
| `canvas-fuse` | AGPL only | **Apache-2.0** | |
| `canvas-stored` | AGPL [dual] | **Apache-2.0** | thin wrapper, nothing to protect |
| `embedd` | AGPL [dual], in-tree | **Apache-2.0** | extract from `canvas-server` |
| `messaging` | AGPL [dual], in-tree | **Apache-2.0** | extract from `canvas-server` |
| `voice` | AGPL [dual], in-tree | **Apache-2.0** | extract from `canvas-server` |
| `protocol` / `api-client` / `schemas` | — | **Apache-2.0** | new |
| `plugin-api` | — | **Apache-2.0** | new |
| `canvas-server` | AGPL [dual] | **closed** | |
| `canvas-synapsd` | AGPL [dual] | **closed** | |
| `canvas-neurald` → `agentd` | AGPL [dual] | **closed** | |
| `src/core/agent`, runtimes, `edge` | AGPL [dual], in-tree | **closed** | stays in `canvas-server` |

**Apache-2.0, not MIT.** Same permissions, plus an express patent grant with
retaliation and a NOTICE-preservation requirement that keeps attribution
downstream. MIT is silent on patents; for a protocol and data model designed
here and possibly commercialised later, that silence is not free.

### Document amendments

- [ ] **`CLA.md` — retire it.** Under Apache-2.0 an inbound contribution already
      arrives on terms permitting use in a closed product, so no separate grant
      is needed. The closed repositories take no outside contributions at all.
      The CLA solved a problem that existed only because the open layer was
      copyleft. Replace with a **DCO** (`git commit -s`), which is a one-line
      sign-off and no barrier to a drive-by fix.
- [ ] **`CONTRIBUTING.md` — rewrite.** The current text is built around
      "why a CLA and not just a DCO" and a dual-licensed/AGPL-only repository
      split that will no longer exist. Replace with: DCO, which repositories are
      open, and where to file.
- [ ] **`COMMERCIAL.md` — reframe.** It currently offers an *exemption* from
      copyleft on a dual-licensed engine. After the change the core is closed, so
      a commercial licence is not an alternative route to the same code — it is
      the only route. Rewrite as a licence-to-the-closed-core document. Delete
      the "no cut-down community edition" framing; it stops being true.
- [ ] **`NOTICE` — rewrite per repository.** The `[dual]` / `[AGPL]` component
      table no longer describes reality. Open repositories get an Apache-2.0
      NOTICE; the closed repositories get a proprietary notice.
- [ ] **`LICENSE` — replace per repository.** Apache-2.0 text in the open
      repositories; a proprietary licence in `canvas-server` and
      `canvas-synapsd`.
- [ ] **AGPL §13 machinery in `canvas-server` — restate, do not delete.** The
      `X-Source-Code` header and the `sourceUrl` / `commit` / `license` fields on
      `/rest/v2/ping` were built to satisfy §13. A closed server has no §13
      obligation, so the legal framing in the code comments, `NOTICE`,
      `README.md`, `.env.example` and `CONTRIBUTING.md` becomes wrong and must
      go. Keep the mechanism — it is still the only way to identify which build
      is running, which matters more for support and for MBAG than it ever did
      for compliance. Retarget the comments at build identity.
- [ ] **`README.md` — update the Licence section** in every repository.
- [ ] **`TODO.lic.md` — reconcile.** It is no longer present on `dev`; its open
      items (SynapsD missing a LICENSE file, neurald's ISC/AGPL contradiction,
      missing manifest fields in fuse/web/desktop) are still real and are folded
      into this document's phases.

### Consents and irreversibility

- [x] **Levan Tarbor's contributions** (canvas-web, canvas-browser-extensions) —
      paid Upwork work commissioned by Augmentd s.r.o. Treated as resolved. Keep
      the Upwork contract on file: it is now the documentary basis for
      relicensing those two codebases.
- [ ] **AGPL → Apache-2.0 is one-way.** Once the clients are permissive anyone
      may fork them permissively forever, including parties currently out of
      compliance. For integration code this is the correct trade — client
      adoption pulls the server along — but it cannot be walked back.
- [ ] **Closing previously-AGPL code is also one-way in the other direction.**
      Every published AGPL commit stays AGPL. `canvas-server` and `canvas-synapsd`
      keep a permanent public fork point at their last AGPL release (v2.3.0 is
      tagged). Closing protects future divergence only; it retrieves nothing.
      The mitigation is simply that the fork point goes stale immediately.

### MBAG — do this before closing anything

Contractor-contributed code defaults to MBAG ownership, with an exception for
open source. **That exception is currently what makes Canvas yours.** The moment
`canvas-server`, `synapsd` and `agentd` become closed, the carve-out stops
covering them, and MBAG's default rule can reach precisely the components being
closed to protect them.

Ordering matters, and the in-source licence is not first:

1. [ ] **Written pre-existing-IP carve-out from MBAG** — a side letter or
       amendment recording that Canvas is pre-existing IP owned by Jozef Melich
       / Augmentd s.r.o., licensed to MBAG, and not work product under the
       contractor agreement. Routine to ask for; much harder to obtain after
       deployment.
2. [ ] **Document provenance** — repository creation dates, commit history, the
       public GitHub record predating the engagement. This is the evidence that
       Canvas is pre-existing rather than developed on their time.
3. [ ] **Then** the in-source deployment licence covering MBAG's use of the
       closed core with source access. Straightforward once ownership is settled.

Negotiate while it is still undeployed. That is the strongest position available
— something they want, and no fait accompli to unwind.

### Counsel review

- [ ] Proprietary licence text for the closed core
- [ ] The MBAG carve-out and the in-source deployment licence
- [ ] Rewritten `COMMERCIAL.md` terms
- [ ] How the Melich → Augmentd s.r.o. exclusive licence is papered

---

## Boundary artifacts

Two interfaces stop being internal and become products in their own right. Both
need to exist *before* the split, while server and clients can still be changed
in one commit.

### `packages/protocol` — the API contract

**Correction (Slice 1):** `src/transports/api-contract.js` is *not* the wire
contract — it is fastify decoration plumbing (`SERVICE_DECORATIONS`,
`assertContract`, the mount helpers) and stays server-side. The real wire
contract, and what `@canvas-os/protocol` was authored from, is the
`ResponseObject.js` envelope + machine codes, the `/rest/v2` route surface
(`docs/API.md`, `src/transports/routes/`), the auth header conventions and the
socket.io event names. There is still no OpenAPI spec. Today server and clients
co-evolve in one tree, so drift is caught at build time. After the split, four
clients depend on a contract that the closed server also needs.

The contract therefore lives in the **open** package and the closed server
imports it, never the reverse. The REST surface is already public in
`docs/API.md`, so nothing leaks, and it gives `api-client` something to be
generated or validated against. Without it the clients drift silently.

### `packages/plugin-api` — the integration adapter interface

The integration layer must be consumable by closed `agentd` and by any other
module. That makes the **adapter interface** the boundary object: a published,
versioned package rather than a shape agreed by convention.

Permissive licensing is what makes that consumption safe, and it is also what
makes outside contribution useful — breadth of integrations (WhatsApp, Teams,
Signal, Slack) is commodity work with real value, and the lowest-friction licence
gets the most of it.

---

## Build pipeline: the web artifact

The largest piece of engineering work in this migration, and it is not licensing.

`canvas-server` currently builds the web UI from a submodule via `postinstall`
(`npm run build -w src/ui/web`), and the Dockerfile relies on it: `COPY . .`
followed by `npm ci` pulls the UI source into the image and builds it there.

Once `canvas-web` lives in the open monorepo and the server is closed, the server
must consume the UI as a **published artifact** — an npm package shipping a
prebuilt `dist/`, or a release tarball fetched at build time.

- [ ] Publish `@augmentd-labs/canvas-web` with a prebuilt `dist/`
- [ ] Replace the `postinstall` build with a dependency
- [ ] Rework the Dockerfile: the builder stage no longer compiles the UI
- [ ] Decide the version-pinning policy (exact pin, most likely)
- [ ] Keep a dev path that still builds the UI from source in the monorepo

Do this **while everything is still AGPL and in one tree**, so it can be reverted
cheaply if the shape is wrong.

---

## Phases

Irreversible steps last. Each phase should leave the tree working.

### Phase 0 — gates

- [ ] MBAG pre-existing-IP carve-out signed
- [ ] Provenance documented
- [ ] Apache-2.0 vs MIT confirmed for the open layer
- [ ] `canvas` monorepo repository created (done)

### Phase 1 — scaffold ✅ (Slice 1, 2026-08-08)

- [x] pnpm workspace, `apps/*` + `packages/*` (see
      [Tooling and distribution](#tooling-and-distribution))
- [x] `onlyBuiltDependencies` for bun/sharp/esbuild — note: in pnpm 10 this
      lives in `pnpm-workspace.yaml`, not `.npmrc` (the original note here was
      wrong). `.npmrc` exists as the future registry-config home. Tauri's
      `node-linker=hoisted` escape hatch: not needed yet (bun-compile works
      against the symlinked layout; revisit when desktop lands)
- [x] Shared eslint / tsconfig / prettier (root flat config covers
      `packages/**`; apps keep the configs they arrive with)
- [x] One CI pipeline (lint + tests + cli build + binary smoke; matrix when
      more apps land)
- [x] Versioning strategy — **changesets** (decided)

### Phase 2 — extract the shared packages

Highest value, lowest risk, no licensing exposure. Do it first: it delivers the
thing that actually motivated the monorepo and validates the structure.

- [x] `packages/protocol` — authored from `ResponseObject.js` semantics,
      `docs/API.md` and `src/transports/routes/` (NOT from api-contract.js —
      see the corrected [Boundary artifacts](#boundary-artifacts) section)
- [x] `packages/schemas` — ids, versions, `tag/` features, note/tab/file
      builders, wire-parity with the historical cli output pinned by tests
- [x] `packages/api-client` — fetch-based, envelope unwrap centralized,
      network-error mapping covers node *and* Bun fetch codes (the compiled
      cli runs under Bun); cli's REST file shrank 290 → ~120 lines
- [x] Repoint one client at it (cli is smallest) and prove it works —
      proven: 56 package tests, fresh-clone frozen-lockfile install, bun
      compile under pnpm, binary smoke incl. dead-remote negative test, CI
      green

### Phase 3 — fold in the open clients, with history

`git subtree` preserves history; a file copy orphans 408 commits of web UI work.

```bash
cd canvas
git remote add web-src https://github.com/canvas-ui/canvas-web.git
git fetch web-src main
git subtree add --prefix=apps/web web-src main
```

Repeat for `cli`, `desktop`, `browser-extension` and `shell`. `canvas-fuse`
stays standalone — it is Rust and does not belong in an npm workspace.

- [x] **cli folded in** (Slice 1, subtree from canvas-ui/canvas-cli@109fbee;
      full 236-commit history reachable via the subtree merge's second parent —
      note `git log --follow` does not cross a subtree graft, use
      `git log <merge>^2`). Builds in the monorepo, consumes
      the shared api-client. The monorepo copy is canonical from now on.
      **Old-repo cutover (decided 2026-08-09):** the four folded repos
      (cli, shell, desktop, browser-extensions) carry a final README banner
      pointing at `canvas-ui/canvas` → `apps/<name>` (pushed 2026-08-09);
      archiving deferred to whenever it feels right — archived repos stay
      fetchable, so the server's submodules would be unaffected either way.
      The repos are kept permanently: they are the AGPL fork point and the
      MBAG provenance record. Releases move to the monorepo (tag per app);
      sweep install-script/store links to new release URLs when the release
      pipeline lands. canvas-web stays live until the web fold + Phase 5;
      fuse/stored stay standalone by design.
- [x] **shell, desktop, browser-extension folded in** (Slice 2, 2026-08-09;
      subtrees from shell@8a1daf8, desktop@0d1051c, extension@e412171).
      Nested npm lockfiles dropped; `@tauri-apps/cli` allowlisted. shell is a
      bash project with no package.json — pnpm skips it, nothing to build.
      The extension's `packages/` dir is build *output* (zips), not source.
      (canvas-electron: **dropped**, see Open questions)
- [ ] web folded in, history intact — lands with the web repoint slice
- [x] Each present app builds inside the monorepo (cli binary, desktop
      tsc+vite frontend, extension chromium+firefox packages; extension's 13
      tests + lint joined the recursive sweep). Tauri's Rust bundle is not in
      CI yet.
- [ ] Each consumes `packages/api-client` rather than its own REST code —
      cli done; **desktop done** (Slice 3, 2026-08-09: apiFetch replaced by
      cached shared-client instances, same stateless signatures; the six
      web-mirrored tree-path/layer functions were dead code and were deleted,
      not ported — their routes enter the shared packages with the web
      migration that exercises them; contexts gained the `/url` pair);
      extension next (888-line api-client.js + featureArray divergence);
      web is the big one: ~164 scattered `.payload` unwrap sites across 14
      service files — stage it service-by-service, not in one pass

### Phase 4 — extract the open services from `canvas-server`

`git filter-repo` extracts a subdirectory with its history:

```bash
git clone https://github.com/canvas-ui/canvas-server.git /tmp/extract-embedd
cd /tmp/extract-embedd
git filter-repo --path src/services/embedd \
                --path-rename src/services/embedd/:packages/embedd/

cd canvas
git remote add embedd-src /tmp/extract-embedd
git fetch embedd-src
git merge --allow-unrelated-histories embedd-src/dev
```

Repeat for `messaging` and `voice`.

These three are **self-contained** — verified: every reference they make to
synapsd is a comment, with no real imports crossing out — so extraction is
mechanical.

- [ ] `embedd`, `messaging`, `voice` extracted with history
- [ ] `canvas-server` consumes them as dependencies
- [ ] Transitional wiring via `file:../canvas/packages/<name>` until published

### Phase 5 — web artifact pipeline

Per the section above. Still AGPL, still reversible.

### Phase 6 — relicense the open layer

- [ ] Apache-2.0 `LICENSE` in the monorepo and `canvas-stored`
- [ ] Per-package `license` fields in every manifest, plus `Cargo.toml` for fuse
- [ ] `NOTICE` per repository
- [ ] Retire `CLA.md`, adopt DCO, rewrite `CONTRIBUTING.md`
- [ ] Announce the relicensing — it is a loosening, so nobody can object, but it
      should not be discovered by accident
- [ ] npmjs publishing under `@augmentd-labs` goes live **GitHub Actions-only**:
      per-package trusted-publisher (OIDC) config, "disallow tokens" setting,
      provenance on every release — see
      [Release mechanics](#release-mechanics-decided-2026-08-08-github-actions-only)

### Phase 7 — close the core

Last, because it cannot be undone, and only once Phase 0's MBAG gate is cleared.

- [ ] `canvas-synapsd` → private, proprietary `LICENSE` (this also finally fixes
      it shipping no LICENSE file at all)
- [ ] `canvas-server` → private, proprietary `LICENSE`
- [ ] `neurald` → `agentd`, private
- [ ] Restate the §13 machinery as build identity
- [ ] Rewrite `COMMERCIAL.md` for the closed core
- [ ] Tag a final AGPL release of each so the public fork point is deliberate
      rather than accidental

---

## Working method

**Do not reach the monorepo through a path inside `canvas-server`** — not as a
symlink (`canvas-server/new-monorepo → canvas/`), and not as a gitignored nested
clone either. Gitignoring the path solves the "git commits a dangling link"
problem but not the one that matters.

Measured, not assumed:

| Setup | default `rg` | agent Grep tool | reachable with |
|---|---|---|---|
| symlink, not gitignored | no matches | `No files found` | `--follow` |
| real directory, gitignored | no matches | — | `--no-ignore` |
| symlink *and* gitignored | no matches | no matches | both flags |

ripgrep does not traverse symlinks by default, and it honours `.gitignore`. Either
cause alone hides the tree from every search-based tool; the obvious setup has
both.

The danger is that this fails **silently** — empty results, not an error. An agent
asked "has `embedd` been moved yet?" searches, finds nothing, concludes no, and
redoes the move. "What still imports the old path?" returns clean. Explicit
Read/Write through the link works fine, so driving an agent with exact paths is
survivable; anything involving discovery is not.

Instead:

- **Sibling checkouts.** `canvas/` and `canvas-server/` side by side, both
  attached to the agent session. Each is its own repository root with its own
  ignore rules, so search behaves normally in both with no flags to remember.
- **Whole packages move with `git subtree` / `git filter-repo`,** not by an agent
  copying files. One command, history preserved.
- **During the transition,** `canvas-server` consumes moved packages via
  `"@augmentd-labs/canvas-api-client": "file:../canvas/packages/api-client"`. npm links those
  into `node_modules` itself, which is well-trodden.

The agent's value is the rewiring after each move — imports, build config,
deduplicating the client REST code — not the relocation itself.

---

## Tooling and distribution

### Package manager

Today: **npm only.** Lockfiles in the root, `canvas-desktop` and
`canvas-browser-extensions`; no pnpm or yarn anywhere. The `bunfig.toml` in
`canvas-cli` is `[build]` / `[compile]` config for producing the CLI binary, not
dependency management — there is no bun lockfile, so bun is orthogonal to this
decision and can keep compiling the CLI inside any workspace.

What makes this easy is that **`canvas-server` is not going into the monorepo.**
The native dependencies (lmdb, roaring, onnxruntime-node, sharp) and the tuned
Dockerfile stay in their own repository. The two repos are linked by packages,
not by a shared install, so they do not have to agree.

- **`canvas` monorepo → pnpm.** Greenfield, so there is no migration to pay for.
  The reason is not speed, it is **strict `node_modules`**: pnpm refuses to
  resolve a dependency a package did not declare. That is exactly the failure
  mode when extracting publishable packages — `api-client` works inside the
  monorepo because something got hoisted into a shared tree, then breaks the
  moment anyone installs it standalone. npm hides that until a user hits it.
  Given the whole point here is independently reusable packages, that property
  is worth more than anything else on offer.
- **`canvas-server` → stay on npm.** It works, the Dockerfile is tuned, and
  native prebuilds are where pnpm's strictness costs debugging time for no gain.
- **Not yarn.** Berry's PnP fights native modules, classic is unmaintained, and
  neither offers anything pnpm does not.

pnpm costs to budget for: `overrides` moves under `pnpm.overrides`; pnpm 10
blocks postinstall scripts unless allowlisted via `onlyBuiltDependencies`
(which lives in `pnpm-workspace.yaml`, not `.npmrc` — measured in Slice 1);
Tauri may want `node-linker=hoisted` or a `public-hoist-pattern` (not needed
for bun-compile, which resolves the symlinked layout fine).

**Do not switch `canvas-server` during the migration.** Moving packages and
changing package manager at once makes native-module breakage expensive to
attribute.

*Cleanup noticed on the way:* the `allowScripts` block in the root
`package.json` is read by nothing — no code, workflow or script references it.
Dead config, safe to delete.

### Publishing

**npm cannot install a package from a subdirectory of a git repository.** There
is no `#path:packages/api-client`; it has never been supported, and pnpm does
not add it. This is the constraint that decides everything below.

- **Inside the monorepo — nothing to publish, ever.** Workspace linking handles
  `apps/web` → `packages/api-client` natively. That is most of the value, free.
- **Standalone repos — git dependencies work.** No subdirectory problem, so
  `"canvas-stored": "github:canvas-ui/canvas-stored#v1.2.0"` is legitimately
  good enough. Same for `canvas-synapsd`.
- **`canvas-server` → monorepo packages is the case that needs a decision**, and
  it applies to `@augmentd-labs/canvas-embedd`, `@augmentd-labs/canvas-messaging`, `@augmentd-labs/canvas-voice` and
  `@augmentd-labs/canvas-protocol`. `file:../canvas/packages/<name>` works locally with the
  sibling checkouts and is fine during the migration, but breaks in CI and
  Docker. **Revised (Slice 1): GitHub Release tarballs, not GitHub Packages.**
  CI runs `pnpm pack` per package on tag and attaches the tarball to a
  release; canvas-server depends on the URL
  (`"@augmentd-labs/canvas-protocol": "https://github.com/.../releases/download/..."`).
  npm/pnpm install tarball URLs natively, the lockfile pins integrity, no
  auth while the repos are public, and exact-pin matches the policy anyway.
  GitHub Packages was dropped because it demands a token even for *public*
  installs (adoption poison) and chains the scope to the GitHub org login —
  a namespace now lost to a squatter. Public **npmjs** under `@augmentd-labs`
  enters at Phase 6, when the packages go Apache and third parties should
  `npm install` them.
- **The web UI genuinely needs publishing.** Phase 5 exists so the server can
  consume a *prebuilt* `dist`. A git dependency would run the vite build via
  `prepare` on install, dragging the whole frontend toolchain into
  `canvas-server`'s `node_modules` and its image — which is the situation Phase
  5 is escaping. A release tarball carrying `dist/` satisfies this the same
  way.

Staged: workspace links now, `file:` during the migration, GitHub Release
tarballs when CI/Docker needs fetchable artifacts, npmjs at adoption time —
and the web UI ships as a prebuilt tarball because prebuilt output is the
entire requirement.

### Release mechanics (decided 2026-08-08): GitHub Actions only

No manual `npm publish` anywhere, ever — enforced by npm, not by convention:

- Every npmjs publish goes through **npm Trusted Publishing (OIDC)**: the
  package's trusted-publisher config is pinned to the exact repo + workflow
  file, so npm accepts publishes only from that workflow. No `NPM_TOKEN`
  secrets exist anywhere.
- Package publishing access set to "require 2FA and disallow tokens", which
  hard-blocks laptop and token publishes while OIDC keeps working.
- The workflow runs with `permissions: { id-token: write, contents: read }`
  and publishes `--provenance --access public` (scoped packages default to
  private; provenance links every release to its commit + run on the npm page).
- Trigger on tag push / GitHub Release; a human gate, if wanted, is a GitHub
  environment with required reviewers — "approve the run", never "run npm".
- Bootstrap caveat: trusted-publisher config lives in package settings, which
  exist only after first publish. If the UI refuses pre-registration, first
  publish runs from CI with a short-lived granular token stored as a repo
  secret, deleted immediately after switching to OIDC.

The `@augmentd-labs` npm org + `augmentd-labs` GitHub org (created 2026-08-08)
are the publishing home for ALL packages, this monorepo's included — see the
naming section. Applies here from the first tarball-building release workflow
onward, and to npmjs the moment Phase 6 publishes under `@augmentd-labs`.

---

## Open questions

- **`canvas-electron`** — **decided (Slice 1): dropped.** Not folded into the
  monorepo; the repo stays where it is (archive on GitHub at leisure). Desktop
  is Tauri.
- **`agentd`** — does the rename happen during the migration or after?
- **SynapsD trademark** — worth registering while it is still the distinctive
  name, though less pressing once the code is closed.
