// Lane L3 — instant list filtering / segment+sort switching (client behaviour).
//
// Real stack, real browser: the real Admin router (session, CSRF, tab dispatch, asset whitelist),
// the real access-policy store/runtime/admin and the real SSR pages over a real HTTP listener,
// driven by real Chromium over the DevTools protocol. No Playwright: the repository's pinned
// browser resolution is reused (`scripts/web-regression/chromium-binary.mjs`, issue #380 — full
// Chrome for Testing only) and the protocol client is ~120 lines over Node's built-in WebSocket, so
// the evidence runs with no dependency installation.
//
// Pinned behaviour (prototype: `docs/admin-ui-proto/src/6-app.js` + `5-render.js`):
//   1. filtering is a pure view operation (rows + mobile cards, prototype empty state on zero hits,
//      no form value moves, clearing restores, no reload);
//   2. a status segment / sort `<select>` switches in place (`pushState`, only `.content` swapped,
//      focus kept, no new `PerformanceNavigationTiming` entry);
//   3. both still work with script disabled (the GET search form, the segment link);
//   4. a negative control proves the filter checker can go red.
//
// Retired with the freeze (design §7 step 2 + step 5, plan Task 3). The legacy editor is gone: no page
// renders `#authz-form`, `[data-preview-form]` or a `.ped-side` pane any more, and the fragment route
// that fed the pane is deleted, so these cases measured a surface that no longer exists. They were
// removed rather than fixed — do not re-add them without a page that renders what they measured:
//   * "the editor preview derives the summary locally and takes the verdict from the server"
//     (the live `.ped-side` preview and its `GET /admin/auth/access-policy/preview?preview=1` answer);
//   * "⌘/Ctrl+Enter submits the editor through the real form" (the frozen `#authz-form`);
//   * part (3) of "without script the same actions work" (that form's `button[form="authz-form"]`);
//   * "negative control: a verdict computed in the browser" (it mutated that preview's adopt step).
//   * "the preview endpoint is additive …" (it fetched the deleted fragment route; the frozen POST
//     endpoints' CSRF gate stays pinned in `test/access-policy-frozen.test.js`).
//
// The browser half skips (loudly) only when no full Chromium build exists; with
// `ADMIN_CLIENT_BROWSER_EVIDENCE=1` it fails closed, so an evidence run can never pass by skipping.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import express from "express";

import { createAdminRouter } from "../../src/admin/router.js";
import { createAccessPolicyAdmin } from "../../src/admin/access-policy.js";
import { createAccessPolicyRuntime } from "../../src/access-policy/runtime.js";
import { createAccessPolicyStore } from "../../src/access-policy/store.js";
import { Cdp, Page, js, launchBrowser, resolveBrowser, sleep } from "./browser-harness.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FEATURE_ASSET = path.join(APP_ROOT, "src", "admin", "assets", "admin-feature-lists.js");
const ADMIN_PASSWORD = "l3-lists-admin-password";
const REQUIRE_BROWSER = process.env.ADMIN_CLIENT_BROWSER_EVIDENCE === "1";

// ------------------------------------------------------------------ fixture server

function snapshot() {
  const keys = [
    { id: "k-bot", label: "研究机器人", prefix: "obmcp_1a2b3c4d", allowedScopes: ["obsidian.read"], allowedVaults: ["vault"], createdAt: "2026-10-01T00:00:00.000Z", lastUsedAt: "2026-10-10T02:00:00.000Z", lastSource: "192.168.1.5" },
    { id: "k-desktop", label: "桌面客户端", prefix: "obmcp_5e6f7a8b", allowedScopes: ["obsidian.read", "obsidian.write"], allowedVaults: ["vault"], createdAt: "2026-10-02T00:00:00.000Z", lastUsedAt: null, lastSource: null },
    { id: "k-archive", label: "归档导出", prefix: "obmcp_9c0d1e2f", allowedScopes: ["obsidian.read"], allowedVaults: ["research"], createdAt: "2026-10-03T00:00:00.000Z", lastUsedAt: null, lastSource: null },
  ];
  const clients = [
    { clientId: "c-claude", clientName: "Claude Desktop", redirectUris: ["http://127.0.0.1:33418/callback"], connectionOrigins: ["https://obsidian.example.com"], createdAt: "2026-09-01T00:00:00.000Z", lastUsedAt: "2026-10-10T02:00:00.000Z", lastSource: "192.168.1.5" },
    { clientId: "c-cursor", clientName: "Cursor", redirectUris: ["cursor://callback"], connectionOrigins: [], createdAt: "2026-09-02T00:00:00.000Z", lastUsedAt: null, lastSource: null },
    { clientId: "c-zed", clientName: "Zed", redirectUris: ["zed://callback"], connectionOrigins: ["https://zed.example.com"], createdAt: "2026-09-03T00:00:00.000Z", lastUsedAt: null, lastSource: null },
  ];
  const oauthUsers = [
    { id: "u-alice", username: "alice", displayName: "Alice Chen", allowedScopes: ["obsidian.read"], allowedVaults: ["vault"], createdAt: "2026-09-01T00:00:00.000Z", lastLoginAt: "2026-10-10T02:00:00.000Z" },
    { id: "u-bob", username: "bob", displayName: "Bob Li", allowedScopes: ["obsidian.read"], allowedVaults: ["research"], createdAt: "2026-09-02T00:00:00.000Z", lastLoginAt: null },
    { id: "u-carol", username: "carol", displayName: "", allowedScopes: ["obsidian.read"], allowedVaults: ["vault"], createdAt: "2026-09-03T00:00:00.000Z", lastLoginAt: null },
  ];
  const base = { scopes: ["obsidian.read"], allowedVaults: ["vault"], lastUsedAt: "2026-10-10T02:00:00.000Z", lastSource: "192.168.1.5", connectionOrigin: "https://obsidian.example.com" };
  const tokens = [
    { ...base, id: "tok-access-active", type: "access", clientId: "c-claude", userId: "u-alice", createdAt: "2026-10-08T07:00:00.000Z", status: "active" },
    { ...base, id: "tok-refresh-active", type: "refresh", clientId: "c-claude", userId: "u-alice", createdAt: "2026-10-08T07:00:00.000Z", status: "active" },
    { ...base, id: "tok-access-rotated", type: "access", clientId: "c-cursor", userId: "u-bob", createdAt: "2026-10-06T07:00:00.000Z", status: "rotated" },
    { ...base, id: "tok-refresh-rotated", type: "refresh", clientId: "c-cursor", userId: "u-bob", createdAt: "2026-10-06T07:00:00.000Z", status: "rotated" },
    { ...base, id: "tok-access-revoked", type: "access", clientId: "c-zed", userId: "u-carol", createdAt: "2026-10-04T07:00:00.000Z", status: "revoked" },
    { ...base, id: "tok-refresh-revoked", type: "refresh", clientId: "c-zed", userId: "u-carol", createdAt: "2026-10-04T07:00:00.000Z", status: "revoked" },
  ];
  const audit = [
    { id: "au-1", time: "2026-10-10T02:29:00.000Z", action: "mcp.tool.write_note", method: "tools/call", tool: "write_note", outcome: "success", credentialType: "api-key", credentialId: "k-bot", clientId: "api-key:k-bot", source: "192.168.1.5", sourceKind: "direct", userAgent: "undici", agent: "undici", agentSource: "ua", origin: "obsidian.example.com" },
    { id: "au-2", time: "2026-10-10T02:15:00.000Z", action: "mcp.tool.get_note", method: "tools/call", tool: "get_note", outcome: "failure", credentialType: "oauth-access", clientId: "c-claude", userId: "u-alice", source: "192.168.1.24", sourceKind: "loopback", userAgent: "Claude-User/1.0", agent: "Claude Desktop", agentSource: "clientInfo", reason: "定时授权拒绝：当前不在允许窗口", origin: "obsidian.example.com" },
    { id: "au-3", time: "2026-10-10T01:00:00.000Z", action: "admin.login", outcome: "failure", credentialType: "none", source: "203.0.113.45", sourcePeer: "172.18.0.1", sourceKind: "trusted-proxy", sourceTrusted: true, sourceTrustedEntry: "172.18.0.1", userAgent: "python-requests/2.32.3", reason: "管理密码错误", origin: "obsidian.example.com" },
    { id: "au-4", time: "2026-10-09T22:00:00.000Z", action: "oauth.token", outcome: "success", credentialType: "oauth-refresh", clientId: "c-cursor", userId: "u-bob", source: "192.168.1.30", sourceKind: "direct", userAgent: "cursor/1.0", agent: "cursor/1.0", agentSource: "ua", origin: "obsidian.example.com" },
  ];
  return { apiKeys: keys, clients, oauthUsers, tokens, audit, configuredApiKeyUsage: { lastUsedAt: null, lastSource: null } };
}

/** The real Admin plane in a temp directory, with a request log for the browser's own traffic. */
async function createFixture(cleanups) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "admin-l3-lists-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createAccessPolicyStore({ file: path.join(dir, "access-policy.json") });
  await store.ready;
  const runtime = createAccessPolicyRuntime({ enabled: true, store });
  await runtime.ready;
  const admin = createAccessPolicyAdmin({ store, runtime });
  const provider = {
    ready: Promise.resolve(),
    audits: [],
    recordAudit(event) { this.audits.push(event); },
    async authorizationSnapshot() { return snapshot(); },
    accessRuntime: runtime,
  };
  const app = express();
  const requests = [];
  app.use((req, _res, next) => {
    requests.push(`${req.method} ${req.originalUrl}`);
    next();
  });
  app.use("/admin/auth", createAdminRouter({ provider, adminPassword: ADMIN_PASSWORD, secureCookie: false, accessPolicyAdmin: admin }));
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  cleanups.push(() => new Promise((resolve) => listener.close(resolve)));
  const origin = `http://127.0.0.1:${listener.address().port}`;
  const login = await fetch(`${origin}/admin/auth/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 303, "the fixture login must succeed");
  const [cookieName, cookieValue] = login.headers.get("set-cookie").split(";", 1)[0].split("=");
  return { origin, cookie: `${cookieName}=${cookieValue}`, cookieName, cookieValue, requests, admin, store, runtime, provider };
}

async function get(fixture, url) {
  const response = await fetch(`${fixture.origin}${url}`, { headers: { cookie: fixture.cookie }, redirect: "manual" });
  return { status: response.status, location: response.headers.get("location"), body: await response.text() };
}

// ------------------------------------------------------------------ observations / checkers

const normalise = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const countAll = (selector) => js((value) => document.querySelectorAll(value).length, selector);
const countVisible = (selector) => js((value) => [...document.querySelectorAll(value)].filter((node) => getComputedStyle(node).display !== "none").length, selector);
/** The text of the first row that is still visible (filtering hides rows with an inline style). */
const visibleRowCell = (rowSelector, cell) => js((row, column) => {
  const target = [...document.querySelectorAll(row)].find((node) => getComputedStyle(node).display !== "none");
  return String(target?.querySelector(`td:nth-child(${column})`)?.textContent ?? "");
}, rowSelector, cell);

/**
 * The filtering scenario (desktop rows + mobile cards). Returns observations only; `assertFilterView`
 * judges them, so a negative control can re-run the *same* checker against a broken build.
 */
async function observeFilter(page) {
  await page.goto("/admin/auth?tab=audit");
  await page.evaluate(js(() => { window.__l3Marker = "kept"; window.__l3Navigations = performance.getEntriesByType("navigation").length; }));
  // Pre-existing field state the filter must never touch (a select and a text filter).
  await page.evaluate(js(() => {
    document.querySelector('select[name="action"]').value = "MCP";
    document.querySelector('input[name="origin"]').value = "obsidian.example.com";
  }));
  const readFields = js(() => ({
    action: document.querySelector('select[name="action"]').value,
    origin: document.querySelector('input[name="origin"]').value,
  }));
  const before = {
    rows: await page.evaluate(countAll(".tbl tbody tr")),
    fields: await page.evaluate(readFields),
  };
  await page.focus('input[name="q"]');
  await page.type("claude");
  const after = {
    rows: await page.evaluate(countVisible(".tbl tbody tr")),
    rowText: await page.evaluate(visibleRowCell(".tbl tbody tr", 4)),
    fields: await page.evaluate(readFields),
    queryValue: await page.evaluate(js(() => document.querySelector('input[name="q"]').value)),
    marker: await page.evaluate(js(() => ({ marker: window.__l3Marker ?? null, navigations: performance.getEntriesByType("navigation").length, before: window.__l3Navigations }))),
  };
  // Zero hits: the prototype's own empty state, table hidden.
  await page.backspaces("claude".length);
  await page.type("zzz-no-such-row");
  const empty = await page.evaluate(js(() => ({
    text: String(document.querySelector(".tw .empty")?.textContent ?? "").replace(/\s+/g, " ").trim(),
    tableHidden: getComputedStyle(document.querySelector(".tw .tbl")).display === "none",
    visibleRows: [...document.querySelectorAll(".tbl tbody tr")].filter((row) => getComputedStyle(row).display !== "none").length,
    visibleCardLists: [...document.querySelectorAll(".mcards")].filter((node) => getComputedStyle(node).display !== "none").length,
  })));
  // Clearing restores the list exactly (and never a field we did not type in).
  await page.backspaces("zzz-no-such-row".length);
  const restored = {
    rows: await page.evaluate(countVisible(".tbl tbody tr")),
    fields: await page.evaluate(readFields),
    emptyHidden: await page.evaluate(js(() => {
      const node = document.querySelector(".tw .empty");
      return !node || getComputedStyle(node).display === "none";
    })),
  };
  // Mobile: the same typing must filter the card list (`.mcards` is what is visible below 720px).
  await page.mobile(true);
  await page.goto("/admin/auth?tab=audit");
  const mobileBefore = await page.evaluate(countVisible(".mcards .mc"));
  await page.focus('input[name="q"]');
  await page.type("claude");
  const mobileAfter = await page.evaluate(countVisible(".mcards .mc"));
  await page.backspaces("claude".length);
  await page.type("zzz-no-such-row");
  const mobileEmpty = await page.evaluate(js(() => ({
    text: String(document.querySelector(".tw .empty")?.textContent ?? "").replace(/\s+/g, " ").trim(),
    cardLists: [...document.querySelectorAll(".mcards")].filter((node) => getComputedStyle(node).display !== "none").length,
  })));
  await page.mobile(false);
  return { before, after, empty, restored, mobile: { before: mobileBefore, after: mobileAfter, empty: mobileEmpty } };
}

function assertFilterView(observations) {
  assert.equal(observations.before.rows, 4, `the audit fixture must render four rows: ${JSON.stringify(observations.before)}`);
  assert.equal(observations.after.rows, 1, `typing must narrow the desktop list to one row: ${JSON.stringify(observations.after)}`);
  assert.match(observations.after.rowText, /Claude Desktop/, "the surviving row is the matching one");
  assert.equal(observations.after.marker.marker, "kept", "filtering must not reload the document");
  assert.equal(observations.after.marker.navigations, 1, `filtering must not add a navigation entry: ${JSON.stringify(observations.after.marker)}`);
  assert.equal(observations.after.fields.action, "MCP", "filtering must not move another field's value");
  assert.equal(observations.after.fields.origin, "obsidian.example.com", "filtering must not clear a text filter");
  assert.equal(observations.before.fields.action, "MCP", "the pre-existing select value was really set");
  assert.equal(observations.after.queryValue, "claude", "the operator's own input stays exactly as typed");
  assert.match(observations.empty.text, /没有匹配的审计记录/, `zero hits must show the prototype empty state: ${JSON.stringify(observations.empty)}`);
  assert.match(observations.empty.text, /调整或重置筛选条件/, "the empty state keeps the prototype's second line");
  assert.equal(observations.empty.tableHidden, true, "the table is hidden while every row is filtered out");
  assert.equal(observations.empty.visibleRows, 0, "no row stays visible on a zero-hit filter");
  assert.equal(observations.restored.rows, 4, "clearing the box restores every row");
  assert.equal(observations.restored.fields.action, "MCP", "restoring the list does not touch other fields");
  assert.equal(observations.restored.emptyHidden, true, "the empty state goes away again");
  assert.equal(observations.mobile.before, 4, `the mobile card list renders four cards: ${JSON.stringify(observations.mobile)}`);
  assert.equal(observations.mobile.after, 1, "typing narrows the mobile card list too");
  assert.match(observations.mobile.empty.text, /没有匹配的审计记录/, "the mobile zero-hit state is the prototype's");
  assert.equal(observations.mobile.empty.cardLists, 0, "an all-filtered card list is not left as an empty box");
}

/** Segment + sort + toolbar select switching: URL and content change, the document does not reload. */
async function observeSegments(page) {
  await page.goto("/admin/auth?tab=tokens");
  await page.evaluate(js(() => { window.__l3Marker = "kept"; window.__l3Navigations = performance.getEntriesByType("navigation").length; }));
  const activeHref = await page.evaluate(js(() => document.querySelector('.seg a[href*="status=active"]').getAttribute("href")));
  const before = {
    rows: await page.evaluate(countAll(".tbl tbody tr")),
    firstRow: normalise(await page.evaluate(visibleRowCell(".tbl tbody tr", 1))),
    url: await page.evaluate(js(() => location.href)),
  };
  // The sort `<select>` of the same toolbar, changed by keyboard (`ArrowDown`), not by assignment.
  const sortBefore = await page.evaluate(js(() => document.querySelector('select[name="order"]').value));
  await page.selectNext('select[name="order"]');
  await sleep(300);
  const sort = {
    url: await page.evaluate(js(() => location.href)),
    order: await page.evaluate(js(() => document.querySelector('select[name="order"]')?.value ?? null)),
    marker: await page.evaluate(js(() => ({ marker: window.__l3Marker ?? null, navigations: performance.getEntriesByType("navigation").length }))),
    firstRow: normalise(await page.evaluate(visibleRowCell(".tbl tbody tr", 1))),
  };
  // The segment link now carries the sort the operator chose, so its href is read here.
  const segmentHref = await page.evaluate(js(() => document.querySelector('.seg a[href*="status=active"]').getAttribute("href")));
  await page.click('.seg a[href*="status=active"]');
  await sleep(300);
  const segment = {
    url: await page.evaluate(js(() => location.href)),
    rows: await page.evaluate(countAll(".tbl tbody tr")),
    marker: await page.evaluate(js(() => ({ marker: window.__l3Marker ?? null, navigations: performance.getEntriesByType("navigation").length, before: window.__l3Navigations }))),
    focus: await page.evaluate(js(() => document.activeElement?.getAttribute("href") ?? null)),
    on: await page.evaluate(js(() => document.querySelector(".seg a.on")?.getAttribute("href") ?? null)),
    sortKept: await page.evaluate(js(() => document.querySelector('select[name="order"]')?.value ?? null)),
  };
  // The audit toolbar's own `action` select (prototype `data-af`: changing it re-renders at once).
  await page.goto("/admin/auth?tab=audit");
  await page.evaluate(js(() => { window.__l3Marker = "kept"; }));
  await page.selectNext('select[name="action"]');
  await sleep(300);
  const toolbar = {
    url: await page.evaluate(js(() => location.href)),
    rows: await page.evaluate(countAll(".tbl tbody tr")),
    marker: await page.evaluate(js(() => window.__l3Marker ?? null)),
    selectValue: await page.evaluate(js(() => document.querySelector('select[name="action"]')?.value ?? null)),
  };
  return { before, segmentHref, segment, sortBefore, sort, toolbar };
}

function assertSegments(observations) {
  assert.equal(observations.before.rows, 3, `three grants are listed initially: ${JSON.stringify(observations.before)}`);
  assert.match(observations.segment.url, /status=active/, "the segment click pushes its own URL");
  assert.notEqual(observations.segment.url, observations.before.url, "the URL really changed");
  assert.equal(observations.segment.rows, 1, "only the active grant remains listed");
  assert.equal(observations.segment.marker.marker, "kept", "a segment switch must not reload the document");
  assert.equal(observations.segment.marker.navigations, observations.segment.marker.before, `no new navigation entry: ${JSON.stringify(observations.segment.marker)}`);
  assert.equal(observations.segment.on, observations.segmentHref, "the clicked segment is the active one after the swap");
  assert.equal(observations.segment.focus, observations.segmentHref, "focus is restored onto the same control after the swap");
  assert.equal(observations.sortBefore, "desc", "the fixture starts on the default sort order");
  assert.match(observations.sort.url, /order=asc/, "the sort control re-renders through a URL change");
  assert.equal(observations.sort.order, "asc", "the swapped toolbar keeps the chosen sort order");
  assert.equal(observations.sort.marker.marker, "kept", "the sort switch must not reload the document");
  assert.equal(observations.sort.marker.navigations, 1, "the sort switch adds no navigation entry");
  assert.notEqual(observations.sort.firstRow, observations.before.firstRow, "the sort really reordered the rows");
  assert.equal(observations.segment.sortKept, "asc", "the segment switch keeps the toolbar's other choices");
  assert.match(observations.toolbar.url, /action=MCP/, "the audit toolbar select applies immediately");
  assert.equal(observations.toolbar.selectValue, "MCP", "the swapped toolbar keeps the chosen value");
  assert.equal(observations.toolbar.rows, 2, "the audit toolbar filter really narrowed the list");
  assert.equal(observations.toolbar.rows < observations.before.rows, true, "the narrowed list is shorter than the full list");
  assert.equal(observations.toolbar.marker, "kept", "the audit toolbar switch must not reload the document");
}

// ------------------------------------------------------------------ suite wiring

const suite = { fixture: null, cleanups: [], page: null, cdp: null, child: null, profile: null };

before(async () => {
  suite.fixture = await createFixture(suite.cleanups);
  // The browser half is opt-in, so the default `npm test` gate never launches Chromium (see
  // `needsBrowser`). The fixture above still runs: the static/HTTP contract needs it.
  if (!REQUIRE_BROWSER) return;
  const resolution = resolveBrowser();
  if (resolution.error) assert.fail(`ADMIN_CLIENT_BROWSER_EVIDENCE=1 but no full Chromium build could be found: ${resolution.error}`);
  const launched = await launchBrowser(resolution.executablePath);
  suite.child = launched.child;
  suite.profile = launched.profile;
  suite.cdp = await Cdp.connect(launched.endpoint);
});

after(async () => {
  suite.cdp?.close();
  if (suite.child) suite.child.kill("SIGKILL");
  // Windows keeps a few profile files locked for a moment after SIGKILL; the profile lives in the
  // OS temp directory, so a busy entry must not fail the run.
  if (suite.profile) await fs.rm(suite.profile, { recursive: true, force: true }).catch(() => {});
  for (const cleanup of suite.cleanups.reverse()) await cleanup();
});

/**
 * The browser half is opt-in. The repository's `npm test` gate deliberately does not launch
 * Chromium (browser evidence lives in the `scripts/run-*checks.mjs` runners), and a
 * Chromium-launching file inside the default discovery made unrelated timing tests flaky under
 * load. The skip is explicit and names the command; with the variable set a missing browser is a
 * hard failure instead.
 */
function needsBrowser(t) {
  if (!REQUIRE_BROWSER) {
    t.skip("browser evidence is opt-in: re-run with ADMIN_CLIENT_BROWSER_EVIDENCE=1 (CHECKPOINT.md §2)");
    return false;
  }
  assert.ok(suite.cdp, "the browser fixture must be up when the evidence gate is on");
  return true;
}

/** One fresh page target with the Admin session cookie already installed. */
async function openPage() {
  const { targetId } = await suite.cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await suite.cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = new Page(suite.cdp, targetId, sessionId, suite.fixture.origin);
  await page.send("Page.enable");
  await page.send("DOM.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  await page.send("Network.setCookie", { name: suite.fixture.cookieName, value: suite.fixture.cookieValue, url: `${suite.fixture.origin}/`, path: "/" });
  return page;
}

/** Run `scenario` in a fresh page against the feature module exactly as it is on disk right now. */
async function withPage(scenario) {
  const page = await openPage();
  try {
    return await scenario(page, suite.fixture);
  } finally {
    try { await suite.cdp.send("Target.closeTarget", { targetId: page.targetId }); } catch { /* already closed */ }
  }
}

/**
 * Replace a slice of the *real* feature asset on disk (the router reads it per request, so no
 * restart is needed), run `scenario`, restore the file, and hand the observations to `checker` —
 * expecting a red. A mutation that cannot be applied fails the test, so a negative control can
 * never pass by quietly doing nothing.
 */
async function withMutatedFeature({ find, replace }, scenario, checker, expect) {
  const original = await fs.readFile(FEATURE_ASSET, "utf8");
  // Line endings belong to the checkout (`.gitattributes` + `core.autocrlf`), not to this test: the
  // anchor is matched against the LF form and the original bytes are restored verbatim afterwards.
  const normalized = original.replace(/\r\n/g, "\n");
  assert.ok(normalized.includes(find), `the negative control must find its anchor in ${path.basename(FEATURE_ASSET)}`);
  await fs.writeFile(FEATURE_ASSET, normalized.replace(find, replace));
  try {
    const observations = await withPage(scenario);
    assert.throws(() => checker(observations), expect, "the mutated build must make the checker go red");
    return observations;
  } finally {
    await fs.writeFile(FEATURE_ASSET, original);
    assert.equal(await fs.readFile(FEATURE_ASSET, "utf8"), original, "the feature asset must be restored byte for byte");
  }
}

// ------------------------------------------------------------------ static + HTTP checks

test("the enhancement module keeps its no-JS / no-fabrication invariants (static)", async () => {
  const source = await fs.readFile(FEATURE_ASSET, "utf8");
  // Comments may name what is forbidden (that is the record of the rule); code may not do it.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
  assert.equal(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(code), false, "no HTML is ever built from a string");
  assert.equal(/\beval\s*\(|new Function\s*\(/.test(code), false, "no eval / Function constructor");
  assert.equal(/[\s"']on[a-z]+\s*=/.test(code), false, "no inline event handler");
  assert.equal(/https?:\/\//.test(code.replace(/http:\/\/www\.w3\.org[^"']*/g, "")), false, "no third-party origin");
  assert.match(code, /location\.assign\(url\)/, "every intercepted navigation keeps its fallback");
  // The frozen editor's two behaviours are gone (see the header): no key shortcut and no fetch of a
  // verdict fragment is left in this module, so the module cannot grow one back unnoticed.
  assert.doesNotMatch(code, /registerShortcut\("mod\+enter"|access-policy\/preview|#authz-form|data-preview-form/, "nothing here saves the frozen editor or fetches its preview");
});

// ------------------------------------------------------------------ browser checks

test("the enhancement module boots on an authenticated page", async (t) => {
  if (!needsBrowser(t)) return;
  await withPage(async (page) => {
    await page.goto("/admin/auth?tab=audit");
    // `admin-client.js` boot() replaces the history state; without a boot the whole module graph
    // failed to evaluate (see the lane CHECKPOINT on the registry's temporal dead zone).
    assert.equal(await page.evaluate(js(() => history.state?.adminClient ?? null)), "root", "the enhancement client must boot before any behaviour is judged");
  });
});

test("the Admin CSP permits the same-origin fetches the client must make", async (t) => {
  if (!needsBrowser(t)) return;
  await withPage(async (page) => {
    await page.goto("/admin/auth?tab=audit");
    const probe = await page.evaluate(js(async () => {
      try {
        const response = await fetch(location.href, { headers: { "x-admin-fragment": "1" } });
        return { ok: true, status: response.status };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }));
    // `default-src 'none'` also governs `connect-src`, so `fetchFragment` needs `connect-src 'self'`.
    assert.equal(probe.ok, true, `same-origin fetch must be allowed by the Admin CSP: ${JSON.stringify(probe)}`);
    assert.equal(probe.status, 200, `the probe fetch must really reach the page: ${JSON.stringify(probe)}`);
  });
});

test("typing filters the list in place (rows + mobile cards, prototype empty state, no reload)", async (t) => {
  if (!needsBrowser(t)) return;
  const observations = await withPage(observeFilter);
  assertFilterView(observations);
});

test("status segments and sort controls switch in place (URL + content only)", async (t) => {
  if (!needsBrowser(t)) return;
  assertSegments(await withPage(observeSegments));
});

test("without script the same actions work: GET filter, full-page segment", async (t) => {
  if (!needsBrowser(t)) return;
  const fixture = suite.fixture;
  await withPage(async (page) => {
    try {
      // (1) the search box submits and the server filters. The box is a real GET form and the `/`
      // hint is its submit button (`button.kbd-hint`, carrying the prototype's own `<kbd>/</kbd>`),
      // so the pointer path works without a line of script.
      await page.setScriptExecutionDisabled(true);
      await page.goto("/admin/auth?tab=accounts");
      await page.focus('input[name="q"]');
      await page.type("alice");
      const filteredLoad = page.cdp.waitFor("Page.loadEventFired", page.sessionId);
      await page.click('form.search button[type="submit"]');
      await filteredLoad;
      const filtered = await get(fixture, "/admin/auth?tab=accounts&q=alice");
      assert.match(filtered.body, /alice/, "the server-side filter answer carries the account");
      assert.equal(/u-bob|u-carol/.test(filtered.body), false, "…and only that account");
      await page.setScriptExecutionDisabled(false);
      assert.match(await page.evaluate(js(() => location.search)), /q=alice/, "the plain GET form really navigated with the query");

      // (2) a segment link is still a plain navigation.
      await page.setScriptExecutionDisabled(true);
      await page.goto("/admin/auth?tab=tokens");
      const segmentLoad = page.cdp.waitFor("Page.loadEventFired", page.sessionId);
      await page.click('.seg a[href*="status=active"]');
      await segmentLoad;
      await page.setScriptExecutionDisabled(false);
      assert.match(await page.evaluate(js(() => location.search)), /status=active/, "the segment link navigated on its own");
      assert.equal(await page.evaluate(countAll(".tbl tbody tr")), 1, "the server-rendered page shows only the active grant");
    } finally {
      await page.setScriptExecutionDisabled(false);
    }
  });
});

// ------------------------------------------------------------------ negative controls

test("negative control: a filter that writes form values makes the checker go red", async (t) => {
  if (!needsBrowser(t)) return;
  await withMutatedFeature({
    find: "  const apply = (input) => {\n    const main = document.querySelector(\".main\");",
    replace: "  const apply = (input) => {\n    const main = document.querySelector(\".main\");\n    const touched = main.querySelector('select[name=\"action\"]');\n    if (touched) touched.value = '';\n    const cleared = main.querySelector('input[name=\"origin\"]');\n    if (cleared) cleared.value = '';",
  }, observeFilter, assertFilterView, /must not move another field's value/);
});
