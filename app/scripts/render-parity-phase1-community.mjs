#!/usr/bin/env node
// Phase 1-C community theme gate for the unified Markdown rendering TODO.
//
// Phase 1-A proves the paint comes from a synthetic fixture theme; this gate
// proves the same contract against DERIVED SUBSETS OF REAL COMMUNITY THEMES
// (Things / Minimal / AnuPpuccin), committed as `test/fixtures/*.subset.css` and
// installed through the production `/api/web/v1/theme.css` endpoint.
//
// Issue #360: every pass runs TWICE, once per colour side (`light`, then
// `dark`). Before this slice only one side was sampled by accident -- the vault
// appearance carried no `colorMode`, so the server rendered `theme-light`, the
// app resolved "system" and headless Chromium's default
// `prefers-color-scheme: light` kept it light. The dark side is now requested
// through the production `#color-mode` control and its observable result is
// asserted (`theme-dark` on <html> and <body>, root `color-scheme: dark`), plus
// three app-declared dark tokens (`render-parity-color-sides.mjs`). Each side
// measures its OWN fallback pass, so "the theme does not declare this in dark"
// is compared against the dark fallback rather than the light one, and a
// light-only subset must not paint the dark side.
//
// Per kind K, surface S and asserted property P the contract is two-sided:
//   * the subset declares P for K   -> computed must equal the theme's declared
//     value (a theme rule the app out-specifies is a failure);
//   * the subset does not declare P -> computed must equal the Web fallback.
// Token-mediated paint (the theme declares `--text-normal` and a host rule reads
// it) is asserted at token level: every root token the subset declares must be in
// force with the theme's own value. Theme tokens the app's own layer out-specifies
// are reported as `clobbered` and are only failures with
// RENDER_PARITY_COMMUNITY_STRICT=1 (see the slice HANDOFF).
//
// A root token the theme itself declares, whose computed value is the empty
// string while the theme's own sheet still owns it, is a DIFFERENT thing: the
// browser dropped that declaration at parse time (e.g. AnuPpuccin's
// `rgba(var(255, 255, 255), 0.09)`, where `var(255, 255, 255)` is not a custom
// property reference), so no cascade can ever make it compute to a value. That
// token is classified as `themeInvalid` -- its own tier, printed with the token
// name, the declaring source and the empty value -- and is deliberately NOT
// counted as `clobbered`/`shadowed`/`mismatches` (an app-side clobber still is).
//
// Environment: PLAYWRIGHT_MODULE, CHROMIUM_EXECUTABLE, RENDER_PARITY_OUTPUT,
// COMMUNITY_THEMES_PATH (optional real theme dir, gated in addition to the
// subsets when it exists), RENDER_PARITY_COMMUNITY_STRICT, RENDER_PARITY_SKIP_CONTROL,
// RENDER_PARITY_SIDES (comma list; defaults to light,dark -- used to isolate one
// side while debugging, never in CI).
// Exit codes: 0 = every theme passed; 1 = assertion failure; 2 = blocked.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { KINDS, PROBE_SOURCE } from "./render-parity-theme-core.mjs";
import { parseSubset } from "./extract-theme-subset.mjs";
import { kindProps, mutateSubsetCss, observedTokens, resolveThemeTokens, surveyFallback, surveyTheme, tableOf } from "./render-parity-community-probe.mjs";
import { DARK_FIXTURE_RELATIVE, DARK_FIXTURE_THEME_NAME, DECLARED_SIDE_TOKENS, SIDES, colorSideProblems, declaredSideTokenMismatches, setColorMode, sideSeparationProblems, validateColorSideDeclarations, validateDarkFixture } from "./render-parity-color-sides.mjs";
import { printCommunityThemeSummary } from "./render-parity-community-summary.mjs";
import { waitForSurfaceReady } from "./render-parity-readiness.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const fixturesRoot = path.join(appRoot, "test/fixtures");
const outputRoot = path.resolve(process.env.RENDER_PARITY_OUTPUT || path.join(os.tmpdir(), `render-parity-community-${process.pid}`));
const strictTokens = Boolean(process.env.RENDER_PARITY_COMMUNITY_STRICT);
const problems = [];
// Messages are prefixed with the colour side currently being measured, so one
// report can carry both sides and the light side stays a first-class pass.
let failPrefix = "";
const fail = (message) => problems.push(failPrefix ? `${failPrefix}${message}` : message);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeValue = (value) => String(value ?? "").replace(/\s+/g, " ").replace(/"/g, "'").replace(/\s*,\s*/g, ",").trim().toLowerCase();

/**
 * Is this observed root token a declaration the browser dropped at parse time?
 *
 * The value the theme asks for cannot be reproduced by any cascade, so it would
 * otherwise be reported as "the app's layer wins" -- which is the opposite of
 * what happened. Requires BOTH the empty computed value and the absence of an
 * app-side owner, so a token the app's own sheet out-specifies (which computes
 * to a real value, or to an app-side value) is never excused.
 *
 * `ownerSheet == null` is part of the trigger because a declaration the browser
 * dropped is invisible to the CSSOM: `rule.style.getPropertyValue()` is already
 * empty, so the theme's own rule never appears in `tokenOwners` and the token
 * has NO owner at all (measured: `ownerSheet: null` for both AnuPpuccin tokens,
 * see the slice HANDOFF).
 */
export function isThemeSideInvalid({ observed, ownerSheet }) {
  return String(observed ?? "") === "" && (ownerSheet == null || ownerSheet === "community-theme");
}

async function importPlaywright() {
  const href = process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright";
  try { return await import(href); } catch (error) { return { error }; }
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
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { if ((await fetch(`${base}/healthz`)).ok) return child; } catch { /* still starting */ }
    if (child.exitCode !== null) throw new Error("render-parity server exited during startup");
    await sleep(100);
  }
  // A server that never became healthy must not be left running: the caller only
  // receives `child` on success, so without this kill the process is orphaned and
  // keeps the harness alive (measured: a failed step hung until the outer
  // `timeout` killed it instead of exiting with the honest failure).
  child.kill();
  throw new Error("render-parity server did not become healthy");
}

async function writeTheme(vault, name, css) {
  const dir = path.join(vault, ".obsidian", "themes", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "theme.css"), css);
}

/** Point the production theme endpoint at `name`; `null` loads no theme at all. */
async function setThemeLink(page, base, name) {
  await page.evaluate(async ({ href }) => {
    const link = document.querySelector("#community-theme");
    if (!link) throw new Error("community theme link is missing");
    if (!href) { link.disabled = true; link.removeAttribute("href"); return; }
    await new Promise((resolve, reject) => {
      link.onload = () => resolve();
      link.onerror = () => reject(new Error(`theme failed to load: ${href}`));
      link.disabled = false;
      link.href = href;
    });
  }, { href: name ? `${base}/api/web/v1/theme.css?name=${encodeURIComponent(name)}` : null });
  await sleep(100);
}

/** Two-sided assertion for one installed theme (subset or full real theme). */
function assertTheme({ name, survey, fallback, body, fallbackTokens, record, includeDark }) {
  const table = tableOf(body, { includeDark });
  const resolved = resolveThemeTokens(table, (selector) => survey.reader.applicable[selector] === true || survey.live.applicable[selector] === true);
  const claims = { declared: 0, tokenMediated: 0, fallback: 0 };
  record.fallbackTokens = Object.fromEntries(Object.keys(table).filter((token) => fallbackTokens[token] != null).map((token) => [token, fallbackTokens[token]]));
  for (const surface of ["reader", "live"]) {
    for (const kind of KINDS) {
      for (const prop of kindProps(kind, surface)) {
        const label = `${surface} ${kind.id}.${prop}`;
        const before = fallback[surface].kinds[kind.id]?.values?.[prop];
        const entry = survey[surface].kinds[kind.id];
        const actual = entry?.values?.[prop];
        if (actual == null) {
          record.mismatches.push({ surface, kind: kind.id, prop, expected: "element", actual: "missing" });
          fail(`${name} ${label}: no element to measure`);
          continue;
        }
        const declared = entry.declarations?.[prop];
        if (declared?.shadowedBy) {
          // The theme declares this property for the kind but an app rule wins at
          // the same element. When both produce the same paint the theme's intent
          // is met; otherwise it is reported (fatal only in strict mode).
          if (normalizeValue(actual) === normalizeValue(declared.normalized)) { claims.declared += 1; continue; }
          record.shadowed.push({ surface, kind: kind.id, prop, selector: declared.selector, declared: declared.normalized, computed: actual, shadowedBy: declared.shadowedBy });
          continue;
        }
        if (declared) {
          claims.declared += 1;
          if (normalizeValue(actual) !== normalizeValue(declared.normalized)) {
            record.mismatches.push({ surface, kind: kind.id, prop, expected: declared.normalized, actual, selector: declared.selector, mode: "declared" });
            fail(`${name} ${label}: theme declared ${JSON.stringify(declared.value)} (${declared.selector}), computed ${JSON.stringify(actual)}`);
          }
          continue;
        }
        if (normalizeValue(actual) === normalizeValue(before)) { claims.fallback += 1; continue; }
        const sentinel = survey.sentinel?.[surface]?.kinds?.[kind.id]?.values?.[prop];
        if (sentinel != null && normalizeValue(sentinel) !== normalizeValue(actual)) { claims.tokenMediated += 1; continue; }
        record.mismatches.push({ surface, kind: kind.id, prop, expected: "theme-attributable", actual, fallback: before, mode: "unattributed" });
        fail(`${name} ${label}: computed ${JSON.stringify(actual)} differs from the fallback ${JSON.stringify(before)} but no theme declaration or theme token explains it`);
      }
    }
  }
  const tokens = { root: 0, element: 0, notApplicable: 0, unresolved: 0, dynamic: 0, hostDependent: 0, asserted: 0 };
  const assertedTokens = new Set();
  const chainOf = (token, seen = new Set()) => {
    const winner = resolved[token];
    if (!winner) return [];
    const out = [];
    for (const match of winner.value.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) {
      if (seen.has(match[1])) continue;
      seen.add(match[1]);
      out.push(match[1], ...chainOf(match[1], seen));
    }
    return out;
  };
  for (const token of Object.keys(table)) {
    const winner = resolved[token];
    if (!winner) { tokens.notApplicable += 1; continue; }
    if (winner.scope !== "root") { tokens.element += 1; continue; }
    tokens.root += 1;
    if (winner.resolved == null) { tokens.unresolved += 1; continue; }
    if (/^(inherit|initial|unset|revert|revert-layer)$/i.test(winner.resolved.trim())) { tokens.dynamic += 1; continue; }
    // A token whose `var()` chain is served by the host (a token the app defines,
    // or one the theme never defines) cannot be predicted from the subset alone:
    // counted, not asserted. An empty host value means both sides fall through to
    // the declared fallback, which this resolver reproduces.
    const hostDependent = chainOf(token).some((dep) => {
      const hostValue = String(survey.reader.tokens[dep] ?? survey.live.tokens[dep] ?? "").trim();
      if (!hostValue) return false;
      const other = resolved[dep];
      return !other || other.resolved == null || normalizeValue(hostValue) !== normalizeValue(other.resolved);
    });
    if (hostDependent) {
      tokens.hostDependent += 1;
      if (record.hostDependentSample.length < 12) record.hostDependentSample.push({ token, value: winner.value, chain: chainOf(token).slice(0, 4) });
      continue;
    }
    const observed = survey.reader.tokens[token] || survey.live.tokens[token];
    if (normalizeValue(observed) === normalizeValue(winner.resolved)) {
      tokens.asserted += 1;
      assertedTokens.add(token);
      continue;
    }
    const owner = survey.reader.tokenOwners[token] ?? survey.live.tokenOwners[token];
    if (isThemeSideInvalid({ observed, ownerSheet: owner?.sheet })) {
      record.themeInvalid.push({ token, declared: winner.resolved, computed: observed, selector: winner.selector, ownerSheet: owner?.sheet ?? null, ownerSelector: owner?.selector ?? null });
      continue;
    }
    const clobbered = (owner && owner.sheet !== "community-theme")
      || (fallbackTokens[token] != null && normalizeValue(observed) === normalizeValue(fallbackTokens[token]));
    if (clobbered) {
      record.clobbered.push({ token, declared: winner.resolved, computed: observed, selector: winner.selector, shadowedBy: owner?.sheet === "community-theme" ? null : owner?.selector ?? null });
      continue;
    }
    record.mismatches.push({ surface: "token", kind: token, prop: "value", expected: winner.resolved, actual: observed, selector: winner.selector, mode: "token" });
    fail(`${name} token ${token}: theme declares ${JSON.stringify(winner.resolved)} (${winner.selector}), computed ${JSON.stringify(observed)}`);
  }
  record.tokens = tokens;
  record.claims = claims;
  return { resolved, assertedTokens };
}

async function runTheme(page, base, vault, theme, fallback, fallbackTokens, setMode, includeDark = false) {
  const record = { name: theme.name, source: theme.source, mismatches: [], clobbered: [], shadowed: [], themeInvalid: [], control: null, tokens: null, claims: null, hostDependentSample: [], fallbackTokens: {} };
  await writeTheme(vault, theme.themeName, theme.body);
  await setThemeLink(page, base, theme.themeName);
  const survey = await surveyTheme(page, { kinds: KINDS, body: theme.body, dropped: theme.droppedSample || [], sleep, setMode, includeDark });
  const result = assertTheme({ name: theme.name, survey, fallback, body: theme.body, fallbackTokens, record, includeDark });
  record.droppedMatches = [...survey.reader.droppedMatches, ...survey.live.droppedMatches];
  if (process.env.RENDER_PARITY_SKIP_CONTROL) return record;
  // Negative control: mutate the installed subset and require the paint to follow.
  // Only entries whose declared value actually moved are required to move, so a
  // mutation that cannot reach the surface is never excused.
  const mutated = mutateSubsetCss(theme.body);
  await writeTheme(vault, `${theme.themeName}Mut`, mutated.css);
  await setThemeLink(page, base, `${theme.themeName}Mut`);
  const after = await surveyTheme(page, { kinds: KINDS, body: mutated.css, dropped: [], sleep, setMode, includeDark });
  const afterResolved = resolveThemeTokens(tableOf(mutated.css, { includeDark }), (selector) => after.reader.applicable[selector] === true || after.live.applicable[selector] === true);
  const unchanged = [];
  let moved = 0;
  for (const surface of ["reader", "live"]) {
    for (const kind of KINDS) {
      for (const prop of kindProps(kind, surface)) {
        const declared = after[surface].kinds[kind.id]?.declarations?.[prop];
        if (!declared || declared.shadowedBy) continue;
        const before = survey[surface].kinds[kind.id]?.values?.[prop];
        const value = after[surface].kinds[kind.id]?.values?.[prop];
        if (normalizeValue(value) !== normalizeValue(declared.normalized)) {
          fail(`${theme.name} negative control ${surface} ${kind.id}.${prop}: mutated declaration ${JSON.stringify(declared.value)} computed ${JSON.stringify(value)}`);
          continue;
        }
        const was = survey[surface].kinds[kind.id]?.declarations?.[prop];
        if (was && normalizeValue(was.normalized) === normalizeValue(declared.normalized)) continue;
        if (normalizeValue(before) === normalizeValue(value)) unchanged.push(`${surface} ${kind.id}.${prop} stayed ${JSON.stringify(value)}`);
        else moved += 1;
      }
    }
  }
  for (const token of result.assertedTokens) {
    const target = afterResolved[token];
    const was = result.resolved[token]?.resolved;
    const before = survey.reader.tokens[token] ?? survey.live.tokens[token];
    const value = after.reader.tokens[token] ?? after.live.tokens[token];
    if (!target || target.resolved == null) continue;
    if (normalizeValue(value) !== normalizeValue(target.resolved)) {
      fail(`${theme.name} negative control token ${token}: mutated declaration ${JSON.stringify(target.value)} computed ${JSON.stringify(value)}`);
      continue;
    }
    if (was != null && normalizeValue(was) === normalizeValue(target.resolved)) continue;
    if (normalizeValue(before) === normalizeValue(value)) unchanged.push(`token ${token} stayed ${JSON.stringify(value)}`);
    else moved += 1;
  }
  record.control = { mutations: mutated.mutations, moved, unchanged };
  if (!mutated.mutations) fail(`${theme.name} negative control: the mutation transform changed nothing`);
  if (!moved) fail(`${theme.name} negative control: no declared value moved, the assertions do not follow the theme`);
  for (const entry of unchanged) fail(`${theme.name} negative control: ${entry}`);
  return record;
}

async function main() {
  const report = { status: "running", generatedAt: new Date().toISOString(), kinds: KINDS.length, strictTokens, sides: {}, problems: [] };
  await fs.mkdir(outputRoot, { recursive: true });
  const fixtures = [];
  for (const file of (await fs.readdir(fixturesRoot)).filter((name) => /^render-parity-.*\.subset\.css$/.test(name)).sort()) {
    const parsed = parseSubset(await fs.readFile(path.join(fixturesRoot, file), "utf8"));
    if (parsed.bodySha256 !== parsed.manifest.subset.sha256) fail(`${file}: body sha256 ${parsed.bodySha256} does not match the pinned manifest ${parsed.manifest.subset.sha256}`);
    fixtures.push({ file, name: parsed.manifest.source.name, body: parsed.body, manifest: parsed.manifest });
  }
  if (!fixtures.length) fail("no community theme subsets found in test/fixtures");
  const subsetRecords = () => fixtures.map((entry) => ({
    file: entry.file, theme: entry.name, bytes: Buffer.byteLength(entry.body, "utf8"), rules: entry.manifest.subset.rules,
    tokens: entry.manifest.subset.tokens, sourceSha256: entry.manifest.source.sha256, bodySha256: entry.manifest.subset.sha256,
  }));
  const requested = (process.env.RENDER_PARITY_SIDES || "").split(",").map((value) => value.trim()).filter(Boolean);
  const sides = requested.length ? requested : SIDES;
  for (const mode of sides) if (!SIDES.includes(mode)) fail(`RENDER_PARITY_SIDES: unknown colour side ${mode}`);
  const appCss = await fs.readFile(path.join(appRoot, "src/app/assets/app.css"), "utf8");
  for (const problem of validateColorSideDeclarations(appCss)) fail(`app.css: ${problem}`);
  // The self-built dark fixture carries the only real `.theme-dark` declarations
  // the dark side ever asserts (the committed subsets are light-only), so its
  // shape is validated before any side is measured. It is read once and used for
  // every side.
  const darkFixtureCss = (await fs.readFile(path.join(appRoot, DARK_FIXTURE_RELATIVE), "utf8")).replace(/\r\n/g, "\n");
  for (const problem of validateDarkFixture(darkFixtureCss)) fail(`fixture: ${problem}`);
  const playwright = await importPlaywright();
  const write = async () => {
    report.problems = problems;
    await fs.writeFile(path.join(outputRoot, "render-parity-community-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  };
  if (playwright.error || !playwright.chromium) {
    report.status = "blocked";
    report.reason = playwright.error ? playwright.error.message : "PLAYWRIGHT_MODULE did not expose chromium";
    await write();
    console.log(`BLOCKED render-parity Phase 1-C: ${report.reason}`);
    process.exitCode = 2;
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "render-parity-community-"));
  const vault = path.join(root, "vault");
  await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
  await fs.writeFile(path.join(vault, ".obsidian", "appearance.json"), JSON.stringify({ cssTheme: "", theme: "moonstone", baseFontSize: 16 }));
  await fs.writeFile(path.join(vault, "ThemeParity.md"), PROBE_SOURCE);
  await fs.writeFile(path.join(vault, "embed-parity.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>');
  const port = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => { const selected = server.address().port; server.close(() => resolve(selected)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(24).toString("hex");
  let browser;
  let child;
  const realThemes = [];
  try {
    child = await startServer(vault, path.join(root, "data"), base, password);
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
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
    const setMode = async (mode) => {
      if (!(await page.locator(`.document.mode-${mode}`).count())) {
        await page.locator(".view-mode-toggle:visible").click();
        await page.locator(`.view-mode-menu:not([hidden]) .view-mode-item[data-mode="${mode}"]`).click();
      }
      await page.waitForFunction((name) => document.querySelector(`.document.mode-${name}`) != null, mode);
      // #414 (C): reader.js / editor.js load on demand, so `mode-<mode>` is not surface
      // readiness. Bounded wait; a timeout logs READINESS and the probe assertion still fires.
      await waitForSurfaceReady(page, { surface: mode === "preview" ? "reader" : "live", kinds: KINDS });
      await sleep(60);
    };
    const realPath = process.env.COMMUNITY_THEMES_PATH;
    if (realPath && (await fs.stat(realPath).catch(() => null))?.isDirectory()) {
      for (const entry of await fs.readdir(realPath, { withFileTypes: true })) {
        const file = path.join(realPath, entry.name, "theme.css");
        if (!entry.isDirectory() || !(await fs.stat(file).catch(() => null))?.isFile()) continue;
        realThemes.push({ name: entry.name, body: await fs.readFile(file, "utf8"), source: `${realPath}/${entry.name}/theme.css`, themeName: `RenderParityReal${entry.name}`, droppedSample: [] });
      }
    }
    // A self-built dark fixture runs on BOTH sides even when
    // COMMUNITY_THEMES_PATH is unset: it is the one theme whose `.theme-dark`
    // declarations the dark side asserts, because the committed subsets are
    // light-only by construction (#360).
    realThemes.push({ name: DARK_FIXTURE_THEME_NAME, body: darkFixtureCss, source: DARK_FIXTURE_RELATIVE, themeName: DARK_FIXTURE_THEME_NAME, droppedSample: [], selfBuilt: true });
    // One full pass per colour side, LIGHT FIRST so a regression that broke the
    // light sample could never be hidden behind the new dark one. Each side runs
    // its own fallback pass (no community theme at all), so "the theme does not
    // declare this here" is compared against that side's own fallback value, and
    // it owns its own negative control.
    const declaredBySide = {};
    for (const mode of sides) {
      const includeDark = mode === "dark";
      const fallbackTokenNames = [...new Set([
        ...DECLARED_SIDE_TOKENS.map((entry) => entry.token),
        ...[...fixtures, ...realThemes].flatMap((entry) => observedTokens(tableOf(entry.body, { includeDark }))),
      ])].sort();
      failPrefix = `[${mode}] `;
      const side = { side: mode, color: null, colorProblems: [], subsets: subsetRecords(), realThemes: [], clobbered: [], themeInvalid: [], declaredTokens: {}, fallbackTokens: {}, control: null };
      report.sides[mode] = side;
      side.color = await setColorMode(page, mode);
      side.colorProblems = colorSideProblems(mode, side.color);
      for (const problem of side.colorProblems) fail(`${problem}`);
      // Theme-side invalid declarations are grouped per (theme, token): the
      // committed subset and the real theme carry the same broken declaration,
      // which is one defect with several sources, not several defects.
      const themeInvalidIndex = new Map();
      const noteThemeInvalid = (theme, source, entries) => {
        for (const entry of entries) {
          const key = `${theme}\u0000${entry.token}`;
          let target = themeInvalidIndex.get(key);
          if (!target) {
            target = { theme, token: entry.token, computed: entry.computed, declared: entry.declared, ownerSheet: entry.ownerSheet, sources: [] };
            themeInvalidIndex.set(key, target);
          }
          target.sources.push({ source, selector: entry.selector });
        }
      };
      await setThemeLink(page, base, null);
      const fallback = await surveyFallback(page, { kinds: KINDS, tokens: fallbackTokenNames, sleep, setMode });
      side.fallbackTokens = fallback.reader.tokens;
      // The app's own light/dark declarations must be in force on this side; the
      // pinned literals come from app.css (`validateColorSideDeclarations`).
      side.declaredTokens = Object.fromEntries(DECLARED_SIDE_TOKENS.map((entry) => [entry.token, { expected: entry[mode], actual: fallback.reader.tokens[entry.token] ?? null }]));
      declaredBySide[mode] = fallback.reader.tokens;
      for (const mismatch of declaredSideTokenMismatches(mode, fallback.reader.tokens)) {
        fail(`declared ${mismatch.token}: expected ${JSON.stringify(mismatch.expected)} on the ${mismatch.side} side, computed ${JSON.stringify(mismatch.actual)}`);
      }
      for (const entry of fixtures) {
        const record = await runTheme(page, base, vault, { ...entry, themeName: `RenderParityCommunity${entry.name}`, droppedSample: entry.manifest.droppedSample }, fallback, fallback.reader.tokens, setMode, includeDark);
        Object.assign(side.subsets.find((item) => item.file === entry.file), {
          mismatches: record.mismatches, clobbered: record.clobbered.length, clobberedDetails: record.clobbered,
          shadowed: record.shadowed.length, shadowedDetails: record.shadowed, claims: record.claims, tokens: record.tokens,
          themeInvalid: record.themeInvalid.length, themeInvalidDetails: record.themeInvalid,
          control: record.control, droppedMatches: record.droppedMatches, hostDependentSample: record.hostDependentSample, fallbackTokens: record.fallbackTokens,
        });
        for (const item of record.clobbered) side.clobbered.push({ theme: entry.name, ...item });
        noteThemeInvalid(entry.name, `test/fixtures/${entry.file}`, record.themeInvalid);
        for (const match of record.droppedMatches) fail(`${entry.name}: dropped rule still matches ${match.kind} (${match.hits?.[0]}): ${match.selector.slice(0, 160)} (${match.props.join(",")})`);
      }
      for (const theme of realThemes) {
        const record = await runTheme(page, base, vault, theme, fallback, fallback.reader.tokens, setMode, includeDark);
        record.side = mode;
        side.realThemes.push(record);
        for (const item of record.clobbered) side.clobbered.push({ theme: theme.name, ...item });
        noteThemeInvalid(theme.name, theme.source, record.themeInvalid);
      }
      side.themeInvalid = [...themeInvalidIndex.values()];
      if (strictTokens) {
        for (const entry of side.clobbered) {
          fail(`${entry.theme} token ${entry.token}: theme declares ${JSON.stringify(entry.declared)} (${entry.selector}) but the app's own layer wins with ${JSON.stringify(entry.computed)}`);
        }
        for (const entry of [...side.subsets, ...side.realThemes]) {
          for (const item of entry.shadowedDetails || entry.shadowed || []) {
            fail(`${entry.theme ?? entry.name} ${item.surface} ${item.kind}.${item.prop}: theme declares ${JSON.stringify(item.declared)} (${item.selector}) but the app rule ${item.shadowedBy} wins with ${JSON.stringify(item.computed)}`);
          }
        }
      }
      side.problems = problems.filter((problem) => problem.startsWith(failPrefix));
    }
    failPrefix = "";
    // A side that silently sampled the other side would pass every assertion
    // above: the pinned tokens must actually separate the two sides.
    for (const problem of sideSeparationProblems(declaredBySide)) fail(`${problem} -- the dark sample is not sampling a different cascade`);
    if (pageErrors.length) fail(`${pageErrors.length} uncaught page error(s): ${pageErrors[0].split("\n")[0]}`);
    report.pageErrors = pageErrors;
    report.status = problems.length === 0 ? "passed" : "failed";
  } catch (error) {
    const message = error.stack || error.message;
    fail(message);
    const unavailable = /Executable doesn't exist|Failed to launch|Host system is missing dependencies|browserType\.launch/i.test(message);
    report.status = unavailable ? "blocked" : "failed";
    if (unavailable) report.reason = "Chromium could not be launched; install the shared runtime browsers.";
  } finally {
    await browser?.close().catch(() => {});
    if (child) {
      child.kill();
      await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
    }
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith("render-parity-community-")) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }
  await write();
  const realThemesConfigured = realThemes.filter((entry) => !entry.selfBuilt).map((entry) => entry.name).join(", ") || null;
  process.exitCode = printCommunityThemeSummary({ report, sides, realThemesConfigured, strictTokens, outputRoot, problems });
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
