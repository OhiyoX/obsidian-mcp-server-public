#!/usr/bin/env node
// Phase 1-B shared geometry hard gate for the unified Markdown rendering TODO.
//
// Boot/report/exit-code/negative-control pattern is intentionally identical to
// `render-parity-phase1-theme.mjs` (Phase 1-A): both are bounded Chromium gates
// that boot the real Web app in an isolated Vault, load a real theme.css fixture
// through the production `/api/web/v1/theme.css` endpoint, and assert that the
// measured result equals what the theme declared — never that Reader == Live.
//
// What this gate adds is the geometry half of the TODO's hard gate:
//   * adjacent-block bounding-box gaps for heading->paragraph/list/table/code/quote
//     and the symmetric block->heading pairs;
//   * table allocator width, table rect, and wrapper clientWidth vs scrollWidth
//     as evidence for the shared overflow policy.
//
// Environment:
//   PLAYWRIGHT_MODULE          absolute path to an external Playwright entry module
//   CHROMIUM_EXECUTABLE        absolute path to a Chromium binary
//   RENDER_PARITY_OUTPUT       artifact directory (default: OS temp dir)
//   RENDER_PARITY_GEOMETRY_ALLOWLIST  alternative allowlist path (tests)
//   RENDER_PARITY_SKIP_CONTROL unset; set to skip the negative control (never in CI)
//   RENDER_PARITY_SCREENSHOTS  set to also capture Reader/Live x light/dark images
//
// Exit codes: 0 = ran and every measured geometry followed the theme tokens;
// 1 = geometry or fixture failure; 2 = browser runtime unavailable (blocked).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  ADJACENCIES,
  GEOMETRY_ALLOWLIST_RELATIVE,
  GEOMETRY_EXPECTED,
  GEOMETRY_FIXTURE_RELATIVE,
  GEOMETRY_PROBE_SOURCE,
  GEOMETRY_THEME_NAME,
  GEOMETRY_TOKENS,
  MUTATED_GEOMETRY_THEME_NAME,
  TABLES,
  classifyGeometryMismatches,
  describeGeometryMismatch,
  evaluateAllocatorParity,
  evaluateGeometry,
  geometryNegativeControl,
  mutateGeometryCss,
  mutatedGeometryExpected,
  validateGeometryFixture,
} from "./render-parity-geometry-core.mjs";
import {
  ensureLiveTables,
  ensureReaderTables,
  probeSurfaceSettled,
  setThemeLink,
} from "./render-parity-geometry-harness.mjs";
import { waitForSurfaceReady } from "./render-parity-readiness.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(appRoot, GEOMETRY_FIXTURE_RELATIVE);
const allowlistPath = process.env.RENDER_PARITY_GEOMETRY_ALLOWLIST
  ? path.resolve(process.env.RENDER_PARITY_GEOMETRY_ALLOWLIST)
  : path.join(appRoot, GEOMETRY_ALLOWLIST_RELATIVE);
const outputRoot = path.resolve(
  process.env.RENDER_PARITY_OUTPUT || path.join(os.tmpdir(), `render-parity-geometry-${process.pid}`),
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  return probeSurfaceSettled(page, surface, sleep);
}

async function main() {
  const fixtureCss = (await fs.readFile(fixturePath, "utf8")).replace(/\r\n/g, "\n");
  const allowlist = JSON.parse(await fs.readFile(allowlistPath, "utf8"));
  const fixtureProblems = validateGeometryFixture(fixtureCss);
  for (const problem of fixtureProblems) fail(`fixture: ${problem}`);
  if (fixtureProblems.length) {
    console.log(`FAIL render-parity geometry fixture: ${fixtureProblems[0]}`);
    process.exitCode = 1;
    return;
  }

  const playwright = await importPlaywright();
  await fs.mkdir(outputRoot, { recursive: true });
  const report = {
    status: "running",
    generatedAt: new Date().toISOString(),
    fixture: GEOMETRY_FIXTURE_RELATIVE,
    allowlist: path.relative(appRoot, allowlistPath),
    tokens: GEOMETRY_TOKENS,
    adjacencies: ADJACENCIES.map((adj) => `${adj.direction}:${adj.id}`),
    tables: TABLES.map((table) => table.id),
    mismatches: [],
    negativeControl: null,
    problems: [],
  };
  if (playwright.error || !playwright.chromium) {
    report.status = "blocked";
    report.reason = playwright.error ? playwright.error.message : "PLAYWRIGHT_MODULE did not expose chromium";
    await fs.writeFile(path.join(outputRoot, "render-parity-geometry-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`BLOCKED render-parity geometry: ${report.reason}`);
    process.exitCode = 2;
    return;
  }
  const { chromium } = playwright;

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "render-parity-geometry-"));
  const vault = path.join(root, "vault");
  await fs.mkdir(vault);
  await writeTheme(vault, GEOMETRY_THEME_NAME, fixtureCss);
  await fs.writeFile(
    path.join(vault, ".obsidian", "appearance.json"),
    JSON.stringify({ cssTheme: GEOMETRY_THEME_NAME, theme: "moonstone", baseFontSize: 16 }),
  );
  await fs.writeFile(path.join(vault, "GeometryParity.md"), GEOMETRY_PROBE_SOURCE);

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
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
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
    await page.waitForSelector('.note[title="GeometryParity.md"]');
    await page.locator('.note[title="GeometryParity.md"]').click();
    await page.waitForFunction(() => document.querySelector("#current-path")?.textContent === "GeometryParity.md");

    const setMode = async (name) => {
      if (!(await page.locator(`.document.mode-${name}`).count())) {
        await page.locator(".view-mode-toggle:visible").click();
        await page.locator(`.view-mode-menu:not([hidden]) .view-mode-item[data-mode="${name}"]`).click();
      }
      await page.waitForFunction((mode) => document.querySelector(`.document.mode-${mode}`) != null, name);
      // #414 (C): reader.js / editor.js load on demand, so `mode-<name>` is not surface
      // readiness. Bounded wait; a timeout logs READINESS and the geometry assertion still fires.
      await waitForSurfaceReady(page, { surface: name === "preview" ? "reader" : "live", kinds: [...ADJACENCIES, ...TABLES] });
      await sleep(60);
    };

    await setThemeLink(page, base, GEOMETRY_THEME_NAME, sleep);
    await setMode("preview");
    await ensureReaderTables(page, sleep);
    await sleep(120);
    const reader = await probe(page, "reader");

    await setMode("live");
    await sleep(120);
    await page.evaluate(() => {
      const view = window.__testEditor?._view;
      if (view) view.dispatch({ selection: { anchor: view.state.doc.length } });
    });
    await ensureLiveTables(page, sleep);
    await sleep(150);
    const live = await probe(page, "live");
    const mismatches = [
      ...evaluateGeometry(reader, GEOMETRY_EXPECTED, allowlist),
      ...evaluateGeometry(live, GEOMETRY_EXPECTED, allowlist),
      ...evaluateAllocatorParity(reader, live, allowlist),
    ];
    const classified = classifyGeometryMismatches(mismatches, allowlist);
    report.mismatches = classified.failures;
    report.environmentMismatches = classified.environment;
    report.snapshots = { reader, live };
    for (const mismatch of classified.failures) fail(`geometry ${describeGeometryMismatch(mismatch)}`);

    if (!process.env.RENDER_PARITY_SKIP_CONTROL) {
      const mutatedCss = mutateGeometryCss(fixtureCss);
      const mutatedExpectations = mutatedGeometryExpected(GEOMETRY_EXPECTED);
      await writeTheme(vault, MUTATED_GEOMETRY_THEME_NAME, mutatedCss);
      await setMode("preview");
      await setThemeLink(page, base, MUTATED_GEOMETRY_THEME_NAME, sleep);
      await ensureReaderTables(page, sleep);
      await sleep(120);
      const readerAfter = await probe(page, "reader");
      await setMode("live");
      await page.evaluate(() => {
        const view = window.__testEditor?._view;
        if (view) view.dispatch({ selection: { anchor: view.state.doc.length } });
      });
      await ensureLiveTables(page, sleep);
      await sleep(150);
      const liveAfter = await probe(page, "live");
      const controlMismatches = [
        ...evaluateGeometry(readerAfter, mutatedExpectations, allowlist),
        ...evaluateGeometry(liveAfter, mutatedExpectations, allowlist),
      ];
      const unchanged = [
        ...geometryNegativeControl(reader, readerAfter, GEOMETRY_EXPECTED, mutatedExpectations),
        ...geometryNegativeControl(live, liveAfter, GEOMETRY_EXPECTED, mutatedExpectations),
      ];
      report.negativeControl = { mismatches: controlMismatches, unchanged, mutatedTokens: mutatedExpectations };
      report.negativeControlSnapshots = { reader: readerAfter, live: liveAfter };
      for (const mismatch of controlMismatches) fail(`negative control ${describeGeometryMismatch(mismatch)}`);
      for (const entry of unchanged) fail(`negative control did not follow the mutated geometry: ${entry}`);
    }

    if (pageErrors.length) fail(`${pageErrors.length} uncaught page error(s): ${pageErrors[0].split("\n")[0]}`);
    report.pageErrors = pageErrors;

    if (process.env.RENDER_PARITY_SCREENSHOTS) {
      // Screenshots use the Web's own fallback geometry (no community theme), so
      // a reviewer sees the real default spacing rather than the fixture numbers.
      await page.evaluate(() => {
        const link = document.querySelector("#community-theme");
        if (link) {
          link.disabled = true;
          link.removeAttribute("href");
        }
      });
      await sleep(120);
      const setColorMode = async (colorMode) => {
        await page.evaluate((mode) => {
          try {
            localStorage.setItem("obsidian-web.color-mode", mode);
          } catch {
            /* private mode */
          }
          const select = document.querySelector("#color-mode");
          if (select) {
            select.value = mode;
            select.dispatchEvent(new Event("change"));
          }
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
      const screenshots = {};
      for (const colorMode of ["light", "dark"]) {
        await setColorMode(colorMode);
        for (const surface of ["preview", "live"]) {
          await setMode(surface);
          if (surface === "live") await ensureLiveTables(page, sleep);
          await page.evaluate(() => window.__testEditor?.scrollToPosition?.(0));
          await sleep(150);
          const file = path.join(outputRoot, `geometry-parity-${surface}-${colorMode}.png`);
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
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith("render-parity-geometry-")) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }

  report.problems = problems;
  const reportPath = path.join(outputRoot, "render-parity-geometry-report.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log("");
  console.log("Render parity Phase 1-B (shared geometry token) summary");
  console.log(`  status     : ${report.status}`);
  console.log(`  adjacencies: ${ADJACENCIES.length} x 2 surfaces`);
  console.log(`  tables     : ${TABLES.length} x 2 surfaces`);
  console.log(`  report     : ${reportPath}`);
  if (problems.length) {
    console.log("  problems :");
    for (const problem of problems) console.log(`    - ${problem}`);
  }
  process.exitCode = report.status === "passed" ? 0 : report.status === "blocked" ? 2 : 1;
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
