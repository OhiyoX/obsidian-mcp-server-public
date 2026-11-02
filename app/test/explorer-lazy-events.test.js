// Phase 2B-1b-i unit tests: SSE -> per-parent lazy Explorer invalidation.
import assert from "node:assert/strict";
import test from "node:test";
import { createLazyExplorerEvents } from "../frontend/app/features/explorer/lazy-events.js";

function createSpyController() {
  const calls = [];
  return {
    calls,
    invalidate: (path) => calls.push({ kind: "invalidate", path }),
    invalidateEverything: () => calls.push({ kind: "invalidateEverything" }),
  };
}

test("note events invalidate only the affected parent", () => {
  const controller = createSpyController();
  const events = createLazyExplorerEvents({ controller });
  for (const type of ["note.created", "note.changed", "note.deleted"]) {
    events.handle({ type, path: "Notes/A.md" });
  }
  assert.deepEqual(controller.calls, [
    { kind: "invalidate", path: "Notes/A.md" },
    { kind: "invalidate", path: "Notes/A.md" },
    { kind: "invalidate", path: "Notes/A.md" },
  ]);
});

test("vault.resync invalidates everything once and never per-note", () => {
  const controller = createSpyController();
  const events = createLazyExplorerEvents({ controller });
  events.handle({ type: "vault.resync" });
  events.handle({ isResync: true, type: "note.changed", path: "Notes/A.md" });
  assert.deepEqual(controller.calls, [{ kind: "invalidateEverything" }, { kind: "invalidateEverything" }]);
});

test("an active query still keeps the tree parent cache current (fan-out, not either/or)", () => {
  const controller = createSpyController();
  const search = [];
  const events = createLazyExplorerEvents({
    controller,
    isQueryActive: () => true,
    onSearchInvalidate: (event) => search.push(event.path),
  });
  events.handle({ type: "note.changed", path: "Notes/A.md" });
  assert.deepEqual(controller.calls, [{ kind: "invalidate", path: "Notes/A.md" }], "tree is invalidated too");
  assert.deepEqual(search, ["Notes/A.md"], "search is invalidated as well");
});

test("an active query on vault.resync resets the lazy tree and invalidates the search", () => {
  const controller = createSpyController();
  const search = [];
  const events = createLazyExplorerEvents({
    controller,
    isQueryActive: () => true,
    onSearchInvalidate: (event) => search.push(event.type),
  });
  events.handle({ type: "vault.resync" });
  assert.deepEqual(controller.calls, [{ kind: "invalidateEverything" }]);
  assert.deepEqual(search, ["vault.resync"]);
});

test("asset events and other vaults never touch the tree", () => {
  const controller = createSpyController();
  const assets = [];
  const events = createLazyExplorerEvents({ controller, vaultId: "main", onAssetEvent: (event) => assets.push(event.type) });
  events.handle({ type: "asset.changed", path: "img/pixel.png" });
  events.handle({ type: "note.changed", path: "Notes/A.md", vaultId: "other" });
  events.handle(null);
  assert.deepEqual(assets, ["asset.changed"]);
  assert.deepEqual(controller.calls, []);
});
