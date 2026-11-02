// Explorer flat view: the record adapter plus its integration with the frozen
// `sortFlatNotes` model.
//
// Both flat data sources (search rows and the `flat=1` note rows) must normalize into
// the exact record shape the model reads, otherwise the flat list would need a second
// comparator family that could drift from the Tree/query contract.
import assert from "node:assert/strict";
import test from "node:test";
import { flatTitleOf, toFlatRecord, toFlatRecords } from "../frontend/app/features/explorer/flat-view.js";
import { sortFlatNotes } from "../frontend/app/features/explorer/sort-model.js";

const searchRow = (path, { name, modifiedMs = null, score, matchCount = 1, snippets = [] } = {}) => ({
  path,
  name: name ?? path.split("/").pop(),
  kind: "note",
  modifiedMs,
  score,
  matchCount,
  snippets,
});

test("flatTitleOf prefers the catalog title, then the search name without .md, then the path", () => {
  assert.equal(flatTitleOf({ path: "a/b.md", title: "Title", name: "b.md" }), "Title");
  assert.equal(flatTitleOf({ path: "a/b.md", name: "b.md" }), "b");
  assert.equal(flatTitleOf({ path: "a/b.md" }), "b.md");
  assert.equal(flatTitleOf({ path: "a/b.md", title: "" }), "b.md");
  assert.equal(flatTitleOf({ path: "folder/" }), "folder/");
  assert.equal(flatTitleOf({ path: "no-extension", name: "no-extension" }), "no-extension");
});

test("a search row becomes a model record with an ISO modified and its score", () => {
  const record = toFlatRecord(searchRow("Notes/A.md", { modifiedMs: Date.UTC(2026, 0, 2, 3, 4, 5), score: 0.25 }));
  assert.deepEqual(record, {
    path: "Notes/A.md",
    title: "A",
    modified: "2026-01-02T03:04:05.000Z",
    score: 0.25,
  });
});

test("a server flat row keeps its ISO modified and has no score", () => {
  const record = toFlatRecord({ kind: "note", path: "B.md", name: "B.md", title: "B", modified: "2026-01-03T00:00:00.000Z" });
  assert.deepEqual(record, { path: "B.md", title: "B", modified: "2026-01-03T00:00:00.000Z" });
  assert.equal("score" in record, false);
});

test("missing/invalid/non-finite metadata is dropped instead of faked", () => {
  assert.deepEqual(toFlatRecord({ path: "x.md" }), { path: "x.md", title: "x.md" });
  assert.deepEqual(toFlatRecord({ path: "x.md", modifiedMs: null, score: null }), { path: "x.md", title: "x.md" });
  assert.deepEqual(toFlatRecord({ path: "x.md", modifiedMs: Number.NaN, score: Number.POSITIVE_INFINITY }), { path: "x.md", title: "x.md" });
  // A non-string `modified` from a malformed payload is not passed through as valid.
  assert.deepEqual(toFlatRecord({ path: "x.md", modified: 1700000000000 }), { path: "x.md", title: "x.md" });
  // Zero is a valid score and a valid epoch-ms timestamp.
  assert.deepEqual(toFlatRecord({ path: "x.md", modifiedMs: 0, score: 0 }), { path: "x.md", title: "x.md", modified: "1970-01-01T00:00:00.000Z", score: 0 });
});

test("toFlatRecords never drops or duplicates rows and tolerates bad input", () => {
  const rows = [searchRow("a.md"), searchRow("b.md"), { path: "c.md" }];
  const records = toFlatRecords(rows);
  assert.equal(records.length, rows.length);
  assert.deepEqual(records.map((record) => record.path), ["a.md", "b.md", "c.md"]);
  assert.deepEqual(toFlatRecords(null), []);
  assert.deepEqual(toFlatRecords("nope"), []);
});

test("query-context flat ordering uses the frozen model over adapted records (modified desc)", () => {
  const rows = [
    searchRow("b.md", { modifiedMs: Date.UTC(2026, 0, 1) }),
    searchRow("a.md", { modifiedMs: Date.UTC(2026, 0, 3) }),
    searchRow("c.md", { modifiedMs: null }),
  ];
  const sorted = sortFlatNotes(toFlatRecords(rows), { key: "modified", direction: "desc" }, { query: true });
  assert.deepEqual(sorted.map((record) => record.path), ["a.md", "b.md", "c.md"]);
  const asc = sortFlatNotes(toFlatRecords(rows), { key: "modified", direction: "asc" }, { query: true });
  assert.deepEqual(asc.map((record) => record.path), ["b.md", "a.md", "c.md"]);
});

test("score is only honoured with a query and orders finite scores with the requested direction", () => {
  const rows = [
    searchRow("low.md", { score: 0.1 }),
    searchRow("high.md", { score: 0.9 }),
    searchRow("none.md", { score: undefined }),
  ];
  const desc = sortFlatNotes(toFlatRecords(rows), { key: "score", direction: "desc" }, { query: true });
  assert.deepEqual(desc.map((record) => record.path), ["high.md", "low.md", "none.md"]);
  const asc = sortFlatNotes(toFlatRecords(rows), { key: "score", direction: "asc" }, { query: true });
  assert.deepEqual(asc.map((record) => record.path), ["low.md", "high.md", "none.md"]);
  // No query context: `score` is illegal and fails closed to name asc.
  const noQuery = sortFlatNotes(toFlatRecords(rows), { key: "score", direction: "desc" }, { query: false });
  assert.deepEqual(noQuery.map((record) => record.path), ["high.md", "low.md", "none.md"]);
});

test("flat name/path ordering over adapted records is a projection that keeps identities", () => {
  const rows = [searchRow("Folder/B.md"), searchRow("A.md"), searchRow("C.md")];
  const records = toFlatRecords(rows);
  const byName = sortFlatNotes(records, { key: "name", direction: "asc" }, { query: true });
  assert.deepEqual(byName.map((record) => record.path), ["A.md", "Folder/B.md", "C.md"]);
  const byPath = sortFlatNotes(records, { key: "path", direction: "desc" }, { query: true });
  assert.deepEqual(byPath.map((record) => record.path), ["Folder/B.md", "C.md", "A.md"]);
  assert.equal(byName.length, rows.length);
  for (const record of byName) assert.ok(rows.some((row) => row.path === record.path));
  assert.deepEqual(rows.map((row) => row.path), ["Folder/B.md", "A.md", "C.md"], "input order is never mutated");
});
