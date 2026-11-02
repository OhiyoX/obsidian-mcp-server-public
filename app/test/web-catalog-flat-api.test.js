// Flat page (`flat=1`) unit tests: query parsing, the ordering/paging contract, the
// note-only payload, cursor identity and the metadata-only guarantee.
import assert from "node:assert/strict";
import test from "node:test";
import { openWebCatalogStore } from "../src/app/web-catalog/sqlite-store.js";
import { buildWebCatalogFlatQuery } from "../src/app/web-catalog/flat-query.js";
import { WebCatalogHttpError, parseTreeQuery, resolveTreePage } from "../src/app/web-catalog/tree-api.js";

const httpError = (status, code) => (error) =>
  error instanceof WebCatalogHttpError && error.status === status && error.code === code;

const DAY = 24 * 60 * 60 * 1000;
const at = (day) => Date.UTC(2026, 0, day, 12, 0, 0);

function fixtureStore() {
  const store = openWebCatalogStore({ file: ":memory:" });
  store.upsertDirectory({ path: "Folder" });
  store.upsertDirectory({ path: "Folder/Deep" });
  store.upsertNote({ path: "Folder/Deep/Zeta.md", modifiedMs: at(4) });
  store.upsertNote({ path: "Folder/Alpha.md", modifiedMs: at(2) });
  store.upsertNote({ path: "Beta.md", modifiedMs: at(3) });
  store.upsertNote({ path: "Gamma.md", modifiedMs: at(1) });
  store.upsertNote({ path: "NoDate.md" });
  store.upsertBase({ path: "Query.base" });
  store.upsertFile({ path: "photo.png", modifiedMs: at(5) });
  return store;
}

test("parseTreeQuery keeps the frozen tree shape and only adds `flat` for flat pages", () => {
  assert.deepEqual(parseTreeQuery({}), { parent: "", sort: "name", direction: "asc", limit: 100, cursor: null, anchorPath: null });
  const flat = parseTreeQuery({ flat: "1" });
  assert.deepEqual(flat, { parent: "", sort: "modified", direction: "asc", limit: 100, cursor: null, anchorPath: null, flat: true });
  assert.equal(parseTreeQuery({ flat: "1", sort: "path", direction: "desc", limit: "5" }).sort, "path");
  assert.equal(parseTreeQuery({ flat: "1", limit: "5" }).limit, 5);
  // An explicit empty parent is the root, not a parent: accepted.
  assert.equal(parseTreeQuery({ flat: "1", parent: "" }).flat, true);
});

test("flat parsing rejects an unknown flat flag, parent, anchor, sort and limit", () => {
  for (const bad of ["0", "yes", "true", "2"]) {
    assert.throws(() => parseTreeQuery({ flat: bad }), httpError(400, "invalid-flat"), bad);
  }
  assert.throws(() => parseTreeQuery({ flat: "1", parent: "Folder" }), httpError(400, "flat-parent-conflict"));
  assert.throws(() => parseTreeQuery({ flat: "1", parent: "/abs" }), httpError(400, "flat-parent-conflict"));
  assert.throws(() => parseTreeQuery({ flat: "1", anchorPath: "Folder/Alpha.md" }), httpError(400, "invalid-anchor"));
  for (const sort of ["name", "score", "created", "basename"]) {
    assert.throws(() => parseTreeQuery({ flat: "1", sort }), httpError(400, "invalid-sort"), sort);
  }
  assert.throws(() => parseTreeQuery({ flat: "1", direction: "sideways" }), httpError(400, "invalid-sort"));
  assert.throws(() => parseTreeQuery({ flat: "1", limit: "0" }), httpError(400, "invalid-limit"));
  assert.throws(() => parseTreeQuery({ flat: "1", limit: "501" }), httpError(400, "invalid-limit"));
});

test("flat listing returns note rows only, across the whole Vault", () => {
  const store = fixtureStore();
  try {
    assert.equal(store.countNodes("note"), 5);
    for (const sort of ["modified", "path"]) {
      for (const direction of ["asc", "desc"]) {
        const page = store.listFlatNotes({ sort, direction, limit: 100 });
        assert.deepEqual([...new Set(page.items.map((item) => item.kind))], ["note"], `${sort} ${direction}`);
        assert.equal(page.items.length, 5, `${sort} ${direction} returns every note`);
        assert.equal(page.nextCursor, null);
        for (const item of page.items) {
          assert.deepEqual(Object.keys(item).sort(), ["kind", "modified", "name", "path", "title"]);
        }
      }
    }
    assert.equal(store.listFlatNotes({ sort: "path", direction: "asc", limit: 100 }).items.some((item) => item.path === "photo.png"), false);
    assert.equal(store.listFlatNotes({ sort: "path", direction: "asc", limit: 100 }).items.some((item) => item.path === "Query.base"), false);
    assert.equal(store.listFlatNotes({ sort: "path", direction: "asc", limit: 100 }).items.some((item) => item.path === "Folder"), false);
  } finally {
    store.close();
  }
});

test("modified desc/asc orders by the row's own timestamp with missing last, path breaks ties", () => {
  const store = fixtureStore();
  try {
    const desc = store.listFlatNotes({ sort: "modified", direction: "desc", limit: 100 }).items.map((item) => item.path);
    assert.deepEqual(desc, ["Folder/Deep/Zeta.md", "Beta.md", "Folder/Alpha.md", "Gamma.md", "NoDate.md"]);
    const asc = store.listFlatNotes({ sort: "modified", direction: "asc", limit: 100 }).items.map((item) => item.path);
    assert.deepEqual(asc, ["Gamma.md", "Folder/Alpha.md", "Beta.md", "Folder/Deep/Zeta.md", "NoDate.md"]);
    assert.equal(desc.at(-1), "NoDate.md", "a missing timestamp is last under desc");
    assert.equal(asc.at(-1), "NoDate.md", "a missing timestamp is last under asc");

    // Equal timestamps tie-break on the raw path (never on a per-parent rank).
    store.upsertNote({ path: "Folder/Deep/A.md", modifiedMs: at(3) });
    store.upsertNote({ path: "A.md", modifiedMs: at(3) });
    const tied = store.listFlatNotes({ sort: "modified", direction: "desc", limit: 100 }).items
      .filter((item) => item.modified === new Date(at(3)).toISOString())
      .map((item) => item.path);
    assert.deepEqual(tied, ["A.md", "Beta.md", "Folder/Deep/A.md"]);
  } finally {
    store.close();
  }
});

test("path asc/desc is a total order and a real descending keyset", () => {
  const store = fixtureStore();
  try {
    const asc = store.listFlatNotes({ sort: "path", direction: "asc", limit: 100 }).items.map((item) => item.path);
    assert.deepEqual(asc, [...asc].sort());
    const desc = store.listFlatNotes({ sort: "path", direction: "desc", limit: 100 }).items.map((item) => item.path);
    assert.deepEqual(desc, [...asc].reverse());
  } finally {
    store.close();
  }
});

test("keyset paging concatenates to the whole listing for every supported ordering", () => {
  const store = fixtureStore();
  try {
    for (const [sort, direction] of [["modified", "desc"], ["modified", "asc"], ["path", "asc"], ["path", "desc"]]) {
      const whole = store.listFlatNotes({ sort, direction, limit: 100 }).items.map((item) => item.path);
      const paged = [];
      let cursor = null;
      let pages = 0;
      do {
        const page = store.listFlatNotes({ sort, direction, limit: 2, cursor });
        paged.push(...page.items.map((item) => item.path));
        cursor = page.nextCursor;
        pages += 1;
        assert.equal(page.items.length <= 2, true);
      } while (cursor && pages < 10);
      assert.equal(cursor, null, `${sort} ${direction} reaches the end`);
      assert.deepEqual(paged, whole, `${sort} ${direction} paging`);
      assert.equal(pages > 1, true, `${sort} ${direction} needs more than one page at limit 2`);
    }
  } finally {
    store.close();
  }
});

test("a cursor is bound to its ordering, its flat identity and its catalog generation", () => {
  const store = fixtureStore();
  try {
    const first = store.listFlatNotes({ sort: "modified", direction: "desc", limit: 2 });
    assert.ok(first.nextCursor);
    // Same ordering continues.
    assert.equal(store.listFlatNotes({ sort: "modified", direction: "desc", limit: 2, cursor: first.nextCursor }).items.length, 2);
    // Another ordering/direction is a client bug.
    assert.throws(() => store.listFlatNotes({ sort: "path", direction: "asc", cursor: first.nextCursor }), /does not belong to this query/);
    assert.throws(() => store.listFlatNotes({ sort: "modified", direction: "asc", cursor: first.nextCursor }), /does not belong to this query/);
    // A tree cursor must never be accepted by a flat page and vice versa.
    const treeCursor = store.listChildren("", { sort: "modified", direction: "desc", limit: 2 }).nextCursor;
    assert.ok(treeCursor, "the root page has more than 2 children in this fixture");
    assert.throws(() => store.listFlatNotes({ sort: "modified", direction: "desc", cursor: treeCursor }), /does not belong to a flat page/);
    assert.throws(() => store.listChildren("", { sort: "modified", direction: "desc", cursor: first.nextCursor }), /tree page/);
    // The catalog moved on: the cursor is stale, not silently reused.
    store.upsertNote({ path: "New.md", modifiedMs: at(6) });
    assert.throws(
      () => store.listFlatNotes({ sort: "modified", direction: "desc", cursor: first.nextCursor }),
      (error) => error.code === "WEB_CATALOG_CURSOR_STALE",
    );
  } finally {
    store.close();
  }
});

test("the flat page is metadata-only: no FTS join, no note-text read, path order is index-served", () => {
  const store = fixtureStore();
  try {
    const plan = store.planListFlatNotes({ sort: "path", direction: "desc", limit: 10 });
    assert.equal(plan.length > 0, true);
    assert.equal(plan.some((row) => row.detail.includes("nodes_kind_path_key")), true, JSON.stringify(plan));
    // The query text itself never touches the text projection.
    const { sql } = buildWebCatalogFlatQuery({ catalogId: store.catalogId(), generation: store.generation(), sort: "modified", direction: "desc" });
    assert.equal(sql.includes("notes_fts"), false);
    assert.equal(sql.includes("raw"), false);
    assert.match(sql, /FROM nodes\b/);
    // Replacing the public text reader with a tripwire proves the listing never reads it.
    let reads = 0;
    const original = store.readIndexedNoteText;
    store.readIndexedNoteText = (path) => { reads += 1; return original(path); };
    try {
      const page = store.listFlatNotes({ sort: "modified", direction: "desc", limit: 100 });
      assert.equal(page.items.length, 5);
      assert.equal(reads, 0, "a flat page must never read indexed note text");
    } finally {
      store.readIndexedNoteText = original;
    }
  } finally {
    store.close();
  }
});

test("resolveTreePage routes flat=1 to the flat listing without a parent read", async () => {
  const store = fixtureStore();
  let listChildrenCalls = 0;
  let listFlatCalls = 0;
  const runtime = {
    status: () => ({ covered: true }),
    store: {
      metaGet: (key) => (key === "lastReconciledAt" ? "2026-01-01T00:00:00.000Z" : null),
      isStale: () => false,
      listChildren: (...args) => { listChildrenCalls += 1; return store.listChildren(...args); },
      listFlatNotes: (...args) => { listFlatCalls += 1; return store.listFlatNotes(...args); },
    },
  };
  try {
    const payload = await resolveTreePage({ vault: {}, query: { flat: "1", sort: "path", direction: "desc" }, getRuntime: () => runtime });
    assert.equal(listFlatCalls, 1);
    assert.equal(listChildrenCalls, 0);
    assert.equal(payload.parent, "");
    assert.equal(payload.items.length, 5);
    assert.equal(payload.catalog.stale, false);
    assert.equal(payload.items.every((item) => item.kind === "note"), true);
  } finally {
    store.close();
  }
});
