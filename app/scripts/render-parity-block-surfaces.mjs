#!/usr/bin/env node
// §4 item 3 probe: the Live Preview canonical surface of the three block kinds
// (callout / embed / footnote).
//
// It boots the real Web app in an isolated temporary Vault, installs the Phase 1
// theme fixture as a real community theme, renders one document containing the
// three block kinds, and then, on the Live surface:
//
//   1. matches each canonical element (Desktop class + attribute faces frozen
//      from `obsidian.asar`) and lists the classes/attributes it really carries;
//   2. reads its computed paint and requires the value the theme file declared
//      (proving Vault theme inheritance, not a Web fallback or a Web copy);
//   3. captures element screenshots for manual review;
//   4. fails on any uncaught page error.
//
// The READER half of this probe was removed on purpose: the Reader callout /
// footnote / embed surface is owned by U15 (`reader/callout-render.js`,
// `reader/footnote-rules.js`, `test/reader-callout-footnote-canonical.test.js`
// and the Reader prediction of `render-parity-phase1-theme.mjs`), and the
// BLOCK-side Reader implementation this probe used to pin
// (`reader/block-surfaces.js`) is gone. See BLOCK-R2.HANDOFF.md for the exact
// list of dropped Reader assertions and their new owners.
//
// Environment:
//   PLAYWRIGHT_MODULE   absolute path to an external Playwright entry module
//   CHROMIUM_EXECUTABLE absolute path to a Chromium binary
//   RENDER_PARITY_BLOCK_OUTPUT  artifact directory (default: OS temp dir)
//
// Exit codes: 0 = passed, 1 = assertion failure, 2 = browser runtime unavailable.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { THEME_FIXTURE_RELATIVE, THEME_NAME } from "./render-parity-theme-core.mjs";
import { waitForSurfaceReady } from "./render-parity-readiness.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(appRoot, THEME_FIXTURE_RELATIVE);
const outputRoot = path.resolve(
  process.env.RENDER_PARITY_BLOCK_OUTPUT || path.join(os.tmpdir(), `render-parity-blocks-${process.pid}`),
);

export const BLOCK_SOURCE = `# Block surfaces

> [!NOTE] CALLOUTMARK callout title
> Callout body text with **strong** markup.

> [!warning]- FOLDEDMARK folded
> Hidden body.

NOTEEMBEDMARK ![[ThemeTarget|EMBEDMARK]]

Image embed: ![[pixel.svg]]

FOOTNOTEMARK[^blocknote].

[^blocknote]: FOOTNOTEDEFMARK definition body.
`;

// The fixture declares the callout colour twice: the bare `.callout` sentinel
// (`rgb(45, 46, 47)`, the shape AnuPpuccin ships) and the canonical
// `.callout[data-callout="note"]` sentinel (`rgb(231, 232, 233)`, U15's Reader
// rule). The `[data-callout]` rule is more specific, so a callout that really
// carries the attribute computes the second colour while the folded `warning`
// callout keeps the bare colour — which is what makes the attribute assertion
// below meaningful rather than decorative.
const CALLOUT_NOTE_PAINT = { color: "rgb(231, 232, 233)", backgroundColor: "rgb(35, 36, 37)" };
const CALLOUT_BARE_PAINT = { color: "rgb(45, 46, 47)", backgroundColor: "rgb(35, 36, 37)" };

// Every entry is one canonical element of the Live Preview DOM
// (`obsidian.asar → app.js`: `L3` / `I3.initDOM` callout block widget, `A3.initDOM`
// embed loader, `app.css` 12199 footnote line) painted by the fixture theme
// through the selector shape a real Vault theme uses.
const SURFACES = {
  callout: {
    selector: ".cm-callout .callout",
    classes: ["callout"],
    attributes: { "data-callout": "note" },
    paint: CALLOUT_NOTE_PAINT,
  },
  "callout-title": { selector: ".cm-callout .callout .callout-title", classes: ["callout-title"] },
  "callout-title-inner": {
    selector: ".cm-callout .callout .callout-title-inner",
    classes: ["callout-title-inner"],
    text: "CALLOUTMARK callout title",
  },
  "callout-content": { selector: ".cm-callout .callout .callout-content", classes: ["callout-content"] },
  "callout-icon": { selector: ".cm-callout .callout .callout-icon", classes: ["callout-icon"] },
  "callout-folded": {
    selector: ".cm-callout .callout.is-collapsible",
    classes: ["callout", "is-collapsible", "is-collapsed"],
    attributes: { "data-callout": "warning", "data-callout-fold": "-" },
    paint: CALLOUT_BARE_PAINT,
  },
  "callout-fold": {
    selector: ".cm-callout .callout.is-collapsible .callout-fold",
    classes: ["callout-fold", "is-collapsed"],
  },
  embed: {
    selector: ".cm-content .internal-embed.markdown-embed",
    // LP-08 keeps the embed in place: the same element is the in-place wiki
    // chrome, so the frozen `.cm-live-wiki-link` face must stay present next to
    // Desktop's embed container faces (it is never an atomic image widget).
    classes: ["internal-embed", "markdown-embed", "inline-embed", "cm-live-wiki-link"],
    paint: { color: "rgb(65, 66, 67)" },
  },
  image: {
    // Live keeps the frozen in-place chrome and only adds Desktop's embed
    // CONTAINER face (`span.internal-embed.image-embed`, `app.js A3.initDOM`) to
    // it, because LP-08 freezes embeds as wiki chrome instead of replaceable
    // image/media widgets.
    selector: ".cm-content span.internal-embed.image-embed",
    classes: ["internal-embed", "image-embed", "cm-live-wiki-link", "cm-obsidian-link"],
    text: "pixel.svg",
  },
  footnote: {
    selector: ".cm-content .cm-line.HyperMD-footnote",
    classes: ["HyperMD-footnote"],
    paint: { color: "rgb(55, 56, 57)" },
  },
  "footnote-ref-anchor": {
    selector: ".cm-content .cm-line.HyperMD-footnote .cm-hmd-footnote",
    classes: ["cm-hmd-footnote", "cm-formatting"],
  },
  "footnote-backref": {
    selector: ".cm-content .cm-line.HyperMD-footnote .cm-hmd-footnote-url-title",
    classes: ["cm-hmd-footnote-url-title"],
  },
};

function collectSurface(spec) {
  const out = {};
  for (const [id, entry] of Object.entries(spec)) {
    const element = document.querySelector(entry.selector);
    if (!element) {
      out[id] = { found: false };
      continue;
    }
    const style = getComputedStyle(element);
    const values = {};
    for (const prop of Object.keys(entry.paint || {})) values[prop] = style[prop];
    const attributes = {};
    for (const name of ["data-callout", "data-callout-fold", "data-callout-metadata", "data-footnote-id", "data-footref", "href", "src"]) {
      const value = element.getAttribute(name);
      if (value != null) attributes[name] = value;
    }
    out[id] = {
      found: true,
      tag: element.tagName.toLowerCase(),
      classes: [...element.classList].sort(),
      attributes,
      text: (element.textContent || "").trim().slice(0, 64),
      html: element.outerHTML.slice(0, 700),
      values,
    };
  }
  return out;
}

function problemsFor(snapshot) {
  const problems = [];
  for (const [id, expected] of Object.entries(SURFACES)) {
    const entry = snapshot[id];
    if (!entry?.found) {
      problems.push(`live ${id}: missing (${expected.selector})`);
      continue;
    }
    for (const className of expected.classes || []) {
      if (!entry.classes.includes(className)) {
        problems.push(`live ${id}: missing canonical class .${className} (has "${entry.classes.join(" ")}")`);
      }
    }
    for (const [name, value] of Object.entries(expected.attributes || {})) {
      const actual = entry.attributes[name] ?? null;
      if (actual !== value) problems.push(`live ${id}: ${name} expected ${value}, got ${JSON.stringify(actual)}`);
    }
    if (expected.text && entry.text !== expected.text) {
      problems.push(`live ${id}: text expected ${JSON.stringify(expected.text)}, got ${JSON.stringify(entry.text)}`);
    }
    for (const [prop, value] of Object.entries(expected.paint || {})) {
      if (entry.values[prop] !== value) {
        problems.push(`live ${id} ${prop}: theme declared ${value}, computed ${entry.values[prop]}`);
      }
    }
  }
  return problems;
}

async function importPlaywright() {
  const href = process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright";
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
      OAUTH_INITIAL_USERNAME: "block-probe",
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
      if ((await fetch(`${base}/healthz`)).ok) return child;
    } catch { /* still starting */ }
    if (child.exitCode !== null) throw new Error("block probe server exited during startup");
    await sleep(100);
  }
  throw new Error("block probe server did not become healthy");
}

async function main() {
  const problems = [];
  const playwright = await importPlaywright();
  await fs.mkdir(outputRoot, { recursive: true });
  const report = {
    status: "running",
    generatedAt: new Date().toISOString(),
    document: "BlockSurfaces.md",
    theme: THEME_NAME,
    surface: "live",
    surfaces: {},
    problems: [],
    screenshots: [],
    skippedScreenshots: [],
    pageErrors: [],
  };
  if (playwright.error || !playwright.chromium) {
    report.status = "blocked";
    report.reason = playwright.error ? playwright.error.message : "PLAYWRIGHT_MODULE did not expose chromium";
    await fs.writeFile(path.join(outputRoot, "block-surface-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`BLOCKED block-surface probe: ${report.reason}`);
    process.exitCode = 2;
    return;
  }
  const { chromium } = playwright;

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "render-parity-blocks-"));
  const vault = path.join(root, "vault");
  await fs.mkdir(path.join(vault, ".obsidian", "themes", THEME_NAME), { recursive: true });
  const fixtureCss = (await fs.readFile(fixturePath, "utf8")).replace(/\r\n/g, "\n");
  await fs.writeFile(path.join(vault, ".obsidian", "themes", THEME_NAME, "theme.css"), fixtureCss);
  await fs.writeFile(
    path.join(vault, ".obsidian", "appearance.json"),
    JSON.stringify({ cssTheme: THEME_NAME, theme: "moonstone", baseFontSize: 16 }),
  );
  await fs.writeFile(path.join(vault, "BlockSurfaces.md"), BLOCK_SOURCE);
  // A 1x1 SVG so the image embed resolves through the real asset endpoint.
  await fs.writeFile(
    path.join(vault, "pixel.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="rgb(120,82,238)"/></svg>',
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
    child = await startServer(vault, path.join(root, "data"), base, password);
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    });
    // Tall viewport: the whole document must fit CodeMirror's rendered viewport,
    // otherwise a block below the fold has no DOM to probe.
    const context = await browser.newContext({ viewport: { width: 1440, height: 1600 }, deviceScaleFactor: 2 });
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
      form: { username: "block-probe", password },
    });
    if (login.status() !== 200) throw new Error(`login failed with ${login.status()}`);
    await page.goto(`${base}/app`);
    await page.waitForSelector('.note[title="BlockSurfaces.md"]');
    await page.locator('.note[title="BlockSurfaces.md"]').click();
    await page.waitForFunction(() => document.querySelector("#current-path")?.textContent === "BlockSurfaces.md");

    const setMode = async (name) => {
      if (!(await page.locator(`.document.mode-${name}`).count())) {
        await page.locator(".view-mode-toggle:visible").click();
        await page.locator(`.view-mode-menu:not([hidden]) .view-mode-item[data-mode="${name}"]`).click();
      }
      await page.waitForFunction((mode) => document.querySelector(`.document.mode-${mode}`) != null, name);
      // #414 (C): reader.js / editor.js load on demand, so `mode-<name>` is not surface
      // readiness. Bounded wait; a timeout logs READINESS and the canonical-face assertion still fires.
      await waitForSurfaceReady(page, { surface: name === "preview" ? "reader" : "live" });
      await sleep(80);
    };

    await page.evaluate(async ({ href }) => {
      const link = document.querySelector("#community-theme");
      await new Promise((resolve, reject) => {
        link.onload = () => resolve();
        link.onerror = () => reject(new Error("theme failed to load"));
        link.disabled = false;
        link.href = href;
      });
    }, { href: `${base}/api/web/v1/theme.css?name=${encodeURIComponent(THEME_NAME)}` });
    await sleep(80);

    await setMode("live");
    // Idle surface: move the caret to the top so no block is revealed for
    // editing (a revealed callout is raw source, not a widget).
    await page.evaluate(() => {
      const view = window.__testEditor?._view;
      if (view) view.dispatch({ selection: { anchor: 0 } });
    });
    await sleep(150);
    const snapshot = await page.evaluate(collectSurface, SURFACES);
    report.surfaces.live = snapshot;
    problems.push(...problemsFor(snapshot));
    for (const [id, spec] of Object.entries(SURFACES)) {
      const locator = page.locator(spec.selector).first();
      if (!(await locator.count())) continue;
      // Decoration-only facets (an empty `.callout-icon` / `.callout-fold`) can
      // have a zero box; screenshot only what a human can actually look at.
      const box = await locator.boundingBox();
      if (!box || box.width < 1 || box.height < 1) {
        report.skippedScreenshots.push(`${id}-live`);
        continue;
      }
      const file = path.join(outputRoot, `block-${id}-live.png`);
      await locator.screenshot({ path: file });
      report.screenshots.push(path.basename(file));
    }
    await page.screenshot({ path: path.join(outputRoot, "block-page-live.png") });
    report.screenshots.push("block-page-live.png");

    report.pageErrors = pageErrors;
    if (pageErrors.length) problems.push(`${pageErrors.length} uncaught page error(s): ${pageErrors[0].split("\n")[0]}`);
  } catch (error) {
    problems.push(`probe failure: ${error.message}`);
  } finally {
    report.problems = problems;
    report.status = problems.length ? "failed" : "passed";
    await fs.writeFile(path.join(outputRoot, "block-surface-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await browser?.close().catch(() => {});
    child?.kill();
  }

  console.log("\nBlock surface probe summary");
  console.log(`  status      : ${report.status}`);
  console.log(`  surfaces    : ${Object.keys(report.surfaces).join(", ")}`);
  console.log(`  screenshots : ${report.screenshots.length}`);
  console.log(`  report      : ${path.join(outputRoot, "block-surface-report.json")}`);
  for (const problem of report.problems) console.log(`    - ${problem}`);
  if (problems.length) process.exitCode = 1;
}

await main();
