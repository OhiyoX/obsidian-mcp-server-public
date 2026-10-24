// Phase 1B unit tests for the incremental indexer + reconcile.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
import assert from "node:assert/strict";
import test from "node:test";
import { openWebCatalogStore } from "../src/app/web-catalog/store.js";
import {
  catalogRecordFromRead,
  createVaultCatalogSource,
  ensureCatalogDirectories,
  upsertCatalogRead,
} from "../src/app/web-catalog/indexer.js";
import { createWebCatalogReconciler } from "../src/app/web-catalog/reconcile.js";

function note(overrides = {}) {
  const base = { size: 10, modifiedMs: 1000, content: "body", frontmatter: {}, ...overrides };
  base.signature = overrides.signature ?? `sig:${base.size}:${base.modifiedMs}:${base.content}`;
  return base;
}

function createFakeSource(initial = {}) {
  const files = new Map(Object.entries(initial));
  const source = {
    files,
    listCount: 0,
    readCount: 0,
    readBaseCount: 0,
    onList: null,
    async list() {
      source.listCount += 1;
      if (source.onList) await source.onList(source);
      return [...files.entries()].map(([path, file]) => ({
        path,
        kind: file.kind ?? "note",
        size: file.size,
        modifiedMs: file.modifiedMs,
        signature: file.signature,
      }));
    },
    async read(rel) {
      source.readCount += 1;
      const file = files.get(rel);
      if (!file) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (file.unreadable) throw Object.assign(new Error("EIO"), { code: "EIO" });
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
      source.readBaseCount += 1;
      const file = files.get(rel);
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
  };
  return source;
}

test("catalogRecordFromRead projects metadata, tags, aliases and scalar properties", () => {
  const record = catalogRecordFromRead({
    path: "Notes/Alpha.md",
    content: "body #inline",
    frontmatter: { aliases: ["A"], type: "note", nested: { no: true } },
    revision: "r1",
    stat: { size: 4, modified: "2026-01-01T00:00:00.000Z", created: "2025-01-01T00:00:00.000Z" },
  });
  assert.equal(record.modifiedMs, Date.parse("2026-01-01T00:00:00.000Z"));
  assert.deepEqual(record.aliases, ["A"]);
  assert.equal(record.properties.type, "note");
  assert.equal(record.properties.nested, undefined);
  assert.ok(record.tags.includes("inline"));
});

test("the Vault source signature changes when ctime changes even if size/mtime do not", async () => {
  let ctime = 100;
  const source = createVaultCatalogSource({
    vaultRoot: "/vault",
    listMarkdown: async () => ["/vault/A.md"],
    stat: async () => ({ size: 5, mtimeMs: 1000, ctimeMs: ctime, ino: 7 }),
    readNote: async () => ({}),
    toVaultPath: () => "A.md",
  });
  const first = (await source.list())[0];
  ctime = 200;
  const second = (await source.list())[0];
  assert.equal(first.size, second.size);
  assert.equal(first.modifiedMs, second.modifiedMs);
  assert.notEqual(first.signature, second.signature);
});

test("upsertCatalogRead is idempotent for an unchanged revision (no second publication)", () => {
  const store = openWebCatalogStore();
  ensureCatalogDirectories(store, "a/b/Note.md");
  assert.equal(store.countNodes("directory"), 2);

  const read = {
    path: "a/b/Note.md",
    content: "hello",
    frontmatter: {},
    revision: "r1",
    stat: { size: 5, modified: "2026-01-01T00:00:00.000Z", created: "2025-01-01T00:00:00.000Z" },
  };
  const first = upsertCatalogRead(store, read);
  const generation = store.generation();
  const second = upsertCatalogRead(store, read);
  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true, "a same-revision write must be a no-op");
  assert.equal(store.generation(), generation, "self-echo must not advance the generation");
  assert.equal(store.countNodes("note"), 1);
  store.close();
});

test("cold reconcile indexes notes + ancestors, publishes clean, then reuses unchanged files", async () => {
  const store = openWebCatalogStore();
  const source = createFakeSource({
    "_Workspace/40-Projects/Alpha.md": note({ size: 12, modifiedMs: 2000 }),
    "Notes/Beta.md": note({ size: 8, modifiedMs: 1000 }),
  });
  const reconciler = createWebCatalogReconciler({ store, source });

  const first = await reconciler.reconcile();
  assert.equal(first.reparsed, 2);
  assert.equal(store.isStale(), false);
  assert.ok(store.metaGet("lastReconciledAt"));

  const second = await reconciler.reconcile();
  assert.equal(second.reused, 2);
  assert.equal(source.readCount, 2, "unchanged files must not be re-read");
  store.close();
});

test("reconcile detects a same-size, same-mtime content change via the file signature", async () => {
  const store = openWebCatalogStore();
  const file = { size: 10, modifiedMs: 1000, content: "old", signature: "sig-1" };
  const source = createFakeSource({ "Notes/Beta.md": file });
  const reconciler = createWebCatalogReconciler({ store, source });
  await reconciler.reconcile();
  assert.equal(store.testDb().prepare("SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH 'old'").get().n, 1);

  // Content changed but size and mtime are byte-for-byte identical.
  file.content = "new";
  file.signature = "sig-2";
  const second = await reconciler.reconcile();
  assert.equal(second.reparsed, 1, "a same-size/same-mtime rewrite must be re-read");
  assert.equal(store.testDb().prepare("SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH 'old'").get().n, 0);
  assert.equal(store.testDb().prepare("SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH 'new'").get().n, 1);
  store.close();
});

test("reconcile applies create, change and delete", async () => {
  const store = openWebCatalogStore();
  const source = createFakeSource({ "Notes/Beta.md": note() });
  const reconciler = createWebCatalogReconciler({ store, source });
  await reconciler.reconcile();

  source.files.set("Notes/Beta.md", note({ size: 11, modifiedMs: 2000, content: "changed" }));
  source.files.set("Notes/Gamma.md", note({ content: "gamma" }));
  const second = await reconciler.reconcile();
  assert.equal(second.reparsed, 2);

  source.files.delete("Notes/Beta.md");
  const third = await reconciler.reconcile();
  assert.equal(third.removed, 1);
  assert.equal(store.locate("Notes/Beta.md"), null);
  store.close();
});

test("the generation fence discards a scan superseded by a concurrent mutation and re-runs", async () => {
  const store = openWebCatalogStore();
  const source = createFakeSource({ "Notes/Beta.md": note() });
  let mutated = false;
  source.onList = () => {
    if (mutated) return;
    mutated = true;
    store.upsertNote({ path: "Notes/Beta.md", content: "concurrent", revision: "concurrent" });
  };
  const reconciler = createWebCatalogReconciler({ store, source });

  const result = await reconciler.reconcile();
  assert.equal(source.listCount, 2, "the superseded scan must be retried");
  assert.equal(result.skipped, false);
  store.close();
});

test("reconcile is single-flight, concurrent callers share the loop promise, and dirty is not lost", async () => {
  const store = openWebCatalogStore();
  const source = createFakeSource({ "Notes/Beta.md": note() });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  source.onList = async () => {
    if (source.listCount === 1) await gate;
  };
  const reconciler = createWebCatalogReconciler({ store, source });

  const first = reconciler.reconcile();
  assert.equal(reconciler.isRunning(), true);
  const second = reconciler.reconcile();
  assert.equal(first, second, "concurrent callers must await the whole single-flight loop");
  reconciler.markDirty();
  release();
  await first;
  assert.equal(source.listCount, 2, "a dirty mark triggers one trailing re-run");
  assert.equal(reconciler.isRunning(), false);
  store.close();
});

test("a generic read failure keeps the previous snapshot and leaves the catalog stale", async () => {
  const store = openWebCatalogStore();
  const source = createFakeSource({ "Notes/Beta.md": note({ content: "healthy" }) });
  const reconciler = createWebCatalogReconciler({ store, source });
  await reconciler.reconcile();
  assert.equal(store.isStale(), false);

  source.files.set("Notes/Beta.md", note({ size: 11, modifiedMs: 2000, content: "x", unreadable: true }));
  await assert.rejects(() => reconciler.reconcile());

  assert.equal(store.locate("Notes/Beta.md").path, "Notes/Beta.md", "the old row must survive");
  assert.equal(store.testDb().prepare("SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH 'healthy'").get().n, 1);
  assert.equal(store.isStale(), true, "a real I/O failure must leave the catalog stale");
  store.close();
});

test("only a bounded/oversized note degrades to metadata-only, and its ancestor chain is created", async () => {
  const store = openWebCatalogStore();
  const source = createFakeSource({
    "Deep/A/B/Huge.md": { size: 999, modifiedMs: 5, content: "", signature: "big" },
  });
  const reconciler = createWebCatalogReconciler({ store, source, maxReadBytes: 100 });

  const result = await reconciler.reconcile();
  assert.equal(result.metadataOnly, 1);
  assert.equal(source.readCount, 0, "an oversized note must not be read");
  assert.ok(store.locate("Deep/A/B/Huge.md"), "the note stays visible");
  assert.ok(store.locate("Deep/A/B"), "its ancestor chain must exist in the tree");
  store.close();
});

test("removing the last note prunes orphan ancestor directories", async () => {
  const store = openWebCatalogStore();
  const source = createFakeSource({ "Deep/A/B/Only.md": note({ content: "only" }) });
  const reconciler = createWebCatalogReconciler({ store, source });
  await reconciler.reconcile();
  assert.ok(store.locate("Deep/A/B"));

  source.files.delete("Deep/A/B/Only.md");
  const second = await reconciler.reconcile();
  assert.equal(second.removed, 1);
  assert.equal(store.locate("Deep/A/B/Only.md"), null);
  assert.equal(store.locate("Deep/A/B"), null, "the empty ancestor chain must be pruned");
  assert.equal(store.locate("Deep"), null);
  store.close();
});

test("a scan cannot publish clean without coverage, or after coverage is lost mid-scan", async () => {
  const store = openWebCatalogStore();
  const source = createFakeSource({ "Notes/A.md": note() });
  let fence = 0;
  let covered = false;
  const reconciler = createWebCatalogReconciler({
    store,
    source,
    publishFence: () => fence,
    isCovered: () => covered,
  });

  await reconciler.reconcile();
  assert.equal(store.isStale(), true, "no coverage => must stay stale");

  covered = true;
  source.files.set("Notes/B.md", note({ content: "b" }));
  await reconciler.reconcile();
  assert.equal(store.isStale(), false, "stable coverage => may publish clean");

  // Coverage is lost while the scan is in flight; the epoch bumps.
  source.files.set("Notes/C.md", note({ content: "c" }));
  source.onList = () => {
    fence += 1;
    covered = false;
  };
  await reconciler.reconcile();
  assert.equal(store.isStale(), true, "a scan that started before the coverage loss must not clear stale");
  store.close();
});

test("a scan that starts uncovered cannot publish clean when coverage arrives mid-scan", async () => {
  const store = openWebCatalogStore();
  const source = createFakeSource({ "Notes/A.md": note() });
  let fence = 0;
  let covered = false;
  const reconciler = createWebCatalogReconciler({
    store,
    source,
    publishFence: () => fence,
    isCovered: () => covered,
  });

  source.onList = () => {
    if (!covered) {
      covered = true;
      fence += 1;
    }
  };
  await reconciler.reconcile();
  assert.equal(store.isStale(), true, "the uncovered-start pass must not publish clean");

  await reconciler.reconcile();
  assert.equal(store.isStale(), false, "the next fully covered pass may publish clean");
  store.close();
});

test("reconcile indexes, updates and removes base documents without the Markdown reader", async () => {
  const store = openWebCatalogStore();
  const source = createFakeSource({
    "Notes/Project.base": { kind: "base", size: 20, modifiedMs: 1000, content: "views: [a]", signature: "base-1" },
  });
  const reconciler = createWebCatalogReconciler({ store, source });

  const first = await reconciler.reconcile();
  assert.equal(first.reparsed, 1);
  assert.equal(store.locate("Notes/Project.base").kind, "base");
  assert.equal(source.readCount, 0, "a .base must never go through the Markdown reader");
  assert.equal(source.readBaseCount, 1);
  assert.equal(store.baseProjectionStatus().complete, true);

  source.files.set("Notes/Project.base", { kind: "base", size: 20, modifiedMs: 2000, content: "views: [b]", signature: "base-2" });
  const second = await reconciler.reconcile();
  assert.equal(second.reparsed, 1);
  assert.equal(store.locate("Notes/Project.base").revision, "base:views: [b]");

  source.files.delete("Notes/Project.base");
  const third = await reconciler.reconcile();
  assert.equal(third.removed, 1);
  assert.equal(store.locate("Notes/Project.base"), null);
  assert.equal(store.locate("Notes"), null, "the empty ancestor chain is pruned");
  store.close();
});

test("an oversized base degrades to a metadata-only base node, never a note", async () => {
  const store = openWebCatalogStore();
  const source = createFakeSource({
    "Deep/Project.base": { kind: "base", size: 9999, modifiedMs: 5, content: "", signature: "huge-base" },
  });
  const reconciler = createWebCatalogReconciler({ store, source, maxReadBytes: 100 });

  const result = await reconciler.reconcile();
  assert.equal(result.metadataOnly, 1);
  assert.equal(source.readBaseCount, 0, "an oversized base is not hashed");
  assert.equal(store.locate("Deep/Project.base").kind, "base");
  assert.ok(store.locate("Deep"), "its ancestor chain exists");
  store.close();
});

test("reconcile reuses an unchanged base and only re-reads a changed signature", async () => {
  const store = openWebCatalogStore();
  const source = createFakeSource({
    "Project.base": { kind: "base", size: 5, modifiedMs: 1000, content: "v1", signature: "sig-1" },
  });
  const reconciler = createWebCatalogReconciler({ store, source });
  await reconciler.reconcile();
  const second = await reconciler.reconcile();
  assert.equal(second.reused, 1);
  assert.equal(source.readBaseCount, 1, "an unchanged base is not re-hashed");

  source.files.set("Project.base", { kind: "base", size: 5, modifiedMs: 1000, content: "v2", signature: "sig-2" });
  const third = await reconciler.reconcile();
  assert.equal(third.reparsed, 1);
  assert.equal(source.readBaseCount, 2);
  store.close();
});

test("reconcile enumerates an attachment without reading it, then reuses the stat signature", async () => {
  const store = openWebCatalogStore();
  const source = createFakeSource({
    "Notes/Note.md": note({ content: "body" }),
    "Notes/photo.png": { kind: "file", size: 9, modifiedMs: 500, signature: "file-1" },
  });
  const reconciler = createWebCatalogReconciler({ store, source });
  const first = await reconciler.reconcile();

  assert.equal(first.files, 1);
  assert.equal(source.readCount, 1, "only the Markdown note is read");
  assert.equal(source.readBaseCount, 0);
  assert.equal(store.locate("Notes/photo.png").kind, "file");
  const row = store.testDb().prepare("SELECT kind, size, metadata_revision FROM nodes WHERE path = ?").get("Notes/photo.png");
  assert.equal(row.size, 9);
  assert.equal(row.metadata_revision, "file-1");
  assert.equal(store.testDb().prepare("SELECT COUNT(*) AS n FROM notes_fts").get().n, 1, "only the note enters FTS");

  const second = await reconciler.reconcile();
  assert.equal(second.files, 0);
  assert.equal(second.reused, 2, "an unchanged attachment is not re-upserted");
  assert.equal(source.readCount, 1);

  source.files.set("Notes/photo.png", { kind: "file", size: 9, modifiedMs: 501, signature: "file-2" });
  const third = await reconciler.reconcile();
  assert.equal(third.files, 1);
  assert.equal(store.locate("Notes/photo.png").modified_ms, 501);
  assert.equal(source.readCount, 1, "a changed attachment is still never read");
  store.close();
});

test("an oversized attachment stays a file node and is never degraded to metadata-only", async () => {
  const store = openWebCatalogStore();
  const source = createFakeSource({
    "Big/movie.mp4": { kind: "file", size: 9_999_999, modifiedMs: 5, signature: "huge-file" },
  });
  const reconciler = createWebCatalogReconciler({ store, source, maxReadBytes: 100 });
  const result = await reconciler.reconcile();

  assert.equal(result.metadataOnly, 0, "maxReadBytes bounds reads, and a file is never read");
  assert.equal(result.files, 1);
  assert.equal(store.locate("Big/movie.mp4").kind, "file");
  assert.ok(store.locate("Big"), "its ancestor chain exists");
  store.close();
});

test("deleting the last attachment prunes its orphan ancestor chain", async () => {
  const store = openWebCatalogStore();
  const source = createFakeSource({ "Deep/A/B/only.png": { kind: "file", size: 1, modifiedMs: 1, signature: "p1" } });
  const reconciler = createWebCatalogReconciler({ store, source });
  await reconciler.reconcile();
  assert.ok(store.locate("Deep/A/B/only.png"));

  source.files.delete("Deep/A/B/only.png");
  const third = await reconciler.reconcile();
  assert.equal(third.removed, 1);
  assert.equal(store.locate("Deep/A/B/only.png"), null);
  assert.equal(store.locate("Deep"), null, "the empty ancestor chain is pruned");
  store.close();
});
