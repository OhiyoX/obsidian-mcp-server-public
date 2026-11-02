// Column sorting (2026-10-31 owner request: 「点击列头排序」 on every table).
//
// The contract under test is the one a person meets: a header is a link, the link carries the order
// in the URL, the same page decides the row order, and nothing about it needs script. The width drag
// lives in the enhancement module and is asserted in the browser check instead (no DOM, no markup).
import assert from "node:assert/strict";
import test from "node:test";

import { compareCell, nextSort, readSort, sortHref, sortRows } from "../../src/admin/table-sort.js";
import { table } from "../../src/admin/ui.js";
import { renderKeysPage } from "../../src/admin/pages/keys.js";
import { createModel } from "../../src/admin/presentation/model.js";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");

function keysCtx({ query = {}, keys } = {}) {
  const list = keys ?? [
    { id: "k1", label: "zeta", prefix: "obmcp_z", allowedScopes: ["obsidian.read"], allowedVaults: ["default"], createdAt: "2026-10-01T00:00:00.000Z", lastUsedAt: "2026-10-20T00:00:00.000Z", lastSource: "1.1.1.1" },
    { id: "k2", label: "alpha", prefix: "obmcp_a", allowedScopes: [], allowedVaults: [], createdAt: "2026-10-05T00:00:00.000Z", lastUsedAt: null, lastSource: null },
    { id: "k3", label: "Mid", prefix: "obmcp_m", allowedScopes: ["obsidian.read", "obsidian.write"], allowedVaults: ["default"], createdAt: "2026-09-25T00:00:00.000Z", lastUsedAt: "2026-10-27T00:00:00.000Z", lastSource: "10.0.0.2" },
  ];
  return {
    model: createModel({ now: NOW, snapshot: { apiKeys: list, clients: [], oauthUsers: [], tokens: [], audit: [] }, keys: list, vaults: [] }),
    keys: list,
    query,
    csrf: "csrf-token",
    authz: { policies: [], revision: 1 },
  };
}

const labelsInOrder = (content) => {
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(content)?.[1] ?? "";
  return [...body.matchAll(/<b[^>]*>([^<]+)<\/b>/g)].map((match) => match[1]);
};

// ------------------------------------------------------------------ reading the state

test("readSort only accepts columns the page can really sort by", () => {
  assert.deepEqual(readSort({}, ["a", "b"], "a"), { key: "a", order: "asc" });
  assert.deepEqual(readSort({ sort: "b", order: "desc" }, ["a", "b"], "a"), { key: "b", order: "desc" });
  assert.deepEqual(readSort({ sort: "nope" }, ["a", "b"], "a"), { key: "a", order: "asc" }, "an unknown column falls back");
  assert.deepEqual(readSort({ sort: "a", order: "sideways" }, ["a"], "a"), { key: "a", order: "asc" }, "an unknown direction is asc");
  assert.deepEqual(readSort({ sort: "a", order: "DESC" }, ["a"], "a"), { key: "a", order: "desc" }, "case is not a trap");
  assert.deepEqual(readSort({}, ["a"], null), { key: null, order: "asc" }, "a page may start with no column chosen");
});

test("nextSort flips on the sorted column and starts asc elsewhere", () => {
  assert.deepEqual(nextSort({ key: "a", order: "asc" }, "a"), { key: "a", order: "desc" });
  assert.deepEqual(nextSort({ key: "a", order: "desc" }, "a"), { key: "a", order: "asc" });
  assert.deepEqual(nextSort({ key: "a", order: "desc" }, "b"), { key: "b", order: "asc" });
  assert.deepEqual(nextSort(null, "b"), { key: "b", order: "asc" });
});

test("sortHref keeps the page's filters and drops the page number", () => {
  const href = sortHref("/admin/auth?tab=audit&outcome=failure&q=alice&page=3", "time", "desc");
  const url = new URL(href, "http://admin.invalid");
  assert.equal(url.pathname, "/admin/auth");
  assert.equal(url.searchParams.get("tab"), "audit");
  assert.equal(url.searchParams.get("outcome"), "failure");
  assert.equal(url.searchParams.get("q"), "alice");
  assert.equal(url.searchParams.get("sort"), "time");
  assert.equal(url.searchParams.get("order"), "desc");
  assert.equal(url.searchParams.get("page"), null, "page 3 of a different order is not a place to land");
});

test("the comparator orders numbers, dates and text, and keeps blanks at the bottom", () => {
  const rows = [
    { id: "a", name: "b", n: 10, at: "2026-10-02T00:00:00.000Z" },
    { id: "b", name: "a", n: 2, at: null },
    { id: "c", name: "C", n: 30, at: "2026-10-01T00:00:00.000Z" },
    { id: "d", name: "", n: null, at: "2026-10-03T00:00:00.000Z" },
  ];
  const get = { name: (row) => row.name, n: (row) => row.n, at: (row) => row.at };
  assert.deepEqual(sortRows(rows, { key: "name", order: "asc" }, get).map((row) => row.id), ["b", "a", "c", "d"], "text asc, blank last");
  assert.deepEqual(sortRows(rows, { key: "n", order: "asc" }, get).map((row) => row.id), ["b", "a", "c", "d"], "numbers compare as numbers, not as text (10 before 30)");
  assert.deepEqual(sortRows(rows, { key: "n", order: "desc" }, get).map((row) => row.id), ["c", "a", "b", "d"], "desc keeps the blank last instead of leading with it");
  assert.deepEqual(sortRows(rows, { key: "at", order: "asc" }, get).map((row) => row.id), ["c", "a", "d", "b"], "ISO instants compare as time");
  assert.equal(compareCell("10", "9"), 1, "numeric strings are not lexicographic");
  assert.equal(compareCell(null, "x"), 1);
  const copy = sortRows(rows, { key: "name", order: "asc" }, get);
  assert.notEqual(copy, rows, "sorting never mutates the page's own array");
});

// ------------------------------------------------------------------ the header

test("a sortable header is a real link; the direction glyph appears only on the sorted column", () => {
  const cols = [["名称", "26%", "", "name"], ["来源", "12%"], ["创建", "10%", "", "created"], ["", "", "act"]];
  const rows = ["<tr><td>x</td><td>y</td><td>z</td><td class=\"act\"></td></tr>"];
  const html = table(cols, rows, "", { key: "name", order: "asc", base: "/admin/auth?tab=keys" });
  assert.match(html, /<th aria-sort="ascending"><a class="ths" href="\/admin\/auth\?tab=keys&amp;sort=name&amp;order=desc">名称 <span class="ind" aria-hidden="true">▲<\/span><\/a><\/th>/, "the sorted column links to the flipped direction");
  assert.match(html, /<th>来源<\/th>/, "a column with no sort key stays plain text");
  assert.match(html, /<th aria-sort="none"><a class="ths" href="\/admin\/auth\?tab=keys&amp;sort=created&amp;order=asc">创建<\/a><\/th>/, "an unsorted sortable column starts at asc, with no glyph");
  assert.match(html, /<th class="act"><\/th>/, "the row-action column is never sortable");
  assert.doesNotMatch(html, /<a class="ths"[^>]*>来源/, "no link is offered for a column the page cannot sort");
});

test("without a sort context the table is byte-for-byte the old markup", () => {
  const cols = [["名称", "26%", "", "name"], ["", "", "act"]];
  const rows = ["<tr><td>x</td><td class=\"act\"></td></tr>"];
  assert.equal(table(cols, rows, ""), '<div class="tw hide-m"><table class="tbl"><colgroup><col style="width:26%"><col></colgroup><thead><tr><th>名称</th><th class="act"></th></tr></thead><tbody><tr><td>x</td><td class="act"></td></tr></tbody></table></div>');
});

// ------------------------------------------------------------------ the page really reorders

test("?sort=&order= reorders the rendered rows (and the default order is the page's own)", () => {
  const plain = renderKeysPage(keysCtx()).content;
  assert.deepEqual(labelsInOrder(plain), ["alpha", "Mid", "zeta"], "no column chosen ⇒ sorted by name asc");

  const desc = renderKeysPage(keysCtx({ query: { sort: "name", order: "desc" } })).content;
  assert.deepEqual(labelsInOrder(desc), ["zeta", "Mid", "alpha"]);

  const byCreated = renderKeysPage(keysCtx({ query: { sort: "created", order: "asc" } })).content;
  assert.deepEqual(labelsInOrder(byCreated), ["Mid", "zeta", "alpha"], "created compares as time");

  const byUse = renderKeysPage(keysCtx({ query: { sort: "lastUsed", order: "desc" } })).content;
  assert.deepEqual(labelsInOrder(byUse), ["Mid", "zeta", "alpha"], "desc: newest use first, a never-used Key stays at the bottom");

  // Searching keeps filtering and sorting independent.
  const searched = renderKeysPage(keysCtx({ query: { q: "obmcp_m", sort: "name", order: "desc" } })).content;
  assert.deepEqual(labelsInOrder(searched), ["Mid"]);
});

test("negative control: the ordering assertions can go red", () => {
  const asc = renderKeysPage(keysCtx({ query: { sort: "name", order: "asc" } })).content;
  assert.throws(() => assert.deepEqual(labelsInOrder(asc), ["zeta", "Mid", "alpha"]), "asc must not match the desc order");
  const rows = [{ n: 1 }, { n: null }, { n: 3 }];
  const get = { n: (row) => row.n };
  assert.notDeepEqual(sortRows(rows, { key: "n", order: "asc" }, get).map((row) => row.n), [null, 1, 3], "nulls never lead");
});
