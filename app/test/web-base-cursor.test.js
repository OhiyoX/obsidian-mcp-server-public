// Unit tests for the opaque Base pagination cursor (A3 HTTP contract).
//
// The cursor is not a public offset/pageNumber: it binds catalog identity,
// generation, Base path, Base revision, view identity and the result-order
// contract version. Malformed tokens are `BASE_CURSOR_INVALID` (HTTP 400);
// any identity mismatch is `BASE_CURSOR_STALE` (HTTP 409).
import assert from "node:assert/strict";
import test from "node:test";

const {
  BASE_CURSOR_VERSION,
  BASE_ORDER_CONTRACT_VERSION,
  BaseCursorError,
  encodeBaseCursor,
  decodeBaseCursor,
  assertBaseCursorMatches,
} = await import("../src/app/base-cursor.js");

const identity = {
  catalogId: "cat-1",
  generation: 7,
  path: "Project.base",
  revision: "sha256:abc123",
  view: "All",
  orderContract: BASE_ORDER_CONTRACT_VERSION,
};
const cursorFields = (overrides = {}) => ({ ...identity, offset: 0, ...overrides });
const encodeRaw = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");

function isCursorError(code) {
  return (error) => {
    assert.ok(error instanceof BaseCursorError, `expected BaseCursorError, got ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  };
}

test("cursor round-trips the frozen identity and stays base64url", () => {
  const token = encodeBaseCursor(cursorFields({ offset: 40 }));
  assert.equal(typeof token, "string");
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  const decoded = decodeBaseCursor(token);
  assert.deepEqual(decoded, { v: BASE_CURSOR_VERSION, ...cursorFields({ offset: 40 }) });
  assert.doesNotThrow(() => assertBaseCursorMatches(decoded, identity));
});

test("empty cursor decodes to null (no cursor supplied)", () => {
  for (const value of [null, undefined, ""]) assert.equal(decodeBaseCursor(value), null);
});

test("malformed tokens are BASE_CURSOR_INVALID", () => {
  for (const bad of ["not base64url!", "!!!", "@@@", "=", "a b c"]) {
    assert.throws(() => decodeBaseCursor(bad), isCursorError("BASE_CURSOR_INVALID"), bad);
  }
});

test("oversized token is rejected before JSON parsing", () => {
  assert.throws(() => decodeBaseCursor("A".repeat(5000)), isCursorError("BASE_CURSOR_INVALID"));
});

test("tampered payload fails closed", () => {
  const token = encodeBaseCursor(cursorFields({ offset: 10 }));
  const decoded = Buffer.from(token, "base64url").toString("utf8");
  const tampered = Buffer.from(decoded.replace('"v":1', '"v":99'), "utf8").toString("base64url");
  assert.throws(() => decodeBaseCursor(tampered), isCursorError("BASE_CURSOR_INVALID"));
});

test("shape violations are rejected", () => {
  const base = cursorFields({ offset: 0 });
  const cases = [
    {},
    { v: BASE_CURSOR_VERSION },
    { v: BASE_CURSOR_VERSION, ...base, catalogId: "" },
    { v: BASE_CURSOR_VERSION, ...base, generation: -1 },
    { v: BASE_CURSOR_VERSION, ...base, generation: 1.5 },
    { v: BASE_CURSOR_VERSION, ...base, path: "" },
    { v: BASE_CURSOR_VERSION, ...base, revision: "" },
    { v: BASE_CURSOR_VERSION, ...base, view: "" },
    { v: BASE_CURSOR_VERSION, ...base, offset: -1 },
    { v: BASE_CURSOR_VERSION, ...base, offset: 1.5 },
    { v: BASE_CURSOR_VERSION, ...base, orderContract: 0 },
    { v: BASE_CURSOR_VERSION, ...base, sort: "" },
    { v: BASE_CURSOR_VERSION, ...base, filter: 0 },
    { v: BASE_CURSOR_VERSION, ...base, q: ["a"] },
  ];
  for (const obj of cases) {
    assert.throws(() => decodeBaseCursor(encodeRaw(obj)), isCursorError("BASE_CURSOR_INVALID"), JSON.stringify(obj));
  }
});

test("any identity mismatch is BASE_CURSOR_STALE", () => {
  const decoded = decodeBaseCursor(encodeBaseCursor(cursorFields({ offset: 5 })));
  const mutations = {
    catalogId: "cat-2",
    generation: 8,
    path: "Other.base",
    revision: "sha256:def456",
    view: "Recent",
    orderContract: BASE_ORDER_CONTRACT_VERSION + 1,
  };
  for (const [key, value] of Object.entries(mutations)) {
    assert.throws(
      () => assertBaseCursorMatches(decoded, { ...identity, [key]: value }),
      isCursorError("BASE_CURSOR_STALE"),
      `mismatch on ${key}`,
    );
  }
});

// ── Frozen query-override identity (D-PARITY-PLAN extension) ────────────────
test("the cursor binds the canonical sort/filter/q identities", () => {
  const overrides = { sort: 'sort-identity', filter: 'filter-identity', q: "Apple" };
  const token = encodeBaseCursor(cursorFields({ offset: 4, ...overrides }));
  const decoded = decodeBaseCursor(token);
  assert.deepEqual(decoded, { v: BASE_CURSOR_VERSION, ...cursorFields({ offset: 4 }), ...overrides });
  assert.doesNotThrow(() => assertBaseCursorMatches(decoded, { ...identity, ...overrides }));
});

test("a cursor without overrides compares equal to an undefined identity", () => {
  const decoded = decodeBaseCursor(encodeBaseCursor(cursorFields({ offset: 0 })));
  assert.equal(Object.hasOwn(decoded, "sort"), false, "an absent override is not minted");
  assert.doesNotThrow(() => assertBaseCursorMatches(decoded, { ...identity, sort: undefined, filter: undefined, q: undefined }));
});

test("any sort/filter/q mismatch (or a newly added override) is BASE_CURSOR_STALE", () => {
  const decoded = decodeBaseCursor(
    encodeBaseCursor(cursorFields({ offset: 2, sort: "sort-a", filter: "filter-a", q: "a" })),
  );
  const mutations = [
    { sort: "sort-b" },
    { filter: "filter-b" },
    { q: "b" },
    { sort: undefined },
    { filter: undefined },
    { q: undefined },
  ];
  for (const mutation of mutations) {
    assert.throws(
      () => assertBaseCursorMatches(decoded, { ...identity, sort: "sort-a", filter: "filter-a", q: "a", ...mutation }),
      isCursorError("BASE_CURSOR_STALE"),
      JSON.stringify(mutation),
    );
  }
});
