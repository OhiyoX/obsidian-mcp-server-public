#!/usr/bin/env node
// Phase 1-F font-token gate for the unified Markdown rendering TODO (issue #361).
//
// The question this gate answers with a computed style, not a CSS reading:
//
//   * does `.preview` (Reader article) and `.cm-editor` (Live Preview root)
//     compute their font FAMILY from the theme's `--font-text` chain,
//   * in the DEFAULT theme (no community theme installed), and
//   * with a COMMUNITY theme that declares a font token different from the
//     interface font?
//
// The failure mode it exists for is the ":root alias inheritance trap": the
// app declares `body { font: ... var(--font-interface) }` and
// `:root { --font-text: var(--font-text-override, var(--font-text-theme)) }`.
// A host that stopped consuming `var(--font-text)` would silently fall back to
// the already-resolved body font and no colour-only gate would notice, because
// app.css's own `--font-text-theme` aliases `--font-interface-theme`.
//
// Expectations come from the THEME DEFINITION, never from the implementation's
// own output:
//   * the community pass pins the two font lists `test/fixtures/
//     render-parity-font-fixture.css` declares, and `validateFontFixture` fails
//     if either literal is no longer present in that file;
//   * the default pass pins the font list app.css declares for
//     `--font-interface-theme` (the tail of the `--font-text` chain when no
//     theme and no user override exist), and `validateAppFallback` fails if that
//     literal or the alias declaration disappears from app.css;
//   * the only thing taken from the browser at assert time is the SERIALIZATION
//     of that declared list (`FONT_NORMALIZE` on a throwaway element), so
//     quoting/whitespace differences cannot be mistaken for inheritance.
//
// The negative control mutates the installed fixture so the declared lists
// change to distinguishable values, then requires both hosts to FOLLOW. A host
// that keeps painting the old family fails. `--font-text-theme` is additionally
// required to differ from `--font-interface-theme` in the fixture and in the
// measured values, otherwise the assertion could not tell the two apart.
//
// Environment: PLAYWRIGHT_MODULE, CHROMIUM_EXECUTABLE, RENDER_PARITY_OUTPUT,
// RENDER_PARITY_SKIP_CONTROL (never in CI).
// Exit codes: 0 = every host consumed the theme font chain; 1 = assertion
// failure; 2 = blocked (no Chromium runtime).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { FONT_NORMALIZE, FONT_SURVEY } from "./render-parity-font-probe.mjs";
import { waitForSurfaceReady } from "./render-parity-readiness.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const FIXTURE_RELATIVE = "test/fixtures/render-parity-font-fixture.css";
const BODY_FIXTURE_RELATIVE = "test/fixtures/render-parity-font-fixture-body.css";
const APP_CSS_RELATIVE = "src/app/assets/app.css";
const THEME_NAME = "RenderParityFont";
const MUTATED_THEME_NAME = "RenderParityFontMut";
// The same three tokens declared ONLY on `body` (the shape the Obsidian theme
// docs and the real Things theme use). A `:root`-only alias cannot see them.
const BODY_THEME_NAME = "RenderParityFontBody";
const MUTATED_BODY_THEME_NAME = "RenderParityFontBodyMut";
const THEME_TOKEN = "--font-text";

// Font lists, written out exactly as the declaring file spells them. `validate*`
// below re-reads the declaring file and fails when a literal drifts, so these
// are pinned expectations of the theme definition, not a copy of an output.
const APP_FALLBACK_TEXT_LIST = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, Ubuntu, "Noto Sans SC", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
const APP_FALLBACK_ALIAS = "--font-text: var(--font-text-override, var(--font-text-theme));";
const FIXTURE_TEXT_LIST = '"RenderParity Text Alpha", "RenderParity Text Beta", serif';
const FIXTURE_UI_LIST = '"RenderParity UI Alpha", "RenderParity UI Beta", sans-serif';
const FIXTURE_MONO_LIST = '"RenderParity Mono Alpha", monospace';
// Distinguishable replacements for the negative control: same shape, different
// family names, so "the value moved" cannot be confused with "a font loaded".
const MUTATED_TEXT_LIST = '"RenderParity Text Mutated", serif';
const MUTATED_UI_LIST = '"RenderParity UI Mutated", sans-serif';
const MUTATED_MONO_LIST = '"RenderParity Mono Mutated", monospace';

// The two required hosts, plus the two CodeMirror surfaces that actually paint
// text. `.cm-content` and `.cm-scroller` are allowed to inherit (only the
// `.cm-editor` root and `.preview` must own the declaration), but the family
// still has to reach them.
const HOSTS = [
  { id: "preview", selector: ".preview", token: THEME_TOKEN, requiresOwnDeclaration: true },
  { id: "cm-editor", selector: ".cm-editor", token: THEME_TOKEN, requiresOwnDeclaration: true },
  { id: "cm-scroller", selector: ".cm-scroller", token: THEME_TOKEN, requiresOwnDeclaration: false },
  { id: "cm-content", selector: ".cm-content", token: THEME_TOKEN, requiresOwnDeclaration: false },
];
const TOKENS = ["--font-text", "--font-text-theme", "--font-text-override", "--font-interface", "--font-interface-theme", "--font-monospace"];

const outputRoot = path.resolve(process.env.RENDER_PARITY_OUTPUT || path.join(os.tmpdir(), `render-parity-font-${process.pid}`));
const problems = [];
const fail = (message) => problems.push(message);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const collapse = (value) => String(value ?? "").replace(/\s+/g, " ").replace(/"/g, "'").replace(/\s*,\s*/g, ",").trim().toLowerCase();

/** Every literal the fixture must declare, or the pinned expectations are stale. */
export function validateFontFixture(css) {
  const text = String(css ?? "").replace(/\s+/g, " ");
  const wanted = [FIXTURE_UI_LIST, FIXTURE_TEXT_LIST, FIXTURE_MONO_LIST];
  const problems = wanted.filter((value) => !text.includes(value)).map((value) => `font fixture does not declare ${value}`);
  if (!/--font-text-theme:\s*"RenderParity Text Alpha"/.test(text)) problems.push("font fixture no longer binds --font-text-theme to the text sentinel list");
  return problems;
}

/** app.css must still declare the default chain the default pass pins. */
export function validateAppFallback(css) {
  const text = String(css ?? "").replace(/\s+/g, " ");
  const problems = [];
  if (!text.includes(APP_FALLBACK_TEXT_LIST)) problems.push(`app.css no longer declares the fallback interface font list ${APP_FALLBACK_TEXT_LIST}`);
  if (!text.includes(APP_FALLBACK_ALIAS)) problems.push(`app.css no longer declares ${APP_FALLBACK_ALIAS}`);
  for (const decl of ["--font-interface: var(--font-interface-override, var(--font-interface-theme));", "--font-monospace: var(--font-monospace-override, var(--font-monospace-theme));"]) {
    if (!text.includes(decl)) problems.push(`app.css no longer declares ${decl}`);
  }
  if (!text.includes("font: var(--font-text-size, 16px)/var(--line-height-normal, 1.5) var(--font-text);")) {
    problems.push("app.css no longer declares the .preview font shorthand over var(--font-text)");
  }
  return problems;
}

/**
 * Negative-control transform: replace the fixture's three font lists with
 * distinguishable ones. Returns the mutated CSS plus the expectations the paint
 * must follow.
 */
export function mutateFontFixture(css) {
  let mutations = 0;
  const swap = (value) => () => {
    mutations += 1;
    return value;
  };
  const mutated = String(css)
    .replace(FIXTURE_TEXT_LIST, swap(MUTATED_TEXT_LIST))
    .replace(FIXTURE_UI_LIST, swap(MUTATED_UI_LIST))
    .replace(FIXTURE_MONO_LIST, swap(MUTATED_MONO_LIST));
  return { css: mutated, mutations, expected: { text: MUTATED_TEXT_LIST, ui: MUTATED_UI_LIST, mono: MUTATED_MONO_LIST } };
}

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
    cwd: appRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return child;
    } catch {
      // still starting
    }
    if (child.exitCode !== null) throw new Error("render-parity server exited during startup");
    await sleep(100);
  }
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
    if (!href) {
      link.disabled = true;
      link.removeAttribute("href");
      return;
    }
    await new Promise((resolve, reject) => {
      link.onload = () => resolve();
      link.onerror = () => reject(new Error(`theme failed to load: ${href}`));
      link.disabled = false;
      link.href = href;
    });
  }, { href: name ? `${base}/api/web/v1/theme.css?name=${encodeURIComponent(name)}` : null });
  await sleep(120);
}

async function survey(page) {
  const snapshot = await page.evaluate(FONT_SURVEY, { hosts: HOSTS, tokens: TOKENS });
  const normalize = (value) => page.evaluate(FONT_NORMALIZE, value);
  return { snapshot, normalize };
}

/**
 * Assert one pass: every host computed family equals the browser's serialization
 * of `declaredList`, and — where required — the host owns a `font-family`
 * declaration that consumes the theme token from an app-owned sheet.
 */
async function assertPass({ page, label, declaredList, record }) {
  const { snapshot, normalize } = await survey(page);
  const expected = await normalize(declaredList);
  record.expected = declaredList;
  record.expectedComputed = expected;
  record.hosts = snapshot;
  for (const host of HOSTS) {
    const entry = snapshot[host.id];
    if (!entry?.found) {
      fail(`${label} ${host.selector}: no element to measure`);
      continue;
    }
    if (collapse(entry.fontFamily) !== collapse(expected)) {
      fail(`${label} ${host.selector}: expected the declared ${THEME_TOKEN} chain ${JSON.stringify(expected)}, computed ${JSON.stringify(entry.fontFamily)} (own declaration: ${entry.own ? `${entry.own.property}: ${entry.own.value} @ ${entry.own.selector}` : `none, inherited from <${entry.inherited?.tag}> via ${entry.inherited?.selector}`})`);
      continue;
    }
    if (!host.requiresOwnDeclaration) continue;
    if (!entry.own) {
      fail(`${label} ${host.selector}: computed the theme font but declares no font-family of its own (inherited ${JSON.stringify(entry.inherited?.value)} from <${entry.inherited?.tag}> ${entry.inherited?.selector}); the host must consume ${THEME_TOKEN} itself`);
      continue;
    }
    if (!/var\(\s*--font-text\s*[,)]/.test(entry.own.value)) {
      fail(`${label} ${host.selector}: own ${entry.own.property} declaration does not consume ${THEME_TOKEN}: ${JSON.stringify(entry.own.value)} @ ${entry.own.selector} (${entry.own.sheet})`);
    }
    if (entry.own.sheet === "community-theme") {
      fail(`${label} ${host.selector}: the community theme, not the app host rule, declares the document font (${JSON.stringify(entry.own.value)} @ ${entry.own.selector})`);
    }
  }
  return { snapshot, expected };
}

async function main() {
  const report = { status: "running", generatedAt: new Date().toISOString(), fixture: FIXTURE_RELATIVE, hosts: HOSTS.map((host) => host.selector), passes: {}, problems: [] };
  await fs.mkdir(outputRoot, { recursive: true });

  const fixtureCss = (await fs.readFile(path.join(appRoot, FIXTURE_RELATIVE), "utf8")).replace(/\r\n/g, "\n");
  const appCss = (await fs.readFile(path.join(appRoot, APP_CSS_RELATIVE), "utf8")).replace(/\r\n/g, "\n");
  for (const problem of validateFontFixture(fixtureCss)) fail(`fixture: ${problem}`);
  for (const problem of validateAppFallback(appCss)) fail(`app.css: ${problem}`);
  // The body-only fixture declares the SAME sentinels, so validateFontFixture
  // (the pinned lists + the text-token binding) applies to it unchanged.
  const bodyFixtureCss = (await fs.readFile(path.join(appRoot, BODY_FIXTURE_RELATIVE), "utf8")).replace(/\r\n/g, "\n");
  for (const problem of validateFontFixture(bodyFixtureCss)) fail(`body fixture: ${problem}`);
  const mutated = mutateFontFixture(fixtureCss);
  const mutatedBody = mutateFontFixture(bodyFixtureCss);
  report.bodyControlTransform = { mutations: mutatedBody.mutations };
  if (!mutated.mutations) fail("negative control: the mutation transform changed nothing");
  if (!mutatedBody.mutations) fail("body negative control: the mutation transform changed nothing");
  for (const [name, before, after] of [["text", FIXTURE_TEXT_LIST, MUTATED_TEXT_LIST], ["ui", FIXTURE_UI_LIST, MUTATED_UI_LIST]]) {
    if (collapse(before) === collapse(after)) fail(`negative control: the ${name} list mutation is a no-op`);
  }
  report.controlTransform = { mutations: mutated.mutations, expected: mutated.expected };

  const playwright = await importPlaywright();
  if (playwright.error || !playwright.chromium) {
    report.status = "blocked";
    report.reason = playwright.error ? playwright.error.message : "PLAYWRIGHT_MODULE did not expose chromium";
    report.problems = problems;
    await fs.writeFile(path.join(outputRoot, "render-parity-font-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`BLOCKED render-parity Phase 1-F: ${report.reason}`);
    process.exitCode = 2;
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "render-parity-font-"));
  const vault = path.join(root, "vault");
  await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
  await fs.writeFile(path.join(vault, ".obsidian", "appearance.json"), JSON.stringify({ cssTheme: "", theme: "moonstone", baseFontSize: 16 }));
  await fs.writeFile(path.join(vault, "FontParity.md"), "# FontParity\n\nFont token host.\n\n```js\nconst font = 1;\n```\n");
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
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 1200 } })).newPage();
    page.setDefaultTimeout(15000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
    await page.addInitScript(() => {
      Object.defineProperty(window, "createObsidianEditor", {
        configurable: true,
        set(factory) {
          Object.defineProperty(window, "createObsidianEditor", {
            configurable: true, writable: true,
            value(...args) {
              const editor = factory(...args);
              window.__testEditor = editor;
              return editor;
            },
          });
        },
      });
    });
    const login = await page.request.post(`${base}/auth/login`, { form: { username: "render-parity", password } });
    if (login.status() !== 200) throw new Error(`login failed with ${login.status()}`);
    await page.goto(`${base}/app`);
    await page.waitForSelector('.note[title="FontParity.md"]');
    await page.locator('.note[title="FontParity.md"]').click();
    await page.waitForFunction(() => document.querySelector("#current-path")?.textContent === "FontParity.md");

    const setMode = async (mode) => {
      if (!(await page.locator(`.document.mode-${mode}`).count())) {
        await page.locator(".view-mode-toggle:visible").click();
        await page.locator(`.view-mode-menu:not([hidden]) .view-mode-item[data-mode="${mode}"]`).click();
      }
      await page.waitForFunction((name) => document.querySelector(`.document.mode-${name}`) != null, mode);
      // #414 (C): reader.js / editor.js load on demand, so `mode-<mode>` is not
      // surface readiness. Bounded wait; a timeout logs READINESS and the paint
      // assertion still fires.
      await waitForSurfaceReady(page, { surface: mode === "preview" ? "reader" : "live" });
      await sleep(80);
    };

    // Pass A: the default theme, no community theme installed at all. The Reader
    // host lives in preview mode, the Live hosts in live mode, so both modes are
    // measured for every pass.
    await setThemeLink(page, base, null);
    await setMode("preview");
    report.passes.readerDefault = await assertPass({ page, label: "default/reader", declaredList: APP_FALLBACK_TEXT_LIST, record: {} });
    await setMode("live");
    report.passes.liveDefault = await assertPass({ page, label: "default/live", declaredList: APP_FALLBACK_TEXT_LIST, record: {} });

    // Pass B: a community theme whose text/interface/mono lists all differ.
    await writeTheme(vault, THEME_NAME, fixtureCss);
    await setThemeLink(page, base, THEME_NAME);
    await setMode("preview");
    report.passes.readerTheme = await assertPass({ page, label: "community/reader", declaredList: FIXTURE_TEXT_LIST, record: {} });
    await setMode("live");
    report.passes.liveTheme = await assertPass({ page, label: "community/live", declaredList: FIXTURE_TEXT_LIST, record: {} });
    // Instrument self-check: the assertion can only fail for the right reason if
    // the text list and the interface list are measurably different.
    const liveTheme = report.passes.liveTheme.snapshot;
    const interfaceList = liveTheme["cm-editor"]?.values?.["--font-interface-theme"];
    const textList = liveTheme["cm-editor"]?.values?.["--font-text-theme"];
    report.instrument = { textList, interfaceList };
    if (!textList || !interfaceList) fail("community/live: the theme font tokens are not readable on .cm-editor");
    else if (collapse(textList) === collapse(interfaceList)) fail(`community/live: the fixture's text and interface lists are not distinguishable (${textList})`);

    // Pass C: negative control. The mutated fixture declares different families;
    // both hosts must follow, which is what rules out "happens to be equal".
    if (!process.env.RENDER_PARITY_SKIP_CONTROL) {
      await writeTheme(vault, MUTATED_THEME_NAME, mutated.css);
      await setThemeLink(page, base, MUTATED_THEME_NAME);
      await setMode("preview");
      const readerControl = await assertPass({ page, label: "control/reader", declaredList: mutated.expected.text, record: {} });
      await setMode("live");
      const liveControl = await assertPass({ page, label: "control/live", declaredList: mutated.expected.text, record: {} });
      const unchanged = [];
      for (const [name, before, after] of [["reader", report.passes.readerTheme, readerControl], ["live", report.passes.liveTheme, liveControl]]) {
        for (const host of HOSTS) {
          const was = before.snapshot[host.id]?.fontFamily;
          const now = after.snapshot[host.id]?.fontFamily;
          if (was != null && collapse(was) === collapse(now)) unchanged.push(`${name} ${host.selector} stayed ${JSON.stringify(now)}`);
        }
      }
      report.control = { ...mutated.expected, unchanged, reader: readerControl, live: liveControl };      for (const entry of unchanged) fail(`negative control did not follow the mutated theme: ${entry}`);
    }

    // Pass D: the theme declares the font tokens ONLY on `body` (the documented
    // Obsidian theme shape, and what the real Things theme ships). A `:root`-only
    // alias computes its substitution on <html>, where a body-scoped theme token
    // is invisible, so the document hosts keep the app font while still
    // "consuming" `var(--font-text)` — the trap the root-shaped Pass B cannot see.
    await writeTheme(vault, BODY_THEME_NAME, bodyFixtureCss);
    await setThemeLink(page, base, BODY_THEME_NAME);
    await setMode("preview");
    report.passes.readerBodyTheme = await assertPass({ page, label: "body-theme/reader", declaredList: FIXTURE_TEXT_LIST, record: {} });
    await setMode("live");
    report.passes.liveBodyTheme = await assertPass({ page, label: "body-theme/live", declaredList: FIXTURE_TEXT_LIST, record: {} });

    // Pass E: the body-only theme's own negative control. The mutated body
    // fixture must reach both hosts too, otherwise "the body pass is green"
    // could come from a host that ignores the body scope entirely.
    if (!process.env.RENDER_PARITY_SKIP_CONTROL) {
      await writeTheme(vault, MUTATED_BODY_THEME_NAME, mutatedBody.css);
      await setThemeLink(page, base, MUTATED_BODY_THEME_NAME);
      await setMode("preview");
      const readerBodyControl = await assertPass({ page, label: "body-control/reader", declaredList: mutatedBody.expected.text, record: {} });
      await setMode("live");
      const liveBodyControl = await assertPass({ page, label: "body-control/live", declaredList: mutatedBody.expected.text, record: {} });
      const bodyUnchanged = [];
      for (const [name, before, after] of [["body reader", report.passes.readerBodyTheme, readerBodyControl], ["body live", report.passes.liveBodyTheme, liveBodyControl]]) {
        for (const host of HOSTS) {
          const was = before.snapshot[host.id]?.fontFamily;
          const now = after.snapshot[host.id]?.fontFamily;
          if (was != null && collapse(was) === collapse(now)) bodyUnchanged.push(`${name} ${host.selector} stayed ${JSON.stringify(now)}`);
        }
      }
      report.bodyControl = { ...mutatedBody.expected, unchanged: bodyUnchanged, reader: readerBodyControl, live: liveBodyControl };
      for (const entry of bodyUnchanged) fail(`body negative control did not follow the mutated theme: ${entry}`);
    }

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
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith("render-parity-font-")) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }

  report.problems = problems;
  const reportPath = path.join(outputRoot, "render-parity-font-report.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log("");
  console.log("Render parity Phase 1-F (font token -> document hosts) summary");
  console.log(`  status : ${report.status}`);
  console.log(`  hosts  : ${HOSTS.map((host) => `${host.selector}${host.requiresOwnDeclaration ? "" : " (inherit ok)"}`).join(", ")}`);
  for (const [name, pass] of Object.entries(report.passes)) {
    console.log(`  ${name.padEnd(14)}: ${JSON.stringify(pass.expected)}`);
  }
  for (const [name, pass] of Object.entries(report.passes)) {
    for (const host of HOSTS) {
      const entry = pass.snapshot[host.id];
      const own = entry?.own ? `${entry.own.property}: ${entry.own.value} @ ${entry.own.selector} (${entry.own.sheet})` : "no own declaration";
      console.log(`    ${name} ${host.selector}: ${JSON.stringify(entry?.fontFamily)} <- ${own}`);
    }
  }
  if (report.control) console.log(`  control: text ${JSON.stringify(report.control.text)} ui ${JSON.stringify(report.control.ui)} unchanged ${JSON.stringify(report.control.unchanged)}`);
  if (report.instrument) console.log(`  instrument: --font-text-theme ${JSON.stringify(report.instrument.textList)} vs --font-interface-theme ${JSON.stringify(report.instrument.interfaceList)}`);
  console.log(`  report : ${reportPath}`);
  if (problems.length) {
    console.log("  problems :");
    for (const problem of problems) console.log(`    - ${problem}`);
  }
  process.exitCode = report.status === "passed" ? 0 : report.status === "blocked" ? 2 : 1;
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
