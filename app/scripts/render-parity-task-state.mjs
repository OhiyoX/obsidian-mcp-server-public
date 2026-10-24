#!/usr/bin/env node
// Checked-task completion probe for the unified Markdown rendering TODO
// (unified-rendering §4 first item: "checked-task 富文本完成态").
//
// The Phase 1-A gate proves the *completed* paint is inherited from the Vault's
// authoritative theme.css. This probe proves the state surface itself in a real
// Chromium:
//
//   1. a completed Live task line carries BOTH `data-task="x"` and the
//      `is-checked` class; an open line carries `data-task=" "` and no class;
//   2. toggling the checkbox adds/removes the class immediately, in both
//      directions, without touching the existing toggle/caret semantics;
//   3. with the real theme fixture installed, the completed computed style in
//      Reader AND Live equals the value the fixture declared;
//   4. with the theme disabled, the Web fallback paints `var(--text-faint)` +
//      `line-through` on the completed item in both hosts, and leaves the open
//      item untouched;
//   5. four element screenshots (Reader/Live x open/completed) plus two page
//      screenshots document the visible result.
//
// Environment:
//   PLAYWRIGHT_MODULE            absolute path to an external Playwright entry
//   CHROMIUM_EXECUTABLE          absolute path to a Chromium binary
//   RENDER_PARITY_TASK_OUTPUT    artifact directory (default: OS temp dir)
//
// Exit codes: 0 = every assertion held; 1 = assertion failure; 2 = browser
// runtime unavailable (honest blocked state).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  EXPECTED,
  KINDS,
  PROBE_SOURCE,
  THEME_FIXTURE_RELATIVE,
  THEME_NAME,
  collectThemePaint,
  describeMismatch,
  evaluatePaint,
} from "./render-parity-theme-core.mjs";
import { waitForSurfaceReady } from "./render-parity-readiness.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(appRoot, THEME_FIXTURE_RELATIVE);
const outputRoot = path.resolve(
  process.env.RENDER_PARITY_TASK_OUTPUT || path.join(os.tmpdir(), `render-parity-task-${process.pid}`),
);
const NOTE_NAME = "TaskState.md";
const OPEN_MARKER = "TASKMARK";
const DONE_MARKER = "TASKDONEMARK";

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
      OAUTH_INITIAL_USERNAME: "task-state",
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
  child.stderr.on("data", () => {});
  child.stdout.resume();
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return { child };
    } catch {
      // still starting
    }
    if (child.exitCode !== null) throw new Error("task-state server exited during startup");
    await sleep(100);
  }
  throw new Error("task-state server did not become healthy");
}

/**
 * Runs in the browser. Reads the Live/Reader completed-task surfaces: classes,
 * data attributes and the computed paint, plus the resolved fallback tokens.
 */
function readTaskSurfaces({ openMarker, doneMarker }) {
  const resolveToken = (token) => {
    const probe = document.createElement("div");
    probe.style.color = token;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  };
  const deepestWith = (scope, needle) => {
    let best = null;
    const walk = (element) => {
      if (!(element.textContent || "").includes(needle)) return;
      best = element;
      for (const child of element.children) walk(child);
    };
    if (scope) walk(scope);
    return best;
  };
  const paintOf = (element) => {
    const style = getComputedStyle(element);
    return { color: style.color, textDecorationLine: style.textDecorationLine };
  };
  const surface = (element) => (element
    ? {
      ...paintOf(element),
      classes: [...element.classList].sort(),
      dataTask: element.getAttribute("data-task"),
      html: element.outerHTML.slice(0, 220),
    }
    : null);
  const preview = document.querySelector("#preview");
  const content = document.querySelector(".cm-content");
  const readerDone = deepestWith(preview, doneMarker)?.closest("li.task-list-item") || null;
  const readerOpen = deepestWith(preview, openMarker)?.closest("li.task-list-item") || null;
  const liveDone = deepestWith(content, doneMarker)?.closest(".HyperMD-task-line") || null;
  const liveOpen = deepestWith(content, openMarker)?.closest(".HyperMD-task-line") || null;
  return {
    readerDone: surface(readerDone),
    readerOpen: surface(readerOpen),
    liveDone: surface(liveDone),
    liveOpen: surface(liveOpen),
    liveTaskLines: document.querySelectorAll(".cm-line.HyperMD-task-line").length,
    faint: resolveToken("var(--text-faint)"),
    normal: resolveToken("var(--text-normal)"),
  };
}

/** Runs in the browser. Source text of the task lines the probe toggles. */
function readTaskSource({ doneMarker }) {
  const view = window.__testEditor?._view;
  if (!view) return null;
  const text = view.state.doc.toString().split("\n");
  return text.filter((line) => line.includes(doneMarker) || line.includes("TASKMARK"));
}

function assertLiveState(label, measured, { expectChecked }) {
  const done = measured.liveDone;
  const open = measured.liveOpen;
  if (!done || !open) {
    fail(`${label}: Live task lines are missing (completed=${Boolean(done)}, open=${Boolean(open)})`);
    return;
  }
  if (expectChecked) {
    if (done.dataTask !== "x") fail(`${label}: completed Live line data-task is ${JSON.stringify(done.dataTask)}, expected "x"`);
    if (!done.classes.includes("is-checked")) fail(`${label}: completed Live line is missing is-checked (${done.classes.join(" ")})`);
  } else {
    if (done.dataTask !== " ") fail(`${label}: toggled Live line data-task is ${JSON.stringify(done.dataTask)}, expected " "`);
    if (done.classes.includes("is-checked")) fail(`${label}: toggled Live line still carries is-checked`);
  }
  if (open.dataTask !== " ") fail(`${label}: open Live line data-task is ${JSON.stringify(open.dataTask)}, expected " "`);
  if (open.classes.includes("is-checked")) fail(`${label}: open Live line must not carry is-checked`);
  if (measured.liveTaskLines !== 2) fail(`${label}: expected 2 Live task lines, found ${measured.liveTaskLines}`);
}

async function setThemeEnabled(page, enabled) {
  await page.evaluate((on) => {
    const link = document.querySelector("#community-theme");
    if (!link) throw new Error("community theme link is missing");
    link.disabled = !on;
  }, enabled);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await sleep(60);
}

async function main() {
  const fixtureCss = (await fs.readFile(fixturePath, "utf8")).replace(/\r\n/g, "\n");
  const playwright = await importPlaywright();
  await fs.mkdir(outputRoot, { recursive: true });
  const report = {
    status: "running",
    generatedAt: new Date().toISOString(),
    fixture: THEME_FIXTURE_RELATIVE,
    kinds: KINDS.map((kind) => kind.id),
    assertions: {},
    problems: [],
  };
  if (playwright.error || !playwright.chromium) {
    report.status = "blocked";
    report.reason = playwright.error ? playwright.error.message : "PLAYWRIGHT_MODULE did not expose chromium";
    await fs.writeFile(path.join(outputRoot, "checked-task-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`BLOCKED checked-task probe: ${report.reason}`);
    process.exitCode = 2;
    return;
  }
  const { chromium } = playwright;

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "render-parity-task-"));
  const vault = path.join(root, "vault");
  const themeDir = path.join(vault, ".obsidian", "themes", THEME_NAME);
  await fs.mkdir(themeDir, { recursive: true });
  await fs.writeFile(path.join(themeDir, "theme.css"), fixtureCss);
  await fs.writeFile(
    path.join(vault, ".obsidian", "appearance.json"),
    JSON.stringify({ cssTheme: THEME_NAME, theme: "moonstone", baseFontSize: 16 }),
  );
  await fs.writeFile(path.join(vault, NOTE_NAME), PROBE_SOURCE);

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
    child = (await startServer(vault, path.join(root, "data"), base, password)).child;
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
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
      form: { username: "task-state", password },
    });
    if (login.status() !== 200) throw new Error(`login failed with ${login.status()}`);
    await page.goto(`${base}/app`);
    await page.waitForSelector(`.note[title="${NOTE_NAME}"]`);
    await page.locator(`.note[title="${NOTE_NAME}"]`).click();
    await page.waitForFunction((name) => document.querySelector("#current-path")?.textContent === name, NOTE_NAME);

    const setMode = async (name) => {
      if (!(await page.locator(`.document.mode-${name}`).count())) {
        await page.locator(".view-mode-toggle:visible").click();
        await page.locator(`.view-mode-menu:not([hidden]) .view-mode-item[data-mode="${name}"]`).click();
      }
      await page.waitForFunction((mode) => document.querySelector(`.document.mode-${mode}`) != null, name);
      // #414 (C): reader.js / editor.js load on demand, so `mode-<name>` is not surface
      // readiness. Bounded wait; a timeout logs READINESS and the task-state assertion still fires.
      await waitForSurfaceReady(page, { surface: name === "preview" ? "reader" : "live", kinds: KINDS });
      await sleep(60);
    };
    const focusLiveEnd = async () => {
      await page.evaluate(() => {
        const editor = window.__testEditor;
        const view = editor?._view;
        if (!view) return;
        editor.scrollToPosition?.(view.state.doc.length);
        view.dispatch({ selection: { anchor: view.state.doc.length } });
      });
      await sleep(120);
    };
    const readSurfaces = () => page.evaluate(readTaskSurfaces, { openMarker: OPEN_MARKER, doneMarker: DONE_MARKER });
    const readSource = () => page.evaluate(readTaskSource, { doneMarker: DONE_MARKER });

    // 1-2. Theme installed: the completed state surface and its inherited paint.
    await setMode("live");
    await focusLiveEnd();
    const themed = await readSurfaces();
    report.assertions.stateWithTheme = themed;
    assertLiveState("themed", themed, { expectChecked: true });

    await setMode("preview");
    await sleep(80);
    const readerSnapshot = await page.evaluate(collectThemePaint, { kinds: KINDS, surface: "reader" });
    await setMode("live");
    await focusLiveEnd();
    const liveSnapshot = await page.evaluate(collectThemePaint, { kinds: KINDS, surface: "live" });
    const mismatches = [
      ...evaluatePaint(readerSnapshot, EXPECTED, "reader"),
      ...evaluatePaint(liveSnapshot, EXPECTED, "live"),
    ];
    report.assertions.themeMismatches = mismatches;
    report.assertions.readerSnapshot = readerSnapshot["task-checked"];
    report.assertions.liveSnapshot = liveSnapshot["task-checked"];
    for (const mismatch of mismatches) fail(`theme inheritance ${describeMismatch(mismatch)}`);

    // 3. Theme disabled: the Web fallback must own the completed paint.
    await setThemeEnabled(page, false);
    await setMode("live");
    await focusLiveEnd();
    const liveFallback = await readSurfaces();
    await setMode("preview");
    await sleep(80);
    const readerFallback = await readSurfaces();
    report.assertions.fallback = { live: liveFallback, reader: readerFallback };
    for (const [label, measured] of [["live", liveFallback], ["reader", readerFallback]]) {
      const done = label === "live" ? measured.liveDone : measured.readerDone;
      const open = label === "live" ? measured.liveOpen : measured.readerOpen;
      if (!done || !open) {
        fail(`fallback ${label}: completed/open task element is missing`);
        continue;
      }
      if (done.color !== measured.faint) fail(`fallback ${label}: completed color ${done.color} != --text-faint ${measured.faint}`);
      if (done.textDecorationLine !== "line-through") fail(`fallback ${label}: completed text-decoration is ${done.textDecorationLine}, expected line-through`);
      if (open.color === measured.faint) fail(`fallback ${label}: open task must not use the faint completed tone`);
      if (open.textDecorationLine !== "none") fail(`fallback ${label}: open task text-decoration is ${open.textDecorationLine}, expected none`);
    }

    // 4. Screenshots: Reader/Live x open/completed, plus the full page each.
    const screenshots = {};
    const shot = async (name, locator) => {
      const file = path.join(outputRoot, `checked-task-${name}.png`);
      await locator.screenshot({ path: file });
      screenshots[name] = path.relative(appRoot, file);
    };
    await setMode("preview");
    await sleep(100);
    await shot("reader-open", page.locator("li.task-list-item", { hasText: OPEN_MARKER }).first());
    await shot("reader-completed", page.locator("li.task-list-item", { hasText: DONE_MARKER }).first());
    await page.screenshot({ path: path.join(outputRoot, "checked-task-reader-page.png") });
    screenshots["reader-page"] = path.relative(appRoot, path.join(outputRoot, "checked-task-reader-page.png"));
    await setMode("live");
    await focusLiveEnd();
    await shot("live-open", page.locator(".cm-line.HyperMD-task-line", { hasText: OPEN_MARKER }).first());
    await shot("live-completed", page.locator(".cm-line.HyperMD-task-line", { hasText: DONE_MARKER }).first());
    await page.screenshot({ path: path.join(outputRoot, "checked-task-live-page.png") });
    screenshots["live-page"] = path.relative(appRoot, path.join(outputRoot, "checked-task-live-page.png"));
    report.screenshots = screenshots;

    // 5. Toggle: the class must follow the document in both directions.
    await setThemeEnabled(page, true);
    const doneLine = page.locator(".cm-line.HyperMD-task-line", { hasText: DONE_MARKER });
    await doneLine.locator("input.cm-live-task-checkbox").click();
    await page.waitForFunction((marker) => {
      const line = [...document.querySelectorAll(".cm-line.HyperMD-task-line")]
        .find((element) => (element.textContent || "").includes(marker));
      return Boolean(line) && !line.classList.contains("is-checked");
    }, DONE_MARKER);
    const unchecked = await readSurfaces();
    report.assertions.afterUncheck = { surfaces: unchecked, source: await readSource() };
    assertLiveState("after-uncheck", unchecked, { expectChecked: false });
    if (!(await readSource()).some((line) => line.startsWith("- [ ]") && line.includes(DONE_MARKER))) {
      fail(`after-uncheck: source line was not toggled to "- [ ] ${DONE_MARKER}"`);
    }

    await doneLine.locator("input.cm-live-task-checkbox").click();
    await page.waitForFunction((marker) => {
      const line = [...document.querySelectorAll(".cm-line.HyperMD-task-line")]
        .find((element) => (element.textContent || "").includes(marker));
      return Boolean(line) && line.classList.contains("is-checked");
    }, DONE_MARKER);
    const rechecked = await readSurfaces();
    report.assertions.afterRecheck = { surfaces: rechecked, source: await readSource() };
    assertLiveState("after-recheck", rechecked, { expectChecked: true });
    if (!(await readSource()).some((line) => line.startsWith("- [x]") && line.includes(DONE_MARKER))) {
      fail(`after-recheck: source line was not toggled back to "- [x] ${DONE_MARKER}"`);
    }
    // The completed paint must still come from the theme after a re-render.
    if (rechecked.liveDone?.color !== EXPECTED["task-checked"].color) {
      fail(`after-recheck: completed color ${rechecked.liveDone?.color} != theme ${EXPECTED["task-checked"].color}`);
    }

    if (pageErrors.length) fail(`${pageErrors.length} uncaught page error(s): ${pageErrors[0].split("\n")[0]}`);
    report.pageErrors = pageErrors;
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
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith("render-parity-task-")) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }

  report.problems = problems;
  const reportPath = path.join(outputRoot, "checked-task-report.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log("");
  console.log("Checked-task completion probe summary");
  console.log(`  status  : ${report.status}`);
  console.log(`  report  : ${reportPath}`);
  if (report.screenshots) console.log(`  shots   : ${Object.keys(report.screenshots).length}`);
  if (problems.length) {
    console.log("  problems:");
    for (const problem of problems) console.log(`    - ${problem}`);
  }
  process.exitCode = report.status === "passed" ? 0 : report.status === "blocked" ? 2 : 1;
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
