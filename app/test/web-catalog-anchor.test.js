// Phase 2A-1 tests: anchor-aware Store primitive (anchor-inclusive keyset).
//
// Contract: `listChildren(parent, { limit, cursor, sort, direction, anchorPath })`
// with cursor/anchor mutual exclusion, an anchor that must be a direct child of the
// parent, and a page whose first item is the anchor — no offset, no raw tuple
// exposed to clients, and the same ordering spec/index as normal cursor paging.
import assert from "node:assert/strict";
import test from "node:test";
import { openWebCatalogStore } from "../src/app/web-catalog/store.js";
import { WebCatalogAnchorError } from "../src/app/web-catalog/cursor.js";

function seed(store) {
  store.upsertDirectory({ path: "P", name: "P" });
  for (const name of ["a", "b", "c", "d", "e"]) store.upsertNote({ path: `P/${name}.md` });
}

test("anchorPath returns an anchor-inclusive page whose first item is the anchor", () => {
  const store = openWebCatalogStore();
  seed(store);

  const page = store.listChildren("P", { limit: 2, sort: "name", direction: "asc", anchorPath: "P/c.md" });
  assert.deepEqual(page.items.map((item) => item.path), ["P/c.md", "P/d.md"]);
  assert.ok(page.nextCursor, "an anchored partial page still exposes a normal cursor");

  const next = store.listChildren("P", { limit: 2, sort: "name", direction: "asc", cursor: page.nextCursor });
  assert.deepEqual(next.items.map((item) => item.path), ["P/e.md"]);
  assert.equal(next.nextCursor, null);
  store.close();
});

test("cursor and anchorPath are mutually exclusive", () => {
  const store = openWebCatalogStore();
  seed(store);
  const cursor = store.listChildren("P", { limit: 1, sort: "name", direction: "asc" }).nextCursor;
  assert.ok(cursor);
  assert.throws(
    () => store.listChildren("P", { limit: 1, cursor, anchorPath: "P/c.md" }),
    (error) => error instanceof WebCatalogAnchorError && error.code === "WEB_CATALOG_ANCHOR_INVALID",
  );
  store.close();
});

test("an anchor that is missing or not a direct child fails closed", () => {
  const store = openWebCatalogStore();
  seed(store);
  store.upsertDirectory({ path: "Q", name: "Q" });
  store.upsertNote({ path: "Q/x.md" });
  store.upsertDirectory({ path: "P/Sub", name: "Sub" });
  store.upsertNote({ path: "P/Sub/deep.md" });

  assert.throws(
    () => store.listChildren("P", { anchorPath: "P/nope.md" }),
    (error) => error instanceof WebCatalogAnchorError && error.code === "WEB_CATALOG_ANCHOR_MISSING",
  );
  assert.throws(
    () => store.listChildren("P", { anchorPath: "Q/x.md" }),
    (error) => error.code === "WEB_CATALOG_ANCHOR_MISSING",
    "an existing note in another parent is not a valid anchor",
  );
  assert.throws(
    () => store.listChildren("P", { anchorPath: "P/Sub/deep.md" }),
    (error) => error.code === "WEB_CATALOG_ANCHOR_MISSING",
    "a grandchild is not a direct child",
  );
  store.close();
});

test("an anchor may be a directory", () => {
  const store = openWebCatalogStore();
  store.upsertDirectory({ path: "P", name: "P" });
  store.upsertDirectory({ path: "P/Folder", name: "Folder" });
  store.upsertNote({ path: "P/z.md" });
  const page = store.listChildren("P", { sort: "name", direction: "asc", limit: 10, anchorPath: "P/Folder" });
  assert.equal(page.items[0].path, "P/Folder");
  assert.equal(page.items[0].kind, "directory");
  store.close();
});

test("an anchored page under sort=modified keeps folders-first and missing-last", () => {
  const store = openWebCatalogStore();
  store.upsertDirectory({ path: "P", name: "P" });
  store.upsertDirectory({ path: "P/Folder", name: "Folder" });
  store.upsertNote({ path: "P/a.md", modifiedMs: 100 });
  store.upsertNote({ path: "P/b.md", modifiedMs: 200 });
  store.upsertNote({ path: "P/m.md", modifiedMs: null });

  // asc order: P/Folder, P/a.md, P/b.md, P/m.md
  const page = store.listChildren("P", { sort: "modified", direction: "asc", limit: 10, anchorPath: "P/b.md" });
  assert.deepEqual(page.items.map((item) => item.path), ["P/b.md", "P/m.md"]);
  store.close();
});

test("an anchored page respects the raw UTF-16 path tie-break", () => {
  const store = openWebCatalogStore();
  store.upsertDirectory({ path: "P", name: "P" });
  store.upsertNote({ path: "P/\uFA6C.md" });
  store.upsertNote({ path: "P/\u{242EE}.md" });

  const fromSupplementary = store.listChildren("P", {
    sort: "name",
    direction: "asc",
    limit: 10,
    anchorPath: "P/\u{242EE}.md",
  });
  assert.deepEqual(fromSupplementary.items.map((item) => item.path), ["P/\u{242EE}.md", "P/\uFA6C.md"]);

  const fromBmp = store.listChildren("P", { sort: "name", direction: "asc", limit: 10, anchorPath: "P/\uFA6C.md" });
  assert.deepEqual(fromBmp.items.map((item) => item.path), ["P/\uFA6C.md"]);
  store.close();
});

test("an anchored page in a 5k directory is served by the ordering index", () => {
  const store = openWebCatalogStore();
  store.upsertDirectory({ path: "Big", name: "Big" });
  store.batch(() => {
    for (let index = 0; index < 5000; index += 1) {
      store.upsertNote({ path: `Big/n-${String(index).padStart(5, "0")}.md`, modifiedMs: index });
    }
  });

  const plans = [
    ["name", "asc", "nodes_parent_name_asc"],
    ["name", "desc", "nodes_parent_name_desc"],
    ["modified", "asc", "nodes_parent_modified_asc"],
    ["modified", "desc", "nodes_parent_modified_desc"],
  ];
  for (const [sort, direction, index] of plans) {
    const detail = store
      .planListChildren("Big", { sort, direction, limit: 10, anchorPath: "Big/n-04999.md" })
      .map((row) => row.detail)
      .join("\n");
    assert.match(detail, new RegExp(`USING INDEX ${index}`), `${sort}/${direction} anchored plan\n${detail}`);
    assert.doesNotMatch(detail, /TEMP B-TREE/, `${sort}/${direction} must not sort in a temp b-tree`);
    assert.doesNotMatch(detail, /\bSCAN nodes\b/, `${sort}/${direction} must not scan the whole table`);
  }

  const page = store.listChildren("Big", {
    sort: "name",
    direction: "asc",
    limit: 3,
    anchorPath: "Big/n-04998.md",
  });
  assert.deepEqual(page.items.map((item) => item.path), ["Big/n-04998.md", "Big/n-04999.md"]);
  assert.equal(page.nextCursor, null);
  store.close();
});
