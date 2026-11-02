// SortSpec request-identity unit tests: strict normalization, version pinning and
// the existing children-API parameter mapping.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSortSpec, sortSpecEquals, sortSpecQuery, EXPLORER_SORT_SPEC_VERSION } from "../frontend/app/features/explorer/sort-spec.js";

test("normalizeSortSpec pins version 1 and accepts only valid key/direction", () => {
  assert.deepEqual(normalizeSortSpec({ key: "modified", direction: "desc" }), { version: 1, key: "modified", direction: "desc" });
  assert.equal(EXPLORER_SORT_SPEC_VERSION, 1);
});

test("normalizeSortSpec fails closed to name asc for damaged/unknown input", () => {
  for (const value of [undefined, null, 0, "name", [], {}, { key: "path", direction: "asc" }, { key: "name", direction: "up" }, { version: 2, key: "name", direction: "asc" }]) {
    assert.deepEqual(normalizeSortSpec(value), { version: 1, key: "name", direction: "asc" });
  }
});

test("normalizeSortSpec always returns a fresh frozen object", () => {
  const first = normalizeSortSpec({ key: "name", direction: "asc" });
  const second = normalizeSortSpec({ key: "name", direction: "asc" });
  assert.notEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
});

test("sortSpecEquals is exact on version/key/direction", () => {
  const spec = normalizeSortSpec({ key: "modified", direction: "desc" });
  assert.equal(sortSpecEquals(spec, normalizeSortSpec({ key: "modified", direction: "desc" })), true);
  assert.equal(sortSpecEquals(spec, normalizeSortSpec({ key: "modified", direction: "asc" })), false);
  assert.equal(sortSpecEquals(spec, null), false);
});

test("sortSpecQuery maps to the existing sort/direction parameters only", () => {
  assert.deepEqual(sortSpecQuery({ key: "modified", direction: "desc" }), { sort: "modified", direction: "desc" });
  assert.deepEqual(sortSpecQuery(undefined), { sort: "name", direction: "asc" });
});
