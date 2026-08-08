# Monorepo migration

Consolidate ten repositories into four, extract the shared client packages that
do not exist yet, and move the licence boundary from "everything AGPL" to
"permissive integrations, closed core".

Status: **planning**. Nothing below has been executed.

---

## Why

- **`api-client` does not exist.** It is declared as an npm workspace in the
  root manifest but there is no such directory. Meanwhile the REST surface is
  reimplemented in every client: 3 files in `canvas-cli`, 4 in `canvas-web`, 6
  in `canvas-browser-extensions`, 1 in `canvas-desktop`. Schema handling is
  duplicated the same way (38 files in web, 17 in cli, 8 in the extension). A
  shared package cannot exist across ten repositories without publishing to npm
  first, which is why it never got built.
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
canvas                  Apache-2.0    monorepo (the private repo already prepared)
  apps/
    web                               ← canvas-web
    cli                               ← canvas-cli
    desktop                           ← canvas-desktop (tauri)
    browser-extension                 ← canvas-browser-extensions
    shell                             ← canvas-shell
    fuse                              ← canvas-fuse
  packages/
    api-contract                      ← extracted, new
    api-client                        ← extracted, new
    types                             ← extracted, new
    integrations                      ← adapter layer, new
    embedd                            ← src/services/embedd
    messaging                         ← src/services/messaging
    voice                             ← src/services/voice

canvas-stored           Apache-2.0    standalone, ad-hoc reuse
canvas-synapsd          closed        standalone, ad-hoc reuse
canvas-server           closed        server · agentd · runtimes · edge
```

Ten repositories become four. SynapsD and StoreD stay standalone deliberately:
a package you drop into a throwaway experiment should not drag a monorepo behind
it.

Keep `edge` structurally separable inside `canvas-server` — a slim open runtime
may be spun out later, and that is far easier if it never grows tendrils into the
rest of the server.

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
| `api-client` / `api-contract` / `types` | — | **Apache-2.0** | new |
| `integrations` | — | **Apache-2.0** | new |
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

### API contract

`src/transports/api-contract.js` is 99 lines and there is no OpenAPI spec. Today
server and clients co-evolve in one tree, so drift is caught at build time. After
the split, four clients depend on a contract owned by a closed repository.

Publish the contract as an Apache-2.0 package. The REST surface is already
public in `docs/API.md`, so publishing leaks nothing, and it gives `api-client`
something to be generated or validated against. Without it the clients drift
silently.

### Integration adapter interface

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

- [ ] Publish `@canvas/web` with a prebuilt `dist/`
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

### Phase 1 — scaffold

- [ ] npm workspaces, `apps/*` + `packages/*`
- [ ] Shared eslint / tsconfig / prettier
- [ ] One CI pipeline with a per-package test matrix
- [ ] Versioning strategy — changesets, or fixed lockstep

### Phase 2 — extract the shared packages

Highest value, lowest risk, no licensing exposure. Do it first: it delivers the
thing that actually motivated the monorepo and validates the structure.

- [ ] `packages/api-contract` — lift from `src/transports/api-contract.js`
- [ ] `packages/types` — deduplicate the schema handling across clients
- [ ] `packages/api-client` — consolidate the 14 files of duplicated REST access
- [ ] Repoint one client at it (cli is smallest) and prove it works

### Phase 3 — fold in the open clients, with history

`git subtree` preserves history; a file copy orphans 408 commits of web UI work.

```bash
cd canvas
git remote add web-src https://github.com/canvas-ui/canvas-web.git
git fetch web-src main
git subtree add --prefix=apps/web web-src main
```

Repeat for `cli`, `desktop`, `browser-extension`, `shell`, `fuse`.

- [ ] All six clients folded in, history intact
- [ ] Each builds inside the monorepo
- [ ] Each consumes `packages/api-client` rather than its own REST code

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
  `"@canvas/api-client": "file:../canvas/packages/api-client"`. npm links those
  into `node_modules` itself, which is well-trodden.

The agent's value is the rewiring after each move — imports, build config,
deduplicating the client REST code — not the relocation itself.

---

## Open questions

- **`canvas-electron`** — listed as probably not surviving. Fold in or drop?
- **`canvas-fuse`** is Rust, so it sits outside npm workspaces. Keep it in the
  monorepo with its own Cargo build, or leave it standalone?
- **Publishing target** — public npm for the open packages, or a private
  registry initially?
- **`agentd`** — does the rename happen during the migration or after?
- **SynapsD trademark** — worth registering while it is still the distinctive
  name, though less pressing once the code is closed.
