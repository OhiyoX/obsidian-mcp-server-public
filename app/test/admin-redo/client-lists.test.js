// Lane L3 — instant list filtering / segment+sort switching / live policy preview (client behaviour).
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
//   3. the editor pane's 「现在（…）」 verdict and 「对主体的影响」 are the server's: they equal an
//      explicit `GET …/preview?preview=1` answer, while the summary/timeline follow the form locally
//      and a blocked/unavailable endpoint keeps the last *server* verdict (never a browser one);
//   4. `⌘/Ctrl+Enter` submits the editor; 5. every one of these still works with script disabled;
//   6. two negative controls prove the checkers can go red.
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
const DAY_LABELS = Object.freeze({ mon: "周一", tue: "周二", wed: "周三", thu: "周四", fri: "周五", sat: "周六", sun: "周日" });

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
    { id: "au-3", time: "2026-10-10T01:00:00.000Z", action: "admin.login", outcome: "failure", credentialType: "none", source: "198.51.100.7", sourcePeer: "172.18.0.1", sourceKind: "trusted-proxy", sourceTrusted: true, sourceTrustedEntry: "172.18.0.1", userAgent: "python-requests/2.32.3", reason: "管理密码错误", origin: "obsidian.example.com" },
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
const textOf = (selector) => js((value) => String(document.querySelector(value)?.textContent ?? ""), selector);
/** The text of the first row that is still visible (filtering hides rows with an inline style). */
const visibleRowCell = (rowSelector, cell) => js((row, column) => {
  const target = [...document.querySelectorAll(row)].find((node) => getComputedStyle(node).display !== "none");
  return String(target?.querySelector(`td:nth-child(${column})`)?.textContent ?? "");
}, rowSelector, cell);

/** The 「现在（…）」 verdict the server put into the pane (first `.verdict` of the fragment). */
export function firstVerdictText(html) {
  const match = /<div class="verdict[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(String(html));
  if (!match) return null;
  // Removing tags (rather than replacing them with a space) reproduces `textContent` exactly, so the
  // comparison is against the same string the browser would show.
  return normalise(match[1]
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
}

/** The first `.sumbox` headline of a server answer. */
export function firstSummaryText(html) {
  const match = /<div class="sumbox"><b>([\s\S]*?)<\/b>/.exec(String(html));
  return match ? normalise(match[1].replace(/<[^>]*>/g, "")) : null;
}

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

/**
 * The weekday key of the day BEFORE today in the policy timezone. A draft whose weekly window lives on
 * that day carries no window for today, so the server's 「现在」 verdict for it is deterministic — it
 * cannot depend on the hour the test happens to run at. (It is robust across a midnight rollover too:
 * the day is then one further behind, still not today.)
 */
function otherDayKey() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  const yesterday = new Date(new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`).getTime() - 86400000);
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][yesterday.getUTCDay()];
}

/** The edited (unsaved) window that provably excludes "now" in the policy timezone. */
function excludedWindow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  const minutes = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  const [from, to] = minutes < 12 * 60 ? ["12:00", "13:00"] : ["00:00", "01:00"];
  const dayIndex = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`).getUTCDay();
  const dayKey = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][dayIndex];
  return { dayKey, from, to, summary: `${DAY_LABELS[dayKey]} ${from}–${to}` };
}

/**
 * The editor preview scenario in three phases: (a) local summary/timeline while the server endpoint
 * is blocked, (b) the surfaced failure, (c) agreement with the explicit `?preview=1` answer.
 */
async function observePreview(page, fixture) {
  const window_ = excludedWindow();
  // Phase (0) — the deterministic verdict: load the draft on a day that is NOT today. Whatever the
  // wall clock says, the loaded draft carries no window for today, so the server's verdict is
  // 「不在今日时段」 and must not read as 允许访问. (Wave Q: this replaces a `/现在（/` match that
  // asserted nothing about the verdict while depending on the hour through the loaded 09:00–18:00 row.)
  const otherDay = otherDayKey();
  await page.goto(`/admin/auth/access-policy?new=1&day=${otherDay}`);
  const otherDayVerdict = {
    verdict: normalise(await page.evaluate(textOf(".ped-side .verdict"))),
    summary: normalise(await page.evaluate(textOf(".ped-side .sumbox b"))),
    dayKey: otherDay,
  };
  await page.block(["*access-policy/preview*"]);
  // Wave P: a new policy renders no weekly rows until a day is chosen (the prototype's own flow —
  // its chip adds a 09:00–18:00 window). The day is chosen through the same GET round trip the chip
  // performs (`?day=<key>`), so the scenario stays a plain navigation instead of a click that
  // reloads mid-scenario; the fields are then cleared before typing (they no longer start empty).
  // Phase (a) start: the draft with the day the edited window needs — the same GET round trip the
  // 周一 chip performs (Wave P: a new policy renders no weekly row until a day is chosen).
  await page.goto(`/admin/auth/access-policy?new=1&day=${window_.dayKey}`);
  assert.equal(await page.evaluate(js((key) => Boolean(document.querySelector(`input[name="w_${key}_from_1"]`)), window_.dayKey)), true, `?day=${window_.dayKey} must render that weekly row (the chip adds the prototype's 09:00–18:00)`);
  const initial = {
    summary: normalise(await page.evaluate(textOf(".ped-side .sumbox b"))),
    verdict: normalise(await page.evaluate(textOf(".ped-side .verdict"))),
    timelineRows: await page.evaluate(countAll(".ped-side .tl .tr")),
    previewCalls: fixture.requests.filter((entry) => entry.includes("access-policy/preview")).length,
  };
  for (const [suffix, value] of [["from", window_.from], ["to", window_.to]]) {
    const selector = `input[name="w_${window_.dayKey}_${suffix}_1"]`;
    // The chip's default is 09:00 / 18:00; the field is cleared through a real `input` event (the
    // client's listener) and then typed character by character through the editing pipeline.
    await page.evaluate(`(() => { const el = document.querySelector('${selector}'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()`);
    await page.focus(selector);
    await page.type(value);
  }
  // Read immediately: the debounced round trip is both un-elapsed and blocked, so everything below
  // is what the browser derived (or refused to derive) on its own.
  const blocked = {
    summary: normalise(await page.evaluate(textOf(".ped-side .sumbox b"))),
    marks: normalise(await page.evaluate(textOf(".ped-side .sumbox [data-admin-preview-marks]"))),
    verdict: normalise(await page.evaluate(textOf(".ped-side .verdict"))),
    note: normalise(await page.evaluate(textOf(".ped-side [data-admin-preview-note]"))),
    timelineRows: await page.evaluate(countAll(".ped-side .tl .tr")),
    bars: await page.evaluate(countAll(".ped-side .tl .tr .w")),
  };
  await sleep(800);
  const failure = {
    verdict: normalise(await page.evaluate(textOf(".ped-side .verdict"))),
    note: normalise(await page.evaluate(textOf(".ped-side [data-admin-preview-note]"))),
  };
  // Unblock and type one more character (in a field the window does not read) so a fresh request
  // reaches the server.
  await page.block([]);
  await page.focus('input[name="label"]');
  await page.type("现");
  const answer = await (async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const call = [...fixture.requests].reverse().find((entry) => entry.includes("access-policy/preview")
        && entry.includes("preview=1")
        && entry.includes(`w_${window_.dayKey}_from_1=`));
      if (call) return get(fixture, call.slice("GET ".length));
      await sleep(100);
    }
    return null;
  })();
  await sleep(400);
  return {
    window: window_,
    otherDay: otherDayVerdict,
    initial,
    blocked,
    failure,
    answer,
    pane: {
      verdict: normalise(await page.evaluate(textOf(".ped-side .verdict"))),
      summary: normalise(await page.evaluate(textOf(".ped-side .sumbox b"))),
      timelineRows: await page.evaluate(countAll(".ped-side .tl .tr")),
      note: normalise(await page.evaluate(textOf(".ped-side [data-admin-preview-note]"))),
      helpText: normalise(await page.evaluate(js(() => [...document.querySelectorAll(".ped-side p.help")].map((node) => node.textContent).join(" ")))),
      previewCalls: fixture.requests.filter((entry) => entry.includes("access-policy/preview")).length,
    },
  };
}

function assertPreview(observations) {
  assert.equal(observations.initial.timelineRows, 7, "the SSR pane draws the 7-day timeline");
  // Phase (0): the loaded draft's window belongs to another day, so the server's verdict is
  // deterministic — and this is the assertion that pins what the verdict MEANS, not just its shape.
  assert.match(observations.otherDay.verdict, /现在（/, `the pane starts from the server's verdict: ${observations.otherDay.verdict}`);
  assert.match(observations.otherDay.verdict, /今日无生效时段/, `a draft whose window is on another day cannot allow now: ${observations.otherDay.verdict}`);
  assert.equal(/允许访问/.test(observations.otherDay.verdict), false, `the verdict must not read as 允许访问: ${observations.otherDay.verdict}`);
  assert.match(observations.otherDay.summary, new RegExp(`${DAY_LABELS[observations.otherDay.dayKey]}.*09:00`), `the summary still names the other day's default window: ${observations.otherDay.summary}`);
  // (a) the summary/timeline half follows the form locally …
  assert.equal(observations.blocked.summary, observations.window.summary, `the summary is derived in the browser: ${JSON.stringify(observations.blocked)}`);
  assert.notEqual(observations.blocked.summary, observations.initial.summary, "typing really changed the summary");
  assert.equal(observations.blocked.timelineRows, 7, "the locally derived timeline keeps its seven rows");
  assert.equal(observations.blocked.bars, 1, `exactly the edited day carries a bar: ${JSON.stringify(observations.blocked)}`);
  // … (b) while the verdict half stays the server's: nothing is invented, and the failure is visible.
  assert.equal(observations.blocked.verdict, observations.initial.verdict, `the blocked endpoint must not produce a verdict in the browser: ${JSON.stringify(observations.blocked)}`);
  assert.match(observations.blocked.note, /服务端/, "the pending note names the server as the verdict's source");
  assert.equal(observations.failure.verdict, observations.initial.verdict, "a failed preview fetch keeps the last server verdict");
  assert.match(observations.failure.note, /不可用/, "a failed preview fetch is reported, not hidden");
  // (c) the server's answer is adopted, and it is exactly what an explicit request returns.
  assert.ok(observations.answer, "the enhancement script must call the preview endpoint with the draft");
  assert.equal(observations.answer.status, 200, `the explicit preview request must succeed: ${observations.answer?.status}`);
  const expectedVerdict = firstVerdictText(observations.answer.body);
  const expectedSummary = firstSummaryText(observations.answer.body);
  assert.ok(expectedVerdict, "the explicit server answer contains a verdict block");
  assert.equal(observations.pane.verdict, expectedVerdict, `the pane's verdict is the server's answer, not the browser's: ${JSON.stringify({ pane: observations.pane.verdict, server: expectedVerdict })}`);
  assert.match(observations.pane.verdict, /不在今日时段/, `the server verdict reflects the edited window: ${observations.pane.verdict}`);
  assert.equal(/允许访问/.test(observations.pane.verdict), false, "a window excluding now must not read as 允许");
  assert.equal(observations.pane.summary, expectedSummary, "the adopted summary equals the server's summary");
  assert.equal(observations.pane.timelineRows, 7, "the adopted timeline keeps seven rows");
  assert.equal(observations.pane.note, "", "the pending/stale note disappears once the server answered");
  assert.equal(/不会更新本栏/.test(observations.pane.helpText), false, "the no-script hint about a frozen pane is removed once the pane follows the form");
  assert.ok(observations.pane.previewCalls > observations.initial.previewCalls, "the pane really re-adopted a server answer");
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

/**
 * A minimal valid new-policy draft, filled the way an operator does: label, one subject, one
 * capability (the capability group is a native `<details>`, so the same clicks work with script off).
 */
async function fillPolicyDraft(page, label) {
  // Wave P: a new policy renders NO weekly rows until a day is chosen (the prototype's own flow
  // `6-app.js:311`), so the caller navigates with `?day=mon` — the same GET round trip the 周一 chip
  // performs — and the row is there with the prototype's default 09:00–18:00 window.
  await page.focus('input[name="label"]');
  await page.type(label);
  const window_ = await page.evaluate(js(() => {
    const from = document.querySelector('input[name="w_mon_from_1"]');
    const to = document.querySelector('input[name="w_mon_to_1"]');
    return from && to ? { from: from.value, to: to.value } : null;
  }));
  assert.deepEqual(window_, { from: "09:00", to: "18:00" }, "a draft must already carry the prototype's Monday window (09:00–18:00, chosen with ?day=mon)");
  await page.click('input[name="subjects"][value="api-key:k-bot"]');
  await page.click("details.cap-g > summary");
  const opened = await page.evaluate(js(() => document.querySelector("details.cap-g").open));
  assert.equal(opened, true, "the capability group must open before its checkbox can be clicked");
  await page.click('details.cap-g input[name="capabilities"]');
  const picked = await page.evaluate(js(() => ({
    subjects: document.querySelectorAll('input[name="subjects"]:checked').length,
    capabilities: document.querySelectorAll('input[name="capabilities"]:checked').length,
  })));
  assert.deepEqual(picked, { subjects: 1, capabilities: 1 }, "the draft must carry one subject and one capability");
}

/** Whatever the page says about the last write — used in failure messages, never as a check. */
const outcomeText = () => js(() => String(document.querySelector(".result")?.textContent ?? "").replace(/\s+/g, " ").trim());

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
  assert.match(code, /registerShortcut\("mod\+enter"/, "⌘/Ctrl+Enter is registered with the shell's key router");
  assert.match(code, /PREVIEW_ENDPOINT = "\/admin\/auth\/access-policy\/preview"/, "the verdict comes from the server fragment endpoint");
});

test("the preview endpoint is additive: it reads, and the write endpoints keep their CSRF gate", async () => {
  const fixture = suite.fixture;
  const url = "/admin/auth/access-policy/preview?preview=1&label=%E9%A2%84%E8%A7%88&mode=suspend&timezone=Asia%2FShanghai&new=1";
  const preview = await get(fixture, url);
  assert.equal(preview.status, 200, "the read-only preview fragment is served to the session");
  assert.match(preview.body, /<aside class="ped-side">/, "it returns the preview pane's SSR markup");
  assert.match(preview.body, /class="verdict/, "the pane carries the server's 现在判定");
  assert.match(preview.body, /name="csrf"/, "the editor form it embeds still carries the CSRF field");
  assert.equal(/<script/i.test(preview.body), false, "the fragment loads no script of its own");
  const replay = await get(fixture, url);
  assert.equal(replay.body, preview.body, "the same draft always renders the same fragment");
  const unauthenticated = await fetch(`${fixture.origin}${url}`, { redirect: "manual" });
  assert.equal(unauthenticated.status, 303, "without a session the endpoint redirects to login like every other Admin page");
  for (const endpoint of ["preview", "create", "update", "toggle", "delete", "repair"]) {
    const response = await fetch(`${fixture.origin}/admin/auth/access-policy/${endpoint}`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: fixture.cookie },
      body: new URLSearchParams({ label: "x" }).toString(),
    });
    assert.equal(response.status, 403, `POST ${endpoint} must still require the CSRF token`);
  }
  const writes = fixture.requests.filter((entry) => /^POST .*access-policy/.test(entry));
  assert.equal(writes.length, 6, `the CSRF probe posted to six existing endpoints: ${writes.join(", ")}`);
  const list = await get(fixture, "/admin/auth/access-policy");
  assert.equal(list.status, 200, "the list page is unaffected by the new endpoint");
  assert.match(list.body, /定时授权/, "…and still renders its own page");
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

test("the editor preview derives the summary locally and takes the verdict from the server", async (t) => {
  if (!needsBrowser(t)) return;
  assertPreview(await withPage(observePreview));
});

test("⌘/Ctrl+Enter submits the editor through the real form", async (t) => {
  if (!needsBrowser(t)) return;
  await withPage(async (page) => {
    await page.goto("/admin/auth/access-policy?new=1&day=mon");
    await fillPolicyDraft(page, "键盘保存的策略");
    const loaded = page.cdp.waitFor("Page.loadEventFired", page.sessionId);
    await page.ctrlEnter();
    await loaded;
    const created = await get(suite.fixture, "/admin/auth/access-policy");
    assert.match(created.body, /键盘保存的策略/, `the shortcut submitted the real form and the policy was stored (page said: ${await page.evaluate(outcomeText())})`);
  });
});

test("without script the same actions work: GET filter, full-page segment, editor save", async (t) => {
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

      // (3) the editor saves through the real POST with no script at all.
      await page.setScriptExecutionDisabled(true);
      await page.goto("/admin/auth/access-policy?new=1&day=mon");
      await fillPolicyDraft(page, "无脚本保存的策略");
      const postedLoad = page.cdp.waitFor("Page.loadEventFired", page.sessionId);
      await page.click('button[type="submit"][form="authz-form"]');
      await postedLoad;
      await page.setScriptExecutionDisabled(false);
      assert.match((await get(fixture, "/admin/auth/access-policy")).body, /无脚本保存的策略/, `the editor's save button works without any script (page said: ${await page.evaluate(outcomeText())})`);
    } finally {
      await page.setScriptExecutionDisabled(false);
    }
  });
});

// ------------------------------------------------------------------ negative controls

test("negative control: a verdict computed in the browser makes the checker go red", async (t) => {
  if (!needsBrowser(t)) return;
  await withMutatedFeature({
    find: "    target.replaceWith(next);",
    replace: "    target.querySelector(\".verdict span\").textContent = \"现在（本地）允许访问\";",
  }, observePreview, assertPreview, /cannot allow now|must not read as 允许访问|verdict is the server's answer/);
});

test("negative control: a filter that writes form values makes the checker go red", async (t) => {
  if (!needsBrowser(t)) return;
  await withMutatedFeature({
    find: "  const apply = (input) => {\n    const main = document.querySelector(\".main\");",
    replace: "  const apply = (input) => {\n    const main = document.querySelector(\".main\");\n    const touched = main.querySelector('select[name=\"action\"]');\n    if (touched) touched.value = '';\n    const cleared = main.querySelector('input[name=\"origin\"]');\n    if (cleared) cleared.value = '';",
  }, observeFilter, assertFilterView, /must not move another field's value/);
});
