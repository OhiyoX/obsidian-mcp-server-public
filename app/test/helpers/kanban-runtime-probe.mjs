// Probe module for the lazy-gate contract test (test/web-bases-kanban-lazy.test.js).
//
// The eager kanban gate keeps NO import cache: three renders of the same view are one load
// because the ES module map keys modules by URL, dedups in-flight loads and returns one
// instance (evidence/probe-import-dedup.mjs, real Chromium: sequential and concurrent
// imports of one URL => 1 request / 1 resource entry; a different `?v=` => a new module).
//
// The test has to assert THAT semantic rather than a counter the gate maintains itself, so
// it imports this file through the gate's real `import()`. The line below records how many
// times the module was EVALUATED, and the `export *` keeps the REAL runtime behind it, so
// every render that "deduped" also really produced a board.
//
// It is a committed fixture rather than a file written to os.tmpdir() per run: importing a
// just-written temp file is racy on Windows (the loader can lose the race with the file
// becoming visible, which showed up as one cold-run ERR_MODULE_NOT_FOUND here).
globalThis.__kanbanRuntimeProbeEvals = (globalThis.__kanbanRuntimeProbeEvals ?? 0) + 1;
export * from "../../frontend/app/features/bases/kanban-runtime.js";
