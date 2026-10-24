// Phase 2B-1b-iii: the SSE controller must adopt the lazy per-parent invalidation
// adapter, not reload the whole tree through loadNotes("").
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const source = await fs.readFile(
  new URL("../frontend/app/features/sync/vault-events-controller.js", import.meta.url),
  "utf8",
);
const appSource = await fs.readFile(new URL("../frontend/app/core/app.js", import.meta.url), "utf8");

test("vault events adopt the lazy Explorer adapter instead of reloading the tree", () => {
  assert.match(source, /import \{ createLazyExplorerEvents \} from "\.\.\/explorer\/lazy-events\.js";/);
  assert.match(source, /const lazyEvents = explorerTree\s*\?/);
  assert.match(source, /lazyEvents\.handle\(event\)/);
  assert.doesNotMatch(source, /scheduleNotesRefresh/);
});

test("the app wires the lazy tree controller into the vault events controller", () => {
  assert.match(appSource, /explorerTree: explorer\.treeController\(\)/);
  assert.match(appSource, /isQueryActive: \(\) => explorer\.isQueryActive\(\)/);
});
