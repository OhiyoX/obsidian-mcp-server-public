#!/usr/bin/env node
// Phase 1-M: mobile (narrow viewport) re-verification of the canonical Markdown
// surface for the unified Markdown rendering TODO (§4 item 5).
//
// Every other theme/parity gate asserts at 1440px wide, so nothing proved that
// the canonical surface still takes its paint from the Vault theme at phone /
// tablet widths. This gate loads the SAME synthetic fixture theme through the
// production `/api/web/v1/theme.css` endpoint and re-runs the SAME per-kind
// assertions (`collectThemePaint` / `evaluatePaint` / `EXPECTED` from
// `render-parity-theme-core.mjs`, which is untouched) at two narrow viewports:
// 375x812 (mobile) and 720x900 (the `@media (max-width: 720px)` boundary).
// 1440 stays owned by the existing CI step, so this gate is narrow-only.
//
// Narrow-width collection discipline (measured failure modes, not precautions):
//   1. each surface is collected in its OWN host mode — a hidden host has no
//      layout, and CodeMirror builds DOM only for a rendered window;
//   2. the Live surface is collected across the whole scroll range
//      (`scroller.scrollTop` set explicitly + selection at the document ends)
//      and merged, because at 375x812 the fixture is ~2x the editor height and
//      two stops were measured to miss the `list` kind entirely;
//   3. before collecting, the host must have layout (`clientHeight > 0`),
//      otherwise the gate fails with the measured dimensions instead of
//      degrading into "no element" noise.
//
// Environment: PLAYWRIGHT_MODULE, CHROMIUM_EXECUTABLE, RENDER_PARITY_OUTPUT,
//   RENDER_PARITY_SKIP_CONTROL, COMMUNITY_THEMES_PATH (when it exists, the
//   committed community subsets are additionally re-run at 375 through
//   `render-parity-mobile-community.mjs`; unset/missing ⇒ synthetic fixture
//   only, no skip and no failure — CI never depends on a local Vault path).
// Exit codes: 0 = every viewport inherited the theme; 1 = assertion failure;
// 2 = browser runtime unavailable (honest blocked state).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  KINDS, EXPECTED, MUTATED_THEME_NAME, PROBE_SOURCE, THEME_ALLOWLIST_RELATIVE, THEME_FIXTURE_RELATIVE, THEME_NAME,
  classifyMismatches, collectThemePaint, describeMismatch, evaluatePaint, mutateCss, mutatedExpected, validateFixture,
} from "./render-parity-theme-core.mjs";
import { runCommunityNarrow } from "./render-parity-mobile-community.mjs";
import { waitForSurfaceReady } from "./render-parity-readiness.mjs";

/** The narrow viewports this gate owns. 1440 is the existing CI step's job. */
export const MOBILE_VIEWPORTS = [
  { label: "mobile", width: 375, height: 812 },
  { label: "breakpoint-720", width: 720, height: 900 },
];
/** Width used by the optional community-subset pass. */
export const COMMUNITY_NARROW_WIDTH = 375;
/**
 * CodeMirror renders only a window of lines, and one stop at each end was
 * measured to miss `list` at 375, so walk the range and merge. Keeping 0 and 1
 * guarantees the two ends are always covered.
 */
export const LIVE_SCROLL_FRACTIONS = [1, 0.75, 0.5, 0.25, 0];
/**
 * Kinds a viewport is allowed not to render. Empty by default: a missing
 * canonical anchor is a failure until someone writes down why it is not.
 * Entries: `{ viewport, surface, kind, reason }`.
 */
export const MOBILE_ALLOWLIST = { nonRendering: [] };

/** A missing kind anchor is fatal unless the (default empty) allowlist names it. */
export function classifyMissingAnchors(mismatches, allowlist = MOBILE_ALLOWLIST, viewportLabel = null) {
  const entries = allowlist?.nonRendering || [];
  const failures = [];
  const allowed = [];
  for (const mismatch of mismatches) {
    const surface = String(mismatch.surface || "").split("@")[0];
    const match = mismatch.prop === "found" && entries.find((entry) => entry.kind === mismatch.kind
      && entry.surface === surface
      && (!viewportLabel || !entry.viewport || entry.viewport === viewportLabel));
    if (match) allowed.push({ ...mismatch, reason: match.reason });
    else failures.push(mismatch);
  }
  return { failures, allowed };
}

/** `clientHeight > 0` guard: a host with no layout cannot be measured. */
export function describeHostLayout({ viewport, surface, mode, clientHeight, clientWidth }) {
  if (!(Number(clientHeight) > 0)) {
    return `${surface}@${viewport}: host has no layout (clientHeight=${clientHeight ?? "null"}, clientWidth=${clientWidth ?? "null"}, mode=${JSON.stringify(mode ?? "")})`;
  }
  return null;
}
/** First found entry wins, so several Live scroll stops merge into one snapshot. */
export function mergeSnapshot(target, snapshot) {
  const merged = target || {};
  for (const [id, entry] of Object.entries(snapshot || {})) {
    if (!merged[id]?.found) merged[id] = entry;
  }
  return merged;
}

/** Report row for one viewport; the viewport size is part of the record. */
export function summarizeViewport(record) {
  return {
    viewport: record.label,
    width: record.width,
    height: record.height,
    status: record.mismatches.length || record.problems.length ? "failed" : "passed",
    mismatches: record.mismatches.length,
    allowlistedMissing: record.allowlistedMissing.length,
    environmentMismatches: record.environmentMismatches.length,
    control: record.control ? { unchanged: record.control.unchanged.length, mismatches: record.control.mismatches.length } : null,
    modes: record.modes,
    layout: record.layout,
  };
}

const appRoot = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(appRoot, THEME_FIXTURE_RELATIVE);
const outputRoot = path.resolve(process.env.RENDER_PARITY_OUTPUT || path.join(os.tmpdir(), `render-parity-mobile-${process.pid}`));
const problems = [];
const fail = (message) => problems.push(message);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function importPlaywright() {
  const href = process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright";
  try {
    return await import(href);
  } catch (error) {
    return { error };
  }
}

async function startServer(vault, dataPath, base, password) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: appRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, HOST: "127.0.0.1", PORT: String(new URL(base).port), VAULT_PATH: vault,
      WEB_VAULTS_ROOT: "", WEB_DEFAULT_VAULT: "", DATA_PATH: dataPath, OAUTH_ENABLED: "true",
      PUBLIC_BASE_URL: base, OAUTH_INITIAL_USERNAME: "render-parity", OAUTH_INITIAL_PASSWORD: password,
      OAUTH_ADMIN_PASSWORD: password, API_KEY: "", GIT_ENABLED: "false", GIT_AUTO_COMMIT: "false",
      GIT_AUTO_PUSH: "false", EMBEDDING_PROVIDER: "disabled", RETRIEVAL_AUTO_EMBED: "false",
    },
  });
  child.stderr.resume();
  child.stdout.resume();
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return child;
    } catch { /* still starting */ }
    if (child.exitCode !== null) throw new Error("render-parity server exited during startup");
    await sleep(100);
  }
  throw new Error("render-parity server did not become healthy");
}

async function writeTheme(vault, name, css) {
  const dir = path.join(vault, ".obsidian", "themes", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "theme.css"), css);
}

/**
 * Point the production theme endpoint at `name`; `null` loads no theme at all.
 * Assigning an unchanged `href` never fires `load`, so an already-installed
 * sheet is a no-op instead of a hang (the isolated Vault boots with the fixture
 * theme already selected in `appearance.json`).
 */
async function setThemeLink(page, base, name) {
  await page.evaluate(async ({ href }) => {
    const link = document.querySelector("#community-theme");
    if (!link) throw new Error("community theme link is missing");
    if (!href) {
      link.disabled = true;
      link.removeAttribute("href");
      return;
    }
    const resolved = new URL(href, document.baseURI).href;
    if (link.getAttribute("href") && link.href === resolved && link.sheet) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`theme did not load within 10s: ${href}`)), 10000);
      link.onload = () => { clearTimeout(timer); resolve(); };
      link.onerror = () => { clearTimeout(timer); reject(new Error(`theme failed to load: ${href}`)); };
      link.disabled = false;
      link.href = href;
    });
  }, { href: name ? `${base}/api/web/v1/theme.css?name=${encodeURIComponent(name)}` : null });
  await sleep(100);
}

async function setMode(page, name) {
  if (!(await page.locator(`.document.mode-${name}`).count())) {
    await page.locator(".view-mode-toggle:visible").click();
    await page.locator(`.view-mode-menu:not([hidden]) .view-mode-item[data-mode="${name}"]`).click();
  }
  await page.waitForFunction((mode) => document.querySelector(`.document.mode-${mode}`) != null, name);
  // #414 (C): reader.js / editor.js load on demand, so `mode-<name>` is not surface readiness.
  // Bounded wait; a timeout logs READINESS and the per-kind assertion still fires.
  await waitForSurfaceReady(page, { surface: name === "preview" ? "reader" : "live", kinds: KINDS });
  await sleep(60);
}

/** Runs in the page: measured layout of the surface that owns `surface`. */
const HOST_LAYOUT = (surface) => {
  const host = surface === "reader"
    ? (document.querySelector("#preview .markdown-preview-view") || document.querySelector("#preview"))
    : document.querySelector(".cm-scroller");
  const container = surface === "reader" ? document.querySelector("#preview") : document.querySelector(".cm-scroller");
  return {
    surface,
    mode: document.querySelector(".document")?.className || "",
    clientHeight: host ? host.clientHeight : null,
    clientWidth: host ? host.clientWidth : null,
    scrollHeight: host ? host.scrollHeight : null,
    containerHeight: container ? container.clientHeight : null,
  };
};

/** Runs in the page: set the selection to the matching end and one scroll stop. */
const SCROLL_TO = (fraction) => {
  const view = window.__testEditor?._view;
  if (view) view.dispatch({ selection: { anchor: fraction === 1 ? view.state.doc.length : 0 } });
  const scroller = document.querySelector(".cm-scroller");
  if (!scroller) return null;
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTop = Math.round(max * fraction);
  return { fraction, want: Math.round(max * fraction), got: scroller.scrollTop, max };
};

/** Fail loudly (with dimensions) when the surface we are about to measure is hidden. */
async function assertSurfaceLayout(page, surface, viewport, expectedMode, record) {
  const layout = await page.evaluate(HOST_LAYOUT, surface);
  const failure = describeHostLayout({ viewport: `${viewport.width}x${viewport.height}`, surface, ...layout });
  if (failure) fail(`${viewport.label}: ${failure}`);
  if (!String(layout.mode).includes(`mode-${expectedMode}`)) {
    fail(`${viewport.label}: ${surface} host mode is ${JSON.stringify(layout.mode)}, expected mode-${expectedMode} (a hidden host has no layout)`);
  }
  record.layout[surface] = layout;
  record.modes[surface] = layout.mode;
  return layout;
}

/** Live snapshot merged over the whole scroll range, plus its stop evidence. */
async function probeLive(page) {
  let merged = {};
  const foundAt = {};
  const stops = [];
  for (const fraction of LIVE_SCROLL_FRACTIONS) {
    stops.push(await page.evaluate(SCROLL_TO, fraction));
    await sleep(150);
    const pass = await page.evaluate(collectThemePaint, { kinds: KINDS, surface: "live" });
    const wasFound = new Set(Object.keys(merged).filter((id) => merged[id].found));
    merged = mergeSnapshot(merged, pass);
    for (const [id, entry] of Object.entries(merged)) if (entry.found && !wasFound.has(id)) foundAt[id] = fraction;
  }
  return { snapshot: merged, foundAt, stops };
}

/** Collect both surfaces in their own host mode; the layout guard runs first. */
async function collectViewport(page, viewport, record) {
  await setMode(page, "preview");
  await sleep(100);
  await assertSurfaceLayout(page, "reader", viewport, "preview", record);
  const reader = await page.evaluate(collectThemePaint, { kinds: KINDS, surface: "reader" });
  await setMode(page, "live");
  await sleep(120);
  await assertSurfaceLayout(page, "live", viewport, "live", record);
  const { snapshot: live, foundAt, stops } = await probeLive(page);
  record.foundAt = foundAt;
  record.stops = stops;
  return { reader, live };
}

/** Assess one viewport's snapshots against the theme declarations. */
function assessViewport(record, snapshots, expected, allowlist, control = null) {
  const suffix = `${record.width}x${record.height}`;
  const mismatches = [
    ...evaluatePaint(snapshots.reader, expected, "reader", `reader@${suffix}`),
    ...evaluatePaint(snapshots.live, expected, "live", `live@${suffix}`),
  ];
  const classified = classifyMismatches(mismatches, allowlist);
  const { failures, allowed } = classifyMissingAnchors(classified.failures, MOBILE_ALLOWLIST, record.label);
  record.mismatches = failures;
  record.allowlistedMissing = allowed;
  record.environmentMismatches = classified.environment;
  record.control = control;
  for (const mismatch of failures) fail(`${record.label} ${describeMismatch(mismatch)}`);
}

/** Negative control: every declared value has to follow the mutated theme. */
function assessControl(record, before, after, expected) {
  const suffix = `${record.width}x${record.height}-mutated`;
  const mismatches = [
    ...evaluatePaint(after.reader, expected, "reader", `reader@${suffix}`),
    ...evaluatePaint(after.live, expected, "live", `live@${suffix}`),
  ];
  const unchanged = [];
  for (const kind of KINDS) {
    for (const surface of ["reader", "live"]) {
      for (const prop of kind.props[surface] || []) {
        const was = before[surface][kind.id]?.values?.[prop];
        const now = after[surface][kind.id]?.values?.[prop];
        if (was != null && was === now) unchanged.push(`${surface} ${kind.id} ${prop} stayed ${JSON.stringify(was)}`);
      }
    }
  }
  for (const mismatch of mismatches) fail(`${record.label} negative control ${describeMismatch(mismatch)}`);
  for (const entry of unchanged) fail(`${record.label} negative control did not follow the mutated theme: ${entry}`);
  return { mismatches, unchanged };
}

async function main() {
  const fixtureCss = (await fs.readFile(fixturePath, "utf8")).replace(/\r\n/g, "\n");
  const allowlist = JSON.parse(await fs.readFile(path.join(appRoot, THEME_ALLOWLIST_RELATIVE), "utf8"));
  const fixtureProblems = validateFixture(fixtureCss);
  if (fixtureProblems.length) {
    console.log(`FAIL render-parity Phase 1-M fixture: ${fixtureProblems[0]}`);
    process.exitCode = 1;
    return;
  }
  await fs.mkdir(outputRoot, { recursive: true });
  const report = {
    status: "running",
    generatedAt: new Date().toISOString(),
    fixture: THEME_FIXTURE_RELATIVE,
    theme: THEME_NAME,
    kinds: KINDS.map((kind) => kind.id),
    viewports: MOBILE_VIEWPORTS.map((viewport) => ({ viewport: viewport.label, width: viewport.width, height: viewport.height })),
    viewportReports: [],
    snapshots: {},
    communityNarrow: null,
    problems: [],
  };
  const writeReport = async () => {
    report.problems = problems;
    report.status = problems.length === 0 ? "passed" : "failed";
    await fs.writeFile(path.join(outputRoot, "render-parity-mobile-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  };
  const playwright = await importPlaywright();
  if (playwright.error || !playwright.chromium) {
    report.status = "blocked";
    report.reason = playwright.error ? playwright.error.message : "PLAYWRIGHT_MODULE did not expose chromium";
    await writeReport();
    console.log(`BLOCKED render-parity Phase 1-M: ${report.reason}`);
    process.exitCode = 2;
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "render-parity-mobile-"));
  const vault = path.join(root, "vault");
  await fs.mkdir(vault, { recursive: true });
  await writeTheme(vault, THEME_NAME, fixtureCss);
  await fs.writeFile(path.join(vault, ".obsidian", "appearance.json"), JSON.stringify({ cssTheme: THEME_NAME, theme: "moonstone", baseFontSize: 16 }));
  await fs.writeFile(path.join(vault, "ThemeParity.md"), PROBE_SOURCE);
  await fs.writeFile(path.join(vault, "embed-parity.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>');
  const port = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const selected = server.address().port;
      server.close(() => resolve(selected));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(24).toString("hex");
  let browser;
  let child;
  try {
    child = await startServer(vault, path.join(root, "data"), base, password);
    browser = await playwright.chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    });
    // The context boots wide (desktop layout); each viewport is applied with
    // `setViewportSize` before it is measured.
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 1800 } })).newPage();
    page.setDefaultTimeout(15000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
    await page.addInitScript(() => {
      Object.defineProperty(window, "createObsidianEditor", {
        configurable: true,
        set(factory) {
          Object.defineProperty(window, "createObsidianEditor", {
            configurable: true, writable: true,
            value(...args) { const editor = factory(...args); window.__testEditor = editor; return editor; },
          });
        },
      });
    });
    const login = await page.request.post(`${base}/auth/login`, { form: { username: "render-parity", password } });
    if (login.status() !== 200) throw new Error(`login failed with ${login.status()}`);
    await page.goto(`${base}/app`);
    await page.waitForSelector('.note[title="ThemeParity.md"]');
    await page.locator('.note[title="ThemeParity.md"]').click();
    await page.waitForFunction(() => document.querySelector("#current-path")?.textContent === "ThemeParity.md");

    for (const [index, viewport] of MOBILE_VIEWPORTS.entries()) {
      const record = {
        label: viewport.label, width: viewport.width, height: viewport.height,
        modes: {}, layout: {}, mismatches: [], allowlistedMissing: [], environmentMismatches: [],
        control: null, foundAt: {}, stops: [], problems: [],
      };
      report.viewportReports.push(record);
      const problemCount = problems.length;
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await sleep(200);
      await setThemeLink(page, base, THEME_NAME);
      const before = await collectViewport(page, viewport, record);
      let control = null;
      if (!process.env.RENDER_PARITY_SKIP_CONTROL) {
        await writeTheme(vault, MUTATED_THEME_NAME, mutateCss(fixtureCss));
        await setThemeLink(page, base, MUTATED_THEME_NAME);
        const after = await collectViewport(page, viewport, record);
        control = assessControl(record, before, after, mutatedExpected(EXPECTED));
        await setThemeLink(page, base, THEME_NAME);
      }
      assessViewport(record, before, EXPECTED, allowlist, control);
      record.problems = problems.slice(problemCount);
      report.viewports[index] = summarizeViewport(record);
      report.snapshots[viewport.label] = before;
    }

    const communityPath = process.env.COMMUNITY_THEMES_PATH;
    if (communityPath && (await fs.stat(communityPath).catch(() => null))?.isDirectory()) {
      // The committed subsets, never the read-only real theme directory: CI must
      // not depend on a local Vault path, and the subsets are the pinned
      // derivative the wide Phase 1-C gate already asserts at 1440.
      report.communityNarrow = await runCommunityNarrow({
        page, base, vault, viewport: MOBILE_VIEWPORTS[0], liveFractions: LIVE_SCROLL_FRACTIONS,
        writeTheme, setThemeLink, setMode, assertSurfaceLayout, fail,
      });
    } else {
      report.communityNarrow = { skipped: false, reason: "COMMUNITY_THEMES_PATH unset or not a directory; synthetic fixture only" };
    }

    if (pageErrors.length) fail(`${pageErrors.length} uncaught page error(s): ${pageErrors[0].split("\n")[0]}`);
    report.pageErrors = pageErrors;
  } catch (error) {
    const message = error.stack || error.message;
    fail(message);
    const browserUnavailable = /Executable doesn't exist|Failed to launch|Host system is missing dependencies|browserType\.launch/i.test(message);
    report.status = browserUnavailable ? "blocked" : "failed";
    if (browserUnavailable) report.reason = "Chromium could not be launched; install the shared runtime browsers.";
  } finally {
    await browser?.close().catch(() => {});
    if (child) {
      child.kill();
      await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
    }
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith("render-parity-mobile-")) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }
  await writeReport();
  console.log("");
  console.log("Render parity Phase 1-M (narrow viewport theme inheritance) summary");
  console.log(`  status   : ${report.status}`);
  console.log(`  kinds    : ${KINDS.length} x 2 surfaces x ${MOBILE_VIEWPORTS.length} viewports`);
  for (const viewport of report.viewports) {
    const live = viewport.layout?.live ?? {};
    const reader = viewport.layout?.reader ?? {};
    const max = live.scrollHeight != null && live.clientHeight != null ? live.scrollHeight - live.clientHeight : "n/a";
    console.log(`  ${viewport.viewport.padEnd(14)}: ${viewport.status} (${viewport.width}x${viewport.height}) mismatches=${viewport.mismatches} allowlisted=${viewport.allowlistedMissing} control=${viewport.control ? `unchanged=${viewport.control.unchanged}` : "skipped"}`);
    console.log(`    layout    : reader clientHeight=${reader.clientHeight} (mode=${JSON.stringify(viewport.modes?.reader)}) live clientHeight=${live.clientHeight} (mode=${JSON.stringify(viewport.modes?.live)}) liveScrollMax=${max}`);
  }
  for (const theme of report.communityNarrow?.themes || []) {
    console.log(`  community ${theme.theme}@${theme.width}: claims=${JSON.stringify(theme.claims)} shadowed=${theme.shadowed.length} control=${theme.control ? `${theme.control.moved} moved / ${theme.control.unchanged.length} unchanged` : "skipped"}`);
  }
  console.log(`  report   : ${path.join(outputRoot, "render-parity-mobile-report.json")}`);
  if (problems.length) {
    console.log("  problems :");
    for (const problem of problems) console.log(`    - ${problem}`);
  }
  process.exitCode = report.status === "passed" ? 0 : report.status === "blocked" ? 2 : 1;
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
