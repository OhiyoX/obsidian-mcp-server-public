// Wave A / A2: BASE catalog node, ordering, migration and projection tests.
//
// Contract: TODO - Web 显示 Bases 视图 §4.1 / §6.2 / §6.3 — directories rank 0,
// NOTE and BASE share file rank 1 with the identical sort tuple, locate/remove and
// schema rebuild expose bases, and a base never enters note projections or FTS.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openWebCatalogStore } from "../src/app/web-catalog/store.js";
import { WEB_CATALOG_SCHEMA_VERSION } from "../src/app/web-catalog/schema.js";
import { WebCatalogCursorError } from "../src/app/web-catalog/cursor.js";
import { documentKindForName } from "../src/app/web-catalog/vault-source.js";
import { catalogRecordFromRead } from "../src/app/web-catalog/indexer.js";

function cleanupFile(file) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${file}${suffix}`, { force: true });
}
function tmpFile(tag) {
  return path.join(os.tmpdir(), `obsidian-catalog-base-${tag}-${Date.now()}-${Math.random()}.sqlite`);
}
const paths = (page) => page.items.map((item) => item.path);

test("BASE is a typed file node with the note DTO shape", () => {
  const store = openWebCatalogStore();
  store.upsertBase({ path: "Alpha.base", size: 10, modifiedMs: 100, revision: "sha256:b" });
  store.upsertNote({ path: "Beta.md", size: 5, modifiedMs: 200, content: "x" });

  const page = store.listChildren("", { sort: "name", direction: "asc" });
  assert.deepEqual(paths(page), ["Alpha.base", "Beta.md"]);
  assert.equal(page.items[0].kind, "base");
  assert.equal(page.items[0].name, "Alpha.base");
  assert.equal(page.items[0].title, "Alpha");
  assert.equal(page.items[1].kind, "note");
  assert.equal(page.items[1].title, "Beta");
  assert.equal(store.locate("Alpha.base").kind, "base");
  assert.equal(store.countNodes("base"), 1);
  store.close();
});

test(".BASE is case-insensitive everywhere", () => {
  assert.equal(documentKindForName("A.BASE"), "base");
  const store = openWebCatalogStore();
  store.upsertBase({ path: "Folder/A.BASE", size: 1, modifiedMs: 1 });
  assert.equal(store.listChildren("Folder").items[0].title, "A");
  assert.equal(store.locate("Folder/A.BASE").kind, "base");
  store.close();
});

test("directory always ranks before files; note/base interleave by the same sort tuple", () => {
  const store = openWebCatalogStore();
  store.upsertDirectory({ path: "P" });
  store.upsertDirectory({ path: "P/Sub" });
  store.upsertBase({ path: "P/a.base", modifiedMs: 100 });
  store.upsertNote({ path: "P/a.md", modifiedMs: 100 });
  store.upsertNote({ path: "P/b.md", modifiedMs: 200 });
  store.upsertBase({ path: "P/c.base", modifiedMs: 50 });

  assert.deepEqual(paths(store.listChildren("P", { sort: "name", direction: "asc" })), [
    "P/Sub",
    "P/a.base",
    "P/a.md",
    "P/b.md",
    "P/c.base",
  ]);
  assert.deepEqual(paths(store.listChildren("P", { sort: "name", direction: "desc" })), [
    "P/Sub",
    "P/c.base",
    "P/b.md",
    "P/a.base",
    "P/a.md",
  ]);
  assert.deepEqual(paths(store.listChildren("P", { sort: "modified", direction: "asc" })), [
    "P/Sub",
    "P/c.base",
    "P/a.base",
    "P/a.md",
    "P/b.md",
  ]);
  assert.deepEqual(paths(store.listChildren("P", { sort: "modified", direction: "desc" })), [
    "P/Sub",
    "P/b.md",
    "P/a.base",
    "P/a.md",
    "P/c.base",
  ]);
  // Same name_rank for note/base with the same stem => raw path ASC tie-break.
  const ranks = store.testDb().prepare("SELECT path, kind_rank, name_rank FROM nodes WHERE path LIKE 'P/%' ORDER BY path").all();
  assert.ok(ranks.filter((row) => row.path.endsWith(".base") || row.path.endsWith(".md")).every((row) => row.kind_rank === 1));
  store.close();
});

test("pagination crosses the note/base boundary without repeats or hidden grouping", () => {
  const store = openWebCatalogStore();
  for (const name of ["a.base", "a.md", "b.base", "b.md", "c.base"]) store.upsertBase({ path: name, modifiedMs: 1 });
  const full = paths(store.listChildren("", { sort: "name", direction: "asc", limit: 100 }));
  const seen = [];
  let cursor = null;
  let guard = 0;
  do {
    const page = store.listChildren("", { sort: "name", direction: "asc", limit: 1, cursor });
    seen.push(...paths(page));
    cursor = page.nextCursor;
    guard += 1;
  } while (cursor && guard < 20);
  assert.deepEqual(seen, full);
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual(full, ["a.base", "a.md", "b.base", "b.md", "c.base"]);
  store.close();
});

test("a base write never touches note projections or FTS", () => {
  const store = openWebCatalogStore();
  store.upsertBase({ path: "Clean.base", size: 3, modifiedMs: 1, revision: "sha256:x" });
  const db = store.testDb();
  const count = (sql) => db.prepare(sql).get().n;
  assert.equal(count("SELECT COUNT(*) AS n FROM note_tags"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM note_aliases"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM note_properties"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM note_frontmatter_state"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM note_links"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM notes_fts"), 0);
  assert.equal(store.baseProjectionStatus().complete, true);
  store.close();
});

test("removePath deletes a base and rename is remove + add", () => {
  const store = openWebCatalogStore();
  store.upsertBase({ path: "Old.base", size: 1, modifiedMs: 1 });
  assert.equal(store.removePath("Old.base"), 1);
  assert.equal(store.locate("Old.base"), null);
  assert.equal(store.locate("Old"), null, "no orphan ancestor is created");

  store.upsertBase({ path: "Fresh.base", size: 1, modifiedMs: 1 });
  assert.equal(store.locate("Fresh.base").kind, "base");
  store.close();
});

test("a cursor issued before a base mutation is stale across the generation change", () => {
  const store = openWebCatalogStore();
  store.upsertBase({ path: "A.base", modifiedMs: 1 });
  store.upsertBase({ path: "B.base", modifiedMs: 2 });
  const first = store.listChildren("", { sort: "name", direction: "asc", limit: 1 });
  assert.ok(first.nextCursor);
  store.upsertBase({ path: "C.base", modifiedMs: 3 });
  assert.throws(
    () => store.listChildren("", { sort: "name", direction: "asc", limit: 1, cursor: first.nextCursor }),
    WebCatalogCursorError,
  );
  store.close();
});

test("baseProjectionStatus fails closed on an unsupported frontmatter value and can recover", () => {
  const store = openWebCatalogStore();
  const status = () => store.baseProjectionStatus();
  assert.deepEqual(status(), { complete: true, codecVersion: 1, faults: [] });

  const bad = catalogRecordFromRead({
    path: "Bad.md",
    content: "x",
    frontmatter: { ok: 1, value: 2n },
    revision: "r1",
    stat: { size: 1, modified: "2026-01-01T00:00:00.000Z", created: "2026-01-01T00:00:00.000Z" },
  });
  assert.ok(bad.frontmatterFault, "an unsupported value must produce a fault");
  store.upsertNote(bad);
  assert.equal(store.locate("Bad.md").kind, "note", "the note stays visible");
  const failed = status();
  assert.equal(failed.complete, false);
  assert.equal(failed.faults.length, 1);
  assert.equal(failed.faults[0].path, "Bad.md");

  const good = catalogRecordFromRead({
    path: "Bad.md",
    content: "x",
    frontmatter: { ok: 1, value: "now supported" },
    revision: "r2",
    stat: { size: 1, modified: "2026-01-02T00:00:00.000Z", created: "2026-01-01T00:00:00.000Z" },
  });
  store.upsertNote(good);
  assert.deepEqual(status(), { complete: true, codecVersion: 1, faults: [] });
  store.close();
});

test("readDocumentRecords returns the lossless frontmatter tree, tags, links and stat", () => {
  const store = openWebCatalogStore();
  const record = catalogRecordFromRead({
    path: "Notes/Record.md",
    content: "[[Linked]]",
    frontmatter: {
      type: "note",
      count: 3,
      ratio: 1.5,
      ready: true,
      nothing: null,
      list: [1, "a"],
      nested: { deep: [true] },
      when: new Date("2026-01-01T10:00:00.000Z"),
      day: new Date("2026-01-01T00:00:00.000Z"),
    },
    revision: "sha256:rec",
    stat: { size: 42, modified: "2026-02-03T04:05:06.000Z", created: "2026-01-01T00:00:00.000Z" },
  });
  store.upsertNote(record);
  store.upsertNote({ ...record, path: "Notes/Other.md", revision: "sha256:other" });

  const read = store.readDocumentRecords(["Notes/Record.md"]);
  assert.equal(read.length, 1);
  assert.equal(read[0].path, "Notes/Record.md");
  assert.equal(read[0].basename, "Record");
  assert.equal(read[0].size, 42);
  assert.equal(read[0].created, "2026-01-01T00:00:00.000Z");
  assert.equal(read[0].modified, "2026-02-03T04:05:06.000Z");
  assert.equal(read[0].revision, "sha256:rec");
  assert.deepEqual(read[0].links, ["Linked"]);
  assert.deepEqual(read[0].tags, []);
  assert.deepEqual(read[0].frontmatter, {
    type: "note",
    count: 3,
    ratio: 1.5,
    ready: true,
    nothing: null,
    list: [1, "a"],
    nested: { deep: [true] },
    when: new Date("2026-01-01T10:00:00.000Z"),
    day: new Date("2026-01-01T00:00:00.000Z"),
  });
  store.close();
});

test("two Vault catalogs never cross-contaminate note links for the same path", () => {
  const first = openWebCatalogStore();
  const second = openWebCatalogStore();
  first.upsertNote({ ...catalogRecordFromRead({ path: "Same.md", content: "[[FromFirst]]", frontmatter: {}, revision: "a", stat: {} }) });
  second.upsertNote({ ...catalogRecordFromRead({ path: "Same.md", content: "[[FromSecond]]", frontmatter: {}, revision: "b", stat: {} }) });
  assert.deepEqual(first.readDocumentRecord("Same.md").links, ["FromFirst"]);
  assert.deepEqual(second.readDocumentRecord("Same.md").links, ["FromSecond"]);
  first.close();
  second.close();
});

test("a persisted v7 catalog is fully rebuilt and then exposes base nodes", () => {
  const file = tmpFile("v7");
  const seeded = openWebCatalogStore({ file });
  seeded.upsertNote({ path: "Keep.md", tags: ["kept"], content: "keep" });
  seeded.close();

  // Downgrade the catalog shape to v7: no Wave-A tables, old schemaVersion.
  const raw = new DatabaseSync(file);
  raw.exec(
    "DROP INDEX note_links_target_path;" +
      "DROP TABLE note_links;" +
      "DROP TABLE note_frontmatter_state;" +
      "UPDATE catalog_meta SET value = '7' WHERE key = 'schemaVersion';",
  );
  raw.close();

  const store = openWebCatalogStore({ file });
  assert.equal(store.metaGet("schemaVersion"), String(WEB_CATALOG_SCHEMA_VERSION));
  assert.equal(store.locate("Keep.md"), null, "a v7 catalog must be rebuilt, never stamped current");
  store.upsertBase({ path: "Keep.base", size: 9, modifiedMs: 5, revision: "sha256:base" });
  assert.equal(store.locate("Keep.base").kind, "base");
  assert.deepEqual(paths(store.listChildren("", { sort: "name", direction: "asc" })), ["Keep.base"]);
  store.close();
  cleanupFile(file);
});
