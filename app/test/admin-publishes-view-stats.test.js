// Admin 发布列表 「访问统计」: the column shows the record's real public-page count.
//
// The page stays script-free (CSP `script-src 'self'`), so the count is plain text in the cell
// and `title` carries the last open time. A record nobody opened shows `—`, never a fake 0
// badge, and the old 「规划中」 placeholder key is gone from both catalogs.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (file) => import(pathToFileURL(path.join(APP, "src", file)).href);

const { createModel } = await load("admin/presentation/model.js");
const { renderPublishesPage } = await load("admin/pages/publishes.js");
const { adminCatalogFor } = await load("i18n/admin.js");

const vaults = [{ id: "vault", label: "Vault" }];
const publications = [
  {
    id: "opened",
    kind: "document",
    vaultId: "vault",
    path: "Notes/opened.md",
    lifecycle: "active",
    createdAt: "2026-10-18T09:00:00.000Z",
    views: 3,
    lastViewedAt: "2026-10-19T10:30:00.000Z",
  },
  { id: "never", kind: "document", vaultId: "vault", path: "Notes/never.md", lifecycle: "active", createdAt: "2026-10-18T08:00:00.000Z", views: 0, lastViewedAt: null },
];

const model = createModel({ snapshot: { tokens: [], apiKeys: [], clients: [] }, keys: [], vaults, publications, query: {} });
const ctx = { model, publications, query: {}, csrf: "t", flash: null, origin: "http://127.0.0.1:1" };
const content = (result) => (result && typeof result === "object" ? String(result.content ?? "") : String(result));
const html = content(renderPublishesPage(ctx));
const rowOf = (title) => {
  const rows = (html.match(/<tr[\s\S]*?<\/tr>/g) || []).filter((row) => row.includes(`<b>${title}</b>`));
  assert.equal(rows.length, 1, `exactly one table row for ${title}`);
  return rows[0];
};

test("a viewed record shows its real count and its last open time", () => {
  const row = rowOf("opened");
  assert.match(row, /3 次访问/, "the count is the record's own number");
  assert.match(row, /最近打开：/, "the title names the last open time");
  assert.doesNotMatch(row, /futonly/, "no plan marker is left in the cell");
  // The phone card shows the same number from the same helper, so a phone reader is not blind to it.
  const cards = html.split('<div class="mc">').slice(1).filter((part) => part.includes("<b>opened</b>"));
  assert.equal(cards.length, 1, "one card for the viewed record");
  assert.match(cards[0], /<span title="最近打开：[^"]*">3 次访问<\/span>/, "the phone card carries the count too");
});

test("a never-viewed record shows a dash, not a zero", () => {
  const row = rowOf("never");
  assert.match(row, />—</, "an unopened record keeps the empty-value dash");
  assert.doesNotMatch(row, /次访问/, "no count is invented for it");
});

test("the 「访问统计」 placeholder is gone, and both catalogs still agree on their keys", () => {
  assert.doesNotMatch(html, /访问统计/, "the planned marker is not rendered any more");
  for (const locale of ["zh-CN", "en"]) {
    assert.equal(adminCatalogFor(locale)["adm.publishes.plannedViews"], undefined, `${locale} dropped the placeholder key`);
  }
  assert.deepEqual(Object.keys(adminCatalogFor("en")).sort(), Object.keys(adminCatalogFor("zh-CN")).sort(), "the catalogs cover the same keys");
});
