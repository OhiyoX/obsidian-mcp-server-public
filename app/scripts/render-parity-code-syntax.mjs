#!/usr/bin/env node
// Canonical code-token probe for the unified Markdown rendering TODO
// (§4 second item: "code/glyph 前景与语法色").
//
// The Phase 1-A gate proves the *paint* of each syntax kind is inherited from
// the Vault's authoritative theme.css. This probe proves the class face and the
// fallback layer in a real Chromium:
//
//   1. Live code tokens carry the canonical Obsidian `cm-*` class names (no
//      generated `ͼ…` name survives) and Reader tokens carry `token <name>`;
//   2. with the theme fixture installed, each token's computed colour equals
//      the value the fixture declared, on BOTH surfaces;
//   3. with the theme disabled, it equals the `--code-*` fallback app.css owns;
//   4. the fence registry works for javascript/css/html, and an unknown
//      language stays unhighlighted;
//   5. a mutated fixture moves every asserted colour (negative control);
//   6. seven screenshots (Reader/Live x themed/unthemed + page shots).
//
// Environment:
//   PLAYWRIGHT_MODULE          absolute path to an external Playwright entry
//   CHROMIUM_EXECUTABLE        absolute path to a Chromium binary
//   RENDER_PARITY_CODE_OUTPUT  artifact directory (default: OS temp dir)
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
import { EXPECTED, THEME_FIXTURE_RELATIVE, THEME_NAME, mutateCss, mutateValue } from "./render-parity-theme-core.mjs";
import { waitForSurfaceReady } from "./render-parity-readiness.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(appRoot, THEME_FIXTURE_RELATIVE);
const outputRoot = path.resolve(
  process.env.RENDER_PARITY_CODE_OUTPUT || path.join(os.tmpdir(), `render-parity-code-${process.pid}`),
);
const NOTE_NAME = "CodeSyntax.md";
const MUTATED_THEME_NAME = `${THEME_NAME}CodeMut`;

// The four syntax kinds the Phase 1 gate asserts, with the canonical class face
// each surface must expose for them.
const TOKEN_KINDS = [
  { id: "code-keyword", live: "cm-keyword", reader: ".token.keyword", token: "--code-keyword" },
  { id: "code-string", live: "cm-string", reader: ".token.string", token: "--code-string" },
  { id: "code-comment", live: "cm-comment", reader: ".token.comment", token: "--code-comment" },
  { id: "code-number", live: "cm-number", reader: ".token.number", token: "--code-value" },
];

const PROBE_NOTE = `# CodeSyntax

\`\`\`js
const KEYWORDMARK = "STRMARK" + 4242; // COMMENTMARK
\`\`\`

\`\`\`css
.rule { color: #STRMARK; } /* COMMENTMARK */
\`\`\`

\`\`\`html
<div data-x="STRMARK"><!-- COMMENTMARK --></div>
\`\`\`

\`\`\`python
def STRMARK():  # COMMENTMARK
    return 1
\`\`\`
`;

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
    cwd: appRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(new URL(base).port),
      VAULT_PATH: vault,
      WEB_VAULTS_ROOT: "",
      WEB_DEFAULT_VAULT: "",
      DATA_PATH: dataPath,
      OAUTH_ENABLED: "true",
      PUBLIC_BASE_URL: base,
      OAUTH_INITIAL_USERNAME: "code-syntax",
      OAUTH_INITIAL_PASSWORD: password,
      OAUTH_ADMIN_PASSWORD: password,
      API_KEY: "",
      GIT_ENABLED: "false",
      EMBEDDING_PROVIDER: "disabled",
      RETRIEVAL_AUTO_EMBED: "false",
    },
  });
  child.stderr.on("data", () => {});
  child.stdout.resume();
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return child;
    } catch {
      // still starting
    }
    if (child.exitCode !== null) throw new Error("code-syntax server exited during startup");
    await sleep(100);
  }
  throw new Error("code-syntax server did not become healthy");
}

/**
 * Runs in the browser. Reads every canonical code token on both surfaces, any
 * generated (non-canonical) highlight class that leaked into Live, and the
 * resolved `--code-*` fallback values.
 */
function readCodeSurfaces({ kinds }) {
  const resolveToken = (token) => {
    const probe = document.createElement("div");
    probe.style.color = token;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  };
  const read = (root, selector) => {
    const element = root?.querySelector(selector) || null;
    if (!element) return null;
    return {
      text: (element.textContent || "").slice(0, 48),
      classes: [...element.classList].sort(),
      color: getComputedStyle(element).color,
    };
  };
  const liveRoot = document.querySelector(".cm-content");
  const readerRoot = document.querySelector("#preview .markdown-preview-view") || document.querySelector("#preview");
  const live = {};
  const reader = {};
  const fallback = {};
  for (const kind of kinds) {
    live[kind.id] = read(liveRoot, `.${kind.live}`);
    reader[kind.id] = read(readerRoot, kind.reader);
    fallback[kind.id] = resolveToken(`var(${kind.token})`);
  }
  const leaked = new Set();
  for (const element of liveRoot?.querySelectorAll("*") || []) {
    for (const className of element.classList) if (className.startsWith("\u037c")) leaked.add(className);
  }
  return {
    live,
    reader,
    fallback,
    leakedGeneratedClasses: [...leaked].sort(),
    readerLanguages: [...(readerRoot?.querySelectorAll("code[class*='language-']") || [])].map((el) => el.className),
  };
}

/** Runs in the browser. Bounding box of the first code block on one surface. */
function codeBlockRect({ surface }) {
  let boxes = [];
  if (surface === "reader") {
    const pre = document.querySelector("#preview pre");
    if (pre) boxes = [pre.getBoundingClientRect()];
  } else {
    // Only the first *contiguous* run of code lines, so a document with several
    // fences still yields a tight shot of one block.
    let started = false;
    for (const line of document.querySelectorAll(".cm-content .cm-line")) {
      if (line.classList.contains("cm-live-code")) {
        started = true;
        boxes.push(line.getBoundingClientRect());
      } else if (started) break;
    }
  }
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const visible = boxes.filter((box) => box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < viewportHeight);
  if (!visible.length) return null;
  const left = Math.max(0, Math.min(...visible.map((box) => box.left)) - 8);
  const top = Math.max(0, Math.min(...visible.map((box) => box.top)) - 8);
  const right = Math.min(viewportWidth, Math.max(...visible.map((box) => box.right)) + 8);
  const bottom = Math.min(viewportHeight, Math.max(...visible.map((box) => box.bottom)) + 8);
  if (right <= left || bottom <= top) return null;
  return { x: Math.floor(left), y: Math.floor(top), width: Math.ceil(right - left), height: Math.ceil(bottom - top) };
}

function assertCanonicalFace(label, measured) {
  for (const kind of TOKEN_KINDS) {
    const live = measured.live[kind.id];
    const reader = measured.reader[kind.id];
    if (!live) fail(`${label}: Live is missing the canonical .${kind.live} token (${kind.id})`);
    else if (!live.classes.includes(kind.live)) fail(`${label}: Live ${kind.id} carries ${JSON.stringify(live.classes)}, expected ${kind.live}`);
    if (!reader) fail(`${label}: Reader is missing the canonical ${kind.reader} token (${kind.id})`);
    else if (!reader.classes.includes("token")) fail(`${label}: Reader ${kind.id} carries ${JSON.stringify(reader.classes)}, expected a token * face`);
  }
  if (measured.leakedGeneratedClasses.length) {
    fail(`${label}: Live still carries generated highlight classes ${JSON.stringify(measured.leakedGeneratedClasses)}`);
  }
}

function assertColors(label, measured, expected) {
  for (const kind of TOKEN_KINDS) {
    for (const surface of ["live", "reader"]) {
      const entry = measured[surface][kind.id];
      if (entry && entry.color !== expected[kind.id]) {
        fail(`${label} ${surface} ${kind.id}: computed ${entry.color}, expected ${expected[kind.id]}`);
      }
    }
  }
}

async function main() {
  const fixtureCss = (await fs.readFile(fixturePath, "utf8")).replace(/\r\n/g, "\n");
  const playwright = await importPlaywright();
  await fs.mkdir(outputRoot, { recursive: true });
  const report = {
    status: "running",
    generatedAt: new Date().toISOString(),
    fixture: THEME_FIXTURE_RELATIVE,
    kinds: TOKEN_KINDS.map((kind) => kind.id),
    assertions: {},
    problems: [],
  };
  if (playwright.error || !playwright.chromium) {
    report.status = "blocked";
    report.reason = playwright.error ? playwright.error.message : "PLAYWRIGHT_MODULE did not expose chromium";
    await fs.writeFile(path.join(outputRoot, "code-syntax-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`BLOCKED code-syntax probe: ${report.reason}`);
    process.exitCode = 2;
    return;
  }
  const { chromium } = playwright;

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "render-parity-code-"));
  const vault = path.join(root, "vault");
  const themesRoot = path.join(vault, ".obsidian", "themes");
  await fs.mkdir(path.join(themesRoot, THEME_NAME), { recursive: true });
  await fs.mkdir(path.join(themesRoot, MUTATED_THEME_NAME), { recursive: true });
  await fs.writeFile(path.join(themesRoot, THEME_NAME, "theme.css"), fixtureCss);
  await fs.writeFile(path.join(themesRoot, MUTATED_THEME_NAME, "theme.css"), mutateCss(fixtureCss));
  await fs.writeFile(
    path.join(vault, ".obsidian", "appearance.json"),
    JSON.stringify({ cssTheme: THEME_NAME, theme: "moonstone", baseFontSize: 16 }),
  );
  await fs.writeFile(path.join(vault, NOTE_NAME), PROBE_NOTE);

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
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    });
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
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

    const login = await page.request.post(`${base}/auth/login`, { form: { username: "code-syntax", password } });
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
      // readiness. Bounded wait; a timeout logs READINESS and the code-token assertion still fires.
      await waitForSurfaceReady(page, {
        surface: name === "preview" ? "reader" : "live",
        needles: ["KEYWORDMARK", "STRMARK", "COMMENTMARK"],
      });
      await sleep(80);
    };
    const focusLiveEnd = async () => {
      await page.evaluate(() => {
        const editor = window.__testEditor;
        const view = editor?._view;
        if (!view) return;
        editor.scrollToPosition?.(view.state.doc.length);
        view.dispatch({ selection: { anchor: view.state.doc.length } });
      });
      await sleep(140);
    };
    const readSurfaces = () => page.evaluate(readCodeSurfaces, { kinds: TOKEN_KINDS });
    const setThemeEnabled = async (enabled) => {
      await page.evaluate((on) => {
        const link = document.querySelector("#community-theme");
        if (!link) throw new Error("community theme link is missing");
        link.disabled = !on;
      }, enabled);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await sleep(80);
    };
    const setThemeLink = async (name) => {
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
    };
    const screenshots = {};
    const pageShot = async (name) => {
      const file = path.join(outputRoot, `code-syntax-${name}.png`);
      await page.screenshot({ path: file });
      screenshots[name] = path.relative(appRoot, file);
    };
    const shot = async (name, surface) => {
      const firstBlock = surface === "reader"
        ? page.locator("#preview pre").first()
        : page.locator(".cm-content .cm-line.cm-live-code").first();
      await firstBlock.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(80);
      const rect = await page.evaluate(codeBlockRect, { surface });
      const file = path.join(outputRoot, `code-syntax-${name}.png`);
      if (rect) await page.screenshot({ path: file, clip: rect });
      else await page.screenshot({ path: file });
      screenshots[name] = path.relative(appRoot, file);
    };

    // 1-2. Theme installed: canonical class face + inherited paint on both hosts.
    await setThemeLink(THEME_NAME);
    await setMode("live");
    await focusLiveEnd();
    const themedLive = await readSurfaces();
    await setMode("preview");
    await sleep(120);
    const themedReader = await readSurfaces();
    const themed = { ...themedReader, live: themedLive.live, leakedGeneratedClasses: themedLive.leakedGeneratedClasses };
    report.assertions.themed = themed;
    assertCanonicalFace("themed", themed);
    assertColors("themed", themed, {
      "code-keyword": EXPECTED["code-keyword"].color,
      "code-string": EXPECTED["code-string"].color,
      "code-comment": EXPECTED["code-comment"].color,
      "code-number": EXPECTED["code-number"].color,
    });
    await setMode("live");
    await focusLiveEnd();
    await shot("live-themed", "live");
    await pageShot("live-themed-page");
    await setMode("preview");
    await sleep(120);
    await shot("reader-themed", "reader");
    await pageShot("reader-themed-page");

    // 3. Theme disabled: the `--code-*` fallback must own the paint.
    await setThemeEnabled(false);
    await sleep(80);
    await shot("reader-unthemed", "reader");
    const unthemedReader = await readSurfaces();
    await setMode("live");
    await focusLiveEnd();
    await shot("live-unthemed", "live");
    await pageShot("live-unthemed-page");
    const unthemedLive = await readSurfaces();
    const unthemed = { ...unthemedReader, live: unthemedLive.live, leakedGeneratedClasses: unthemedLive.leakedGeneratedClasses };
    report.assertions.unthemed = unthemed;
    assertCanonicalFace("unthemed", unthemed);
    assertColors("unthemed", unthemed, unthemedLive.fallback);

    // 4. Language registry + unknown-language behaviour, both surfaces.
    const registry = await page.evaluate(() => ({
      readerCodes: [...document.querySelectorAll("#preview pre code")].map((el) => ({
        className: el.className,
        tokens: [...el.querySelectorAll("span")].map((span) => span.className),
      })),
      liveLines: [...document.querySelectorAll(".cm-content .cm-line.cm-live-code")].map((el) => el.textContent),
    }));
    report.assertions.registry = registry;
    for (const language of ["language-js", "language-css", "language-html"]) {
      const entry = registry.readerCodes.find((code) => code.className.includes(language));
      if (!entry) fail(`registry: Reader is missing the ${language} block`);
      else if (!entry.tokens.length) fail(`registry: Reader ${language} block has no token spans`);
    }
    const pythonEntry = registry.readerCodes.find((code) => code.className.includes("language-python"));
    if (!pythonEntry) fail("registry: Reader is missing the python block");
    else if (pythonEntry.tokens.length) fail(`registry: unknown language python must stay unhighlighted, got ${JSON.stringify(pythonEntry.tokens)}`);

    // 5. Negative control: the mutated fixture must move every asserted colour.
    await setThemeEnabled(true);
    await setThemeLink(MUTATED_THEME_NAME);
    await setMode("preview");
    await sleep(120);
    const mutatedReader = await readSurfaces();
    await setMode("live");
    await focusLiveEnd();
    const mutatedLive = await readSurfaces();
    const mutated = { ...mutatedReader, live: mutatedLive.live };
    report.assertions.mutated = mutated;
    const unchanged = [];
    for (const kind of TOKEN_KINDS) {
      const want = mutateValue(EXPECTED[kind.id].color);
      for (const surface of ["live", "reader"]) {
        const entry = mutated[surface][kind.id];
        if (!entry) continue;
        if (entry.color !== want) fail(`mutated ${surface} ${kind.id}: computed ${entry.color}, expected ${want}`);
        if (entry.color === themed[surface][kind.id]?.color) unchanged.push(`${surface} ${kind.id} stayed ${entry.color}`);
      }
    }
    report.assertions.mutatedUnchanged = unchanged;
    for (const entry of unchanged) fail(`negative control did not follow the mutated theme: ${entry}`);

    if (pageErrors.length) fail(`${pageErrors.length} uncaught page error(s): ${pageErrors[0].split("\n")[0]}`);
    report.pageErrors = pageErrors;
    report.screenshots = screenshots;
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
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith("render-parity-code-")) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }

  report.problems = problems;
  const reportPath = path.join(outputRoot, "code-syntax-report.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log("");
  console.log("Canonical code-token probe summary");
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
