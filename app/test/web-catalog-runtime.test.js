// Phase 1B unit tests for the Web Catalog runtime lifecycle hooks.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// The store/source are injected, so startup reconcile, watcher events, resync and
// read-your-writes internal updates are deterministic and offline.
import assert from "node:assert/strict";
import test from "node:test";
import { openWebCatalogStore } from "../src/app/web-catalog/store.js";
import {
  __resetWebCatalogRuntimesForTests,
  __setWebCatalogRuntimeFactoryForTests,
  applyWatcherEvent,
  closeWebCatalogRuntime,
  createWebCatalogRuntime,
  getWebCatalogRuntime,
  getWebCatalogRuntimeById,
  isWebCatalogEnabled,
  notifyWatcherClosed,
  notifyWatcherReady,
} from "../src/app/web-catalog/runtime.js";

const vault = { id: "main", root: "/vault", primary: true };
const quiet = { error() {} };

function fakeSource(files = {}) {
  const map = new Map(Object.entries(files));
  return {
    map,
    block: null,
    readCount: 0,
    readBaseCount: 0,
    statFileCount: 0,
    async list() {
      if (this.block) await this.block;
      return [...map.entries()].map(([path, file]) => ({
        path,
        kind: file.kind ?? "note",
        size: file.size,
        modifiedMs: file.modifiedMs,
      }));
    },
    async read(rel) {
      this.readCount += 1;
      const file = map.get(rel);
      if (!file) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return {
        path: rel,
        content: file.content ?? "",
        frontmatter: file.frontmatter ?? {},
        revision: `rev:${file.content ?? ""}`,
        stat: {
          size: file.size,
          modified: new Date(file.modifiedMs).toISOString(),
          created: new Date(0).toISOString(),
        },
      };
    },
    async readBase(rel) {
      this.readBaseCount += 1;
      const file = map.get(rel);
      if (!file) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return {
        path: rel,
        revision: `base:${file.content ?? ""}`,
        stat: {
          size: file.size,
          modified: new Date(file.modifiedMs).toISOString(),
          created: new Date(0).toISOString(),
        },
      };
    },
    async statFile(rel) {
      this.statFileCount += 1;
      const file = map.get(rel);
      if (!file) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { path: rel, size: file.size, modifiedMs: file.modifiedMs };
    },
  };
}

test("the runtime is gated by WEB_CATALOG_ENABLED and is per-vault single-instance", (t) => {
  const saved = process.env.WEB_CATALOG_ENABLED;
  t.after(() => {
    __resetWebCatalogRuntimesForTests();
    if (saved === undefined) delete process.env.WEB_CATALOG_ENABLED;
    else process.env.WEB_CATALOG_ENABLED = saved;
  });

  // Phase 2B: the catalog is enabled by default (unset).
  delete process.env.WEB_CATALOG_ENABLED;
  assert.equal(isWebCatalogEnabled(), true, "the catalog is enabled by default");

  process.env.WEB_CATALOG_ENABLED = "false";
  assert.equal(isWebCatalogEnabled(), false);
  assert.equal(getWebCatalogRuntime(vault), null, "disabled catalog must not open a store");

  process.env.WEB_CATALOG_ENABLED = "true";
  let created = 0;
  __setWebCatalogRuntimeFactoryForTests((v) => {
    created += 1;
    return createWebCatalogRuntime({ vault: v, store: openWebCatalogStore(), source: fakeSource(), logger: quiet });
  });

  const first = getWebCatalogRuntime(vault);
  const second = getWebCatalogRuntime({ ...vault });
  assert.ok(first);
  assert.equal(first, second, "the same vault id reuses one runtime");
  assert.equal(created, 1);

  closeWebCatalogRuntime(vault.id);
  assert.notEqual(getWebCatalogRuntime(vault), first, "a closed runtime is recreated on demand");
  assert.equal(created, 2);
});

test("every authorized Web Vault gets its own independent runtime (no primary-only gate)", async (t) => {
  const saved = process.env.WEB_CATALOG_ENABLED;
  t.after(() => {
    __resetWebCatalogRuntimesForTests();
    if (saved === undefined) delete process.env.WEB_CATALOG_ENABLED;
    else process.env.WEB_CATALOG_ENABLED = saved;
  });
  process.env.WEB_CATALOG_ENABLED = "true";
  __setWebCatalogRuntimeFactoryForTests((v) =>
    createWebCatalogRuntime({
      vault: v,
      store: openWebCatalogStore(),
      source: fakeSource({ "Notes/A.md": { size: 3, modifiedMs: 1000, content: v.id } }),
      logger: quiet,
    }),
  );

  const primary = { id: "main", root: "/vaults/main", primary: true };
  const secondary = { id: "team", root: "/vaults/team", primary: false };
  const first = getWebCatalogRuntime(primary);
  const second = getWebCatalogRuntime(secondary);
  assert.ok(first && second, "a secondary Vault must not be gated out");
  assert.notEqual(first, second);
  assert.notEqual(first.store.catalogId(), second.store.catalogId(), "independent catalog identity");

  // Each runtime reconciles its own root/source: same path, different content.
  await first.drain();
  await second.drain();
  assert.equal(first.store.locate("Notes/A.md").revision, "rev:main");
  assert.equal(second.store.locate("Notes/A.md").revision, "rev:team", "each Vault catalog reads its own root");

  assert.equal(getWebCatalogRuntime(primary), first, "the same vault id reuses its runtime");
  closeWebCatalogRuntime(secondary.id);
  assert.notEqual(getWebCatalogRuntime(secondary), second);
});

test("indexFile is read-your-writes, removePath deletes, resync marks stale then reconciles", async () => {
  const store = openWebCatalogStore();
  const source = fakeSource({ "Notes/A.md": { size: 5, modifiedMs: 1000, content: "hello" } });
  const runtime = createWebCatalogRuntime({ vault, store, source, logger: quiet });

  const indexed = await runtime.indexFile(undefined, "Notes/A.md");
  assert.equal(indexed.ok, true);
  assert.equal(store.locate("Notes/A.md").path, "Notes/A.md");

  runtime.removePath("Notes/A.md");
  assert.equal(store.locate("Notes/A.md"), null);

  const resync = runtime.resync("watcher-ready");
  assert.equal(resync.stale, true);
  await runtime.drain();
  assert.equal(store.isStale(), true, "without watcher coverage the snapshot stays explicitly stale");
  runtime.setCoverage(true, "watcher-ready");
  await runtime.drain();
  assert.equal(store.isStale(), false, "coverage present => the reconcile may publish clean");

  const status = runtime.status();
  assert.equal(status.vaultId, "main");
  assert.equal(status.reconciling, false);
  assert.ok(status.generation >= 0);
  store.close();
});

test("applyWatcherEvent maps created/changed to index and deleted to remove", async () => {
  const store = openWebCatalogStore();
  const source = fakeSource({ "Notes/A.md": { size: 5, modifiedMs: 1000, content: "hello" } });
  const runtime = createWebCatalogRuntime({ vault, store, source, logger: quiet });

  await applyWatcherEvent(runtime, { type: "note.created", path: "Notes/A.md", absolute: "/vault/Notes/A.md" });
  assert.ok(store.locate("Notes/A.md"));
  await applyWatcherEvent(runtime, { type: "note.changed", path: "Notes/A.md", absolute: "/vault/Notes/A.md" });
  assert.ok(store.locate("Notes/A.md"));
  await applyWatcherEvent(runtime, { type: "note.deleted", path: "Notes/A.md" });
  assert.equal(store.locate("Notes/A.md"), null);

  assert.equal(await applyWatcherEvent(null, { type: "note.created", path: "x" }), null);
  store.close();
});

test("an unreadable/oversized note is reported without throwing and never breaks the caller", async () => {
  const store = openWebCatalogStore();
  const runtime = createWebCatalogRuntime({ vault, store, source: fakeSource(), logger: quiet });

  const missing = await runtime.indexFile(undefined, "Missing.md");
  assert.equal(missing.ok, false);
  const removed = runtime.removePath("/absolute/bad.md");
  assert.equal(removed.ok, false, "invalid paths are reported, not thrown");
  store.close();
});

test("start() reconciles the initial snapshot in the background", async () => {
  const store = openWebCatalogStore();
  const source = fakeSource({ "Notes/A.md": { size: 5, modifiedMs: 1000, content: "hello" } });
  const runtime = createWebCatalogRuntime({ vault, store, source, logger: quiet });

  runtime.start();
  await runtime.drain();
  assert.equal(store.locate("Notes/A.md").path, "Notes/A.md");
  store.close();
});

test("coverage transitions bump the fence epoch on both edges", () => {
  const store = openWebCatalogStore();
  const runtime = createWebCatalogRuntime({ vault, store, source: fakeSource(), logger: quiet });
  assert.equal(runtime.status().covered, false);
  const start = runtime.status().coverageEpoch;

  runtime.setCoverage(true, "ready");
  assert.equal(runtime.status().coverageEpoch, start + 1);
  runtime.setCoverage(true, "ready");
  assert.equal(runtime.status().coverageEpoch, start + 1, "no transition => no epoch bump");
  runtime.setCoverage(false, "closed");
  assert.equal(runtime.status().coverageEpoch, start + 2);
  assert.equal(store.isStale(), true, "losing coverage marks stale");
  store.close();
});

test("a runtime stays uncovered and stale until the watcher reaches ready", async () => {
  const store = openWebCatalogStore();
  const source = fakeSource({ "Notes/A.md": { size: 5, modifiedMs: 1000, content: "x" } });
  const runtime = createWebCatalogRuntime({ vault, store, source, logger: quiet });

  runtime.start(); // watcher created, but chokidar has not reached ready yet
  await runtime.drain();
  assert.equal(runtime.status().covered, false);
  assert.equal(store.isStale(), true, "watcher create is not coverage-ready");

  runtime.setCoverage(true, "watcher-ready");
  await runtime.drain();
  assert.equal(store.isStale(), false, "only a fully covered pass may publish clean");
  store.close();
});

test("a watcher self-echo of a direct write does not advance the generation twice", async () => {
  const store = openWebCatalogStore();
  const source = fakeSource({ "Notes/A.md": { size: 5, modifiedMs: 1000, content: "hello" } });
  const runtime = createWebCatalogRuntime({ vault, store, source, logger: quiet });

  const direct = await runtime.indexFile("/vault/Notes/A.md", "Notes/A.md");
  assert.equal(direct.skipped, false);
  const afterDirect = store.generation();

  const echo = await runtime.indexFile("/vault/Notes/A.md", "Notes/A.md");
  assert.equal(echo.skipped, true, "the watcher echo must be a no-op");
  assert.equal(store.generation(), afterDirect, "self-echo must not republish the generation");
  store.close();
});

test("a content-identical touch re-publishes because the modified ordering changed", async () => {
  const store = openWebCatalogStore();
  const source = fakeSource({ "Notes/A.md": { size: 5, modifiedMs: 1000, content: "hello" } });
  const runtime = createWebCatalogRuntime({ vault, store, source, logger: quiet });
  await runtime.indexFile(undefined, "Notes/A.md");
  const generation = store.generation();

  source.map.get("Notes/A.md").modifiedMs = 2000;
  const touch = await runtime.indexFile(undefined, "Notes/A.md");
  assert.equal(touch.skipped, false, "a touch must not be swallowed as self-echo");
  assert.equal(store.generation(), generation + 1);
  assert.equal(store.locate("Notes/A.md").modified_ms, 2000);
  store.close();
});

test("a runtime created by a write without any watcher never reports clean", async () => {
  const store = openWebCatalogStore();
  const source = fakeSource({ "Notes/A.md": { size: 5, modifiedMs: 1000, content: "hello" } });
  const runtime = createWebCatalogRuntime({ vault, store, source, logger: quiet });

  await runtime.indexFile(undefined, "Notes/A.md");
  await runtime.drain();
  assert.equal(store.locate("Notes/A.md").path, "Notes/A.md");
  assert.equal(store.isStale(), true, "no watcher coverage => the catalog is not clean");
  assert.equal(runtime.status().covered, false);
  store.close();
});

test("a failed incremental mutation marks the catalog stale instead of staying clean", async () => {
  const store = openWebCatalogStore();
  const source = fakeSource();
  const runtime = createWebCatalogRuntime({ vault, store, source, logger: quiet });
  runtime.setCoverage(true, "test");
  await runtime.drain();
  assert.equal(store.isStale(), false);

  let release;
  source.block = new Promise((resolve) => {
    release = resolve;
  });
  const failed = await runtime.indexFile(undefined, "Missing.md");
  assert.equal(failed.ok, false);
  assert.equal(store.isStale(), true, "a failed catalog write must not leave a clean snapshot");
  release();
  await runtime.drain();
  assert.equal(store.isStale(), false, "the scheduled repair reconciles it back to clean");

  const badRemove = runtime.removePath("/absolute/bad.md");
  assert.equal(badRemove.ok, false);
  assert.equal(store.isStale(), true, "a failed removal must not leave a clean snapshot");
  await runtime.drain();
  store.close();
});

test("a watcher coverage gap marks the catalog stale until coverage returns", (t) => {
  const saved = process.env.WEB_CATALOG_ENABLED;
  t.after(() => {
    __resetWebCatalogRuntimesForTests();
    if (saved === undefined) delete process.env.WEB_CATALOG_ENABLED;
    else process.env.WEB_CATALOG_ENABLED = saved;
  });
  process.env.WEB_CATALOG_ENABLED = "true";
  __setWebCatalogRuntimeFactoryForTests((v) =>
    createWebCatalogRuntime({
      vault: v,
      store: openWebCatalogStore(),
      source: fakeSource({ "Notes/A.md": { size: 5, modifiedMs: 1000, content: "hello" } }),
      logger: quiet,
    }),
  );

  notifyWatcherReady(vault);
  const runtime = getWebCatalogRuntimeById(vault.id);
  assert.ok(runtime);
  return runtime.drain().then(() => {
    assert.equal(runtime.status().stale, false, "coverage is back and the snapshot is reconciled");
    notifyWatcherClosed(vault.id);
    assert.equal(runtime.status().stale, true, "no subscriber => explicitly stale, never silently clean");
  });
});

test("indexFile routes a .base to stat+hash+upsertBase, never the Markdown reader", async () => {
  const store = openWebCatalogStore();
  const source = fakeSource({ "Notes/Project.base": { kind: "base", size: 7, modifiedMs: 1000, content: "views: []" } });
  const runtime = createWebCatalogRuntime({ vault, store, source, logger: quiet });

  const indexed = await runtime.indexFile("/vault/Notes/Project.base", "Notes/Project.base");
  assert.equal(indexed.ok, true);
  assert.equal(store.locate("Notes/Project.base").kind, "base");
  assert.equal(source.readCount, 0, "a base must not be read by the Markdown reader");
  assert.equal(source.readBaseCount, 1);
  assert.equal(store.testDb().prepare("SELECT COUNT(*) AS n FROM notes_fts").get().n, 0);

  const echo = await runtime.indexFile("/vault/Notes/Project.base", "Notes/Project.base");
  assert.equal(echo.skipped, true, "an unchanged base is a self-echo no-op");
  store.close();
});

test("applyWatcherEvent maps base created/changed to upsert and deleted to remove", async () => {
  const store = openWebCatalogStore();
  const source = fakeSource({ "Config.base": { kind: "base", size: 7, modifiedMs: 1000, content: "v1" } });
  const runtime = createWebCatalogRuntime({ vault, store, source, logger: quiet });

  await applyWatcherEvent(runtime, { type: "note.created", path: "Config.base", absolute: "/vault/Config.base" });
  assert.equal(store.locate("Config.base").kind, "base");
  source.map.get("Config.base").content = "v2";
  await applyWatcherEvent(runtime, { type: "note.changed", path: "Config.base", absolute: "/vault/Config.base" });
  assert.equal(store.locate("Config.base").revision, "base:v2");
  await applyWatcherEvent(runtime, { type: "note.deleted", path: "Config.base" });
  assert.equal(store.locate("Config.base"), null);

  // A real asset is not a catalog document.
  assert.equal(await applyWatcherEvent(runtime, { type: "asset.changed", path: "image.png", absolute: "/vault/image.png" }), null);
  store.close();
});

test("indexFile routes an attachment to stat-only upsertFile and skips hidden paths", async () => {
  const store = openWebCatalogStore();
  const source = fakeSource({ "Assets/photo.png": { kind: "file", size: 11, modifiedMs: 1000 } });
  const runtime = createWebCatalogRuntime({ vault, store, source, logger: quiet });

  const indexed = await runtime.indexFile("/vault/Assets/photo.png", "Assets/photo.png");
  assert.equal(indexed.ok, true);
  assert.equal(store.locate("Assets/photo.png").kind, "file");
  assert.equal(source.readCount, 0, "an attachment never reaches the Markdown reader");
  assert.equal(source.readBaseCount, 0);
  assert.equal(source.statFileCount, 1);
  assert.equal(store.testDb().prepare("SELECT COUNT(*) AS n FROM notes_fts").get().n, 0);

  const echo = await runtime.indexFile("/vault/Assets/photo.png", "Assets/photo.png");
  assert.equal(echo.skipped, true, "an unchanged attachment is a self-echo no-op");
  assert.equal(source.statFileCount, 2, "the echo re-stats to confirm the same mtime");

  const hidden = await runtime.indexFile("/vault/.hidden/photo.png", ".hidden/photo.png");
  assert.equal(hidden.skipped, true, "a hidden path is not an inventory entry");
  assert.equal(store.locate(".hidden/photo.png"), null);
  assert.equal(source.statFileCount, 2, "a hidden path is never even stat-ed");
  store.close();
});
