// Wave R (Q12) — the self-drawn select: real browser, real Admin router, real form submits.
//
// **This is a user-decided DESIGN CHANGE (2026-10-18), not prototype parity.** The prototype uses
// native `<select>` elements and a native option list cannot be styled, so the owner asked for the
// expanded list to be drawn by the plane. What this file pins:
//
//   1. with the script running, every `select.sel` gets a proxy control: the popup is on `<body>`
//      with `position: fixed` (no clipping ancestor can cut it), the selected row is painted
//      (`--sel` surface + check mark) and the closed control is still the prototype's `.sel` box;
//   2. the pick is mirrored back into the REAL select (value + a real `change` event), so the form
//      still submits the picked value and the page's own listeners keep working;
//   3. keyboard/ARIA at native level: ↑/↓, Enter/Space, Home/End, Esc (close, focus back), Tab,
//      type-ahead, outside click, `role=combobox` + `aria-expanded` + `aria-controls` +
//      `aria-activedescendant`;
//   4. **without any script the behaviour is exactly what it was**: the native select is visible and
//      functional, no proxy appears, and the no-JS submit button still posts the form;
//   5. three negative controls (no mirroring / popup not on body / real select moved out of the
//      form) each make the same checker go red, so a green run cannot be vacuous.
//
// The browser half is opt-in (`ADMIN_CLIENT_BROWSER_EVIDENCE=1`), exactly like the other client
// tests: the repository's default gate does not launch Chromium, and a Chromium-launching file in
// the default discovery made unrelated timing tests flaky under load.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import express from "express";

import { createAdminRouter } from "../../src/admin/router.js";
import { createAccessPolicyAdmin } from "../../src/admin/access-policy.js";
import { createAccessPolicyRuntime } from "../../src/access-policy/runtime.js";
import { createAccessPolicyStore } from "../../src/access-policy/store.js";
import { Cdp, Page, js, launchBrowser, resolveBrowser, sleep } from "./browser-harness.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FEATURE_ASSET = path.join(APP_ROOT, "src", "admin", "assets", "admin-feature-select.js");
const ADMIN_PASSWORD = "wave-r-select-admin-password";
const REQUIRE_BROWSER = process.env.ADMIN_CLIENT_BROWSER_EVIDENCE === "1";

// ------------------------------------------------------------------ fixture server

function snapshot() {
  const stamp = "2026-10-18T02:00:00.000Z";
  return {
    apiKeys: [
      { id: "k-bot", label: "研究机器人", prefix: "obmcp_1a2b3c4d", allowedScopes: ["obsidian.read"], allowedVaults: ["vault"], createdAt: stamp, lastUsedAt: stamp, lastSource: "192.168.1.5" },
      { id: "k-desktop", label: "桌面客户端", prefix: "obmcp_5e6f7a8b", allowedScopes: ["obsidian.read", "obsidian.write"], allowedVaults: ["vault"], createdAt: stamp, lastUsedAt: null, lastSource: null },
    ],
    clients: [
      { clientId: "c-claude", clientName: "Claude Desktop", redirectUris: ["http://127.0.0.1:33418/callback"], connectionOrigins: ["https://obsidian.example.com"], createdAt: stamp, lastUsedAt: stamp, lastSource: "192.168.1.5" },
    ],
    oauthUsers: [
      { id: "u-alice", username: "alice", displayName: "Alice Chen", allowedScopes: ["obsidian.read"], allowedVaults: ["vault"], createdAt: stamp, lastLoginAt: stamp },
      { id: "u-bob", username: "bob", displayName: "Bob Li", allowedScopes: ["obsidian.read"], allowedVaults: ["vault"], createdAt: stamp, lastLoginAt: null },
    ],
    tokens: [],
    audit: [],
    configuredApiKeyUsage: { lastUsedAt: null, lastSource: null },
  };
}

async function createFixture(cleanups) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wave-r-select-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createAccessPolicyStore({ file: path.join(dir, "access-policy.json") });
  await store.ready;
  const runtime = createAccessPolicyRuntime({ enabled: true, store });
  await runtime.ready;
  const admin = createAccessPolicyAdmin({ store, runtime });
  const provider = {
    ready: Promise.resolve(),
    audits: [],
    recordAudit(event) { this.audits.push(event); },
    async authorizationSnapshot() { return snapshot(); },
    accessRuntime: runtime,
  };
  const app = express();
  app.use("/admin/auth", createAdminRouter({ provider, adminPassword: ADMIN_PASSWORD, secureCookie: false, accessPolicyAdmin: admin }));
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  cleanups.push(() => new Promise((resolve) => listener.close(resolve)));
  const origin = `http://127.0.0.1:${listener.address().port}`;
  const login = await fetch(`${origin}/admin/auth/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 303, "the fixture login must succeed");
  const [cookieName, cookieValue] = login.headers.get("set-cookie").split(";", 1)[0].split("=");
  return { origin, cookie: `${cookieName}=${cookieValue}`, cookieName, cookieValue, admin, store, runtime, provider };
}

const suite = { cleanups: [], fixture: null, cdp: null, child: null, profile: null };

before(async () => {
  suite.fixture = await createFixture(suite.cleanups);
  if (!REQUIRE_BROWSER) return;
  const resolution = resolveBrowser();
  if (resolution.error) assert.fail(`ADMIN_CLIENT_BROWSER_EVIDENCE=1 but no full Chromium build could be found: ${resolution.error}`);
  const launched = await launchBrowser(resolution.executablePath);
  suite.child = launched.child;
  suite.profile = launched.profile;
  suite.cdp = await Cdp.connect(launched.endpoint);
});

after(async () => {
  suite.cdp?.close();
  if (suite.child) suite.child.kill("SIGKILL");
  if (suite.profile) await fs.rm(suite.profile, { recursive: true, force: true }).catch(() => {});
  for (const cleanup of suite.cleanups.reverse()) await cleanup();
});

function needsBrowser(t) {
  if (!REQUIRE_BROWSER) {
    t.skip("browser evidence is opt-in: re-run with ADMIN_CLIENT_BROWSER_EVIDENCE=1");
    return false;
  }
  assert.ok(suite.cdp, "the browser fixture must be up when the evidence gate is on");
  return true;
}

async function openPage() {
  const { targetId } = await suite.cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await suite.cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = new Page(suite.cdp, targetId, sessionId, suite.fixture.origin);
  await page.send("Page.enable");
  await page.send("DOM.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  await page.send("Network.setCookie", { name: suite.fixture.cookieName, value: suite.fixture.cookieValue, url: `${suite.fixture.origin}/`, path: "/" });
  return page;
}

async function withPage(scenario) {
  const page = await openPage();
  try {
    return await scenario(page, suite.fixture);
  } finally {
    try { await suite.cdp.send("Target.closeTarget", { targetId: page.targetId }); } catch { /* already closed */ }
  }
}

/** Patch the real feature asset (the router reads it per request), run, restore byte for byte. */
async function withMutatedFeature({ find, replace }, scenario, checker, expect) {
  const original = await fs.readFile(FEATURE_ASSET, "utf8");
  const normalized = original.replace(/\r\n/g, "\n");
  assert.ok(normalized.includes(find), `the negative control must find its anchor in ${path.basename(FEATURE_ASSET)}`);
  await fs.writeFile(FEATURE_ASSET, normalized.replace(find, replace));
  try {
    const observations = await withPage(scenario);
    assert.throws(() => checker(observations), expect, "the mutated build must make the checker go red");
    return observations;
  } finally {
    await fs.writeFile(FEATURE_ASSET, original);
    assert.equal(await fs.readFile(FEATURE_ASSET, "utf8"), original, "the feature asset must be restored byte for byte");
  }
}

// ------------------------------------------------------------------ observations

const AUTHZ = "/admin/auth/access-policy";

/** Everything the checker needs, measured on the live page; observing never asserts. */
async function observeSelect(page) {
  await page.goto(AUTHZ);
  await page.evaluate(js(() => { window.__waveR = "kept"; window.__waveRNav = performance.getEntriesByType("navigation").length; }));
  const inventory = await page.evaluate(js(() => {
    const selects = [...document.querySelectorAll("select.sel")];
    const proxies = [...document.querySelectorAll("[data-select-proxy]")];
    return {
      selects: selects.length,
      proxies: proxies.length,
      optOuts: [...document.querySelectorAll("select.sel[data-native-select]")].length,
      eachHasProxy: selects.every((select) => select.nextElementSibling?.hasAttribute?.("data-select-proxy")),
      nativeClipped: selects.every((select) => select.hasAttribute("data-select-native") && select.getAttribute("aria-hidden") === "true"),
      nativeInForm: selects.every((select) => Boolean(select.form)),
    };
  }));

  const opened = await page.evaluate(js(() => {
    const select = document.querySelector("#preview select.sel");
    const proxy = select?.nextElementSibling;
    if (!proxy) return { opened: false };
    proxy.click();
    const popup = document.querySelector("[data-select-popup]");
    const selected = popup?.querySelector('.sel-opt[aria-selected="true"]');
    const check = selected?.querySelector(".sel-check");
    return {
      opened: Boolean(popup),
      onBody: popup?.parentElement === document.body,
      position: popup ? getComputedStyle(popup).position : null,
      expanded: proxy.getAttribute("aria-expanded"),
      controls: proxy.getAttribute("aria-controls"),
      role: proxy.getAttribute("role"),
      options: popup ? popup.querySelectorAll("[role=option]").length : 0,
      selectedCount: popup ? popup.querySelectorAll('.sel-opt[aria-selected="true"]').length : 0,
      selectedPaint: selected ? getComputedStyle(selected).backgroundColor : null,
      checkVisible: check ? getComputedStyle(check).visibility : null,
      activedescendant: proxy.getAttribute("aria-activedescendant"),
      listRole: popup?.getAttribute("role") ?? null,
      selectOptions: select.options.length,
      focused: document.activeElement === proxy,
    };
  }));

  // Pick a real (non-placeholder) option through the popup, and prove the submit would carry it.
  const picked = await page.evaluate(js(async () => {
    const select = document.querySelector("#preview select.sel");
    const proxy = select && select.nextElementSibling;
    if (!select || !proxy) return { value: null, selectValue: null, changes: [], submitted: null, inForm: false, proxyText: null, selectLabel: null, closed: true };
    const changes = [];
    select.addEventListener("change", () => changes.push(select.value));
    let submitted = null;
    select.form?.addEventListener("submit", (event) => {
      event.preventDefault();
      submitted = new FormData(select.form).get("subject");
    }, { once: true });
    const target = [...document.querySelectorAll("[data-select-popup] .sel-opt")].find((node) => node.dataset.value);
    const value = target ? target.dataset.value : null;
    if (target) target.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    select.form?.requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 40));
    return {
      value,
      selectValue: select.value,
      changes,
      submitted,
      inForm: Boolean(select.form),
      proxyText: String(proxy.textContent).trim(),
      selectLabel: select.options[select.selectedIndex] ? String(select.options[select.selectedIndex].label).trim() : null,
      closed: !document.querySelector("[data-select-popup]"),
    };
  }));

  // Keyboard: open with ArrowDown, move, commit with Enter; then Esc closes and gives focus back.
  const keyboard = await page.evaluate(js(async () => {
    const select = document.querySelector("#preview select.sel");
    const proxy = select && select.nextElementSibling;
    if (!select || !proxy) return { opened: false, firstActive: null, secondActive: null, endActive: null, afterEnter: { closed: true, value: null, focusBack: false }, reopened: false, afterEscape: { closed: true, focusBack: false } };
    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    proxy.focus();
    const press = async (key) => {
      proxy.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    };
    await press("ArrowDown");
    const opened = Boolean(document.querySelector("[data-select-popup]"));
    const firstActive = proxy.getAttribute("aria-activedescendant");
    await press("ArrowDown");
    const secondActive = proxy.getAttribute("aria-activedescendant");
    await press("End");
    const endActive = proxy.getAttribute("aria-activedescendant");
    await press("Enter");
    const afterEnter = {
      value: select.value,
      closed: !document.querySelector("[data-select-popup]"),
      focusBack: document.activeElement === proxy,
    };
    await press("ArrowDown");
    const reopened = Boolean(document.querySelector("[data-select-popup]"));
    await press("Escape");
    const afterEscape = {
      closed: !document.querySelector("[data-select-popup]"),
      focusBack: document.activeElement === proxy,
    };
    return { opened, firstActive, secondActive, endActive, afterEnter, reopened, afterEscape };
  }));

  // Type-ahead on the closed control (native selects commit as you type).
  const typeahead = await page.evaluate(js(async () => {
    const select = document.querySelector("#preview select.sel");
    const proxy = select && select.nextElementSibling;
    if (!select || !proxy) return { letter: "?", value: null, label: "", wanted: null };
    const target = [...select.options].find((option) => option.value);
    if (!target) return { letter: "?", value: null, label: "", wanted: null };
    const letter = String(target.label).trim()[0];
    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    proxy.focus();
    proxy.dispatchEvent(new KeyboardEvent("keydown", { key: letter, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { letter, value: select.value, label: String(select.options[select.selectedIndex]?.label ?? "").trim(), wanted: target.value };
  }));

  // Outside click closes; the control's own click toggles.
  const outside = await page.evaluate(js(async () => {
    const proxy = document.querySelector("#preview [data-select-proxy]");
    if (!proxy) return { opened: false, closed: false, reopened: false, toggledClosed: false, alive: window.__waveR === "kept", navigations: performance.getEntriesByType("navigation").length, baseline: window.__waveRNav };
    proxy.click();
    const opened = Boolean(document.querySelector("[data-select-popup]"));
    document.querySelector(".main .page")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const closed = !document.querySelector("[data-select-popup]");
    proxy.click();
    const reopened = Boolean(document.querySelector("[data-select-popup]"));
    proxy.click();
    const toggledClosed = !document.querySelector("[data-select-popup]");
    return { opened, closed, reopened, toggledClosed, alive: window.__waveR === "kept", navigations: performance.getEntriesByType("navigation").length, baseline: window.__waveRNav };
  }));

  return { inventory, opened, picked, keyboard, typeahead, outside };
}

function assertSelect(observations) {
  const { inventory, opened, picked, keyboard, typeahead, outside } = observations;
  assert.ok(inventory.selects >= 1, "the policy list page must render at least one select.sel");
  assert.equal(inventory.proxies, inventory.selects - inventory.optOuts, `every select.sel (minus explicit opt-outs) gets one proxy: ${JSON.stringify(inventory)}`);
  assert.equal(inventory.nativeInForm, true, "the real select is still in its form (submits keep working)");
  assert.equal(inventory.eachHasProxy, true, "the proxy is inserted next to its own select");
  assert.equal(inventory.nativeClipped, true, "the real select is visually hidden and aria-hidden, not removed");

  assert.equal(opened.opened, true, "clicking the control opens a popup");
  assert.equal(opened.onBody, true, "the popup is appended to <body>");
  assert.equal(opened.position, "fixed", `the popup is position:fixed (got ${opened.position})`);
  assert.equal(opened.expanded, "true", "aria-expanded flips to true");
  assert.equal(opened.role, "combobox", "the control is role=combobox");
  assert.equal(opened.listRole, "listbox", "the popup is role=listbox");
  assert.ok(opened.options > 0, "the popup renders one role=option per option");
  assert.equal(opened.selectedCount, 1, "exactly one option is aria-selected");
  assert.equal(opened.checkVisible, "visible", "the selected row carries a visible check mark");
  assert.ok(opened.activedescendant, "the control points at the active option (aria-activedescendant)");
  assert.ok(opened.controls, "the control names the popup (aria-controls)");
  assert.notEqual(opened.selectedPaint, "rgba(0, 0, 0, 0)", "the selected row has a surface colour (--sel)");

  assert.ok(picked.value, "the fixture offers at least one real subject");
  assert.equal(picked.selectValue, picked.value, `picking an option mirrors into the real select (${picked.value})`);
  assert.ok(picked.changes.includes(picked.value), "picking dispatches a real change event on the select");
  assert.equal(picked.submitted, picked.value, `a submit of the same form carries the picked value (${picked.submitted})`);
  assert.equal(picked.closed, true, "the popup closes after a pick");
  assert.equal(picked.proxyText, picked.selectLabel, "the closed control shows the selected label");

  assert.equal(keyboard.opened, true, "ArrowDown opens the list");
  assert.notEqual(keyboard.firstActive, keyboard.secondActive, "ArrowDown moves the active option");
  assert.notEqual(keyboard.endActive, keyboard.secondActive, "End jumps to the last option");
  assert.equal(keyboard.afterEnter.closed, true, "Enter commits and closes");
  assert.ok(keyboard.afterEnter.value, "Enter commits a value");
  assert.equal(keyboard.afterEnter.focusBack, true, "focus stays on the control after Enter");
  assert.equal(keyboard.reopened, true, "ArrowDown opens again");
  assert.equal(keyboard.afterEscape.closed, true, "Esc closes the list");
  assert.equal(keyboard.afterEscape.focusBack, true, "Esc gives the focus back to the control");

  assert.equal(typeahead.label.toLowerCase().startsWith(String(typeahead.letter).toLowerCase()), true,
    `type-ahead jumps to an option starting with 「${typeahead.letter}」 (got 「${typeahead.label}」)`);

  assert.equal(outside.opened, true, "the control opens on click");
  assert.equal(outside.closed, true, "an outside pointerdown closes the list");
  assert.equal(outside.reopened, true, "a second click opens it again");
  assert.equal(outside.toggledClosed, true, "a click on the control itself closes it");
  assert.equal(outside.alive, true, "none of this reloaded the document");
  assert.equal(outside.navigations, outside.baseline, "no navigation entry was added");
}

/** The no-JS contract: exactly the markup the server rendered, with nothing enhanced. */
async function observeNoScript(page) {
  await page.setScriptExecutionDisabled(true);
  try {
    await page.goto(AUTHZ);
    await sleep(120);
    const contract = await page.evaluate(js(() => {
      const select = document.querySelector("#preview select.sel");
      const button = document.querySelector('#preview [data-enhance~="hide-when-scripted"]');
      const rect = select.getBoundingClientRect();
      return {
        proxies: document.querySelectorAll("[data-select-proxy]").length,
        popups: document.querySelectorAll("[data-select-popup]").length,
        clipped: select.hasAttribute("data-select-native"),
        ariaHidden: select.getAttribute("aria-hidden"),
        tabIndex: select.tabIndex,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: getComputedStyle(select).display !== "none",
        buttonVisible: Boolean(button) && getComputedStyle(button).display !== "none" && button.hidden !== true,
        enhancedForm: select.form?.dataset.enhanced ?? null,
      };
    }));
    // A native pick still works, and the explicit submit button posts the form.
    await page.selectNext("#preview select.sel");
    const afterArrow = await page.evaluate(js(() => document.querySelector("#preview select.sel").value));
    const loaded = page.cdp.waitFor("Page.loadEventFired", page.sessionId);
    await page.click('#preview [data-enhance~="hide-when-scripted"]');
    await loaded;
    await sleep(120);
    const afterSubmit = await page.evaluate(js(() => ({
      verdicts: document.querySelectorAll("#preview .card .verdict").length,
      selected: document.querySelector("#preview select.sel").value,
      proxies: document.querySelectorAll("[data-select-proxy]").length,
    })));
    return { contract, afterArrow, afterSubmit };
  } finally {
    await page.setScriptExecutionDisabled(false);
  }
}

function assertNoScript(observations) {
  const { contract, afterArrow, afterSubmit } = observations;
  assert.equal(contract.proxies, 0, "with no script no proxy is rendered");
  assert.equal(contract.popups, 0, "with no script no popup exists");
  assert.equal(contract.clipped, false, "the real select is not visually hidden");
  assert.equal(contract.ariaHidden, null, "the real select is not aria-hidden");
  assert.notEqual(contract.tabIndex, -1, "the real select keeps its place in the tab order");
  assert.equal(contract.visible, true, "the real select is visible");
  assert.ok(contract.width > 40 && contract.height >= 28, `the real select has a real box (${contract.width}×${contract.height})`);
  assert.equal(contract.buttonVisible, true, "the no-JS submit button is visible and usable");
  assert.equal(contract.enhancedForm, null, "the form is not marked as enhanced without the script");
  assert.ok(afterArrow, "a native ArrowDown still picks an option");
  assert.equal(afterSubmit.proxies, 0, "the re-rendered page also carries no proxy");
  assert.ok(afterSubmit.verdicts >= 1, "the no-JS submit really produced the server's verdict");
  assert.equal(afterSubmit.selected, afterArrow, "the submitted page keeps the picked subject");
}

// ------------------------------------------------------------------ tests

test("Q12 自绘下拉：开/选/键盘/Esc/外点/type-ahead + 镜像后提交带对值", async (t) => {
  if (!needsBrowser(t)) return;
  const observations = await withPage(observeSelect);
  assertSelect(observations);
});

test("Q12 无 JS：原生 select 与显式提交按钮的行为与之前完全一致", async (t) => {
  if (!needsBrowser(t)) return;
  const observations = await withPage(observeNoScript);
  assertNoScript(observations);
});

test("负控：断开镜像（不派发 change）→ 判据红", async (t) => {
  if (!needsBrowser(t)) return;
  await withMutatedFeature({
    find: "    if (changed) select.dispatchEvent(new Event(\"change\", { bubbles: true }));",
    replace: "    if (changed) { /* mirroring disabled by the negative control */ }",
  }, observeSelect, assertSelect, /picking dispatches a real change event/);
});

test("负控：弹层不挂 body（挂在控件旁边）→ 判据红", async (t) => {
  if (!needsBrowser(t)) return;
  await withMutatedFeature({
    find: "    document.body.appendChild(popup);",
    replace: "    proxy.parentElement.appendChild(popup);",
  }, observeSelect, assertSelect, /the popup is appended to <body>/);
});

test("负控：把真实 select 移出表单 → 判据红", async (t) => {
  if (!needsBrowser(t)) return;
  await withMutatedFeature({
    find: "    select.after(proxy);\n    select._selProxy = proxy;",
    replace: "    select.after(proxy);\n    if (select.form) select.form.after(select);\n    select._selProxy = proxy;",
  }, observeSelect, assertSelect, /still in its form/);
});
