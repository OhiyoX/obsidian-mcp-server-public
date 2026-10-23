// Desktop-parity override codec: sort / filter / q in the document URL and in the
// `/api/web/v1/base` request (D-PARITY-PLAN frozen contract).
import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_FILTER_OPS,
  BASE_QUERY_MAX,
  BASE_SORT_MAX,
  buildBaseHref,
  buildBaseSearch,
  normalizeFilter,
  normalizeQuery,
  normalizeSort,
  parseBaseSearch,
} from "../frontend/app/features/bases/query-state.js";
import { buildBaseRequestUrl } from "../frontend/app/features/bases/state.js";

test("sort normalizes to the frozen [{key,dir}] shape and drops junk", () => {
  assert.deepEqual(normalizeSort([{ key: "status", dir: "desc" }, { key: "name" }, null, { dir: "asc" }, { key: "" }]), [
    { key: "status", dir: "desc" },
    { key: "name", dir: "asc" },
  ]);
  assert.deepEqual(normalizeSort('not json'), []);
  assert.deepEqual(normalizeSort([{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }, { key: "e" }]).length, BASE_SORT_MAX);
});

test("filter normalizes to the canonical operator vocabulary", () => {
  assert.deepEqual(normalizeFilter([
    { key: "status", op: "is", value: "active" },
    { key: "updated", op: "is-empty" },
    { key: "name", op: "nope" },
    { key: "name", op: "contains" },
  ]), [
    { key: "status", op: "is", value: "active" },
    { key: "updated", op: "is-empty" },
    { key: "name", op: "contains" },
  ]);
  assert.ok(BASE_FILTER_OPS.includes("starts-with"));
  assert.ok(BASE_FILTER_OPS.includes("is-not-empty"));
});

test("q is a bounded string", () => {
  assert.equal(normalizeQuery("a".repeat(BASE_QUERY_MAX + 40)).length, BASE_QUERY_MAX);
  assert.equal(normalizeQuery(null), "");
  assert.equal(normalizeQuery(42), "");
});

test("the URL round-trips view/sort/filter/q in a stable order", () => {
  const search = buildBaseSearch({
    view: "开发 dev",
    sort: [{ key: "updated", dir: "desc" }],
    filter: [{ key: "status", op: "is", value: "active" }],
    q: "secrets",
  });
  assert.match(search, /^\?view=/);
  assert.ok(search.indexOf("sort=") < search.indexOf("filter="));
  assert.ok(search.indexOf("filter=") < search.indexOf("q="));

  const parsed = parseBaseSearch(search);
  assert.equal(parsed.view, "开发 dev");
  assert.deepEqual(parsed.sort, [{ key: "updated", dir: "desc" }]);
  assert.deepEqual(parsed.filter, [{ key: "status", op: "is", value: "active" }]);
  assert.equal(parsed.q, "secrets");
});

test("an empty override set produces no query string at all", () => {
  assert.equal(buildBaseSearch({ view: null, sort: [], filter: [], q: "" }), "");
  assert.deepEqual(parseBaseSearch(""), { view: null, sort: [], filter: [], q: "" });
  assert.equal(buildBaseHref("/app/base/x", { sort: [], filter: [], q: "" }), "/app/base/x");
});

test("malformed URL values never throw and never leak into the request", () => {
  const parsed = parseBaseSearch("?sort=%7Bbroken&filter=not-json&q=");
  assert.deepEqual(parsed.sort, []);
  assert.deepEqual(parsed.filter, []);
  assert.equal(parsed.q, "");
});

test("a top-level expression array survives the URL round-trip (review F1)", () => {
  const url = buildBaseSearch({ filter: ["score > 8"] });
  assert.deepEqual(parseBaseSearch(url).filter, ["score > 8"]);
  // The legacy condition array is untouched.
  assert.deepEqual(parseBaseSearch(buildBaseSearch({ filter: [{ key: "a", op: "is", value: 1 }] })).filter, [
    { key: "a", op: "is", value: 1 },
  ]);
});

test("an empty group is preserved instead of being turned into no-filter (review F3)", () => {
  assert.deepEqual(normalizeFilter({ or: [] }), { or: [] });
  assert.equal(buildBaseSearch({ filter: { or: [] } }), `?filter=${encodeURIComponent('{"or":[]}')}`);
  assert.deepEqual(parseBaseSearch(buildBaseSearch({ filter: { or: [] } })).filter, { or: [] });
  // The legacy empty AND list still means "no override" (no query parameter).
  assert.equal(buildBaseSearch({ filter: [] }), "");
});

test("the request URL carries sort/filter/q and still never exposes paging fields", () => {
  const url = buildBaseRequestUrl({
    path: "A.base",
    view: "Table",
    limit: 100,
    cursor: null,
    sort: [{ key: "name", dir: "asc" }],
    filter: [{ key: "status", op: "is", value: "active" }],
    q: "x",
  });
  const params = new URLSearchParams(url.split("?")[1]);
  assert.equal(params.get("path"), "A.base");
  assert.equal(params.get("view"), "Table");
  assert.equal(params.get("limit"), "100");
  assert.deepEqual(JSON.parse(params.get("sort")), [{ key: "name", dir: "asc" }]);
  assert.deepEqual(JSON.parse(params.get("filter")), [{ key: "status", op: "is", value: "active" }]);
  assert.equal(params.get("q"), "x");
  assert.equal(url.includes("offset"), false);
  assert.equal(url.includes("pageNumber"), false);
});

test("buildBaseHref keeps the override query before any fragment", () => {
  assert.equal(
    buildBaseHref("/app/base/x#heading", { q: "a b" }),
    "/app/base/x?q=a+b#heading",
  );
});
