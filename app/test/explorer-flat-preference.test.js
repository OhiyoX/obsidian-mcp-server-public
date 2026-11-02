// Explorer flat-view preferences: mode + flat sort payloads (Phase 2).
//
// These two localStorage payloads must stay independent from the frozen Phase 1 Tree
// preference (`obsidian-web.explorer-sort.v1`), and the flat key set must be narrowed
// by what the current data source can serve.
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_EXPLORER_FLAT_SORT,
  DEFAULT_EXPLORER_MODE,
  EXPLORER_FLAT_SERVER_KEYS,
  EXPLORER_FLAT_SORT_KEYS,
  EXPLORER_FLAT_SORT_STORAGE_KEY,
  EXPLORER_MODE_STORAGE_KEY,
  EXPLORER_MODE_VERSION,
  coerceFlatSort,
  effectiveFlatSort,
  isFlatSortKeyAvailable,
  parseExplorerMode,
  parseFlatSort,
  readExplorerMode,
  readFlatSort,
  writeExplorerMode,
  writeFlatSort,
} from "../frontend/app/features/explorer/flat-preference.js";
import { EXPLORER_SORT_STORAGE_KEY, writeExplorerSort } from "../frontend/app/features/explorer/sort-preference.js";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, value); },
    raw: map,
  };
}

test("mode payload round-trips through the exact v1 shape", () => {
  const storage = memoryStorage();
  assert.equal(writeExplorerMode(storage, "flat"), true);
  assert.equal(storage.raw.get(EXPLORER_MODE_STORAGE_KEY), '{"version":1,"mode":"flat"}');
  assert.equal(readExplorerMode(storage), "flat");
  writeExplorerMode(storage, "tree");
  assert.equal(readExplorerMode(storage), "tree");
});

test("mode parsing fails closed to tree for anything malformed", () => {
  for (const raw of [
    undefined, null, 42, "{nope", "[]", "null", '"flat"', "true",
    '{"version":1}', '{"mode":"flat"}',
    '{"version":"1","mode":"flat"}', '{"version":2,"mode":"flat"}',
    '{"version":1,"mode":"sideways"}', '{"version":1,"mode":"flat","path":"A.md"}',
  ]) {
    assert.equal(parseExplorerMode(raw), DEFAULT_EXPLORER_MODE, String(raw));
  }
});

test("flat sort payload round-trips and defaults to modified desc", () => {
  const storage = memoryStorage();
  assert.deepEqual(readFlatSort(memoryStorage()), { key: "modified", direction: "desc" });
  assert.equal(writeFlatSort(storage, { key: "path", direction: "asc" }), true);
  assert.equal(storage.raw.get(EXPLORER_FLAT_SORT_STORAGE_KEY), '{"version":1,"key":"path","direction":"asc"}');
  assert.deepEqual(readFlatSort(storage), { key: "path", direction: "asc" });
});

test("flat sort accepts the Phase 2 key set (name/modified/path + query-only score)", () => {
  assert.deepEqual([...EXPLORER_FLAT_SORT_KEYS], ["name", "modified", "path", "score"]);
  for (const key of EXPLORER_FLAT_SORT_KEYS) {
    for (const direction of ["asc", "desc"]) {
      assert.deepEqual(parseFlatSort(JSON.stringify({ version: 1, key, direction })), { key, direction });
    }
  }
});

test("flat sort parsing fails closed for unknown key/direction/version/extra fields", () => {
  for (const raw of [
    undefined, null, "42", "{nope", "[]", "null", '"name"',
    '{"version":1,"key":"name"}', '{"version":1,"direction":"asc"}',
    '{"version":"1","key":"name","direction":"asc"}', '{"version":2,"key":"name","direction":"asc"}',
    '{"version":1,"key":"created","direction":"asc"}', '{"version":1,"key":"name","direction":"up"}',
    '{"version":1,"key":"name","direction":"asc","path":"A.md"}',
  ]) {
    assert.deepEqual(parseFlatSort(raw), { ...DEFAULT_EXPLORER_FLAT_SORT }, String(raw));
  }
});

test("coerceFlatSort always returns a fresh spec", () => {
  const spec = { key: "path", direction: "desc" };
  const coerced = coerceFlatSort(spec);
  assert.deepEqual(coerced, spec);
  assert.notEqual(coerced, spec);
  assert.deepEqual(coerceFlatSort({ key: "bogus", direction: "desc" }), { ...DEFAULT_EXPLORER_FLAT_SORT });
});

test("the three preferences never share a key and never overwrite each other", () => {
  const storage = memoryStorage();
  writeExplorerSort(storage, { key: "name", direction: "asc" });
  writeExplorerMode(storage, "flat");
  writeFlatSort(storage, { key: "path", direction: "desc" });
  assert.notEqual(EXPLORER_SORT_STORAGE_KEY, EXPLORER_MODE_STORAGE_KEY);
  assert.notEqual(EXPLORER_SORT_STORAGE_KEY, EXPLORER_FLAT_SORT_STORAGE_KEY);
  assert.notEqual(EXPLORER_MODE_STORAGE_KEY, EXPLORER_FLAT_SORT_STORAGE_KEY);
  assert.deepEqual(Object.keys(JSON.parse(storage.raw.get(EXPLORER_SORT_STORAGE_KEY))), ["version", "key", "direction"]);
  assert.equal(JSON.parse(storage.raw.get(EXPLORER_MODE_STORAGE_KEY)).mode, "flat");
  assert.equal(EXPLORER_MODE_VERSION, 1);
  assert.deepEqual(readFlatSort(storage), { key: "path", direction: "desc" });
});

test("flat key availability is narrowed by the data source", () => {
  for (const key of EXPLORER_FLAT_SORT_KEYS) {
    assert.equal(isFlatSortKeyAvailable(key, { query: true }), true, `${key} with a query`);
  }
  for (const key of EXPLORER_FLAT_SERVER_KEYS) {
    assert.equal(isFlatSortKeyAvailable(key, { query: false }), true, `${key} without a query`);
  }
  assert.equal(isFlatSortKeyAvailable("name", { query: false }), false);
  assert.equal(isFlatSortKeyAvailable("score", { query: false }), false);
  assert.equal(isFlatSortKeyAvailable("bogus", { query: true }), false);
});

test("effectiveFlatSort falls back only for keys the source cannot honour", () => {
  assert.deepEqual(effectiveFlatSort({ key: "name", direction: "asc" }, { query: true }), { key: "name", direction: "asc" });
  assert.deepEqual(effectiveFlatSort({ key: "score", direction: "asc" }, { query: true }), { key: "score", direction: "asc" });
  assert.deepEqual(effectiveFlatSort({ key: "path", direction: "desc" }, { query: false }), { key: "path", direction: "desc" });
  assert.deepEqual(effectiveFlatSort({ key: "name", direction: "asc" }, { query: false }), { ...DEFAULT_EXPLORER_FLAT_SORT });
  assert.deepEqual(effectiveFlatSort({ key: "score", direction: "desc" }, { query: false }), { ...DEFAULT_EXPLORER_FLAT_SORT });
});

test("a throwing storage read fails closed without throwing", () => {
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(readExplorerMode(throwing), DEFAULT_EXPLORER_MODE);
  assert.deepEqual(readFlatSort(throwing), { ...DEFAULT_EXPLORER_FLAT_SORT });
  assert.equal(writeExplorerMode(throwing, "flat"), false);
  assert.equal(writeFlatSort(throwing, { key: "path", direction: "asc" }), false);
  assert.equal(readExplorerMode(null), DEFAULT_EXPLORER_MODE);
  assert.deepEqual(readFlatSort(undefined), { ...DEFAULT_EXPLORER_FLAT_SORT });
});

test("the server-serveable flat keys are a strict subset of the preference keys", () => {
  for (const key of EXPLORER_FLAT_SERVER_KEYS) assert.ok(EXPLORER_FLAT_SORT_KEYS.includes(key), key);
  assert.equal(EXPLORER_FLAT_SERVER_KEYS.length < EXPLORER_FLAT_SORT_KEYS.length, true);
});
