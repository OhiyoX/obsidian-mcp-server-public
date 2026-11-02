// Wave M — issues #604 (page-size form lost `tab=audit`) and #607 (pager emitted one link per page).
//
// Both are SSR-only defects: they must be visible in the HTML the server sends, not just fixed by the
// enhancement script, so these assertions read the rendered page the same way a scriptless browser does.
import assert from "node:assert/strict";
import test from "node:test";

import { renderAuditPage } from "../../src/admin/pages/audit.js";

const row = (index) => ({
  at: Date.now() - index * 60_000,
  ok: index % 7 !== 0,
  action: "mcp.tool_call",
  credential: `API Key · key-${index}`,
  origin: `10.0.0.${index % 250}`,
  source: `agent-${index}`,
  target: `_Workspace/note-${index}.md`,
});

// The page resolves credential names through `ctx.model`; a stub keeps these tests about the pager.
const MODEL = {
  keyName: (id) => String(id),
  keyOf: (id) => String(id),
  client: () => null,
  acct: () => null,
  clientName: () => "client",
  acctName: () => "account",
};

const render = ({ rows = 0, query = {} } = {}) => renderAuditPage({
  snapshot: { audit: Array.from({ length: rows }, (_, index) => row(index)) },
  query,
  model: MODEL,
  csrf: "csrf-test",
  admin: { username: "tester" },
  base: "/admin/auth",
}).content;

const pagerHtml = (html) => /<div class="pager">(.*?)<\/div>\s*$/.exec(html)?.[1] ?? (/<div class="pager">(.*)/s.exec(html)?.[1] ?? "");
const pageLinks = (html) => /<div class="pg">(.*?)<\/div>/s.exec(html)?.[1] ?? "";
const countNodes = (fragment) => (fragment.match(/<a /g) || []).length
  + (fragment.match(/<span class="on"/g) || []).length
  + (fragment.match(/<span class="gap"/g) || []).length;

test("#604 the page-size form carries tab=audit, so 25→50 stays on the audit page", () => {
  const html = render({ rows: 60 });
  const form = /<form class="inline-form" method="get" action="\/admin\/auth">(.*?)<\/form>/s.exec(html);
  assert.ok(form, "the page-size form must be a real GET form");
  assert.match(form[1], /<input type="hidden" name="tab" value="audit">/, "without this the router falls back to 概览");
  assert.equal((form[1].match(/name="tab"/g) || []).length, 1, "exactly one tab field (no duplicate parameters)");
  assert.match(form[1], /name="pageSize"/, "the page-size select is still in the form");
});

test("#604 the page-size form keeps every other filter", () => {
  // Rows that actually match the filters: `outcome=failure` and `credential=api-key` are real filters, so
  // a mismatched fixture would hide the pager and the test would pass for the wrong reason.
  const failing = Array.from({ length: 60 }, (_, index) => ({ ...row(index), ok: false, credentialType: "api-key" }));
  const html = renderAuditPage({ snapshot: { audit: failing }, query: { outcome: "failure", credential: "api-key", q: "agent-", pageSize: "50" }, model: MODEL, csrf: "csrf-test", admin: { username: "tester" }, base: "/admin/auth" }).content;
  assert.match(html, /class="pager"/, "the fixtures must produce a pager");
  const form = /<form class="inline-form" method="get" action="\/admin\/auth">(.*?)<\/form>/s.exec(html)[1];
  for (const [name, value] of [["outcome", "failure"], ["credential", "api-key"], ["q", "agent-"], ["tab", "audit"]]) {
    assert.match(form, new RegExp(`name="${name}" value="${value}"`), `missing ${name}=${value}`);
  }
  assert.equal((form.match(/name="pageSize" type="hidden"/g) || []).length, 0, "pageSize is the select, not a hidden duplicate");
});

test("#607 the pager node count is bounded, not proportional to the number of records", () => {
  const cases = [
    { rows: 25, pages: 1, max: 4 },
    { rows: 200, pages: 8, max: 11 },
    { rows: 2000, pages: 80, max: 11 },
    { rows: 20000, pages: 800, max: 11 },
  ];
  for (const { rows, pages, max } of cases) {
    for (const page of [1, Math.ceil(pages / 2), pages]) {
      const html = render({ rows, query: page > 1 ? { page: String(page) } : {} });
      const nodes = countNodes(pageLinks(html));
      assert.ok(nodes > 0, `${rows} rows: pager renders nothing`);
      assert.ok(nodes <= max, `${rows} rows page ${page}: ${nodes} pager nodes > ${max}`);
    }
  }
  // The pathological case the issue reports: 80 pages used to be 80 links.
  const big = countNodes(pageLinks(render({ rows: 2000 })));
  assert.ok(big <= 11, `2000 rows / 25 per page must stay ≤11 nodes, got ${big}`);
});

test("#607 the window keeps first page, last page and the current page reachable", () => {
  const middle = pageLinks(render({ rows: 2000, query: { page: "40" } }));
  assert.match(middle, />1</, "first page link");
  assert.match(middle, /aria-current="page">40</, "current page marked");
  assert.match(middle, />80</, "last page link");
  assert.match(middle, /class="gap" aria-hidden="true">…</, "ellipsis stands in for the skipped range");
  assert.match(middle, />39</);
  assert.match(middle, />41</);
  assert.equal(/>2</.test(middle), false, "page 2 is not in the window around page 40");
  assert.equal(/>79</.test(middle), false, "page 79 is not in the window around page 40");

  const first = pageLinks(render({ rows: 2000 }));
  assert.match(first, /aria-current="page">1</);
  assert.match(first, />2</, "the next page is next to page 1");
  assert.match(first, />80</);
});

test("#607 no-JS pagination links keep the filters and the tab", () => {
  const failing = Array.from({ length: 2000 }, (_, index) => ({ ...row(index), ok: false, credentialType: "api-key" }));
  const html = renderAuditPage({ snapshot: { audit: failing }, query: { outcome: "failure", q: "agent-", page: "2" }, model: MODEL, csrf: "csrf-test", admin: { username: "tester" }, base: "/admin/auth" }).content;
  const links = [...pageLinks(html).matchAll(/href="([^"]+)"/g)].map((match) => match[1].replace(/&amp;/g, "&"));
  assert.ok(links.length > 0, "there must be clickable page links");
  for (const href of links) {
    const query = new URLSearchParams(href.split("?")[1]);
    assert.equal(query.get("tab"), "audit", `page link lost the tab: ${href}`);
    assert.equal(query.get("outcome"), "failure", `page link lost the outcome filter: ${href}`);
    assert.equal(query.get("q"), "agent-", `page link lost the search term: ${href}`);
  }
  assert.ok(links.some((href) => /[?&]page=3(&|$)/.test(href)), "the '›' link moves to page 3");
});

test("#607 a page beyond the last one renders without crashing and disables '›'", () => {
  const html = render({ rows: 60, query: { page: "999" } });
  const links = pageLinks(html);
  assert.equal(/aria-current="page">3</.test(links), true, "clamped to the last page");
  assert.match(links, /<button type="button" disabled>›<\/button>/);
  assert.equal(/›<\/a>/.test(links), false, "there is no forward link past the end");
});

test("the fail counter stays inside its coloured span (prototype markup unchanged)", () => {
  const html = render({ rows: 30 });
  assert.match(html, /<span style="color:var\(--danger\)">\d+ 条失败<\/span>/);
});
