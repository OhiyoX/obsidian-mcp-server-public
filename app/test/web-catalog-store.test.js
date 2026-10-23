// Phase 1A unit tests for the pure SQLite Web Catalog store.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// Tree ordering contract: docs/web-explorer-sort-model.md (#178) — folders first,
// pinned zh-Hans collator for `name`, path tie-break always ASC, missing/invalid
// `modified` always last in both directions.
// No HTTP, no routes, no frontend: this layer is deterministic and importable.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openWebCatalogStore } from "../src/app/web-catalog/store.js";
import { WEB_CATALOG_SCHEMA_VERSION } from "../src/app/web-catalog/schema.js";
import { WebCatalogCursorError, decodeWebCatalogCursor, encodeWebCatalogCursor } from "../src/app/web-catalog/cursor.js";
import { WebCatalogPathError } from "../src/app/web-catalog/catalog-path.js";
import { sortTreeLevel } from "../frontend/app/features/explorer/sort-model.js";

// The exact collator the Explorer model pins (docs/web-explorer-sort-model.md §4).
const COLLATOR = new Intl.Collator("zh-Hans", {
  numeric: false,
  sensitivity: "variant",
  ignorePunctuation: false,
});
const collatorSort = (names) =>
  [...names].sort((left, right) => COLLATOR.compare(left.normalize("NFC"), right.normalize("NFC")));

function seed(store) {
  store.upsertDirectory({ path: "_Workspace", name: "_Workspace" });
  store.upsertDirectory({ path: "_Workspace/40-Projects", name: "40-Projects" });
  store.upsertNote({
    path: "_Workspace/40-Projects/README.md",
    size: 10,
    modifiedMs: 3_000,
    tags: ["project"],
    aliases: ["Projects Home"],
    properties: { type: "map" },
    content: "projects readme",
  });
  store.upsertNote({ path: "Notes/Alpha.md", size: 20, modifiedMs: 1_000, content: "alpha body" });
  store.upsertNote({ path: "Notes/Beta.md", size: 30, modifiedMs: 2_000, content: "beta body" });
  store.upsertDirectory({ path: "Notes", name: "Notes" });
  store.upsertNote({ path: "Home.md", size: 5, modifiedMs: 500, content: "home" });
}

// One parent with two folders (to exercise folders-first) and notes covering
// valid (100/200/300) and missing/invalid (null) modified values.
function seedOrdering(store) {
  store.upsertDirectory({ path: "P", name: "P" });
  store.upsertDirectory({ path: "P/SubA", name: "SubA" });
  store.upsertDirectory({ path: "P/SubB", name: "SubB" });
  store.upsertNote({ path: "P/a.md", modifiedMs: 100 });
  store.upsertNote({ path: "P/b.md", modifiedMs: 200 });
  store.upsertNote({ path: "P/z.md", modifiedMs: 300 });
  store.upsertNote({ path: "P/m.md", modifiedMs: null });
  store.upsertNote({ path: "P/n.md", modifiedMs: null });
}

function paginateAll(store, parent, options) {
  const seen = [];
  let cursor = null;
  let guard = 0;
  do {
    const page = store.listChildren(parent, { ...options, cursor });
    seen.push(...page.items.map((item) => item.path));
    cursor = page.nextCursor;
    guard += 1;
  } while (cursor && guard < 50);
  return seen;
}

function cleanupFile(file) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${file}${suffix}`, { force: true });
}

function tmpFile(tag) {
  return path.join(os.tmpdir(), `obsidian-catalog-${tag}-${Date.now()}-${Math.random()}.sqlite`);
}

test("migration is idempotent and starts from an empty generation-0 catalog", () => {
  const store = openWebCatalogStore();
  assert.equal(store.generation(), 0);
  assert.equal(store.isStale(), false);
  assert.equal(store.countNodes(), 0);
  store.upsertNote({ path: "A.md" });
  assert.equal(store.countNodes("note"), 1);
  assert.equal(store.countNodes("directory"), 0);
  store.close();
});

test("listChildren is folders-first and pages by name with a stable keyset cursor", () => {
  const store = openWebCatalogStore();
  seed(store);

  const expected = [...collatorSort(["_Workspace", "Notes"]), "Home.md"];

  const first = store.listChildren("", { limit: 2, sort: "name", direction: "asc" });
  assert.equal(first.parent, "");
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor, "a partial page must expose a cursor");
  assert.equal(first.items[0].kind, "directory");
  assert.equal(first.items[1].kind, "directory");
  assert.equal(first.items[0].hasChildren, true);

  const seen = paginateAll(store, "", { limit: 2, sort: "name", direction: "asc" });
  assert.deepEqual(seen, expected);
  assert.equal(new Set(seen).size, seen.length, "pagination must not repeat rows");
  assert.equal(seen[seen.length - 1], "Home.md", "notes come after every folder");
  store.close();
});

test("sort=modified + desc orders newest first and paginates", () => {
  const store = openWebCatalogStore();
  seed(store);
  const page = store.listChildren("Notes", { limit: 1, sort: "modified", direction: "desc" });
  assert.equal(page.items[0].path, "Notes/Beta.md");
  const next = store.listChildren("Notes", {
    limit: 1,
    sort: "modified",
    direction: "desc",
    cursor: page.nextCursor,
  });
  assert.equal(next.items[0].path, "Notes/Alpha.md");
  assert.equal(next.nextCursor, null);
  store.close();
});

test("tree ordering matches the Explorer contract for all four sort/direction combos", () => {
  const store = openWebCatalogStore();
  seedOrdering(store);

  // Folders first, at name ASC, for BOTH modified directions; missing modified
  // always after valid timestamps; path/name tie-breaks never reversed.
  const expected = {
    "name/asc": ["P/SubA", "P/SubB", "P/a.md", "P/b.md", "P/m.md", "P/n.md", "P/z.md"],
    "name/desc": ["P/SubB", "P/SubA", "P/z.md", "P/n.md", "P/m.md", "P/b.md", "P/a.md"],
    "modified/asc": ["P/SubA", "P/SubB", "P/a.md", "P/b.md", "P/z.md", "P/m.md", "P/n.md"],
    "modified/desc": ["P/SubA", "P/SubB", "P/z.md", "P/b.md", "P/a.md", "P/m.md", "P/n.md"],
  };

  for (const [combo, paths] of Object.entries(expected)) {
    const [sort, direction] = combo.split("/");
    const seen = paginateAll(store, "P", { limit: 2, sort, direction });
    assert.deepEqual(seen, paths, combo);
    assert.equal(new Set(seen).size, seen.length, `${combo} must not repeat rows`);
    assert.equal(seen[0].startsWith("P/Sub"), true, `${combo} must keep folders first`);
  }
  store.close();
});

test("name ordering uses the pinned zh-Hans collator, not SQLite's default text order", () => {
  const store = openWebCatalogStore();
  store.upsertDirectory({ path: "P", name: "P" });
  const names = ["apple.md", "Banana.md", "cherry.md", "中文.md"];
  for (const name of names) store.upsertNote({ path: `P/${name}` });

  const titles = names.map((name) => name.replace(/\.md$/, ""));
  const expected = collatorSort(titles);
  const actual = store
    .listChildren("P", { sort: "name", direction: "asc", limit: 100 })
    .items.map((item) => item.title);
  assert.deepEqual(actual, expected);
  // Prove the fixture actually distinguishes the two orderings.
  assert.notDeepEqual([...titles].sort(), expected);
  store.close();
});

test("collator-equal names share a rank so the path tie-break stays ASC in both directions", () => {
  const store = openWebCatalogStore();
  store.upsertDirectory({ path: "P", name: "P" });
  // NFC-equal but distinct raw paths.
  store.upsertNote({ path: "P/a\u0301.md" });
  store.upsertNote({ path: "P/\u00e1.md" });

  for (const direction of ["asc", "desc"]) {
    const seen = paginateAll(store, "P", { limit: 1, sort: "name", direction });
    assert.deepEqual(seen, ["P/a\u0301.md", "P/\u00e1.md"], `${direction} path tie-break must stay ASC`);
  }
  store.close();
});

test("locate returns the ancestor chain without loading siblings", () => {
  const store = openWebCatalogStore();
  seed(store);
  const found = store.locate("_Workspace/40-Projects/README.md");
  assert.equal(found.kind, "note");
  assert.deepEqual(found.ancestors, ["_Workspace", "_Workspace/40-Projects"]);
  assert.equal(store.locate("missing/Nope.md"), null);
  store.close();
});

test("removePath deletes a directory subtree and its projections", () => {
  const store = openWebCatalogStore();
  seed(store);
  const removed = store.removePath("_Workspace");
  assert.equal(removed, 3, "directory + child directory + note");
  assert.equal(store.locate("_Workspace/40-Projects/README.md"), null);
  assert.equal(store.locate("_Workspace"), null);
  const tags = store.testDb().prepare("SELECT COUNT(*) AS n FROM note_tags").get();
  assert.equal(tags.n, 0);
  const fts = store.testDb().prepare("SELECT COUNT(*) AS n FROM notes_fts").get();
  assert.equal(fts.n, 3, "Home.md + Notes/Alpha.md + Notes/Beta.md remain indexed");
  store.close();
});

test("a cursor is invalidated when the catalog generation changes", () => {
  const store = openWebCatalogStore();
  seed(store);
  const first = store.listChildren("", { limit: 1 });
  assert.ok(first.nextCursor);
  store.bumpGeneration();
  assert.throws(
    () => store.listChildren("", { limit: 1, cursor: first.nextCursor }),
    (error) => error instanceof WebCatalogCursorError && error.code === "WEB_CATALOG_CURSOR_STALE",
  );
  store.close();
});

test("cursor codec round-trips a full identity and fails closed on budget/shape", () => {
  const payload = {
    parent: "Notes",
    sort: "name",
    direction: "asc",
    catalogId: "catalog-a",
    g: 2,
    keys: ["Home.md", "Notes/x.md"],
  };
  assert.deepEqual(decodeWebCatalogCursor(encodeWebCatalogCursor(payload)), { v: 4, ...payload });
  assert.equal(decodeWebCatalogCursor(""), null);
  // Malformed / oversized / wrong-shape cursors fail closed before any query runs.
  assert.throws(() => decodeWebCatalogCursor("not-a-cursor!"), WebCatalogCursorError);
  assert.throws(() => decodeWebCatalogCursor("A".repeat(5000)), WebCatalogCursorError);
  assert.throws(
    () => decodeWebCatalogCursor(encodeWebCatalogCursor({ ...payload, keys: [] })),
    WebCatalogCursorError,
  );
  assert.throws(
    () => decodeWebCatalogCursor(encodeWebCatalogCursor({ ...payload, catalogId: "" })),
    WebCatalogCursorError,
  );
  assert.throws(
    () => decodeWebCatalogCursor(encodeWebCatalogCursor({ ...payload, g: -1 })),
    WebCatalogCursorError,
  );
  assert.throws(
    () => decodeWebCatalogCursor(encodeWebCatalogCursor({ ...payload, keys: [{}] })),
    WebCatalogCursorError,
  );

  const store = openWebCatalogStore();
  seed(store);
  const cursor = store.listChildren("Notes", { limit: 1 }).nextCursor;
  assert.throws(() => store.listChildren("_Workspace", { limit: 1, cursor }), WebCatalogCursorError);
  store.close();
});

test("every data mutation publishes a new generation, fencing a cursor issued before it", () => {
  const store = openWebCatalogStore();
  store.upsertDirectory({ path: "P", name: "P" });
  store.upsertNote({ path: "P/a.md", modifiedMs: 1 });
  store.upsertNote({ path: "P/b.md", modifiedMs: 2 });

  const page = store.listChildren("P", { limit: 1 });
  assert.ok(page.nextCursor);
  const generation = store.generation();

  store.upsertNote({ path: "P/new.md", modifiedMs: 3 });
  assert.equal(store.generation(), generation + 1);
  assert.throws(() => store.listChildren("P", { limit: 1, cursor: page.nextCursor }), WebCatalogCursorError);

  const afterInsert = store.listChildren("P", { limit: 1 });
  assert.ok(afterInsert.nextCursor);
  store.removePath("P/new.md");
  assert.throws(() => store.listChildren("P", { limit: 1, cursor: afterInsert.nextCursor }), WebCatalogCursorError);
  store.close();
});

test("batch() commits several mutations as one generation and one atomic publish", () => {
  const store = openWebCatalogStore();
  const before = store.generation();
  store.batch(() => {
    store.upsertDirectory({ path: "P", name: "P" });
    store.upsertNote({ path: "P/a.md", content: "a" });
    store.upsertNote({ path: "P/b.md", content: "b" });
  });
  assert.equal(store.generation(), before + 1, "one batch == one published generation");
  assert.ok(store.locate("P/a.md"));
  assert.ok(store.locate("P/b.md"));
  store.close();
});

test("a throwing batch rolls back every partial write and does not advance the generation", () => {
  const store = openWebCatalogStore();
  const before = store.generation();
  assert.throws(() => {
    store.batch(() => {
      store.upsertNote({ path: "P/a.md", content: "partial" });
      throw new Error("boom");
    });
  }, /boom/);
  assert.equal(store.locate("P/a.md"), null, "no half-written node may survive");
  assert.equal(store.testDb().prepare("SELECT COUNT(*) AS n FROM notes_fts").get().n, 0);
  assert.equal(store.generation(), before);
  store.close();
});

test("upsert replaces FTS content: the old token disappears and the new one is searchable", () => {
  const store = openWebCatalogStore();
  const matches = (term) =>
    store.testDb().prepare("SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH ?").get(term).n;

  store.upsertNote({ path: "A.md", content: "alpha-token beta-token" });
  assert.equal(matches("alpha"), 1);
  assert.equal(matches("beta"), 1);

  store.upsertNote({ path: "A.md", content: "gamma-token" });
  assert.equal(matches("alpha"), 0, "stale FTS rows must be removed on update");
  assert.equal(matches("gamma"), 1);

  store.removePath("A.md");
  assert.equal(matches("gamma"), 0, "removal must drop the FTS row");
  store.close();
});

test("children pagination is served by the ordering indexes (no temp b-tree / full scan)", () => {
  const store = openWebCatalogStore();
  store.upsertDirectory({ path: "P", name: "P" });
  for (let index = 0; index < 200; index += 1) {
    store.upsertNote({ path: `P/n-${String(index).padStart(3, "0")}.md`, modifiedMs: index });
  }
  const plans = [
    ["name", "asc", "nodes_parent_name_asc"],
    ["name", "desc", "nodes_parent_name_desc"],
    ["modified", "asc", "nodes_parent_modified_asc"],
    ["modified", "desc", "nodes_parent_modified_desc"],
  ];
  for (const [sort, direction, index] of plans) {
    const detail = store
      .planListChildren("P", { sort, direction, limit: 10 })
      .map((row) => row.detail)
      .join("\n");
    assert.match(detail, new RegExp(`USING INDEX ${index}`), `${sort}/${direction} must use ${index}\n${detail}`);
    assert.doesNotMatch(detail, /TEMP B-TREE/, `${sort}/${direction} must not sort in a temp b-tree\n${detail}`);
    assert.doesNotMatch(detail, /\bSCAN nodes\b/, `${sort}/${direction} must not scan the whole table\n${detail}`);
  }
  store.close();
});

test("an incompatible older schema is rebuilt, never stamped as current", () => {
  const file = tmpFile("legacy");
  const legacy = new DatabaseSync(file);
  legacy.exec(
    "CREATE TABLE nodes (path TEXT PRIMARY KEY, parent_path TEXT NOT NULL);" +
      "CREATE TABLE catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
  );
  legacy.prepare("INSERT INTO catalog_meta (key, value) VALUES ('schemaVersion', '1')").run();
  legacy.prepare("INSERT INTO nodes (path, parent_path) VALUES ('legacy.md', '')").run();
  legacy.close();

  const store = openWebCatalogStore({ file });
  assert.equal(store.locate("legacy.md"), null, "rows from an incompatible schema must not survive");
  assert.equal(store.metaGet("schemaVersion"), String(WEB_CATALOG_SCHEMA_VERSION));
  store.upsertNote({ path: "fresh.md", content: "fresh" });
  assert.equal(store.locate("fresh.md").path, "fresh.md");
  store.close();
  cleanupFile(file);
});

test("a same-version catalog with an unexpected nodes shape is still rebuilt", () => {
  const file = tmpFile("shape");
  const legacy = new DatabaseSync(file);
  legacy.exec(
    "CREATE TABLE nodes (path TEXT PRIMARY KEY, parent_path TEXT NOT NULL, name TEXT NOT NULL);" +
      "CREATE TABLE catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
  );
  legacy
    .prepare("INSERT INTO catalog_meta (key, value) VALUES ('schemaVersion', ?)")
    .run(String(WEB_CATALOG_SCHEMA_VERSION));
  legacy.prepare("INSERT INTO nodes (path, parent_path, name) VALUES ('stale.md', '', 'stale')").run();
  legacy.close();

  const store = openWebCatalogStore({ file });
  assert.equal(store.locate("stale.md"), null);
  store.upsertNote({ path: "ok.md", content: "ok" });
  assert.equal(store.countNodes("note"), 1);
  store.close();
  cleanupFile(file);
});

test("a same-version catalog with a damaged secondary table is rebuilt", () => {
  const file = tmpFile("secondary");
  const seeded = openWebCatalogStore({ file });
  seeded.upsertNote({ path: "Keep.md", tags: ["kept"] });
  seeded.close();

  const raw = new DatabaseSync(file);
  raw.exec("DROP TABLE note_tags; CREATE TABLE note_tags (path TEXT NOT NULL);");
  raw.close();

  const store = openWebCatalogStore({ file });
  assert.equal(store.locate("Keep.md"), null, "a damaged note_tags must force a rebuild");
  store.upsertNote({ path: "Fresh.md", tags: ["x"] });
  assert.equal(store.testDb().prepare("SELECT COUNT(*) AS n FROM note_tags").get().n, 1);
  store.close();
  cleanupFile(file);
});

test("a same-version catalog whose FTS table is no longer FTS5 is rebuilt", () => {
  const file = tmpFile("fts");
  const seeded = openWebCatalogStore({ file });
  seeded.upsertNote({ path: "Keep.md", content: "keep" });
  seeded.close();

  const raw = new DatabaseSync(file);
  raw.exec("DROP TABLE notes_fts; CREATE TABLE notes_fts (path TEXT, title TEXT, aliases TEXT, tags TEXT, content TEXT);");
  raw.close();

  const store = openWebCatalogStore({ file });
  assert.equal(store.locate("Keep.md"), null, "a non-FTS5 notes_fts must force a rebuild");
  store.upsertNote({ path: "Searchable.md", content: "gamma" });
  assert.equal(
    store.testDb().prepare("SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH 'gamma'").get().n,
    1,
  );
  store.close();
  cleanupFile(file);
});

test("a file-backed catalog persists nodes and generation across close/reopen", () => {
  const file = tmpFile("persist");
  const first = openWebCatalogStore({ file });
  first.upsertNote({ path: "Keep.md", content: "hello", tags: ["kept"] });
  first.upsertNote({ path: "Keep2.md", modifiedMs: 5 });
  const generation = first.generation();
  const order = first.listChildren("", { sort: "name", direction: "asc" }).items.map((item) => item.path);
  first.close();

  const second = openWebCatalogStore({ file });
  assert.equal(second.locate("Keep.md").path, "Keep.md");
  assert.equal(second.countNodes("note"), 2);
  assert.equal(second.generation(), generation, "generation must survive reopen, not reset to 0");
  assert.equal(second.metaGet("schemaVersion"), String(WEB_CATALOG_SCHEMA_VERSION));
  assert.deepEqual(
    second.listChildren("", { sort: "name", direction: "asc" }).items.map((item) => item.path),
    order,
  );
  second.close();
  cleanupFile(file);
});

test("a catalog missing an entire owned table is rebuilt, not silently recreated empty", () => {
  for (const table of ["note_tags", "notes_fts"]) {
    const file = tmpFile(`missing-${table}`);
    const seeded = openWebCatalogStore({ file });
    seeded.upsertNote({ path: "Keep.md", tags: ["kept"], content: "keep" });
    seeded.close();

    const raw = new DatabaseSync(file);
    raw.exec(`DROP TABLE ${table}`);
    raw.close();

    const store = openWebCatalogStore({ file });
    assert.equal(store.locate("Keep.md"), null, `a missing ${table} must force a full rebuild`);
    assert.equal(store.metaGet("schemaVersion"), String(WEB_CATALOG_SCHEMA_VERSION));
    store.upsertNote({ path: "Fresh.md", tags: ["x"], content: "gamma" });
    assert.equal(store.testDb().prepare("SELECT COUNT(*) AS n FROM note_tags").get().n, 1);
    assert.equal(
      store.testDb().prepare("SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH 'gamma'").get().n,
      1,
    );
    store.close();
    cleanupFile(file);
  }
});

test("a catalog missing schemaVersion is rebuilt, not stamped as current", () => {
  const file = tmpFile("noversion");
  const seeded = openWebCatalogStore({ file });
  seeded.upsertNote({ path: "Keep.md", tags: ["kept"] });
  seeded.close();

  const raw = new DatabaseSync(file);
  raw.exec("DELETE FROM catalog_meta WHERE key = 'schemaVersion'");
  raw.close();

  const store = openWebCatalogStore({ file });
  assert.equal(store.locate("Keep.md"), null, "a missing schemaVersion must force a rebuild");
  assert.equal(store.metaGet("schemaVersion"), String(WEB_CATALOG_SCHEMA_VERSION));
  store.upsertNote({ path: "Fresh.md" });
  assert.equal(store.locate("Fresh.md").path, "Fresh.md");
  store.close();
  cleanupFile(file);
});

test("the path tie-break is raw JS UTF-16 order (BMP vs supplementary), not SQLite BINARY", () => {
  const store = openWebCatalogStore();
  store.upsertDirectory({ path: "P", name: "P" });
  // Collator-equal names: JS UTF-16 orders the supplementary char (U+242EE) before
  // the BMP char (U+FA6C), while UTF-8/SQLite BINARY orders them the other way.
  const bmp = "P/\uFA6C.md";
  const supplementary = "P/\u{242EE}.md";
  store.upsertNote({ path: bmp });
  store.upsertNote({ path: supplementary });

  const expected = [bmp, supplementary].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  assert.deepEqual(expected, [supplementary, bmp], "sanity: JS UTF-16 puts the supplementary char first");
  for (const direction of ["asc", "desc"]) {
    const seen = paginateAll(store, "P", { limit: 1, sort: "name", direction });
    assert.deepEqual(seen, expected, `${direction} path tie-break must match JS UTF-16`);
  }
  store.close();
});

test("a content/tag-only save touches only its own ordering row, not its siblings", () => {
  const store = openWebCatalogStore();
  store.upsertDirectory({ path: "P", name: "P" });
  for (let index = 0; index < 50; index += 1) {
    store.upsertNote({ path: `P/n-${String(index).padStart(2, "0")}.md`, modifiedMs: index });
  }

  const before = store.rankWrites();
  store.upsertNote({ path: "P/n-25.md", content: "updated body", tags: ["t"] });
  assert.equal(store.rankWrites() - before, 1, "content/tag save must be O(1), not O(children)");

  // A brand-new sibling legitimately re-ranks the whole parent.
  const beforeInsert = store.rankWrites();
  store.upsertNote({ path: "P/aaa.md" });
  assert.ok(store.rankWrites() - beforeInsert >= 51, "a new sibling must re-rank the parent");
  store.close();
});

test("a cursor from another catalog is rejected even with the same generation", () => {
  const first = openWebCatalogStore();
  const second = openWebCatalogStore();
  for (const store of [first, second]) {
    store.upsertDirectory({ path: "Notes", name: "Notes" });
    for (let index = 0; index < 4; index += 1) store.upsertNote({ path: `Notes/n-${index}.md` });
  }
  assert.notEqual(first.catalogId(), second.catalogId(), "each catalog has its own identity");
  assert.equal(first.generation(), second.generation(), "fixture must share a generation number");
  const cursor = first.listChildren("Notes", { limit: 2 }).nextCursor;
  assert.ok(cursor);
  assert.throws(() => second.listChildren("Notes", { limit: 2, cursor }), WebCatalogCursorError);
  first.close();
  second.close();
});

test("the Store rejects non-canonical paths instead of normalizing them", () => {
  const store = openWebCatalogStore();
  const invalid = ["/abs.md", "a//b.md", "a/../b.md", "..", "a\\b.md", "a\u0000b.md", "a/b/", "C:/x.md", "./a.md"];
  for (const bad of invalid) {
    assert.throws(() => store.upsertNote({ path: bad }), WebCatalogPathError, `upsertNote ${bad}`);
    assert.throws(() => store.upsertDirectory({ path: bad }), WebCatalogPathError, `upsertDirectory ${bad}`);
    assert.throws(() => store.removePath(bad), WebCatalogPathError, `removePath ${bad}`);
    assert.throws(() => store.locate(bad), WebCatalogPathError, `locate ${bad}`);
    assert.throws(() => store.listChildren(bad), WebCatalogPathError, `listChildren ${bad}`);
  }
  assert.throws(() => store.upsertNote({ path: "" }), WebCatalogPathError, "empty note path");
  assert.doesNotThrow(() => store.listChildren(""));
  store.close();
});

test("subtree removal escapes % and _ and never touches same-prefix siblings", () => {
  const store = openWebCatalogStore();
  for (const dir of ["a%b", "axb", "c_d", "cxd"]) store.upsertDirectory({ path: dir, name: dir });
  store.upsertNote({ path: "a%b/1.md" });
  store.upsertNote({ path: "axb/2.md" });
  store.upsertNote({ path: "c_d/1.md" });
  store.upsertNote({ path: "cxd/2.md" });

  assert.equal(store.removePath("a%b"), 2, "a%b + a%b/1.md");
  assert.ok(store.locate("axb"));
  assert.ok(store.locate("axb/2.md"));

  assert.equal(store.removePath("c_d"), 2, "c_d + c_d/1.md");
  assert.ok(store.locate("cxd"));
  assert.ok(store.locate("cxd/2.md"));
  store.close();
});

test("limit boundaries are deterministic (0 / negative / NaN / over-cap)", () => {
  const store = openWebCatalogStore();
  store.upsertDirectory({ path: "P", name: "P" });
  for (let index = 0; index < 5; index += 1) store.upsertNote({ path: `P/n-${index}.md` });
  assert.equal(store.listChildren("P", { limit: 0 }).items.length, 1);
  assert.equal(store.listChildren("P", { limit: -3 }).items.length, 1);
  assert.equal(store.listChildren("P", { limit: Number.NaN }).items.length, 5);
  assert.equal(store.listChildren("P", { limit: 10_000 }).items.length, 5);
  store.close();
});

test("a persisted sort-contract mismatch rebuilds instead of trusting old ranks", () => {
  const file = tmpFile("sortcontract");
  const seeded = openWebCatalogStore({ file });
  seeded.upsertNote({ path: "Keep.md", tags: ["kept"] });
  seeded.close();

  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE catalog_meta SET value = ? WHERE key = 'sortContract'").run('{"version":0}');
  raw.close();

  const store = openWebCatalogStore({ file });
  assert.equal(store.locate("Keep.md"), null, "an incompatible sort contract must rebuild");
  assert.ok(store.catalogId().length > 0);
  store.upsertNote({ path: "Fresh.md" });
  assert.equal(store.locate("Fresh.md").path, "Fresh.md");
  store.close();
  cleanupFile(file);
});

test("a wrong-definition required index is rebuilt (not kept by IF NOT EXISTS)", () => {
  const file = tmpFile("wrongindex");
  const seeded = openWebCatalogStore({ file });
  seeded.upsertNote({ path: "Keep.md" });
  seeded.close();

  const raw = new DatabaseSync(file);
  raw.exec("DROP INDEX nodes_parent_name_asc");
  raw.exec("CREATE INDEX nodes_parent_name_asc ON nodes(path)");
  raw.close();

  const store = openWebCatalogStore({ file });
  assert.equal(store.locate("Keep.md"), null, "a wrong index definition must force a rebuild");
  store.upsertNote({ path: "Fresh.md" });
  assert.equal(store.locate("Fresh.md").path, "Fresh.md");
  store.close();
  cleanupFile(file);
});

test("a missing required index is repaired in place without losing data", () => {
  const file = tmpFile("missingindex");
  const seeded = openWebCatalogStore({ file });
  seeded.upsertNote({ path: "Keep.md" });
  seeded.close();

  const raw = new DatabaseSync(file);
  raw.exec("DROP INDEX nodes_parent_name_asc");
  raw.close();

  const store = openWebCatalogStore({ file });
  assert.equal(store.locate("Keep.md").path, "Keep.md", "a missing index must be repaired, not rebuilt");
  const repaired = store
    .testDb()
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = 'nodes_parent_name_asc'")
    .get();
  assert.ok(repaired, "the index must be recreated");
  store.close();
  cleanupFile(file);
});

test("missing or non-finite catalogGeneration is rebuilt instead of silently reset", () => {
  for (const bad of [null, "", "abc", "Infinity", "-1", "1e3"]) {
    const file = tmpFile("generation");
    const seeded = openWebCatalogStore({ file });
    seeded.upsertNote({ path: "Keep.md" });
    seeded.close();

    const raw = new DatabaseSync(file);
    if (bad === null) raw.exec("DELETE FROM catalog_meta WHERE key = 'catalogGeneration'");
    else raw.prepare("UPDATE catalog_meta SET value = ? WHERE key = 'catalogGeneration'").run(bad);
    raw.close();

    const store = openWebCatalogStore({ file });
    assert.equal(store.locate("Keep.md"), null, `generation ${bad} must force a rebuild`);
    assert.equal(store.generation(), 0);
    store.close();
    cleanupFile(file);
  }
});

test("a failed migration rolls back and leaves the previous catalog intact", () => {
  const file = tmpFile("rollback");
  const seeded = openWebCatalogStore({ file });
  seeded.upsertNote({ path: "Keep.md", content: "keep" });
  seeded.close();

  const raw = new DatabaseSync(file);
  // A VIEW named notes_fts makes DROP TABLE notes_fts fail inside the rebuild, so
  // the migration transaction must roll back instead of publishing a half state.
  raw.exec("DROP TABLE notes_fts");
  raw.exec("CREATE VIEW notes_fts AS SELECT 1 AS path");
  raw.close();

  assert.throws(() => openWebCatalogStore({ file }));

  const verify = new DatabaseSync(file);
  assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM nodes WHERE path = 'Keep.md'").get().n, 1);
  verify.close();
  cleanupFile(file);
});

// Fixture shared by the cross-implementation parity test: folders + notes, ASCII
// case / Chinese / punctuation / NFC-NFD / BMP+supplementary / collator-equal /
// same modified / missing modified.
function parityFixture(store) {
  store.upsertDirectory({ path: "Root", name: "Root" });
  for (const name of ["Alpha", "_zeta", "中文夹", "A"]) store.upsertDirectory({ path: `Root/${name}`, name });
  const notes = [
    ["apple.md", 1000],
    ["Banana.md", null],
    ["中文.md", 500],
    ["!punct.md", 1000],
    ["e\u0301.md", 300],
    ["\u00e9.md", 400],
    ["\uFA6C.md", 100],
    ["\u{242EE}.md", 100],
    ["same-a.md", 700],
    ["same-b.md", 700],
    ["missing.md", null],
  ];
  for (const [name, modifiedMs] of notes) store.upsertNote({ path: `Root/${name}`, modifiedMs });
  // Wave B / A2: BASE shares the file rank and the note sort tuple, so it must
  // interleave with notes. Includes a same-stem note/base pair (path tie-break)
  // and a missing `modified` base.
  const bases = [
    ["apple.base", 1000],
    ["中文.base", 500],
    ["zeta.base", null],
    ["missing-base.base", null],
  ];
  for (const [name, modifiedMs] of bases) store.upsertBase({ path: `Root/${name}`, modifiedMs });
}

test("cross-implementation parity: listChildren equals #178 sortTreeLevel() for all combos/page sizes", () => {
  const file = tmpFile("parity");
  const store = openWebCatalogStore({ file });
  parityFixture(store);

  const full = store.listChildren("Root", { limit: 500, sort: "name", direction: "asc" }).items;
  const folders = full.filter((item) => item.kind === "directory");
  // `sortTreeLevel` has one flat file group; NOTE + BASE must round-trip through it
  // as a single server-ordered file list.
  const notes = full.filter((item) => item.kind !== "directory");
  assert.ok(folders.length > 0 && notes.length > 0, "fixture must mix folders and files");
  assert.ok(notes.some((item) => item.kind === "note") && notes.some((item) => item.kind === "base"), "fixture must mix notes and bases");
  store.close();

  for (const reopen of [1, 2]) {
    const active = openWebCatalogStore({ file });
    for (const key of ["name", "modified"]) {
      for (const direction of ["asc", "desc"]) {
        const expected = sortTreeLevel({ folders, notes }, { key, direction });
        const expectedPaths = [...expected.folders, ...expected.notes].map((record) => record.path);
        for (const pageSize of [1, 2, 3, 100]) {
          const seen = paginateAll(active, "Root", { limit: pageSize, sort: key, direction });
          assert.deepEqual(seen, expectedPaths, `${key}/${direction} pageSize=${pageSize} open=${reopen}`);
        }
      }
    }
    active.close();
  }
  cleanupFile(file);
});

test("5k-child write-amplification gate: content/modified saves are O(1)", () => {
  const store = openWebCatalogStore();
  store.upsertDirectory({ path: "Big", name: "Big" });
  store.batch(() => {
    for (let index = 0; index < 5000; index += 1) {
      store.upsertNote({ path: `Big/n-${String(index).padStart(5, "0")}.md`, modifiedMs: index });
    }
  });
  assert.ok(store.rankWrites() <= 5001, `bulk insert must re-rank the parent once, got ${store.rankWrites()}`);

  const contentBefore = store.rankWrites();
  store.upsertNote({ path: "Big/n-02500.md", content: "updated", tags: ["t"], properties: { a: 1 } });
  assert.equal(store.rankWrites() - contentBefore, 1, "content/tag/property save must be O(1)");

  const modifiedBefore = store.rankWrites();
  store.upsertNote({ path: "Big/n-02500.md", modifiedMs: 999_999 });
  assert.equal(store.rankWrites() - modifiedBefore, 1, "modified-only save must be O(1)");
  store.close();
});

test("generation overflow past MAX_SAFE_INTEGER fails closed without publishing", () => {
  const store = openWebCatalogStore();
  store.upsertNote({ path: "A.md" });
  store
    .testDb()
    .prepare("UPDATE catalog_meta SET value = ? WHERE key = 'catalogGeneration'")
    .run(String(Number.MAX_SAFE_INTEGER));
  assert.equal(store.generation(), Number.MAX_SAFE_INTEGER);

  assert.throws(() => store.bumpGeneration(), /overflow/);
  assert.equal(store.generation(), Number.MAX_SAFE_INTEGER, "a failed bump must not publish");

  // A normal mutation goes through the same guard and rolls back entirely.
  assert.throws(() => store.upsertNote({ path: "B.md" }), /overflow/);
  assert.equal(store.locate("B.md"), null);
  store.close();
});

test("a failed batch does not leave dirty parents for the next transaction", () => {
  const store = openWebCatalogStore();
  store.upsertDirectory({ path: "P", name: "P" });
  store.upsertNote({ path: "P/n.md", content: "p" });
  store.upsertDirectory({ path: "Q", name: "Q" });
  for (let index = 0; index < 10; index += 1) store.upsertNote({ path: `Q/n-${index}.md` });

  const before = store.rankWrites();
  assert.throws(() => {
    store.batch(() => {
      // A new sibling marks Q dirty before the batch throws and rolls back.
      store.upsertNote({ path: "Q/new.md", content: "partial" });
      throw new Error("boom");
    });
  }, /boom/);

  // A content-only save under P must touch only its own row; a leaked Q dirty
  // entry would rewrite Q's 10 siblings as well.
  store.upsertNote({ path: "P/n.md", content: "updated" });
  assert.equal(store.rankWrites() - before, 1, "a rolled-back batch must not dirty Q");
  store.close();
});

test("removePath prunes orphan ancestor directories but keeps populated ones", () => {
  const store = openWebCatalogStore();
  store.upsertDirectory({ path: "Deep", name: "Deep" });
  store.upsertDirectory({ path: "Deep/A", name: "A" });
  store.upsertNote({ path: "Deep/A/Only.md" });
  assert.equal(store.removePath("Deep/A/Only.md"), 1);
  assert.equal(store.locate("Deep/A"), null, "an empty ancestor must be pruned");
  assert.equal(store.locate("Deep"), null, "the whole orphan chain is pruned");

  store.upsertDirectory({ path: "Keep", name: "Keep" });
  store.upsertNote({ path: "Keep/one.md" });
  store.upsertNote({ path: "Keep/two.md" });
  store.removePath("Keep/one.md");
  assert.ok(store.locate("Keep"), "an ancestor with remaining notes must survive");
  store.close();
});
