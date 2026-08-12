# Monorepo migration

Consolidate ten repositories into five and extract the shared client packages
that do not exist yet. Licence boundary (decided 2026-08-12, superseding the
original "permissive integrations, closed core" target): monorepo + fuse are
AGPL-only for everyone; server/synapsd/stored/inferd/agentd stay dual-licensed
AGPL + commercial.

Status: **in progress**. Slice 1 executed 2026-08-08 — Phase 1 (pnpm scaffold),
Phase 2 (all three shared packages), and the cli folded in early as the Phase 3
pilot (subtree, history intact, repointed onto the shared api-client, binary
verified under Bun). Slice 2 executed 2026-08-09 — shell, desktop and
browser-extension folded in and building; Phase 3 now lacks only the web
fold and the per-client repoints. Decisions locked: pnpm 10 for the monorepo (server stays
npm), changesets, canvas-electron dropped, monorepo repo stays public,
packages stay AGPL — made permanent 2026-08-12 (Phase 6 void).

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

Noticed during Slice 1 (pre-existing, not fixed here): the CLI resolves its
home directory from `CANVAS_USER_HOME` while `docs/client-spec.md` specifies
`$CANVAS_HOME`. One of them is wrong.

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
canvas                  AGPL-only     monorepo (public — decided Slice 1)
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
    messaging                         ← src/services/messaging
    voice                             ← src/services/voice

canvas-stored           AGPL+comm     standalone, ad-hoc reuse
canvas-fuse             AGPL-only     standalone (Rust — no npm workspace fit)
canvas-synapsd          AGPL+comm     standalone, ad-hoc reuse
canvas-server           AGPL+comm     src/{core,transports,utils} · agentd · edge
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

    synapsd   → dual (AGPL + commercial), standalone repository
    stored    → dual (AGPL + commercial), standalone repository
    neurald   → agentd, dual (AGPL + commercial), standalone repository

They become dependencies rather than subdirectories, which leaves
`canvas-server` with five cross-repository dependencies: `canvas-synapsd`,
`canvas-stored`, `canvas-inferd`, `@augmentd-labs/canvas-messaging` and
`@augmentd-labs/canvas-voice`. See
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

## Licensing: RESOLVED 2026-08-12 — the Apache/closed-core plan below is DEAD

**Final decision (2026-08-12): no Apache relicense, no closed core.** The
licence topology is the dual-licensing model, kept and cleaned up:

- **AGPL-3.0-or-later ONLY, for everyone, forever**: the client applications
  in the monorepo (`canvas-ui/canvas` `apps/*` — cli, web, browser-extension,
  desktop, shell) and `canvas-fuse`. No commercial licence exists for these.
  Note `canvas-web` thereby *left* the dual set: it is now an AGPL-only open
  client, so even engine licensees must publish web-UI modifications they
  serve (deliberate — it is the anti-SaaS-freeride line).
- **AGPL-3.0-or-later + commercial (dual)**: `canvas-server` (incl.
  messaging/voice/agent in-tree services; embedd was extracted and renamed
  to `canvas-inferd`), `canvas-synapsd`, `canvas-stored`,
  `canvas-inferd`, `canvas-agentd` (consolidating `canvas-neurald`), **and
  the monorepo `packages/*`** (protocol, schemas, api-client — amended later
  the same day: kept dual + CLA-covered so commercial deployments like MBAG
  can build on the official client libraries, and so the commercial offer
  survives outside contributions to the shared code; CLA v1.2, monorepo
  CONTRIBUTING.md documents the apps=DCO / packages=CLA split).

Executed 2026-08-12: monorepo got root `LICENSE` (AGPL) + `NOTICE` + README
licensing section (replacing the interim "Apache later" text); server
`NOTICE`/`COMMERCIAL.md`/`CLA.md` (v1.1) updated to the new component split
(web → AGPL-only, neurald → agentd, inferd/agentd listed, submodule wording
dropped); same CLA/COMMERCIAL updates in `canvas-stored`/`canvas-synapsd`;
`canvas-inferd` and `canvas-agentd` received the full kit
(NOTICE/COMMERCIAL.md/CLA.md; agentd `license` field fixed from UNLICENSED).
`canvas-fuse` was already correct. Phases 6–7 below are void; the MBAG
pre-existing-IP carve-out (Phase 0) is no longer a licensing gate — nothing
moves away from AGPL and nothing closes — though the carve-out remains worth
having for provenance.

Everything from here to the end of "Consents and irreversibility" is the
superseded Apache/closed-core analysis, kept for the record.

### Why the change

AGPL is copyleft: anything that links it must itself be AGPL. A closed
`canvas-server` importing AGPL `stored` and `inferd` would be a copyleft
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
| `canvas-inferd` | AGPL [dual], standalone | **Apache-2.0** | extracted from `canvas-server` |
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
      go. 
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

- [x] Publish the prebuilt web artifact (Slice 6, 2026-08-09): `canvas-web`
      tarball on the monorepo's `web-v2.2.0` release, packed dependency-free
      by `canvas/scripts/pack-web-artifact.mjs` (vite bundles the runtime;
      shipping the unpublished workspace deps in the manifest 404s npm —
      learned the hard way). Lesson recorded: never clobber a release asset
      URL npm may have cached; bump the version instead.
- [x] Replace the `postinstall` build with a dependency (exact tarball-URL
      pin; installs no longer compile anything)
- [x] Rework the Docker path: nothing UI-related remains in the build
      context; `COPY . .` + `npm ci` fetches the artifact like any dep
- [x] Version-pinning policy: exact pin via the versioned release URL
- [x] Dev path: `CANVAS_WEB_ROOT=../canvas/apps/web/dist` overrides the
      static root (see `src/transports/index.js`)

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
- [x] **web folded in** (Slice 5, 2026-08-09; subtree from web@77369ea,
      history intact). Two strictness catches on arrival: code-editor.tsx
      imported @codemirror/{language,state} undeclared (hoisting artifact,
      now declared), and web's own lint carries **294 pre-existing errors**
      from upstream main — web is excluded from the monorepo's recursive
      lint sweep until that debt is paid (its own `pnpm --filter canvas-web
      lint` still runs it).
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
      **extension done** (Slice 4, 2026-08-09: transport swapped onto the
      shared client in envelope mode — unwrap:false keeps sync-engine/
      service-worker reading .status/.payload themselves, wire byte-stable;
      Firefox local-network modes, 10s budget, AuthExpiredError mapping and
      the started-workspace preflight preserved; 18 dead public members
      deleted; 7 wrapper tests added. **featureArray verdict, server-
      verified:** the doc-level field is inert — synapsd Document reads only
      `features` (v3) / legacy `metadata.features`; the extension works
      because every call site mirrors the array into body `features`, which
      is indexed but not stored on the row. Follow-up recorded below.);
      **web transport done** (Slice 5: lib/api.ts rides the shared client in
      envelope mode — unwrap:false keeps api.get/post returning whole
      envelopes, all ~164 `.payload` service sites untouched; web policy
      — redirect guard, token gate, 401→/login, workspace
      autostart-and-replay via protocol's isWorkspaceNotActive — stays
      local; stream() keeps a raw-Response path with the same policy).
      Remaining: migrate the 14 service files onto unwrapped semantics
      service-by-service (flip each call from envelope-typed to payload-
      typed), then drop unwrap:false. Also fold in: web's duplicated
      envelope types (types/api.d.ts ApiResponse vs services/context.ts
      ApiPayload) collapse onto @augmentd-labs/canvas-protocol's
      ResponseEnvelope as services migrate
- [ ] Extension follow-up (deliberate, changes stored data shape): move tab
      tags from the inert doc-level `featureArray` to doc-level `features`
      so they are stored on the row *and* ticked — that is also what makes
      tag-removal unticking work (staleFeatureKeys diffs against the stored
      array, currently empty). Adopt @augmentd-labs/canvas-schemas
      buildTabDoc in tab-manager at the same time (package root is
      browser-bundleable now — buildFileDoc's node:path import removed).

### Phase 4 — extract services from `canvas-server`

Reframed 2026-08-12: this phase was licensing-driven ("open services" headed
to permissive packages under the dead Apache plan). With everything staying
dual-AGPL, extracting messaging/voice is optional modularity — do it if and
when it pays for itself, not for the licence boundary. inferd's scope
(decided 2026-08-12): (a) embeddings, (b) summaries/descriptions,
(c) semantic anchors — experimental internal-state translation belongs in
canvas-agentd, not here — over both local and remote runtimes. Name
`canvas-inferd` is subject to change; a rename must sweep the legal docs
(NOTICE/COMMERCIAL/CLA across all six repos) and the git-dep refs here.

- [x] `canvas-inferd` extracted with history and consumed as a dependency
      (formerly `src/services/embedd`; declares onnxruntime-node properly —
      the old undeclared-dep landmine is defused)
- [ ] (optional) `messaging` and `voice` extracted with history
- [ ] `canvas-server` consumes them as dependencies
- [ ] Transitional wiring via `file:../canvas/packages/<name>` until published

### Interlude (Slice 6, 2026-08-09) — canvas-server de-submoduled

All nine submodules removed; the server is a plain repo again. synapsd and
stored are `github:canvas-ui/...#main` deps — package.json tracks the
branch, package-lock.json pins the exact commit (`npm run deps:bump` +
commit the lockfile to advance; `npm ci` stays reproducible) (13 deep-relative imports
became package imports — both packages have no `exports` fences, so the
consumed subpaths are stable). neurald had zero consumers and is gone
(`src/utils/log.js` debug-namespace string is the only trace). Live local
dev against the sibling checkouts: `npm install --no-save
file:../canvas-synapsd` or `npm link`. Retired: `update-submodules`,
`scripts/update-submodule.sh`, the update-submodules workflow, submodule
steps in `update-git.sh`/`install-*.sh`, `.dockerignore` UI carve-outs,
three orphaned cli test scripts. Follow-ups: synapsd's
`tests/workspace-translation.test.js` still imports the server's
`Workspace.js` (only ever worked nested — move it into the server suite or
drop it), and `.git/modules/*` leftovers can be pruned whenever.

### Phase 5 — web artifact pipeline

Per the section above. Still AGPL, still reversible.

### Phase 6 — relicense the open layer — VOID (superseded 2026-08-12)

Decision: the open layer stays AGPL-3.0-or-later, permanently. See
"Licensing: RESOLVED 2026-08-12" above. Items kept for the record:

- [ ] ~~Apache-2.0 `LICENSE` in the monorepo and `canvas-stored`~~
- [ ] Per-package `license` fields in every manifest, plus `Cargo.toml` for fuse
- [ ] `NOTICE` per repository
- [ ] Retire `CLA.md`, adopt DCO, rewrite `CONTRIBUTING.md`
- [ ] Announce the relicensing — it is a loosening, so nobody can object, but it
      should not be discovered by accident
- [ ] npmjs publishing under `@augmentd-labs` goes live **GitHub Actions-only**:
      per-package trusted-publisher (OIDC) config, "disallow tokens" setting,
      provenance on every release — see
      [Release mechanics](#release-mechanics-decided-2026-08-08-github-actions-only)

### Phase 7 — close the core — VOID (superseded 2026-08-12)

Decision: nothing closes; the engine stays dual-licensed AGPL + commercial.
See "Licensing: RESOLVED 2026-08-12" above. Items kept for the record —
none will be executed:

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

The danger is that this fails **silently**: empty results, not an error. An agent
asks whether a service moved, searches, finds nothing, concludes no, and
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
  it applies to `@augmentd-labs/canvas-messaging`, `@augmentd-labs/canvas-voice` and
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
