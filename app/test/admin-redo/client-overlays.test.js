// Lane L1 (overlays) acceptance test — real Chromium, real Admin server, real Admin markup.
//
// What this file proves, per `docs/admin-ui-proto/src/6-app.js`:
//   1. drawer  (6-app.js:200-218) — a row link shows the server's `.drawer` + `.scrim` over the list
//      without loading a document, pushes the drawer URL, and browser Back closes it again;
//   2. menu    (6-app.js:114-126) — the row's `<details class="mn">` becomes the prototype's floating
//      menu, clamped inside the viewport next to its button, closed by outside click and Esc, with
//      `j/k`/arrows moving the `.kb` highlight and Enter triggering the highlighted item;
//   3. modal   (6-app.js:99-105) — `?confirm=` shows the server's `.modal` centred with the typed
//      input focused, Esc cancels back to the previous state, and Enter submits the **real** form
//      (the server's `confirm` validation stays the authority);
//   4. toast   (6-app.js:92-97) — a plain server result line becomes the toast and fades after ~3.2 s;
//   5. no-JS   — with scripting disabled the same paths complete through the links and forms;
//   6. negative control — when the fragment fetch fails, the action falls back to the real navigation
//      the SSR link always had (and the page stays usable), i.e. the enhancement can really degrade.
//
// How it runs: the Admin fixture server (`scripts/web-regression/admin-layout-fixture.mjs`, the same
// one the Admin browser gate uses) and the pinned full Chromium build
// (`scripts/web-regression/chromium-binary.mjs`, issue #380 — never the headless shell). Chromium is
// driven over raw CDP, so the check needs no Playwright module; `PLAYWRIGHT_BROWSERS_PATH` or
// `CHROMIUM_EXECUTABLE` select the browser exactly as the other browser harnesses do.
//
// Set `OVERLAYS_REQUIRE_BROWSER=1` to turn "no browser on this machine" into a failure instead of a
// skip — a gate that must not silently lose this coverage uses that switch.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const appRoot = path.resolve(import.meta.dirname, "..", "..");
const VIEWPORT = { width: 1440, height: 900 };

/* ------------------------------------------------------------------ browser resolution */

/** The platform's default Playwright browsers cache, used when the environment names none. */
function defaultBrowsersPath() {
  if (process.platform === "win32") return path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  return path.join(os.homedir(), ".cache", "ms-playwright");
}

async function resolveBrowser() {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = defaultBrowsersPath();
  const modulePath = pathToFileURL(path.join(appRoot, "scripts", "web-regression", "chromium-binary.mjs")).href;
  const { resolveChromiumExecutableForEnvironment } = await import(modulePath);
  try {
    return resolveChromiumExecutableForEnvironment();
  } catch (error) {
    return { error };
  }
}

const browserResolution = await resolveBrowser();
const skipReason = browserResolution.error
  ? `no full Chromium build available: ${browserResolution.error.message.split("\n")[0]}`
  : false;
if (skipReason && process.env.OVERLAYS_REQUIRE_BROWSER === "1") throw new Error(skipReason);

/* ------------------------------------------------------------------ CDP driver */

const KEYMAP = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  j: { code: "KeyJ", keyCode: 74 },
  k: { code: "KeyK", keyCode: 75 },
};

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await sleep(100);
  }
}

/** One CDP target (a tab) with the handful of primitives these checks need. */
class Page {
  constructor(connection) {
    this.connection = connection;
    this.exceptions = [];
    this.consoleErrors = [];
    this.logs = [];
    this.loads = 0;
  }

  static async open({ endpoint, scripted = true }) {
    const target = await (await fetch(`${endpoint}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json();
    const connection = new Connection(target.webSocketDebuggerUrl);
    await connection.ready;
    const page = new Page(connection);
    page.endpoint = endpoint;
    page.scripted = scripted;
    await connection.send("Page.enable");
    await connection.send("Runtime.enable");
    await connection.send("Log.enable");
    await connection.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
    if (!scripted) await connection.send("Emulation.setScriptExecutionDisabled", { value: true });
    // Synthesized input (Input.insertText / key events) only reaches the active tab; the harness opens
    // several tabs over one browser, so each new one is brought to the front before it is driven.
    await connection.send("Page.bringToFront");
    connection.on("Page.loadEventFired", () => { page.loads += 1; });
    connection.on("Runtime.exceptionThrown", (params) => page.exceptions.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text));
    connection.on("Runtime.consoleAPICalled", (params) => {
      if (params.type === "error") page.consoleErrors.push(params.args.map((arg) => arg.value ?? arg.description).join(" "));
    });
    connection.on("Log.entryAdded", (params) => page.logs.push(params.entry));
    page.targetId = target.id;
    return page;
  }

  async evaluate(expression) {
    const result = await this.connection.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
    return result.result.value;
  }

  async goto(url) {
    const before = this.loads;
    await this.connection.send("Page.navigate", { url });
    for (let index = 0; index < 200 && this.loads <= before; index += 1) await sleep(25);
    await this.waitFor(`document.readyState === "complete"`, { label: `load of ${url}` });
    return this;
  }

  async waitFor(expression, { timeoutMs = 5000, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let value = null;
      try {
        value = await this.evaluate(expression);
      } catch (error) {
        if (Date.now() > deadline) throw new Error(`waitFor(${label}) failed: ${error.message}`);
      }
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`waitFor(${label}) timed out`);
      await sleep(50);
    }
  }

  async waitForGone(expression, options = {}) {
    return this.waitFor(`(${expression}) ? false : true`, options);
  }

  async location() {
    return this.evaluate("location.href");
  }

  /** The shell rendered (and, with script, the enhancement client really booted). */
  async waitForDocument({ requireClient = true } = {}) {
    await this.waitFor('document.querySelector(".app[data-tab]") !== null || document.querySelector(".login") !== null', { label: "shell rendered" });
    if (this.scripted === false || !requireClient) return;
    // admin-client.js marks its own boot with `history.replaceState({adminClient: "root"}, …)`.
    await this.waitFor('history.state && history.state.adminClient === "root"', { label: "admin client booted (D0 feature registry: see CHECKPOINT prerequisites)" });
  }

  /** Mark the current document so a later check can tell a navigation from an in-place change. */
  async markDocument() {
    await this.evaluate("window.__overlaysProbe = 1");
  }

  async documentAlive() {
    return (await this.evaluate("window.__overlaysProbe === 1")) === true;
  }

  async clickPoint({ x, y }) {
    const base = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 };
    await this.connection.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await this.connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  }

  /** A trusted click on the centre of a rendered element (nothing hidden/no `element.click()`). */
  async click(selector, { index = 0 } = {}) {
    const point = await this.evaluate(`(() => {
      const node = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!node) return null;
      node.scrollIntoView({ block: "center" });
      const rect = node.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height };
    })()`);
    assert.ok(point, `no element for ${selector}[${index}]`);
    assert.ok(point.width > 0 && point.height > 0, `${selector}[${index}] has no box to click`);
    await this.clickPoint(point);
    return point;
  }

  /** A trusted click on the first *rendered* match (table rows and mobile cards both carry a menu). */
  async clickFirstVisible(selector) {
    const index = await this.evaluate(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      return nodes.findIndex((node) => node.getClientRects().length > 0);
    })()`);
    assert.ok(index >= 0, `no rendered element for ${selector}`);
    await this.click(selector, { index });
  }

  async press(name) {
    const key = KEYMAP[name];
    assert.ok(key, `unmapped key ${name}`);
    const base = { key: name, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode };
    if (key.text) {
      // A real key press, not a raw one: Chromium runs implicit form submission for `keyDown` with
      // text (rawKeyDown alone does not), and that is exactly the path the confirm modal relies on.
      //
      // The trailing `char` event is deliberately NOT sent. With `keyDown` already carrying text,
      // Chromium treats `char` as a *second* Enter and submits the form twice; the second response
      // is the server's refusal (the first POST already deleted the row), it becomes the document,
      // and the "Enter submits the real form" check fails ~1 run in 6 with the page left on
      // `/oauth/user/delete`. Measured: two identical POST bodies before, exactly one after. A
      // physical Enter is keydown + keypress — never a text-bearing keydown followed by `char`.
      await this.connection.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: key.text, unmodifiedText: key.text });
    } else {
      await this.connection.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    }
    await this.connection.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async type(text) {
    await this.connection.send("Input.insertText", { text });
  }

  async setViewport({ width, height }) {
    await this.connection.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 720 });
  }

  /** Every check ends here: a script that logs an error or trips the CSP is not a passing overlay. */
  async assertQuiet() {
    assert.deepEqual(this.exceptions, [], "the page must not throw");
    assert.deepEqual(this.consoleErrors, [], "the page must not log errors");
    const violations = this.logs.filter((entry) => /Content Security Policy|Refused to/i.test(entry.text ?? ""));
    assert.deepEqual(violations.map((entry) => entry.text), [], "no CSP violation may be logged");
  }

  async close() {
    this.connection.close();
    await fetch(`${this.endpoint}/json/close/${this.targetId}`).catch(() => {});
  }
}

/** Minimal CDP client: one WebSocket, promise-per-message, event fan-out. */
class Connection {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.endpoint = `http://${new URL(webSocketUrl).host}`;
    this.pending = new Map();
    this.listeners = new Map();
    this.nextId = 0;
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", (event) => reject(new Error(`CDP connect failed: ${event?.message ?? "socket error"}`)), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result ?? {});
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }

  send(method, params = {}) {
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

/* ------------------------------------------------------------------ fixture + login */

const state = { fixture: null, root: null, child: null, endpoint: null, profile: null, serverErrors: [] };

async function ensureServer() {
  if (state.fixture) return state.fixture;
  const { startAdminLayoutFixture } = await import(pathToFileURL(path.join(appRoot, "scripts", "web-regression", "admin-layout-fixture.mjs")).href);
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), "admin-overlays-"));
  state.fixture = await startAdminLayoutFixture({ root: state.root, appRoot, serverErrors: state.serverErrors });
  await waitForHttp(`${state.fixture.base}/healthz`, 30000);
  return state.fixture;
}

// `--no-sandbox` is what makes this launch work on the CI runner (issue #602). That image
// (`mcr.microsoft.com/playwright:v1.63.0-noble`) runs as root, and Chromium aborts instantly there
// without the flag — `ERROR:zygote_host_impl_linux.cc:102 Running as root without --no-sandbox is
// not supported. See https://crbug.com/638180` — so the endpoint never opened and all ten overlay
// checks died with "Chromium did not expose a CDP endpoint" after 20 s of retries each. The flag
// mirrors the default the repository's Playwright-driven harnesses already run with
// (`chromiumSandbox: false`, i.e. Playwright passes `--no-sandbox` itself), and this browser only
// ever opens the loopback fixture server started by this file. Measured in that exact image: without
// the flag the child is dead at 5 s with the line above; with it `/json/version` answers in 750 ms.
const SANDBOX_ARGS = ["--no-sandbox"];

async function ensureBrowser() {
  if (state.endpoint) return state.endpoint;
  const port = await freePort();
  state.profile = await fs.mkdtemp(path.join(os.tmpdir(), "admin-overlays-chrome-"));
  state.child = spawn(browserResolution.executablePath, [
    ...SANDBOX_ARGS,
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${state.profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  // Keep the browser's own stderr instead of discarding it: a launch failure must name its cause,
  // not just report "did not expose a CDP endpoint" after twenty seconds of retrying.
  let browserStderr = "";
  state.child.stderr.on("data", (chunk) => { browserStderr += String(chunk); });
  state.child.stdout.resume();
  const endpoint = `http://127.0.0.1:${port}`;
  for (let index = 0; index < 200; index += 1) {
    try {
      await (await fetch(`${endpoint}/json/version`)).json();
      state.endpoint = endpoint;
      return endpoint;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(
    `Chromium did not expose a CDP endpoint (${browserResolution.executablePath}); `
    + `exit=${state.child.exitCode ?? "still running"}; stderr: ${browserStderr.slice(-2000).trim() || "(empty)"}`,
  );
}

/** A logged-in Admin page of the requested scripting flavour (all tabs share the browser profile). */
async function openPage({ scripted = true, requireClient = true } = {}) {
  const fixture = await ensureServer();
  const endpoint = await ensureBrowser();
  const page = await Page.open({ endpoint, scripted });
  await page.goto(`${fixture.base}/admin/auth/login`);
  // A tab opened after the first login is already authenticated: the login page redirects away.
  if ((await page.location()).endsWith("/login")) {
    await page.click("#pw");
    await page.type(fixture.password);
    await page.press("Enter");
    await page.waitFor(`location.pathname.startsWith("/admin/auth") && !location.pathname.endsWith("/login")`, { timeoutMs: 10000, label: "admin login" });
  }
  await page.waitForDocument({ requireClient });
  return page;
}

/** Wait until the enhancement client has really booted (see `Page.waitForDocument`). */

const openAdmin = async (tab, { scripted = true, requireClient = true } = {}) => {
  const fixture = await ensureServer();
  const page = await openPage({ scripted, requireClient });
  await page.goto(`${fixture.base}/admin/auth?tab=${tab}`);
  await page.waitForDocument({ requireClient });
  return page;
};

after(async () => {
  if (state.fixture) {
    const evidence = await state.fixture.stop();
    console.log(`[overlays] fixture shutdown: ${JSON.stringify(evidence)}`);
  } else if (state.root) {
    await fs.rm(state.root, { recursive: true, force: true }).catch(() => {});
  }
  state.child?.kill();
  if (state.profile) await fs.rm(state.profile, { recursive: true, force: true }).catch(() => {});
});

/* ------------------------------------------------------------------ checks */

// The CSP contract of the served module itself: no inline markup authoring, no eval, no third-party
// origin. Static, so it holds even on a machine without a browser.
test("the served enhancement module stays inside the CSP contract", async () => {
  const fixture = await ensureServer();
  const response = await fetch(`${fixture.base}/admin/auth/assets/admin-feature-overlays.js`);
  assert.equal(response.status, 200, "the whitelisted module must be served");
  const source = await response.text();
  const forbidden = [
    [/\.innerHTML\s*=/, "a .innerHTML assignment"],
    [/\.outerHTML\s*=/, "a .outerHTML assignment"],
    [/insertAdjacentHTML\s*\(/, "insertAdjacentHTML()"],
    [/\beval\s*\(/, "eval()"],
    [/new Function\s*\(/, "new Function()"],
    [/document\.write\s*\(/, "document.write()"],
    [/setAttribute\(\s*["']on/, "an inline event handler attribute"],
    [/https?:\/\//, "an absolute origin"],
  ];
  for (const [pattern, label] of forbidden) {
    assert.equal(pattern.test(source), false, `the served module must not use ${label}`);
  }
  assert.match(source, /fetchFragment/, "overlay content must come from the server's own render");
  assert.match(source, /ctx\.openOverlay/, "overlays must join the shell's Esc/popstate stack");
});

// Two facts this lane does not own but cannot work without. Checked first, so a broken foundation
// fails here with the exact diagnosis instead of failing nine behaviour checks with timeouts.
test("prerequisite: the D0 client boots, and connect-src allows the same-origin fragment fetch", { skip: skipReason }, async () => {
  const page = await openAdmin("accounts", { requireClient: false });
  try {
    // (1) app/src/admin/assets/admin-client.js — feature modules are evaluated before the importing
    // module's body, so the registry must exist before its `const` runs; otherwise the whole module
    // graph aborts with "Cannot access 'features' before initialization" and `boot()` never runs.
    assert.equal(await page.evaluate("history.state?.adminClient ?? null"), "root", "the enhancement client must boot");
    // (2) app/src/admin/router.js — without `connect-src 'self'` the CSP falls back to
    // `default-src 'none'`, every fragment fetch is refused, and no overlay can ever engage.
    const fetched = await page.evaluate('fetch(location.pathname + "?tab=accounts", { credentials: "same-origin" }).then((response) => `HTTP ${response.status}`).catch((error) => `REFUSED: ${error.message}`)');
    assert.equal(fetched, "HTTP 200", `connect-src must allow a same-origin fetch (got ${fetched})`);
    const hasDrawer = await page.evaluate(`(async () => {
      const response = await fetch(document.querySelector("a.cell-link").href, { credentials: "same-origin" });
      const document2 = new DOMParser().parseFromString(await response.text(), "text/html");
      return !!document2.querySelector(".drawer");
    })()`);
    assert.equal(hasDrawer, true, "the fetched document carries the server-rendered .drawer");
    await page.assertQuiet();
  } finally {
    await page.close();
  }
});

test("drawer: a row link shows the server's drawer in place and pushes the drawer URL", { skip: skipReason }, async () => {
  const page = await openAdmin("accounts");
  try {
    const href = await page.evaluate('document.querySelector("a.cell-link").href');
    assert.match(href, /id=/, "the row link must be the `?id=` detail entry");
    const listRows = await page.evaluate('document.querySelectorAll(".tbl tbody tr").length');
    assert.ok(listRows > 0, "the fixture must have at least one account row");
    await page.markDocument();
    await page.click("a.cell-link");
    await page.waitFor('document.querySelector(".drawer.on") !== null', { label: "drawer mounted" });
    assert.equal(await page.documentAlive(), true, "showing the drawer must not load a document");
    assert.equal(await page.location(), href, "the drawer URL is pushed, exactly as the link points");
    assert.equal(await page.evaluate('document.querySelector(".scrim.on") !== null'), true, "the drawer carries its scrim");
    const geometry = await page.evaluate(`(() => {
      const drawer = document.querySelector(".drawer.on");
      const style = getComputedStyle(drawer);
      const rect = drawer.getBoundingClientRect();
      return { position: style.position, visibility: style.visibility, right: rect.right, width: rect.width, viewport: innerWidth };
    })()`);
    assert.equal(geometry.position, "fixed");
    assert.equal(geometry.visibility, "visible");
    assert.ok(Math.abs(geometry.right - geometry.viewport) < 2, `the drawer sits at the right edge (${JSON.stringify(geometry)})`);
    assert.ok(geometry.width > 100, "the drawer has a real width");
    assert.equal(await page.evaluate('document.querySelectorAll(".tbl tbody tr").length'), listRows, "the list stays rendered behind the drawer");
    // Narrow viewport: the prototype turns the drawer into a bottom sheet (stylesheet), and the
    // overlay must stay a floating panel rather than becoming a page.
    await page.setViewport({ width: 390, height: 844 });
    const narrow = await page.evaluate(`(() => { const rect = document.querySelector(".drawer.on").getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, width: rect.width, viewportWidth: innerWidth, viewportHeight: innerHeight }; })()`);
    assert.equal(await page.documentAlive(), true, "a resized drawer is still an overlay");
    assert.ok(Math.abs(narrow.bottom - narrow.viewportHeight) < 2, `bottom sheet stays pinned to the bottom (${JSON.stringify(narrow)})`);
    assert.ok(Math.abs(narrow.width - narrow.viewportWidth) < 2, `bottom sheet spans the width (${JSON.stringify(narrow)})`);
    await page.setViewport(VIEWPORT);
    await page.assertQuiet();
  } finally {
    await page.close();
  }
});

test("drawer: browser Back closes it without reloading the list", { skip: skipReason }, async () => {
  const page = await openAdmin("accounts");
  try {
    await page.markDocument();
    await page.click("a.cell-link");
    await page.waitFor('document.querySelector(".drawer.on") !== null', { label: "drawer mounted" });
    await page.evaluate("history.back()");
    await page.waitForGone('document.querySelector(".drawer")', { label: "drawer closed by Back" });
    assert.equal(await page.documentAlive(), true, "Back must close the drawer, not reload the page");
    assert.equal((await page.location()).includes("id="), false, "Back restores the list URL");
    assert.equal(await page.evaluate('document.body.classList.contains("overlay-open")'), false, "the scroll lock is released");
    assert.equal(await page.evaluate('document.querySelector(".scrim") === null'), true, "the scrim goes with the drawer");
    await page.assertQuiet();
  } finally {
    await page.close();
  }
});

test("drawer: Esc and ✕ close it and hand focus back to the row link", { skip: skipReason }, async () => {
  const page = await openAdmin("accounts");
  try {
    await page.markDocument();
    const anchor = await page.evaluate(`(() => {
      const link = document.querySelector("a.cell-link");
      link.dataset.probe = "1";
      return link.href;
    })()`);
    await page.click("a.cell-link");
    await page.waitFor('document.querySelector(".drawer.on") !== null', { label: "drawer mounted" });
    assert.equal(await page.evaluate('document.activeElement.closest(".drawer") !== null'), true, "focus moves into the drawer");
    await page.press("Escape");
    await page.waitForGone('document.querySelector(".drawer")', { label: "drawer closed by Esc" });
    assert.equal(await page.documentAlive(), true);
    assert.equal((await page.location()).includes("id="), false);
    assert.equal(await page.evaluate('document.activeElement.closest("a.cell-link") !== null'), true, "focus returns to the row link");

    await page.click('[data-probe="1"]');
    await page.waitFor('document.querySelector(".drawer.on") !== null', { label: "drawer re-mounted" });
    await page.click('.drawer header a.ibtn[aria-label="关闭"]');
    await page.waitForGone('document.querySelector(".drawer")', { label: "drawer closed by ✕" });
    assert.equal(await page.documentAlive(), true, "✕ closes in place instead of loading the list URL");
    assert.equal(await page.location(), anchor.replace(/[?&]id=[^&]*/, "").replace(/\?$/, ""), "✕ restores the list URL");
    await page.assertQuiet();
  } finally {
    await page.close();
  }
});

test("menu: the row menu floats next to its button, inside the viewport, and Esc/outside close it", { skip: skipReason }, async () => {
  const page = await openAdmin("accounts");
  try {
    await page.markDocument();
    const anchor = await page.evaluate(`(() => { const r = document.querySelector("details.mn > summary").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.top, bottom: r.bottom, right: r.right }; })()`);
    await page.click("details.mn > summary");
    await page.waitFor('document.querySelector("details.mn").open === true', { label: "menu open" });
    const box = await page.evaluate(`(() => {
      const menu = document.querySelector("details.mn > .menu");
      const style = getComputedStyle(menu);
      const rect = menu.getBoundingClientRect();
      return { position: style.position, display: style.display, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, minWidth: style.minWidth, viewport: innerWidth, height: innerHeight, on: menu.classList.contains("on") };
    })()`);
    assert.equal(box.position, "fixed", "the menu floats like the prototype's, not inside the cell");
    assert.notEqual(box.display, "none");
    assert.equal(box.on, true, "the prototype's visible state class");
    assert.ok(box.left >= 7, `clamped to the left edge (left=${box.left})`);
    assert.ok(box.right <= box.viewport - 7, `clamped to the right edge (right=${box.right}, viewport=${box.viewport})`);
    assert.ok(parseFloat(box.minWidth) >= 220, "prototype `mw = 220`");
    assert.ok(Math.abs(box.right - anchor.right) < 2, "right-aligned to its button, as openMenu does");
    assert.ok(box.top >= anchor.bottom - 1 && box.top <= anchor.bottom + 6, `opens just below the button (menu.top=${box.top}, button.bottom=${anchor.bottom})`);
    assert.equal(await page.documentAlive(), true);

    // Narrow viewport: the floating menu must still be clamped inside the window (openMenu's own
    // arithmetic is what keeps it off-screen otherwise). The mobile card list owns the visible row
    // menu at this width, so the click targets the first rendered one.
    await page.setViewport({ width: 390, height: 844 });
    await page.press("Escape");
    await page.waitFor('document.querySelectorAll("details.mn[open]").length === 0', { label: "Esc closes the menu" });
    await page.clickFirstVisible("details.mn > summary");
    await page.waitFor('document.querySelector("details.mn[open] > .menu.on") !== null', { label: "menu open on a narrow viewport" });
    const narrowBox = await page.evaluate(`(() => { const rect = document.querySelector("details.mn[open] > .menu.on").getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewport: innerWidth, height: innerHeight }; })()`);
    assert.ok(narrowBox.left >= 7 && narrowBox.right <= narrowBox.viewport - 7, `clamped horizontally on a narrow viewport (${JSON.stringify(narrowBox)})`);
    assert.ok(narrowBox.top >= 0 && narrowBox.bottom <= narrowBox.height + 1, `clamped vertically on a narrow viewport (${JSON.stringify(narrowBox)})`);
    await page.setViewport(VIEWPORT);

    await page.press("Escape");
    await page.waitFor('document.querySelectorAll("details.mn[open]").length === 0', { label: "Esc closes the menu" });

    await page.click("details.mn > summary");
    await page.waitFor('document.querySelector("details.mn").open === true', { label: "menu re-opened" });
    await page.click(".side .brand");
    await page.waitFor('document.querySelector("details.mn").open === false', { label: "outside click closes the menu" });
    await page.assertQuiet();
  } finally {
    await page.close();
  }
});

test("menu: j/k move the .kb highlight and Enter triggers the highlighted item", { skip: skipReason }, async () => {
  const page = await openAdmin("accounts");
  try {
    await page.markDocument();
    await page.click("details.mn > summary");
    await page.waitFor('document.querySelector("details.mn").open === true', { label: "menu open" });
    await page.press("j");
    const first = await page.waitFor('document.querySelector(".menu .kb") ? document.querySelector(".menu .kb").textContent.trim() : ""', { label: "first item highlighted" });
    assert.match(first, /查看与编辑/);
    await page.press("j");
    const second = await page.waitFor(`(() => { const node = document.querySelector(".menu .kb"); return node && node.textContent.trim() !== ${JSON.stringify(first)} ? node.textContent.trim() : ""; })()`, { label: "second item highlighted" });
    assert.match(second, /重置密码/);
    await page.press("k");
    const back = await page.waitFor(`(() => { const node = document.querySelector(".menu .kb"); return node && node.textContent.trim() === ${JSON.stringify(first)} ? node.textContent.trim() : ""; })()`, { label: "k moves back up" });
    assert.match(back, /查看与编辑/);
    assert.equal(await page.evaluate('document.querySelectorAll(".menu .kb").length'), 1, "exactly one item is highlighted");

    await page.press("Enter");
    await page.waitFor('document.querySelector(".drawer.on") !== null', { label: "Enter opened the drawer" });
    assert.equal(await page.documentAlive(), true);
    assert.equal((await page.location()).includes("id="), true, "the menu item acted through the normal path");
    assert.equal(await page.evaluate('document.querySelector("details.mn").open === false'), true, "opening an overlay closes the menu (mutual exclusion)");
    assert.equal(await page.evaluate('document.querySelectorAll(".menu.on").length'), 0, "no menu stays visible behind the drawer");
    assert.equal(await page.evaluate('document.querySelectorAll(".drawer.on, .modal.on, .menu.on").length'), 1, "exactly one overlay is visible");
    await page.assertQuiet();
  } finally {
    await page.close();
  }
});

test("modal: ?confirm= is centred, focuses the typed input, and Esc cancels back to the list", { skip: skipReason }, async () => {
  const page = await openAdmin("accounts");
  try {
    await page.markDocument();
    await page.click("details.mn > summary");
    await page.waitFor('document.querySelector("details.mn").open === true', { label: "menu open" });
    await page.click('.menu a[href*="confirm=delete"]');
    await page.waitFor('document.querySelector(".modal.on") !== null', { label: "modal mounted" });
    assert.equal(await page.documentAlive(), true, "the confirm is an overlay, not a page load");
    const geometry = await page.evaluate(`(() => {
      const modal = document.querySelector(".modal.on");
      const rect = modal.getBoundingClientRect();
      return { position: getComputedStyle(modal).position, centre: rect.left + rect.width / 2, viewport: innerWidth, display: getComputedStyle(modal).opacity };
    })()`);
    assert.equal(geometry.position, "fixed");
    assert.ok(Math.abs(geometry.centre - geometry.viewport / 2) < 2, `centred (${JSON.stringify(geometry)})`);
    assert.equal(geometry.display, "1", "the modal is visible");
    assert.equal(await page.evaluate('document.querySelector(".modal.on .scrim") === null && document.querySelector(".scrim.on") !== null'), true, "the modal carries a scrim");
    assert.equal(await page.evaluate('document.activeElement === document.querySelector(".modal input[name=confirm], .modal [data-typeconf]")'), true, "type-to-confirm input is focused");
    assert.equal(await page.evaluate('document.body.classList.contains("overlay-open")'), true, "no scroll-through while the modal is up");

    // Prototype `confirmBox`'s typed gate (`6-app.js:101` renders the button `disabled`, `6-app.js:437`
    // re-enables it on the input event). The SSR form ships the button *enabled* on purpose — the
    // scriptless browser has to be able to submit, and the server compares `confirm` itself — so the
    // enhancement is what has to bring the gate back, and only the page's own target string counts.
    const typed = (await page.evaluate('document.querySelector(".modal .tc code")?.textContent ?? ""')).trim();
    assert.ok(typed.length > 0, "the page must name the string to type");
    assert.equal(await page.evaluate('document.querySelector(".modal button[type=submit]").disabled'), true, "the confirm button starts disabled (empty input)");
    await page.type(typed.slice(0, 1));
    assert.equal(await page.evaluate('document.querySelector(".modal button[type=submit]").disabled'), true, "a partial text keeps the confirm button disabled");
    await page.type(typed.slice(1));
    assert.equal(await page.evaluate('document.querySelector(".modal input[name=confirm]").value'), typed, "the typed text reaches the server-side input");
    assert.equal(await page.evaluate('document.querySelector(".modal button[type=submit]").disabled'), false, "the exact text re-enables the confirm button");
    await page.type("x");
    assert.equal(await page.evaluate('document.querySelector(".modal button[type=submit]").disabled'), true, "a text that no longer matches disables it again");

    await page.press("Escape");
    await page.waitForGone('document.querySelector(".modal")', { label: "Esc closes the modal" });
    assert.equal(await page.documentAlive(), true, "Esc must not reload");
    assert.equal((await page.location()).includes("confirm="), false, "the URL returns to the list state");
    assert.equal(await page.evaluate('document.activeElement.closest("details.mn") !== null'), true, "focus returns to the row's menu button");
    assert.equal(await page.evaluate('document.body.classList.contains("overlay-open")'), false);

    // The plain confirm (`?confirm=disable`, no type-to-confirm field) is the same primitive: the
    // focus falls back to the dialog's own control instead of the typed input.
    await page.click("details.mn > summary");
    await page.waitFor('document.querySelector("details.mn").open === true', { label: "menu open again" });
    await page.click('.menu a[href*="confirm=disable"]');
    await page.waitFor('document.querySelector(".modal.on") !== null', { label: "plain confirm mounted" });
    assert.equal(await page.evaluate('document.querySelector(".modal input[name=confirm]") === null'), true, "this shape has no typed input");
    assert.equal(await page.evaluate('document.activeElement.closest(".modal .acts") !== null'), true, "focus falls back to the dialog control");
    await page.press("Escape");
    await page.waitForGone('document.querySelector(".modal")', { label: "Esc closes the plain confirm" });
    assert.equal(await page.documentAlive(), true);
    await page.assertQuiet();
  } finally {
    await page.close();
  }
});

test("negative control: a failing fragment fetch falls back to real navigation and the page stays usable", { skip: skipReason }, async () => {
  const page = await openAdmin("accounts");
  try {
    // Sabotage the same-origin fragment fetch: every overlay must now degrade to the SSR path.
    await page.evaluate(`window.fetch = () => Promise.resolve(new Response("not found", { status: 404 }));`);
    const href = await page.evaluate('document.querySelector("a.cell-link").href');
    await page.markDocument();
    await page.click("a.cell-link");
    await page.waitFor(`location.href === ${JSON.stringify(href)}`, { timeoutMs: 10000, label: "fallback navigation" });
    await page.waitForDocument();
    assert.equal(await page.documentAlive(), false, "the fallback is a real navigation");
    assert.equal(await page.evaluate('document.querySelector(".drawer.on") !== null'), true, "the server still renders the drawer");
    assert.ok(await page.evaluate('document.querySelectorAll(".tbl tbody tr").length') > 0, "the list underneath is still usable");
    assert.equal(await page.evaluate('document.querySelectorAll(".scrim.on").length'), 1);
  } finally {
    await page.close();
  }
});

test("no script: links, the row menu and the confirm form still complete every path", { skip: skipReason }, async () => {
  const page = await openAdmin("accounts", { scripted: false });
  try {
    const href = await page.evaluate('document.querySelector("a.cell-link").href');
    await page.click("a.cell-link");
    await page.waitFor(`location.href === ${JSON.stringify(href)}`, { timeoutMs: 10000, label: "no-JS drawer navigation" });
    await page.waitFor('document.querySelector(".drawer.on") !== null', { label: "SSR drawer" });
    assert.ok(await page.evaluate('document.querySelectorAll(".tbl tbody tr").length') > 0, "the list is rendered behind the drawer");

    const fixture = await ensureServer();
    await page.goto(`${fixture.base}/admin/auth?tab=accounts`);
    await page.click("details.mn > summary");
    await page.waitFor('document.querySelector("details.mn").open === true', { label: "native details menu" });
    const box = await page.evaluate(`(() => { const menu = document.querySelector("details.mn > .menu"); return { display: getComputedStyle(menu).display, links: menu.querySelectorAll("a").length, forms: menu.querySelectorAll("form").length }; })()`);
    assert.notEqual(box.display, "none", "the native menu is visible without script");
    assert.ok(box.links + box.forms > 0, "the native menu carries the real actions");
    await page.click('.menu a[href*="confirm=delete"]');
    await page.waitFor('document.querySelector(".modal.show") !== null', { timeoutMs: 10000, label: "SSR confirm page" });
    assert.equal(await page.evaluate('document.querySelector(".modal input[name=confirm]") !== null'), true, "the typed-confirm field is there without script");
    assert.equal(await page.evaluate('document.querySelector(".modal button[type=submit]").disabled'), false, "without script the confirm button must stay enabled (the server compares `confirm`)");
    assert.equal(await page.evaluate('document.querySelector(".modal input[name=confirm]").form === document.querySelector(".modal form")'), true, "the typed field is the POST form's owner even from outside the form element");
    assert.equal(await page.evaluate('document.querySelector(".modal form").method'), "post", "the confirm submits as a real POST");
    assert.equal(await page.evaluate('document.querySelector(".modal .scrim") === null && document.querySelector(".scrim") !== null'), true);
  } finally {
    await page.close();
  }
});


test("modal: Enter submits the real form, and the result line becomes a 3.2s toast", { skip: skipReason }, async () => {
  const page = await openAdmin("accounts");
  try {
    await page.click("details.mn > summary");
    await page.waitFor('document.querySelector("details.mn").open === true', { label: "menu open" });
    await page.click('.menu a[href*="confirm=delete"]');
    await page.waitFor('document.querySelector(".modal.on") !== null', { label: "modal mounted" });
    const typed = (await page.evaluate('document.querySelector(".modal .tc code")?.textContent ?? ""')).trim();
    assert.ok(typed.length > 0, "the page must name the string to type");
    await page.type(typed);
    assert.equal(await page.evaluate('document.querySelector(".modal input[name=confirm]").value'), typed, "the typed confirmation must reach the server-side input");
    await page.press("Enter");
    // A real POST + 303: the document is replaced, so the marker is gone and the flash comes back as SSR.
    await page.waitFor(`location.search.includes("tab=accounts") && !location.search.includes("confirm=")`, { timeoutMs: 10000, label: "delete redirect" });
    await page.waitForDocument();
    assert.equal(await page.documentAlive(), false, "the submit is a real navigation, not a simulated write");
    assert.equal(await page.evaluate('document.querySelectorAll(".tbl tbody tr").length'), 0, "the account is really gone");
    const toast = await page.waitFor(`(() => { const node = document.querySelector("#toast.on"); return node ? node.textContent.trim() : ""; })()`, { label: "toast shown" });
    assert.match(toast, /账户已删除/);
    assert.equal(await page.evaluate('document.querySelector(".result").getClientRects().length'), 0, "the SSR banner gives way to the toast");
    const started = Date.now();
    await page.waitForGone('document.querySelector("#toast.on")', { timeoutMs: 6000, label: "toast faded" });
    const elapsed = Date.now() - started;
    assert.ok(elapsed > 2000 && elapsed < 4200, `the toast holds the prototype's 3.2s (faded after ~${elapsed}ms of observation)`);
    assert.equal(await page.evaluate('document.querySelector("#toast") !== null'), true, "the toast fades, it is not torn out");
    await page.assertQuiet();
  } finally {
    await page.close();
  }
});
