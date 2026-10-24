// S2: `file` (attachment) catalog node, ordering, DTO, migration and projection.
//
// Contract: Web/TODO - Explorer 附件条目与后缀徽标（S2）.md §落地步骤 1/2/4 — a
// non-Markdown/non-Base regular file is a `file` node that records path/name/
// extension/size/mtime only. Directories rank 0; NOTE, BASE and FILE share file
// rank 1 with the identical sort tuple; a file never enters note projections, FTS
// or semantic candidates; locate/remove/prune and schema rebuild expose files.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openWebCatalogStore } from "../src/app/web-catalog/store.js";
import { WEB_CATALOG_SCHEMA_VERSION } from "../src/app/web-catalog/schema.js";
import { WebCatalogCursorError } from "../src/app/web-catalog/cursor.js";
import { catalogKindForName, isCatalogInventoryPath, FILE_KIND } from "../src/app/web-catalog/vault-source.js";
import { extensionOf } from "../src/app/web-catalog/catalog-path.js";
import { ensureCatalogDirectories, upsertCatalogFile, fileRecordFromEntry } from "../src/app/web-catalog/indexer.js";
import { joinSemanticCandidates } from "../src/app/web-catalog/semantic-candidates.js";
import { sortTreeLevel } from "../frontend/app/features/explorer/sort-model.js";

function cleanupFile(file) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${file}${suffix}`, { force: true });
}
function tmpFile(tag) {
  return path.join(os.tmpdir(), `obsidian-catalog-file-${tag}-${Date.now()}-${Math.random()}.sqlite`);
}
const paths = (page) => page.items.map((item) => item.path);

test("catalogKindForName/isCatalogInventoryPath classify attachments, not hidden paths", () => {
  assert.equal(catalogKindForName("A.md"), "note");
  assert.equal(catalogKindForName("A.MD"), "note");
  assert.equal(catalogKindForName("A.base"), "base");
  assert.equal(catalogKindForName("A.BASE"), "base");
  assert.equal(catalogKindForName("photo.png"), FILE_KIND);
  assert.equal(catalogKindForName("archive.tar.gz"), FILE_KIND);
  assert.equal(catalogKindForName("LICENSE"), FILE_KIND, "an extension-less file is still an attachment");
  assert.equal(isCatalogInventoryPath("Notes/photo.png"), true);
  assert.equal(isCatalogInventoryPath("LICENSE"), true);
  assert.equal(isCatalogInventoryPath(".hidden/photo.png"), false);
  assert.equal(isCatalogInventoryPath("Notes/.secret.png"), false);
  assert.equal(isCatalogInventoryPath(""), false);
});

test("extensionOf is a lowercase suffix without the dot, and empty when there is none", () => {
  assert.equal(extensionOf("Notes/photo.PNG"), "png");
  assert.equal(extensionOf("Keys/backup.sha256"), "sha256");
  assert.equal(extensionOf("archive.tar.gz"), "gz");
  assert.equal(extensionOf("LICENSE"), "");
  assert.equal(extensionOf(".gitignore"), "", "a dotfile prefix is not an extension");
  assert.equal(extensionOf("trailing."), "");
});

test("FILE is a typed node with the note DTO shape plus a badge extension", () => {
  const store = openWebCatalogStore();
  store.upsertFile({ path: "Assets/photo.PNG", size: 12, modifiedMs: 100 });
  store.upsertNote({ path: "Assets/Note.md", size: 5, modifiedMs: 200, content: "x" });

  const page = store.listChildren("Assets", { sort: "name", direction: "asc" });
  assert.deepEqual(paths(page), ["Assets/Note.md", "Assets/photo.PNG"]);
  const file = page.items[1];
  assert.equal(file.kind, FILE_KIND);
  assert.equal(file.name, "photo.PNG");
  assert.equal(file.title, "photo.PNG", "an attachment keeps its full file name (no title to strip)");
  assert.equal(file.extension, "png");
  assert.equal(file.size, 12);
  assert.equal(file.modified, new Date(100).toISOString());
  assert.equal(page.items[0].extension, undefined, "a note does not gain an extension field");
  assert.equal(store.locate("Assets/photo.PNG").kind, FILE_KIND);
  assert.equal(store.countNodes("file"), 1);
  store.close();
});

test("directory always ranks before files; note/base/file interleave by one sort tuple", () => {
  const store = openWebCatalogStore();
  store.upsertDirectory({ path: "P" });
  store.upsertDirectory({ path: "P/Sub" });
  store.upsertNote({ path: "P/a.md", modifiedMs: 100 });
  store.upsertBase({ path: "P/b.base", modifiedMs: 200 });
  store.upsertFile({ path: "P/c.txt", modifiedMs: 300 });
  store.upsertFile({ path: "P/d.pdf", modifiedMs: null });

  assert.deepEqual(paths(store.listChildren("P", { sort: "name", direction: "asc" })), [
    "P/Sub",
    "P/a.md",
    "P/b.base",
    "P/c.txt",
    "P/d.pdf",
  ]);
  assert.deepEqual(paths(store.listChildren("P", { sort: "name", direction: "desc" })), [
    "P/Sub",
    "P/d.pdf",
    "P/c.txt",
    "P/b.base",
    "P/a.md",
  ]);
  assert.deepEqual(paths(store.listChildren("P", { sort: "modified", direction: "asc" })), [
    "P/Sub",
    "P/a.md",
    "P/b.base",
    "P/c.txt",
    "P/d.pdf",
  ]);
  // A missing `modified` file always sorts last, and never flips under `desc`.
  assert.deepEqual(paths(store.listChildren("P", { sort: "modified", direction: "desc" })), [
    "P/Sub",
    "P/c.txt",
    "P/b.base",
    "P/a.md",
    "P/d.pdf",
  ]);
  assert.ok(
    store
      .testDb()
      .prepare("SELECT kind_rank FROM nodes WHERE path LIKE 'P/%' AND kind != 'directory'")
      .all()
      .every((row) => row.kind_rank === 1),
    "note/base/file all share file rank 1",
  );
  store.close();
});

test("the server order matches #178 sortTreeLevel for a folder/note/base/file level", () => {
  const store = openWebCatalogStore();
  store.upsertDirectory({ path: "Root", name: "Root" });
  store.upsertDirectory({ path: "Root/Dir", name: "Dir" });
  store.upsertNote({ path: "Root/apple.md", modifiedMs: 1000 });
  store.upsertBase({ path: "Root/banana.base", modifiedMs: null });
  store.upsertFile({ path: "Root/cherry.txt", modifiedMs: 500 });
  store.upsertFile({ path: "Root/delta.PDF", modifiedMs: null });

  const full = store.listChildren("Root", { limit: 100, sort: "name", direction: "asc" }).items;
  const folders = full.filter((item) => item.kind === "directory");
  const notes = full.filter((item) => item.kind !== "directory");

  for (const key of ["name", "modified"]) {
    for (const direction of ["asc", "desc"]) {
      const expected = sortTreeLevel({ folders, notes }, { key, direction });
      assert.deepEqual(
        [...expected.folders, ...expected.notes].map((record) => record.path),
        paths(store.listChildren("Root", { limit: 100, sort: key, direction })),
        `${key}/${direction}`,
      );
    }
  }
  store.close();
});

test("pagination crosses the note/base/file boundary without repeats", () => {
  const store = openWebCatalogStore();
  for (const [name, kind] of [
    ["a.md", "note"],
    ["a.txt", "file"],
    ["b.base", "base"],
    ["b.txt", "file"],
    ["c.txt", "file"],
  ]) {
    if (kind === "note") store.upsertNote({ path: name, modifiedMs: 1 });
    else if (kind === "base") store.upsertBase({ path: name, modifiedMs: 1 });
    else store.upsertFile({ path: name, modifiedMs: 1 });
  }
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
  assert.deepEqual(full, ["a.md", "a.txt", "b.base", "b.txt", "c.txt"]);
  store.close();
});

test("a file write never touches note projections, FTS or semantic candidates", () => {
  const store = openWebCatalogStore();
  store.upsertFile({ path: "Assets/photo.png", size: 3, modifiedMs: 1, content: "# not a note" });
  const db = store.testDb();
  const count = (sql) => db.prepare(sql).get().n;
  assert.equal(count("SELECT COUNT(*) AS n FROM notes_fts"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM note_tags"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM note_properties"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM note_links"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM note_frontmatter_state"), 0);

  // Even a retrieval snapshot that names the attachment must not become a Web item.
  const joined = joinSemanticCandidates({ store, recall: { results: [{ path: "Assets/photo.png", score: 0.9 }] } });
  assert.deepEqual(joined.items, []);
  store.close();
});

test("a note that flips to a file drops its note projections and Base fault", () => {
  const store = openWebCatalogStore();
  store.upsertNote({ path: "Swap.md", content: "body", tags: ["t"], properties: { a: 1 } });
  assert.equal(store.testDb().prepare("SELECT COUNT(*) AS n FROM notes_fts").get().n, 1);

  store.upsertFile({ path: "Swap.md", size: 3, modifiedMs: 2 });
  assert.equal(store.locate("Swap.md").kind, FILE_KIND);
  assert.equal(store.testDb().prepare("SELECT COUNT(*) AS n FROM notes_fts").get().n, 0);
  assert.equal(store.testDb().prepare("SELECT COUNT(*) AS n FROM note_tags").get().n, 0);
  assert.equal(store.baseProjectionStatus().complete, true);
  store.close();
});

test("upsertCatalogFile is metadata-only and idempotent for an unchanged mtime", () => {
  const store = openWebCatalogStore();
  const entry = fileRecordFromEntry({
    path: "Notes/scan.pdf",
    size: 42,
    modifiedMs: 900,
    metadataRevision: "42:900:1:2",
  });
  assert.deepEqual(entry, {
    path: "Notes/scan.pdf",
    name: "scan.pdf",
    size: 42,
    modifiedMs: 900,
    createdMs: null,
    metadataRevision: "42:900:1:2",
  });

  assert.equal(upsertCatalogFile(store, entry).skipped, false);
  assert.ok(store.locate("Notes/scan.pdf"));
  assert.ok(store.locate("Notes"), "an attachment creates its ancestor chain");
  assert.equal(upsertCatalogFile(store, entry).skipped, true, "same mtime => no second publication");
  assert.equal(upsertCatalogFile(store, { ...entry, modifiedMs: 901 }).skipped, false);
  assert.equal(store.locate("Notes/scan.pdf").modified_ms, 901);
  store.close();
});

test("removePath deletes a file and prunes an orphan ancestor chain", () => {
  const store = openWebCatalogStore();
  ensureCatalogDirectories(store, "Deep/A/B/photo.png");
  store.upsertFile({ path: "Deep/A/B/photo.png", size: 1, modifiedMs: 1 });
  assert.ok(store.locate("Deep/A/B"));
  assert.equal(store.removePath("Deep/A/B/photo.png"), 1);
  assert.equal(store.locate("Deep/A/B/photo.png"), null);
  assert.equal(store.locate("Deep"), null, "the empty ancestor chain is pruned");

  store.upsertFile({ path: "Fresh.txt", size: 1, modifiedMs: 1 });
  assert.equal(store.locate("Fresh.txt").kind, FILE_KIND);
  store.close();
});

test("a cursor issued before a file mutation is stale across the generation change", () => {
  const store = openWebCatalogStore();
  store.upsertFile({ path: "A.txt", modifiedMs: 1 });
  store.upsertFile({ path: "B.txt", modifiedMs: 2 });
  const first = store.listChildren("", { sort: "name", direction: "asc", limit: 1 });
  assert.ok(first.nextCursor);
  store.upsertFile({ path: "C.txt", modifiedMs: 3 });
  assert.throws(
    () => store.listChildren("", { sort: "name", direction: "asc", limit: 1, cursor: first.nextCursor }),
    WebCatalogCursorError,
  );
  store.close();
});

test("a persisted v8 catalog is rebuilt and then exposes file nodes", () => {
  const file = tmpFile("v8");
  const seeded = openWebCatalogStore({ file });
  seeded.upsertNote({ path: "Keep.md", tags: ["kept"], content: "keep" });
  seeded.close();

  // Simulate a pre-S2 catalog: same table shape, schemaVersion 8 (no file nodes yet).
  const raw = new DatabaseSync(file);
  raw.exec("UPDATE catalog_meta SET value = '8' WHERE key = 'schemaVersion';");
  raw.close();

  const store = openWebCatalogStore({ file });
  assert.equal(store.metaGet("schemaVersion"), String(WEB_CATALOG_SCHEMA_VERSION));
  assert.equal(store.locate("Keep.md"), null, "a v8 catalog must be rebuilt, never stamped current");
  store.upsertFile({ path: "Keep.png", size: 9, modifiedMs: 5 });
  assert.equal(store.locate("Keep.png").kind, FILE_KIND);
  assert.equal(store.listChildren("", { sort: "name", direction: "asc" }).items[0].extension, "png");
  store.close();
  cleanupFile(file);
});
