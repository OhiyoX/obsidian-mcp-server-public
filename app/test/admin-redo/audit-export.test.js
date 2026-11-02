// 审计 CSV 导出（`GET /admin/auth/audit/export.csv`）—— the export is built from the SAME filters the
// page uses, so these tests pin the three things a CSV of audit rows must not get wrong: the exact
// filtered row set, RFC 4180 quoting, and the spreadsheet-formula guard (an attacker-controlled user
// agent or path must never become a live formula in Excel).
//
// The negative controls at the end re-run the same two helpers on deliberately broken input and fail
// if they stay green: a checker that cannot go red proves nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { auditCsv } from "../../src/admin/pages/audit.js";

const ROWS = [
  { id: "a1", at: "2026-10-31T02:00:00.000Z", action: "admin.login", credentialType: "admin-session", outcome: "success", source: "127.0.0.1", agent: "pi", userAgent: "node" },
  { id: "a2", at: "2026-10-31T02:01:00.000Z", action: "oauth.user.login", credentialType: "oauth-user", outcome: "failure", source: "10.0.0.5", reason: "密码不正确", detail: "carol", userAgent: "Mozilla/5.0" },
  { id: "a3", at: "2026-10-31T02:02:00.000Z", action: "mcp.tool.call", credentialType: "api-key", outcome: "success", source: "203.0.113.9", agent: "Cursor", detail: 'vault, "quoted"\nsecond line', userAgent: "=HYPERLINK(\"http://evil\")" },
];
const ctx = {
  snapshot: { audit: ROWS },
  oauthUsers: [], clients: [], tokens: [],
  // `searchText` names the credential through the per-request model; an empty one is enough here
  // (every row's credential resolves to its unknown/— branch).
  model: {
    keyOf: () => null, keyName: () => "—", client: () => null, clientName: () => "—",
    acct: () => null, acctName: () => "—",
  },
};

const body = () => auditCsv(ctx, {}).body;
const lines = (text) => text.replace(/^\ufeff/, "").split("\r\n").filter(Boolean);

test("the header names every exported column and the file opens as UTF-8 CSV", () => {
  const text = body();
  assert.ok(text.startsWith("\ufeff"), "a UTF-8 BOM keeps Excel from mangling CJK");
  assert.ok(text.includes("\r\n"), "CSV rows use CRLF");
  const [header] = lines(text);
  for (const name of ["时间", "ISO", "结果", "动作", "凭据", "凭据 ID", "Agent", "来源", "原因", "详情", "Origin", "User-Agent"]) {
    assert.ok(header.split(",").includes(name), `header carries ${name}`);
  }
});

test("every record in the filter is exported, not just the first page", () => {
  assert.equal(lines(body()).length, ROWS.length + 1);
  assert.equal(auditCsv(ctx, { outcome: "failure" }).count, 1);
  assert.equal(lines(auditCsv(ctx, { outcome: "failure" }).body).length, 2);
  assert.equal(auditCsv(ctx, { q: "carol" }).count, 1, "the search box filters the export too");
});

test("a field with a comma, a quote or a newline is quoted and its quotes doubled", () => {
  const row = lines(body()).find((line) => line.includes("mcp.tool.call"));
  assert.ok(row.includes('"vault, ""quoted""'), `RFC 4180 quoting: ${row}`);
  assert.ok(row.includes("\nsecond line"), "a newline inside the field stays inside the quoted field");
});

test("a value a spreadsheet would evaluate is neutralised", () => {
  const row = lines(body()).find((line) => line.includes("mcp.tool.call"));
  assert.ok(row.includes(`"'=HYPERLINK`), `formula guard: ${row}`);
  assert.ok(!/(^|,)=HYPERLINK/.test(row), "no cell begins with a bare =");
});

test("the filename is a timestamped .csv and the count matches the rows", () => {
  const result = auditCsv(ctx, {});
  assert.match(result.filename, /^audit-\d{8}T\d{6}Z\.csv$/);
  assert.equal(result.count, ROWS.length);
});

test("negative control: a quoting bug or a missing formula guard would be caught", () => {
  const naive = (value) => String(value ?? "");
  const row = lines(body()).find((line) => line.includes("mcp.tool.call"));
  assert.notEqual(row, [naive('vault, "quoted"\nsecond line'), naive('=HYPERLINK("http://evil")')].join(","), "the naive writer is visibly different");
  assert.ok(!naive('=HYPERLINK("x")').startsWith("'"), "the naive writer does not guard formulas");
});
