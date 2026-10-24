// Lane L2 harness — instant theme switching and the prototype's keyboard shortcuts
// (`app/src/admin/assets/admin-feature-keys.js`).
//
// Part 1 (node only, always runs) pins the contract the browser checks stand on:
//   * the shortcut panel's 通用 group and the nav hotkey list come from the prototype's own source
//     (`docs/admin-ui-proto/src/6-app.js:14-20,107-113`), not from a paraphrase;
//   * the SSR markup still carries the no-JS fallbacks this module intercepts;
//   * the module obeys the CSP/SSR rules (no `innerHTML`, no `eval`, no third-party origin).
//
// Part 2 (real server + real Chromium) drives the behaviour and, for every behaviour, a negative
// control: the *real* module source is served with one documented, exact edit that breaks that
// behaviour, and the check must go red. A mutation whose anchor text is missing fails the control
// instead of silently passing.
//
// Run it (the shared Playwright runtime lives outside the worktrees):
//   PLAYWRIGHT_MODULE="D:/Coding/Codex/obsidian server projects/shared/playwright-runtime/node_modules/playwright/index.mjs" \
//     node --test test/admin-redo/client-keys.test.js
// Without a resolvable Playwright runtime/Chromium the browser part skips with the reason, so
// `npm test` stays honest on a machine that has no browser (see CHECKPOINT.md for the recorded run).
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NAV, renderSidebar } from "../../src/admin/layout.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(appRoot, "..");
const modulePath = path.join(appRoot, "src", "admin", "assets", "admin-feature-keys.js");
const clientPath = path.join(appRoot, "src", "admin", "assets", "admin-client.js");
const routerPath = path.join(appRoot, "src", "admin", "router.js");
const protoPath = path.join(repoRoot, "docs", "admin-ui-proto", "src", "6-app.js");

// Read as LF: a Windows checkout may hand back CRLF, and every anchor in this file is written
// against the source text (the negative controls must fail loudly, not silently, if one drifts).
const moduleSource = fs.readFileSync(modulePath, "utf8").replaceAll("\r\n", "\n");
const protoSource = fs.readFileSync(protoPath, "utf8").replaceAll("\r\n", "\n");

/* ------------------------------------------------------------------ part 1: contract pins */

/** The prototype `NAV` entries (`6-app.js:14-20`): `[id, label, icon, hotkey]`, in sidebar order. */
function prototypeNav(source) {
  const block = source.slice(source.indexOf("const NAV = ["), source.indexOf("const isMobile"));
  return [...block.matchAll(/\["[a-z-]+", "([^"]+)", "[a-z]+", "([a-z])"\]/g)].map((match) => ({ label: match[1], hotkey: match[2] }));
}

/** The prototype `showKbd()` 通用 rows (`6-app.js:110`): `${row("/", "搜索 / 筛选")}` … */
function prototypeGeneralRows(source) {
  const line = source.split("\n").find((text) => text.includes("<h3>键盘快捷键</h3>"));
  assert.ok(line, "the prototype's showKbd() panel line must exist");
  return [...line.matchAll(/\$\{row\("([^"]*)", "([^"]*)"\)\}/g)].map((match) => [match[1], match[2]]);
}

/** The module's own `GENERAL_ROWS` literal, read back out of the shipped source. */
function moduleGeneralRows(source) {
  const start = source.indexOf("const GENERAL_ROWS");
  const block = source.slice(start, source.indexOf("]);", start));
  return [...block.matchAll(/\["([^"]*)", "([^"]*)"\]/g)].map((match) => [match[1], match[2]]);
}

test("client-keys: the panel's 通用 group is the prototype's own list, in order", () => {
  const expected = prototypeGeneralRows(protoSource);
  assert.deepEqual(expected.map(([combo]) => combo), ["/", "n", "j k", "↵", "Esc", "t", "?", "⌘ ↵"]);
  assert.deepEqual(moduleGeneralRows(moduleSource), expected);
  // Negative control: a changed row must be reported, so the comparison is not vacuous.
  const tampered = protoSource.replace('${row("?", "本面板")}', '${row("?", "快捷键")}');
  assert.notDeepEqual(moduleGeneralRows(moduleSource), prototypeGeneralRows(tampered));
});

test("client-keys: the panel's 导航 group is the prototype NAV, and the sidebar renders it", () => {
  const expected = prototypeNav(protoSource);
  assert.deepEqual(expected.map((entry) => entry.hotkey), ["o", "a", "k", "c", "t", "p", "u", "z", "v"]);
  const rendered = NAV.filter((item) => item.id).map((item) => ({ label: item.label, hotkey: item.hotkey }));
  assert.deepEqual(rendered, expected, "the sidebar NAV and the prototype NAV must agree (the panel is built from the DOM)");
});

test("client-keys: the SSR markup keeps every no-JS fallback this module intercepts", () => {
  const { side } = renderSidebar({
    activeTab: "accounts",
    theme: "dark",
    csrf: "csrf-under-test",
    accessPolicyBase: "/admin/auth/access-policy",
    vaultGitBase: "/admin/auth/vault-git",
  });
  // 1. the theme control is a real POST form carrying the CSRF token and the *next* theme
  assert.match(side, /<form class="inline-form" method="post" action="\/admin\/auth\/theme">/);
  assert.match(side, /name="csrf" value="csrf-under-test"/);
  assert.match(side, /name="theme" value="light"/);
  assert.match(side, /<button class="ibtn" type="submit" title="切换到浅色主题"/);
  // 2. every nav entry stays a real link with its hotkey
  for (const item of NAV.filter((entry) => entry.id)) {
    assert.match(side, new RegExp(`href="[^"]+"[^>]*data-hotkey="${item.hotkey}"`), `nav ${item.id} must stay a link with data-hotkey`);
  }
  // Negative control: the same probe must not match markup whose theme control is not a POST form.
  const tampered = side.replace(/<form class="inline-form" method="post" action="\/admin\/auth\/theme">/, '<form class="inline-form" method="get" action="/admin/auth/theme">');
  assert.doesNotMatch(tampered, /method="post" action="\/admin\/auth\/theme"/);
});

test("client-keys: the module is served by the exact router whitelist and imported by the client", () => {
  // Line-anchored, not "the string appears somewhere": a commented-out entry keeps a plain
  // `source.match(...)` green while the module stops being served. Anchor at the line start so the
  // `//` prefix of a disabled line cannot satisfy it (the negative control below pins that).
  assert.match(fs.readFileSync(routerPath, "utf8"), /^\s*\["admin-feature-keys\.js", "admin-feature-keys\.js"\],?\s*$/m);
  assert.match(fs.readFileSync(clientPath, "utf8"), /^import "\.\/admin-feature-keys\.js";$/m);
});

/** Code only: the file's own comments name the forbidden APIs they forbid. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("client-keys: the module obeys the CSP and SSR rules (no innerHTML, no eval, no third party)", () => {
  const code = stripComments(moduleSource);
  const forbidden = [
    ["innerHTML", /innerHTML/],
    ["outerHTML", /outerHTML/],
    ["insertAdjacentHTML", /insertAdjacentHTML/],
    ["document.write", /document\.write/],
    ["eval", /\beval\s*\(/],
    ["new Function", /new Function/],
    ["inline handler assignment", /\.on[a-z]+\s*=/],
    ["third-party origin", /https?:\/\//],
  ];
  for (const [label, pattern] of forbidden) assert.doesNotMatch(code, pattern, `${label} is not allowed`);
  assert.match(code, /textContent/, "values are written with textContent");
  // Negative control: the probes must be able to see a violation.
  assert.match(stripComments(`${moduleSource}\nnode.innerHTML = value;\n`), forbidden[0][1]);
});

/* ------------------------------------------------------------------ part 2: real browser + real server */

const KBD_PANEL = "#admin-kbd-panel";
const MODULE_URL = "**/admin/auth/assets/admin-feature-keys.js";
const CLIENT_URL = "**/admin/auth/assets/admin-client.js";
const THEME_FORM = 'form[action="/admin/auth/theme"]';

/**
 * Interim shim for the foundation defect F1 (`CHECKPOINT.md`): as shipped, `admin-client.js` keeps its
 * feature registry in a module-local `const` that its own (cyclic) feature modules reach during their
 * evaluation, so every authenticated page dies with "Cannot access 'features' before initialization"
 * and *no* D0 behaviour can work. `ADMIN_KEYS_BASE_SHIM=f1` serves the documented two-line fix so this
 * lane's own behaviour can be measured before the coordinator lands it. Unset by default: the checks
 * then measure the tree exactly as it stands (red until F1).
 */
const BASE_SHIM = {
  f1: [
    ["const features = [];\n\n/** Register a feature: `registerFeature(name, (ctx) => void)`. */\nexport function registerFeature(name, setup) {\n  features.push({ name, setup });\n}",
      "export function registerFeature(name, setup) {\n  (globalThis.__adminFeatureRegistry ||= []).push({ name, setup });\n}"],
    ["for (const feature of features) {", "for (const feature of globalThis.__adminFeatureRegistry || []) {"],
  ],
};

function shimmedClientSource() {
  const edits = BASE_SHIM[String(process.env.ADMIN_KEYS_BASE_SHIM || "")];
  if (!edits) return null;
  let source = fs.readFileSync(clientPath, "utf8").replaceAll("\r\n", "\n");
  for (const [anchor, replacement] of edits) {
    assert.ok(source.includes(anchor), `the F1 shim anchor must exist in admin-client.js: ${JSON.stringify(anchor)}`);
    source = source.replace(anchor, replacement);
  }
  return source;
}

/** Exact, documented edits of the shipped source. Each anchor must exist or the control fails. */
const MUTATIONS = {
  "theme form navigates (no preventDefault)": (source) => replaceOnce(source, "event.preventDefault();\n    toggleTheme();", "void 0;"),
  "t key removed": (source) => replaceOnce(source, 'guarded("t", toggleTheme)', 'guarded("t", () => {})'),
  "? key removed": (source) => replaceOnce(source, 'guarded("?", showPanel)', 'guarded("?", () => {})'),
  "/ key removed": (source) => replaceOnce(source, 'ctx.registerShortcut("/", guarded("/", () => {', 'ctx.registerShortcut("/", guarded("/", () => { return;'),
  "n key removed": (source) => replaceOnce(source, 'guarded("n", () => activate(createEntry()))', 'guarded("n", () => {})'),
  "j key removed": (source) => replaceOnce(source, 'guarded("j", () => moveRow(1))', 'guarded("j", () => {})'),
  "Enter key removed": (source) => replaceOnce(source, 'guarded("Enter", activateRow)', 'guarded("Enter", () => {})'),
  "g sequence removed": (source) => replaceOnce(source, "ctx.registerShortcut(`g ${entry.key}`, () => entry.link.click());", "void 0;"),
  "mod+enter removed": (source) => replaceOnce(source, "if (form) form.requestSubmit();", "void 0;"),
};

function replaceOnce(source, anchor, replacement) {
  assert.ok(source.includes(anchor), `the negative control's anchor must exist in the module: ${JSON.stringify(anchor)}`);
  return source.replace(anchor, replacement);
}

/** Resolve the shared Playwright runtime + the pinned full Chromium build, or explain the skip. */
async function loadHarness() {
  try {
    const binaryModule = await import(pathToFileURL(path.join(appRoot, "scripts", "web-regression", "chromium-binary.mjs")).href);
    const chromium = await binaryModule.loadPlaywrightChromium();
    const binary = binaryModule.exportHarnessChromiumExecutable({ defaultExecutablePath: binaryModule.playwrightRuntimeExecutablePath(chromium) });
    return { chromium, binary, skipped: null };
  } catch (error) {
    return {
      chromium: null,
      binary: null,
      skipped: `no Playwright runtime/Chromium (${String(error?.message || error).split("\n")[0]}); set PLAYWRIGHT_MODULE to the shared runtime to run the browser checks`,
    };
  }
}

/** The theme control's observable state (and the "this document never navigated" marker). */
function themeState(page) {
  return page.evaluate((selector) => {
    const form = document.querySelector(selector);
    const button = form?.querySelector("button");
    return {
      theme: document.documentElement.dataset.theme,
      meta: document.querySelector('meta[name="theme-color"]')?.content ?? null,
      cookie: document.cookie,
      next: form?.querySelector('input[name="theme"]')?.value ?? null,
      icon: button?.querySelector("use")?.getAttribute("href") ?? null,
      title: button?.getAttribute("title") ?? null,
      marker: window.__l2 ?? null,
    };
  }, THEME_FORM);
}

const cursor = (page) => page.evaluate(() => [...document.querySelectorAll(".tbl tbody tr")]
  .map((row, index) => (row.classList.contains("kb") && row.classList.contains("cur") ? index : -1))
  .filter((index) => index >= 0));

/** One behaviour check: `run({ page, requests, navigations, goto })`; it throws when broken. */
function browserChecks() {
  return [
    {
      name: "boot: the module loads, the client boots, no page error and no failed request",
      run: async ({ page, goto, pageErrors }) => {
        const failed = [];
        const onFailed = (request) => failed.push(`${request.method()} ${request.url()}`);
        page.on("requestfailed", onFailed);
        try {
          await goto("/admin/auth?tab=accounts");
        } finally {
          page.off("requestfailed", onFailed);
        }
        assert.deepEqual(failed, []);
        assert.deepEqual(pageErrors, [], `the enhancement client must boot without an error: ${pageErrors.join(" | ")}`);
        assert.match(await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content), /^#/);
      },
    },
    {
      name: "theme: the sidebar button toggles in place (no navigation, no POST) and syncs cookie/meta/control",
      run: async ({ page, goto, requests, navigations }) => {
        await goto("/admin/auth?tab=accounts");
        const before = await themeState(page);
        const posts = requests.length;
        const navs = navigations();
        await page.click(`${THEME_FORM} button[type="submit"]`);
        await page.waitForFunction((previous) => document.documentElement.dataset.theme !== previous, before.theme);
        const after = await themeState(page);
        assert.equal(after.theme, before.theme === "dark" ? "light" : "dark");
        assert.equal(after.meta, after.theme === "light" ? "#ffffff" : "#101318", "meta[theme-color] must follow the theme");
        assert.match(after.cookie, new RegExp(`(^|; )omcp-admin\\.theme=${after.theme}`), "the server's own cookie must agree on the next render");
        assert.equal(after.marker, "alive", "the page must not have navigated");
        assert.equal(navigations(), navs, "the theme toggle must not navigate");
        assert.equal(requests.length, posts, "the theme toggle must not POST the form");
        assert.equal(after.next, after.theme === "dark" ? "light" : "dark", "the form's next-theme field must follow");
        assert.equal(after.icon, after.theme === "dark" ? "#i-sun" : "#i-moon", "the button must describe the next action");
        assert.equal(after.title, after.theme === "dark" ? "切换到浅色主题" : "切换到深色主题");
      },
    },
    {
      name: "theme: the `t` key does the same in place",
      run: async ({ page, goto, requests, navigations }) => {
        await goto("/admin/auth?tab=accounts");
        const before = await themeState(page);
        const posts = requests.length;
        const navs = navigations();
        await page.keyboard.press("t");
        await page.waitForFunction((previous) => document.documentElement.dataset.theme !== previous, before.theme);
        const after = await themeState(page);
        assert.equal(after.theme, before.theme === "dark" ? "light" : "dark");
        assert.equal(after.marker, "alive", "`t` must not navigate");
        assert.equal(navigations(), navs);
        assert.equal(requests.length, posts);
        assert.match(after.cookie, new RegExp(`(^|; )omcp-admin\\.theme=${after.theme}`));
        assert.equal(after.meta, after.theme === "light" ? "#ffffff" : "#101318");
      },
    },
    {
      name: "panel: `?` opens the prototype's .modal.kbdp, Esc closes it and focus returns",
      run: async ({ page, goto }) => {
        await goto("/admin/auth?tab=accounts");
        await page.focus('a[data-hotkey="a"]');
        await page.keyboard.press("?");
        await page.waitForSelector(`${KBD_PANEL}.on`);
        const panel = await page.evaluate((selector) => {
          const node = document.querySelector(selector);
          const rows = [...node.querySelectorAll(".row")].map((row) => ({
            label: row.firstElementChild.textContent,
            keys: [...row.lastElementChild.querySelectorAll("kbd")].map((kbd) => kbd.textContent),
          }));
          return {
            classes: node.className,
            role: node.getAttribute("role"),
            groups: [...node.querySelectorAll("h4")].map((heading) => heading.textContent),
            rows,
            focused: document.activeElement === node,
            scrim: Boolean(document.querySelector(".scrim.on")),
          };
        }, KBD_PANEL);
        assert.equal(panel.classes, "modal kbdp on", "the panel must carry the prototype's `.modal.kbdp` classes");
        assert.equal(panel.role, "dialog");
        assert.equal(panel.scrim, true, "the panel owns a scrim");
        assert.deepEqual(panel.groups, ["导航", "通用"]);
        assert.equal(panel.focused, true, "focus moves into the panel");
        const nav = NAV.filter((item) => item.id);
        assert.deepEqual(panel.rows.slice(0, nav.length), nav.map((item) => ({ label: item.label, keys: ["g", item.hotkey] })));
        assert.deepEqual(panel.rows.slice(nav.length, nav.length + 3), [
          { label: "搜索 / 筛选", keys: ["/"] },
          { label: "新建（当前页）", keys: ["n"] },
          { label: "表格上下移动", keys: ["j", "k"] },
        ]);
        assert.equal(panel.rows.length, nav.length + 8);
        // Esc goes through the shared overlay stack (`ctx.topOverlay()`), so the panel closes first.
        await page.keyboard.press("Escape");
        await page.waitForFunction((selector) => !document.querySelector(selector).classList.contains("on"), KBD_PANEL);
        assert.equal(await page.evaluate(() => document.activeElement?.dataset?.hotkey), "a", "focus returns to the trigger");
        // …and the scrim closes it too (prototype `#mscrim` click).
        await page.keyboard.press("?");
        await page.waitForSelector(`${KBD_PANEL}.on`);
        // Click the scrim away from the panel (the panel's own centre covers the scrim's centre).
        await page.mouse.click(20, 20);
        await page.waitForFunction((selector) => !document.querySelector(selector).classList.contains("on"), KBD_PANEL);
      },
    },
    {
      name: "search: `/` focuses and selects the current page's search box",
      run: async ({ page, goto }) => {
        await goto("/admin/auth?tab=accounts&q=layout");
        await page.evaluate(() => document.activeElement?.blur?.());
        await page.keyboard.press("/");
        const state = await page.evaluate(() => {
          const field = document.querySelector('input[name="q"]');
          return { focused: document.activeElement === field, start: field.selectionStart, end: field.selectionEnd, value: field.value };
        });
        assert.equal(state.focused, true);
        assert.equal(state.value, "layout");
        assert.deepEqual([state.start, state.end], [0, 6], "the prototype selects the value (`s.focus(); s.select()`)");
      },
    },
    {
      name: "create: `n` opens the current page's create entry (the SSR GET form)",
      run: async ({ page, goto }) => {
        await goto("/admin/auth?tab=accounts");
        await page.keyboard.press("n");
        await page.waitForURL(/id=new/);
        assert.match(page.url(), /tab=accounts&id=new/);
        await page.waitForSelector("#drawer.on");
        assert.match(await page.textContent("#drawer.on h1"), /新建 OAuth 账户/);
      },
    },
    {
      name: "nav: `g a` / `g t` / `g k` follow the sidebar links (the `t`/`k` collisions included)",
      run: async ({ page, goto }) => {
        await goto("/admin/auth?tab=overview");
        await page.keyboard.press("g");
        await page.keyboard.press("a");
        await page.waitForURL(/tab=accounts/);
        await page.keyboard.press("g");
        await page.keyboard.press("t");
        await page.waitForURL(/tab=tokens/);
        await page.keyboard.press("g");
        await page.keyboard.press("k");
        await page.waitForURL(/tab=keys/);
        assert.match(page.url(), /tab=keys/);
      },
    },
    {
      name: "rows: `j`/`k` move .kb.cur and Enter activates the selected row (audit disclosure)",
      run: async ({ page, goto }) => {
        await goto("/admin/auth?tab=audit");
        assert.ok(await page.locator(".tbl tbody tr").count() >= 2, "the fixture must render at least two audit rows");
        await page.keyboard.press("j");
        assert.deepEqual(await cursor(page), [0]);
        await page.keyboard.press("j");
        assert.deepEqual(await cursor(page), [1]);
        await page.keyboard.press("k");
        assert.deepEqual(await cursor(page), [0]);
        await page.keyboard.press("Enter");
        assert.equal(await page.evaluate(() => document.querySelector(".tbl tbody tr.kb details.ua").hasAttribute("open")), true);
      },
    },
    {
      name: "rows: Enter on a detail row opens its ?id= drawer",
      run: async ({ page, goto }) => {
        await goto("/admin/auth?tab=accounts");
        await page.keyboard.press("j");
        assert.deepEqual(await cursor(page), [0]);
        await page.keyboard.press("Enter");
        await page.waitForSelector("#drawer.on");
        assert.match(page.url(), /id=[0-9a-f-]{8}/);
        assert.match(await page.textContent("#drawer.on h1"), /layout-gate/);
      },
    },
    {
      name: "editor: Ctrl+Enter submits the policy editor, from the page and from inside its inputs",
      run: async ({ page, base, goto, requests }) => {
        await goto("/admin/auth/access-policy?new=1");
        await page.fill("#fld-label", "l2-keys harness");
        await page.evaluate(() => document.activeElement?.blur?.());
        const posts = requests.length;
        await page.keyboard.press("Control+Enter");
        await waitForPost(page, requests, posts, "outside the inputs");
        // The in-input case runs in its own page: the first submission's redirect is still in flight,
        // and a navigation started on top of it would be aborted by the browser (a harness artefact,
        // not a behaviour difference).
        const second = await page.context().newPage();
        second.setDefaultTimeout(5000);
        second.setDefaultNavigationTimeout(5000);
        try {
          await second.goto(`${base}/admin/auth/access-policy?new=1`, { waitUntil: "load" });
          await second.fill("#fld-label", "l2-keys harness in-field");
          const inField = requests.length;
          await second.keyboard.press("Control+Enter");
          await waitForPost(second, requests, inField, "inside an input (`allowInInput`)");
        } finally {
          await second.close().catch(() => {});
        }
      },
    },
  ];
}

async function waitForPost(page, requests, since, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const posted = requests.slice(since).find((entry) => entry.method === "POST" && entry.url.includes("/admin/auth/access-policy/create"));
    if (posted) return posted;
    await page.waitForTimeout(50);
  }
  assert.fail(`Ctrl+Enter ${label} must submit the editor form (POST …/access-policy/create)`);
}

test("client-keys: real browser behaviour, with a negative control per behaviour", { timeout: 300000 }, async (t) => {
  const harness = await loadHarness();
  if (harness.skipped) {
    t.skip(harness.skipped);
    return;
  }
  const { startAdminLayoutFixture } = await import(pathToFileURL(path.join(appRoot, "scripts", "web-regression", "admin-layout-fixture.mjs")).href);
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "l2-keys-harness-"));
  const serverErrors = [];
  const fixture = await startAdminLayoutFixture({ root, appRoot, serverErrors });
  const browser = await harness.chromium.launch({ headless: true, executablePath: harness.binary.executablePath });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  const requests = [];
  let navigationCount = 0;
  // Requests are recorded at the context level: a check may open its own page (the editor's second
  // case), and a page-scoped listener would silently miss that page's submission.
  context.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigationCount += 1; });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  // Short, explicit actionability timeouts: a broken behaviour must go red in seconds, not after
  // Playwright's 30s default (a red check that takes half a minute hides which check is red).
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const results = [];
  try {
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try { if ((await fetch(`${fixture.base}/healthz`)).ok) { ready = true; break; } } catch { /* keep waiting */ }
      if (fixture.child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, "the fixture server must become ready");
    const shim = shimmedClientSource();
    if (shim) {
      console.log("[client-keys] ADMIN_KEYS_BASE_SHIM is active: the F1 registry fix is served for admin-client.js");
      // Context-level: a check may open its own page, and a page-scoped route would not apply there.
      await context.route(CLIENT_URL, (route) => route.fulfill({ status: 200, contentType: "application/javascript; charset=utf-8", body: shim }));
    }
    const login = await context.request.post(`${fixture.base}/admin/auth/login`, { form: { password: fixture.password }, maxRedirects: 0 });
    assert.equal(login.status(), 303, "the harness login must succeed");

    const goto = async (url) => {
      pageErrors.length = 0;
      await page.goto(`${fixture.base}${url}`, { waitUntil: "load" });
      await page.evaluate(() => { window.__l2 = "alive"; });
    };
    const checks = browserChecks();
    const run = async (check) => {
      assert.ok(check, "the referenced check must exist");
      // Start every check from a blank document. A red check can leave a navigation in flight (the
      // theme form really posting, the editor really submitting); without this reset the *next*
      // check's goto is aborted by that redirect — a harness artefact that would look like a
      // behaviour failure. Retried, because the in-flight redirect can land mid-reset.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { await page.goto("about:blank", { waitUntil: "load", timeout: 5000 }); break; }
        catch { await page.waitForTimeout(100); }
      }
      try {
        await check.run({ page, base: fixture.base, goto, requests, navigations: () => navigationCount, pageErrors });
        return { name: check.name, pass: true, error: null };
      } catch (error) {
        return { name: check.name, pass: false, error: String(error?.message || error).replace(/\s+/g, " ").slice(0, 300) };
      }
    };

    const byName = (name) => {
      const check = checks.find((entry) => entry.name === name);
      assert.ok(check, `unknown check name: ${name}`);
      return check;
    };
    /** Record a result and echo it, so a long run is observable while it happens. */
    const push = (result) => {
      results.push(result);
      console.log(`[client-keys] ${result.pass ? "ok  " : "RED "} ${result.name}${result.error ? ` :: ${result.error}` : ""}`);
      return result;
    };

    for (const check of checks) push(await run(check));

    // Negative controls: break exactly one behaviour in the real source and require the red, while a
    // neighbouring behaviour stays green (so the mutation is surgical, not a blanket outage).
    const controls = [
      ["theme form navigates (no preventDefault)", "theme: the sidebar button toggles in place (no navigation, no POST) and syncs cookie/meta/control", "theme: the `t` key does the same in place"],
      ["t key removed", "theme: the `t` key does the same in place", "theme: the sidebar button toggles in place (no navigation, no POST) and syncs cookie/meta/control"],
      ["? key removed", "panel: `?` opens the prototype's .modal.kbdp, Esc closes it and focus returns", "search: `/` focuses and selects the current page's search box"],
      ["/ key removed", "search: `/` focuses and selects the current page's search box", "panel: `?` opens the prototype's .modal.kbdp, Esc closes it and focus returns"],
      ["n key removed", "create: `n` opens the current page's create entry (the SSR GET form)", "theme: the `t` key does the same in place"],
      ["j key removed", "rows: `j`/`k` move .kb.cur and Enter activates the selected row (audit disclosure)", "theme: the `t` key does the same in place"],
      ["Enter key removed", "rows: Enter on a detail row opens its ?id= drawer", "theme: the `t` key does the same in place"],
      ["g sequence removed", "nav: `g a` / `g t` / `g k` follow the sidebar links (the `t`/`k` collisions included)", "theme: the `t` key does the same in place"],
      ["mod+enter removed", "editor: Ctrl+Enter submits the policy editor, from the page and from inside its inputs", "theme: the `t` key does the same in place"],
    ];
    for (const [mutation, targetName, invariantName] of controls) {
      const source = MUTATIONS[mutation](moduleSource);
      await context.route(MODULE_URL, (route) => route.fulfill({ status: 200, contentType: "application/javascript; charset=utf-8", body: source }));
      try {
        const target = await run(byName(targetName));
        const invariant = await run(byName(invariantName));
        push({
          name: `negative control: ${mutation}`,
          pass: !target.pass && invariant.pass,
          error: target.pass ? `the check stayed green: ${targetName}` : invariant.pass ? null : `the invariant check broke: ${invariantName} :: ${invariant.error}`,
        });
      } finally {
        await context.unroute(MODULE_URL);
      }
    }

    // Negative control for the checks themselves: with script disabled, no scripted assertion may be
    // green — and the no-JS fallbacks must still work (theme POST, cookie, nav link).
    const noJsContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 900 } });
    const noJs = await noJsContext.newPage();
    noJs.setDefaultTimeout(5000);
    noJs.setDefaultNavigationTimeout(5000);
    const noJsResult = await (async () => {
      const login2 = await noJsContext.request.post(`${fixture.base}/admin/auth/login`, { form: { password: fixture.password }, maxRedirects: 0 });
      assert.equal(login2.status(), 303, "the no-JS login must succeed");
      try {
        await byName("theme: the sidebar button toggles in place (no navigation, no POST) and syncs cookie/meta/control")
          .run({ page: noJs, goto: async (url) => { await noJs.goto(`${fixture.base}${url}`, { waitUntil: "load" }); }, requests, navigations: () => navigationCount, pageErrors: [] });
        return false;
      } catch {
        return true;
      }
    })();
    const fallback = await (async () => {
      await noJs.goto(`${fixture.base}/admin/auth?tab=accounts`, { waitUntil: "load" });
      const before = await noJs.evaluate(() => document.documentElement.dataset.theme);
      await noJs.click(`${THEME_FORM} button[type="submit"]`);
      await noJs.waitForLoadState("load");
      const after = await noJs.evaluate(() => ({ theme: document.documentElement.dataset.theme, cookie: document.cookie }));
      await noJs.click('a[data-hotkey="k"]');
      await noJs.waitForURL(/tab=keys/);
      return {
        theme: before !== after.theme,
        cookie: new RegExp(`(^|; )omcp-admin\\.theme=${after.theme}`).test(after.cookie),
        nav: /tab=keys/.test(noJs.url()),
      };
    })();
    await noJsContext.close();
    push({ name: "negative control: script disabled ⇒ the scripted assertions cannot be green", pass: noJsResult, error: noJsResult ? null : "the theme check passed without any script" });
    push({ name: "no-JS fallbacks: the theme POST, the cookie and the nav links still work", pass: fallback.theme && fallback.cookie && fallback.nav, error: JSON.stringify(fallback) });

    const failed = results.filter((result) => !result.pass);
    console.log(`\nclient-keys checks: ${results.length - failed.length}/${results.length} passed`);
    console.log(JSON.stringify(results, null, 1));
    assert.deepEqual(failed, [], `red checks: ${JSON.stringify(failed, null, 1)}`);
    const fatal = serverErrors.filter((line) => /unhandled|UnhandledPromiseRejection|TypeError|ReferenceError/.test(line));
    assert.deepEqual(fatal, []);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    const shutdown = await fixture.stop();
    assert.equal(shutdown.childExited, true, `the fixture child must be reaped: ${JSON.stringify(shutdown)}`);
    assert.equal(shutdown.portReleased, true, `the fixture port must be free: ${JSON.stringify(shutdown)}`);
    await fsPromises.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
