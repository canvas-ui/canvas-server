# Monorepo migration

**Naming (decided 2026-08-08): the product brands as Canvas OS; the npm scope
is `@augmentd-labs`** — superseding the earlier `@canvas-os` npm plan from the
same day. The `augmentd-labs` npm org + GitHub org exist (created 2026-08-08,
Augmentd s.r.o.'s Labs umbrella for all "experimental" projects ); 

GitHub org stays `canvas-ui` for now; if it is renamed
later (os-canvas or similar), immediately re-register `canvas-ui` as a
placeholder org

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

## Post-migration cleanup

The migration's structural and licensing work is done; these are the loose
ends, none blocking. (TODO consolidation itself — aggressively pruning
shipped items across all the TODO files — is deferred to a dedicated
session.)

- [x] ~~CLI resolves its home directory from `CANVAS_USER_HOME` while
      `docs/client-spec.md` specifies `$CANVAS_HOME`.~~ **The doc was wrong**
      (2026-08-14): cli, desktop, shell and the server all use
      `CANVAS_USER_HOME`, and the server pairs it with `CANVAS_SERVER_HOME`,
      so the `USER` infix is load-bearing. `client-spec.md` §1/§3/§6 updated
      to match the code.

- [x] ~~**Web debt:** staged unwrap migration; collapse the duplicated
      envelope types.~~ **Done 2026-08-14 (web v2.7.0).** Not staged in the
      end — it could not be: the `.payload` generics were pure type
      assertions, so `tsc` was blind to them and a half-migrated tree would
      have failed silently at runtime. Doing it in one pass is what made the
      compiler the safety net (rewrite `api.M<{payload: T}>` → `api.M<T>`, and
      every stale `.payload` becomes a TS2339 with an exact line/column).
      - `unwrap: false` is gone; `api.get/post/...` resolve to the payload.
      - 140 of 146 call sites unwrapped. The 6 that genuinely need an
        envelope field use the new `api.getEnvelope`/`postEnvelope`:
        document lists + `listBackendDocuments` + `getContextDocuments`
        (`count`/`totalCount`), lens image search (counts + `debug`
        distances), admin reindex (`message`).
      - All three duplicate envelope types deleted (`types/api.d.ts`
        `ApiResponse<T>`, `types/workspace.ts` `TreeResponse` +
        `DocumentsApiResponse`, `services/auth.ts`'s own `ApiResponse<T>`);
        the survivors are typed with protocol's `ResponseEnvelope`.
      - `getWorkspaceTree*` now returns `TreeNode` instead of an envelope.
      - Dead code removed: `status === 'success'`/`statusCode` checks. An
        error envelope always rejects in the api-client, so reaching the
        `.then` already means success.
      Verified with `tsc -b --force` (0), lint (0 errors), build, and a
      headless CDP smoke over /home /workspaces /contexts /agents /api-tokens
      /about + a seeded workspace detail page — document rows, "7 documents"
      and "Purge All (7)" all render, i.e. the envelope-count path works.
      Lint: web reached 0 errors in v2.6.6 and the `!canvas-web` filter was
      dropped from the root `lint` script, so the recursive sweep covers web.
- [x] ~~**Extension:** move tags to doc-level `features` + adopt
      `buildTabDoc`.~~ **Done 2026-08-14 (extension v3.1.0).**
      `tab-manager.js convertTabToDocument()` now builds via `buildTabDoc`
      (new `@augmentd-labs/canvas-schemas` dep) and emits doc-level
      `features`; the ~10 document-field `.featureArray` reads in
      `service-worker.js` / `sync-engine.js` / `tab-manager.js` follow.
      Query-side `featureArray` locals (api-client `allOf` filters) are a
      different concept and were left alone.
      Also fixed in passing: `sync-engine.js` read `document.featureArray`
      on documents coming *from* the server (websocket `document.inserted`),
      which the server never sends — so the "skip tabs from this same
      browser" guard silently never fired. It reads `features` now.
      Verified end-to-end against canvas-server 2.5.13: tags are stored on
      the row, dropping one unticks it, unrelated `client/app/*` survives.

---

The `@augmentd-labs` npm org + `augmentd-labs` GitHub org (created 2026-08-08)
are the publishing home for ALL packages, this monorepo's included — see the
naming section. Applies here from the first tarball-building release workflow
onward, and to npmjs the moment Phase 6 publishes under `@augmentd-labs`.

---

## Open questions

- **SynapsD trademark** — worth registering while it is still the distinctive
  name, though less pressing once the code is closed.
