#!/usr/bin/env node
// Phase 1 theme inheritance hard gate for the unified Markdown rendering TODO.
//
// It boots the real Web app in an isolated temporary Vault, installs the
// canonical theme fixture as a real community theme, loads it through the
// production `/api/web/v1/theme.css` endpoint, and asserts that each
// Markdown RenderKind in Reader AND Live Preview computes the exact paint the
// theme file declared. It then runs a negative control: the fixture is mutated,
// reloaded, and the probe must follow the new declarations.
//
// Environment:
//   PLAYWRIGHT_MODULE          absolute path to an external Playwright entry module
//   CHROMIUM_EXECUTABLE        absolute path to a Chromium binary
//   RENDER_PARITY_OUTPUT       artifact directory (default: OS temp dir)
//   RENDER_PARITY_THEME_ALLOWLIST  alternative allowlist path (tests)
//   RENDER_PARITY_SKIP_CONTROL unset; set to skip the negative control (never in CI)
//
// Exit codes: 0 = ran and every kind inherited the theme; 1 = inheritance or
// fixture failure; 2 = browser runtime unavailable (honest blocked state).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  THEME_ALLOWLIST_RELATIVE,
  THEME_FIXTURE_RELATIVE,
  THEME_NAME,
  MUTATED_THEME_NAME,
  KINDS,
  EXPECTED,
  PROBE_SOURCE,
  classifyMismatches,
  collectThemePaint,
  describeMismatch,
  evaluatePaint,
  mutateCss,
  mutatedExpected,
  validateFixture,
} from "./render-parity-theme-core.mjs";
import { waitForSurfaceReady } from "./render-parity-readiness.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(appRoot, THEME_FIXTURE_RELATIVE);
const screenshotFixturePath = path.join(appRoot, "test/fixtures/render-parity-theme-screenshot.css");
const SCREENSHOT_THEME_NAME = "RenderParityScreenshot";
const allowlistPath = process.env.RENDER_PARITY_THEME_ALLOWLIST
  ? path.resolve(process.env.RENDER_PARITY_THEME_ALLOWLIST)
  : path.join(appRoot, THEME_ALLOWLIST_RELATIVE);
const outputRoot = path.resolve(
  process.env.RENDER_PARITY_OUTPUT || path.join(os.tmpdir(), `render-parity-phase1-${process.pid}`),
);

const problems = [];
const fail = (message) => problems.push(message);

async function importPlaywright() {
  const href = process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright";
  try {
    return await import(href);
  } catch (error) {
    return { error };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer(vault, dataPath, base, password) {
  const port = Number(new URL(base).port);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: appRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      VAULT_PATH: vault,
      WEB_VAULTS_ROOT: "",
      WEB_DEFAULT_VAULT: "",
      DATA_PATH: dataPath,
      OAUTH_ENABLED: "true",
      PUBLIC_BASE_URL: base,
      OAUTH_INITIAL_USERNAME: "render-parity",
      OAUTH_INITIAL_PASSWORD: password,
      OAUTH_ADMIN_PASSWORD: password,
      API_KEY: "",
      GIT_ENABLED: "false",
      GIT_AUTO_COMMIT: "false",
      GIT_AUTO_PUSH: "false",
      EMBEDDING_PROVIDER: "disabled",
      RETRIEVAL_AUTO_EMBED: "false",
    },
  });
  const serverErrors = [];
  child.stderr.on("data", (chunk) => serverErrors.push(chunk.toString()));
  child.stdout.resume();
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return { child, serverErrors };
    } catch {
      // still starting
    }
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

async function probe(page, surface) {
  return page.evaluate(collectThemePaint, { kinds: KINDS, surface });
}

// CodeMirror only renders the lines around the viewport, so one scroll position can miss a
// fixture line: with the document tab strip the editor is 40px shorter and the `hr` line
// fell outside the rendered range (#321). Probe the live surface at both ends and keep every
// kind either pass rendered — the assertions themselves are unchanged, they just stop
// depending on where the fixture happens to land.
async function probeLive(page) {
  const merged = {};
  for (const atEnd of [true, false]) {
    await page.evaluate((end) => {
      const view = window.__testEditor?._view;
      if (view) view.dispatch({ selection: { anchor: end ? view.state.doc.length : 0 } });
      const scroller = document.querySelector(".cm-scroller");
      if (scroller) scroller.scrollTop = end ? scroller.scrollHeight : 0;
    }, atEnd);
    await sleep(150);
    const pass = await probe(page, "live");
    for (const [id, entry] of Object.entries(pass)) if (!merged[id]?.found) merged[id] = entry;
  }
  return merged;
}

async function setThemeLink(page, base, name) {
  await page.evaluate(async ({ href }) => {
    const link = document.querySelector("#community-theme");
    if (!link) throw new Error("community theme link is missing");
    await new Promise((resolve, reject) => {
      link.onload = () => resolve();
      link.onerror = () => reject(new Error(`theme failed to load: ${href}`));
      link.disabled = false;
      link.href = href;
    });
  }, { href: `${base}/api/web/v1/theme.css?name=${encodeURIComponent(name)}` });
  await sleep(80);
}

async function main() {
  const fixtureCss = (await fs.readFile(fixturePath, "utf8")).replace(/\r\n/g, "\n");
  const allowlist = JSON.parse(await fs.readFile(allowlistPath, "utf8"));
  const fixtureProblems = validateFixture(fixtureCss);
  for (const problem of fixtureProblems) fail(`fixture: ${problem}`);
  if (fixtureProblems.length) {
    console.log(`FAIL render-parity Phase 1 fixture: ${fixtureProblems[0]}`);
    process.exitCode = 1;
    return;
  }

  const playwright = await importPlaywright();
  await fs.mkdir(outputRoot, { recursive: true });
  const report = {
    status: "running",
    generatedAt: new Date().toISOString(),
    fixture: THEME_FIXTURE_RELATIVE,
    allowlist: path.relative(appRoot, allowlistPath),
    kinds: KINDS.map((kind) => kind.id),
    theme: THEME_NAME,
    mismatches: [],
    negativeControl: null,
    problems: [],
  };
  if (playwright.error || !playwright.chromium) {
    report.status = "blocked";
    report.reason = playwright.error ? playwright.error.message : "PLAYWRIGHT_MODULE did not expose chromium";
    await fs.writeFile(path.join(outputRoot, "render-parity-phase1-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`BLOCKED render-parity Phase 1: ${report.reason}`);
    process.exitCode = 2;
    return;
  }
  const { chromium } = playwright;

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "render-parity-theme-"));
  const vault = path.join(root, "vault");
  await fs.mkdir(vault);
  await writeTheme(vault, THEME_NAME, fixtureCss);
  await fs.writeFile(
    path.join(vault, ".obsidian", "appearance.json"),
    JSON.stringify({ cssTheme: THEME_NAME, theme: "moonstone", baseFontSize: 16 }),
  );
  await fs.writeFile(path.join(vault, "ThemeParity.md"), PROBE_SOURCE);
  // The `![[embed-parity.svg]]` embed must resolve to a real asset, otherwise the
  // Reader renders a broken image and the paint probe measures nothing useful.
  await fs.writeFile(
    path.join(vault, "embed-parity.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>',
  );

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
    const started = await startServer(vault, path.join(root, "data"), base, password);
    child = started.child;
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    });
    // The probe source now covers 24 RenderKinds including the callout block
    // widget, so the whole document must fit the rendered viewport: CodeMirror
    // only builds DOM for the visible range, and a kind below the fold would
    // read as "missing" instead of showing its paint.
    const context = await browser.newContext({ viewport: { width: 1440, height: 1800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
    await page.addInitScript(() => {
      Object.defineProperty(window, "createObsidianEditor", {
        configurable: true,
        set(factory) {
          Object.defineProperty(window, "createObsidianEditor", {
            configurable: true,
            writable: true,
            value(...args) {
              const editor = factory(...args);
              window.__testEditor = editor;
              return editor;
            },
          });
        },
      });
    });

    const login = await page.request.post(`${base}/auth/login`, {
      form: { username: "render-parity", password },
    });
    if (login.status() !== 200) throw new Error(`login failed with ${login.status()}`);
    await page.goto(`${base}/app`);
    await page.waitForSelector('.note[title="ThemeParity.md"]');
    await page.locator('.note[title="ThemeParity.md"]').click();
    await page.waitForFunction(() => document.querySelector("#current-path")?.textContent === "ThemeParity.md");

    const setMode = async (name) => {
      if (!(await page.locator(`.document.mode-${name}`).count())) {
        await page.locator(".view-mode-toggle:visible").click();
        await page.locator(`.view-mode-menu:not([hidden]) .view-mode-item[data-mode="${name}"]`).click();
      }
      await page.waitForFunction((mode) => document.querySelector(`.document.mode-${mode}`) != null, name);
      // #414 (C): reader.js / editor.js load on demand, so `mode-<name>` is not surface
      // readiness. Bounded wait; a timeout logs READINESS and the paint assertion still fires.
      await waitForSurfaceReady(page, { surface: name === "preview" ? "reader" : "live", kinds: KINDS });
      await sleep(60);
    };

    await setThemeLink(page, base, THEME_NAME);
    await setMode("preview");
    await sleep(80);
    const reader = await probe(page, "reader");
    await setMode("live");
    await sleep(120);
    const live = await probeLive(page);

    const readerMismatches = evaluatePaint(reader, EXPECTED, "reader");
    const liveMismatches = evaluatePaint(live, EXPECTED, "live");
    const classified = classifyMismatches([...readerMismatches, ...liveMismatches], allowlist);
    report.mismatches = classified.failures;
    report.environmentMismatches = classified.environment;
    report.snapshots = { reader, live };
    for (const mismatch of classified.failures) fail(`theme inheritance ${describeMismatch(mismatch)}`);

    if (!process.env.RENDER_PARITY_SKIP_CONTROL) {
      const mutatedCss = mutateCss(fixtureCss);
      const mutatedExpectations = mutatedExpected(EXPECTED);
      await writeTheme(vault, MUTATED_THEME_NAME, mutatedCss);
      await setMode("preview");
      await setThemeLink(page, base, MUTATED_THEME_NAME);
      const readerAfter = await probe(page, "reader");
      await setMode("live");
      const liveAfter = await probeLive(page);
      const controlMismatches = [
        ...evaluatePaint(readerAfter, mutatedExpectations, "reader", "reader-mutated"),
        ...evaluatePaint(liveAfter, mutatedExpectations, "live", "live-mutated"),
      ];
      const unchanged = [];
      for (const kind of KINDS) {
        for (const prop of kind.props.reader) {
          const before = reader[kind.id]?.values?.[prop];
          const after = readerAfter[kind.id]?.values?.[prop];
          if (before != null && before === after) unchanged.push(`reader ${kind.id} ${prop} stayed ${JSON.stringify(before)}`);
        }
        for (const prop of kind.props.live) {
          const liveBefore = live[kind.id]?.values?.[prop];
          const liveAfterValue = liveAfter[kind.id]?.values?.[prop];
          if (liveBefore != null && liveBefore === liveAfterValue) unchanged.push(`live ${kind.id} ${prop} stayed ${JSON.stringify(liveBefore)}`);
        }
      }
      report.negativeControl = { mismatches: controlMismatches, unchanged };
      for (const mismatch of controlMismatches) fail(`negative control ${describeMismatch(mismatch)}`);
      for (const entry of unchanged) fail(`negative control did not follow the mutated theme: ${entry}`);
    }

    if (pageErrors.length) fail(`${pageErrors.length} uncaught page error(s): ${pageErrors[0].split("\n")[0]}`);
    report.pageErrors = pageErrors;

    if (process.env.RENDER_PARITY_SCREENSHOTS) {
      const screenshotCss = (await fs.readFile(screenshotFixturePath, "utf8")).replace(/\r\n/g, "\n");
      await writeTheme(vault, SCREENSHOT_THEME_NAME, screenshotCss);
      const setColorMode = async (colorMode) => {
        await page.evaluate((mode) => {
          try { localStorage.setItem("obsidian-web.color-mode", mode); } catch { /* private mode */ }
          const select = document.querySelector("#color-mode");
          if (select) { select.value = mode; select.dispatchEvent(new Event("change")); }
          const dark = mode === "dark";
          for (const node of [document.documentElement, document.body]) {
            node.classList.toggle("theme-dark", dark);
            node.classList.toggle("theme-light", !dark);
          }
          document.documentElement.style.colorScheme = dark ? "dark" : "light";
        }, colorMode);
        await page.waitForFunction((mode) => document.documentElement.classList.contains(`theme-${mode}`), colorMode);
        await sleep(80);
      };
      await setThemeLink(page, base, SCREENSHOT_THEME_NAME);
      const screenshots = {};
      for (const colorMode of ["light", "dark"]) {
        await setColorMode(colorMode);
        for (const surface of ["preview", "live"]) {
          await setMode(surface);
          await page.evaluate(() => window.__testEditor?.scrollToPosition?.(0));
          await sleep(150);
          const file = path.join(outputRoot, `theme-parity-${surface}-${colorMode}.png`);
          await page.screenshot({ path: file });
          screenshots[`${surface}-${colorMode}`] = path.relative(appRoot, file);
        }
      }
      report.screenshots = screenshots;
    }

    report.status = problems.length === 0 ? "passed" : "failed";
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
      await new Promise((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once("exit", resolve);
      });
    }
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith("render-parity-theme-")) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }

  report.problems = problems;
  const reportPath = path.join(outputRoot, "render-parity-phase1-report.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log("");
  console.log("Render parity Phase 1 (real theme.css inheritance) summary");
  console.log(`  status   : ${report.status}`);
  console.log(`  kinds    : ${KINDS.length} x 2 surfaces`);
  console.log(`  report   : ${reportPath}`);
  if (problems.length) {
    console.log("  problems :");
    for (const problem of problems) console.log(`    - ${problem}`);
  }
  process.exitCode = report.status === "passed" ? 0 : report.status === "blocked" ? 2 : 1;
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
