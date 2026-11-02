import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_EXPLORER_SORT,
  EXPLORER_SORT_STORAGE_KEY,
  coerceExplorerSort,
  parseExplorerSort,
  readExplorerSort,
  resolveExplorerSortStorage,
  writeExplorerSort,
} from "../frontend/app/features/explorer/sort-preference.js";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, value); },
    raw: map,
  };
}

test("valid payload round-trips through the exact v1 shape", () => {
  const storage = memoryStorage();
  assert.equal(writeExplorerSort(storage, { key: "modified", direction: "desc" }), true);
  assert.equal(storage.raw.get(EXPLORER_SORT_STORAGE_KEY), '{"version":1,"key":"modified","direction":"desc"}');
  assert.deepEqual(readExplorerSort(storage), { key: "modified", direction: "desc" });
});

test("payload never carries path, account, vault or query fields", () => {
  const storage = memoryStorage();
  writeExplorerSort(storage, { key: "name", direction: "asc" });
  assert.deepEqual(Object.keys(JSON.parse(storage.raw.get(EXPLORER_SORT_STORAGE_KEY))), ["version", "key", "direction"]);
});

test("invalid JSON, array, null and non-object payloads fall back to name asc", () => {
  for (const raw of ["{nope", "[]", "null", '"name"', "42", "true"]) {
    assert.deepEqual(parseExplorerSort(raw), { key: "name", direction: "asc" }, raw);
  }
});

test("wrong version type/value, unknown key/direction and extra fields are rejected", () => {
  const invalid = [
    '{"version":"1","key":"name","direction":"asc"}',
    '{"version":2,"key":"name","direction":"asc"}',
    '{"version":1,"key":"path","direction":"asc"}',
    '{"version":1,"key":"name","direction":"up"}',
    '{"version":1,"key":"name"}',
    '{"version":1,"direction":"asc"}',
    '{"version":1,"key":"name","direction":"asc","path":"A.md"}',
    '{"version":1,"key":"NAME","direction":"asc"}',
  ];
  for (const raw of invalid) {
    assert.deepEqual(parseExplorerSort(raw), { ...DEFAULT_EXPLORER_SORT }, raw);
  }
});

test("storage read exception falls back to the default without throwing", () => {
  const throwing = {
    getItem() { throw new Error("blocked"); },
  };
  assert.deepEqual(readExplorerSort(throwing), { ...DEFAULT_EXPLORER_SORT });
  assert.deepEqual(readExplorerSort(null), { ...DEFAULT_EXPLORER_SORT });
});

test("blocked localStorage accessor resolves to no storage instead of crashing", () => {
  const scope = {
    get localStorage() { throw new Error("blocked"); },
  };
  assert.equal(resolveExplorerSortStorage(scope), null);
  assert.deepEqual(readExplorerSort(resolveExplorerSortStorage(scope)), { ...DEFAULT_EXPLORER_SORT });
});

test("storage write exception reports failure and never mutates the requested spec", () => {
  const throwing = {
    getItem: () => null,
    setItem() { throw new Error("quota"); },
  };
  const requested = { key: "modified", direction: "desc" };
  assert.equal(writeExplorerSort(throwing, requested), false);
  assert.deepEqual(requested, { key: "modified", direction: "desc" });
});

test("coerceExplorerSort always yields a fresh valid object", () => {
  assert.deepEqual(coerceExplorerSort({ key: "modified", direction: "desc" }), { key: "modified", direction: "desc" });
  assert.deepEqual(coerceExplorerSort({ key: "path", direction: "desc" }), { ...DEFAULT_EXPLORER_SORT });
  assert.deepEqual(coerceExplorerSort(undefined), { ...DEFAULT_EXPLORER_SORT });
  const first = coerceExplorerSort({ key: "name", direction: "asc" });
  const second = coerceExplorerSort({ key: "name", direction: "asc" });
  assert.notEqual(first, second);
});
