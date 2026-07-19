# Tests

All canvas-server tests live HERE, never next to the source — `npm test` runs
every `tests/**/*.test.js` via the node test runner.

- Unit/route tests mirror the `src/` layout (`tests/core/workspace/…`,
  `tests/transports/…`, `tests/services/embedd/…`), with inner `src/`/`tests/`
  segments collapsed. Name them `<subject>.test.js` — the `*.test.js` glob is
  what `npm test` picks up.
- The flat `test-*.js` / `*.sh` scripts in this directory are manual
  integration scripts (need a live server); they are intentionally NOT matched
  by the glob.
- Submodules (`src/services/synapsd`, `src/services/stored`, `src/ui/*`) keep
  their own tests in their own repos.
