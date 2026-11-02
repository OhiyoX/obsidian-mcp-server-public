// Test-only `--import` preload: pins a spawned server's ambient clock, so the #434 browser gate
// can assert a deterministic AuthZ decision plus a concrete `nextChangeAt` instead of a value that
// happens to render the same whatever the wall clock says.
//
// Only active when `WEB_TEST_FROZEN_NOW` parses. It follows the `preload-stall-watcher.mjs`
// precedent: the harness hands it to the fixture server child through `NODE_OPTIONS`, and the
// harness process itself is untouched (`admin-window-presentation.mjs` sets both variables just
// around the spawn and restores them immediately).
//
// Patching `Date.now` is sufficient for the decision surface: every AuthZ timestamp comes from the
// injected runtime clock (`src/access-policy/runtime.js` → `now = Date.now`), and the policy store
// stamps `updatedAt` from the same default. `new Date()` is deliberately left alone, so nothing
// that merely wants "the current wall time for logging" is affected.
const frozenMs = process.env.WEB_TEST_FROZEN_NOW ? Date.parse(process.env.WEB_TEST_FROZEN_NOW) : Number.NaN;

if (Number.isFinite(frozenMs)) {
  Date.now = () => frozenMs;
}
