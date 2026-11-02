// #429 fix2 — the third review round's focus counterexample: a *hidden* origin must not win the
// focus return, on the real application in real Chromium.
//
// The review reproduced this in an isolated Vault: open A.md in Live, open a Base surface, open
// A.md again, focus the editor, right-click A's tab, `ArrowDown` into the menu, then the browser
// Back returns to the Base surface and Escape closes the menu. The editor the menu opened with is
// still `isConnected`, but its document view is `[hidden]` now and it has no client rects at all,
// so `focus()` on it is a silent no-op: `document.activeElement` ended on BODY even though the
// live A tab was still sitting in the strip. Connectivity alone was therefore not a strong enough
// test for a focus candidate — the strip's own live-tab fallback was skipped for a node the user
// could not use.
//
// This check pins both halves with the app's own history:
//   * the control — Escape with no navigation still hands the focus back to the *visible* editor,
//     so the fix is not allowed to degrade into "always focus the tab";
//   * the counterexample — after the Back, the hidden origin never takes the focus and the live,
//     focusable, really laid-out A tab button does.
//
// Witnesses are browser-level: `document.activeElement` plus its connectivity/geometry, the saved
// origin node's own connectivity/hidden-ancestor/client-rect state, the menu's `hidden` and
// `data-tab-menu-target`, and the strip's paths. Nothing is inferred from the source.
//
// Split out of tabs-bulk-close.mjs to keep both modules inside the architecture line budget;
// `registerTabsBulkCloseChecks` calls it, so the suite entry point still registers everything.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const NOTE = "A.md";
const BASE_FILE = "U51Focus.base";
// The smallest real Base view (the same shape the #430 badge scene writes): one table view.
const BASE_FIXTURE = "views:\n  - type: table\n    name: All\n    order:\n      - file.name\n";

export async function registerTabsBulkCloseHiddenOriginChecks({ check, sleep, page, open, mode, base, vault }) {
  const tabMain = (notePath) => page.locator(`#document-tabs .document-tab-main[data-tab-path=${JSON.stringify(notePath)}]`);
  const baseRow = page.locator(`.note[data-kind="base"][title=${JSON.stringify(BASE_FILE)}]`);
  const waitMenuOpen = () => page.waitForSelector(".tabs-close-menu:not([hidden])", { timeout: 15000 });
  const waitBaseShown = () => page.waitForFunction(() => document.querySelector("#base-host")?.hidden === false, null, { timeout: 20000 });
  const waitNoteShown = (notePath) => page.waitForFunction((expected) => document.querySelector("#current-path")?.textContent.trim() === expected, notePath, { timeout: 20000 });
  // The Explorer re-renders its list as the app refreshes (SSE, reveal-current, paging), so the
  // Base row is re-resolved with a generous, explicit wait instead of the page default.
  const clickBaseRow = async () => {
    await baseRow.waitFor({ state: "visible", timeout: 30000 });
    await baseRow.click({ timeout: 20000 });
  };

  // Everything the focus assertions read, in one round trip, so a failure can quote the whole
  // state (the focused node, the saved origin node and the strip together).
  const readFocus = (notePath) => page.evaluate((note) => {
    const focused = document.activeElement;
    const origin = window.__u51Origin ?? null;
    const focusedBox = focused?.getBoundingClientRect?.() ?? null;
    const originBox = origin?.getBoundingClientRect?.() ?? null;
    return {
      menuHidden: document.querySelector(".tabs-close-menu")?.hidden ?? null,
      menuTarget: document.querySelector(".tabs-close-menu")?.getAttribute("data-tab-menu-target") ?? null,
      baseShown: document.querySelector("#base-host")?.hidden === false,
      paths: [...document.querySelectorAll("#document-tabs .document-tab")].map((row) => row.getAttribute("data-tab-path")),
      focusTag: focused?.tagName ?? null,
      focusClass: typeof focused?.className === "string" ? focused.className : null,
      focusIsBody: focused === document.body,
      focusConnected: focused?.isConnected === true,
      focusInStrip: Boolean(focused?.closest?.("#document-tabs")),
      focusInEditor: Boolean(focused?.closest?.("#editor")),
      focusPath: focused?.getAttribute?.("data-tab-path") ?? null,
      focusIsLiveTab: focused === document.querySelector(`#document-tabs .document-tab-main[data-tab-path="${note}"]`),      focusIsOrigin: focused === origin,
      focusRects: typeof focused?.getClientRects === "function" ? focused.getClientRects().length : null,
      focusBoxWidth: focusedBox?.width ?? null,
      focusBoxHeight: focusedBox?.height ?? null,
      originConnected: origin?.isConnected === true,
      originHiddenAncestor: Boolean(origin?.closest?.("[hidden]")),
      originRects: typeof origin?.getClientRects === "function" ? origin.getClientRects().length : null,
      originBoxWidth: originBox?.width ?? null,
      liveTab: Boolean(document.querySelector(`#document-tabs .document-tab-main[data-tab-path="${note}"]`)),
    };
  }, notePath);
  // The origin the menu must return the focus to: the focus owner *before* the press, exactly as
  // `features/tabs/view.js` captured it at `pointerdown`. Saved by identity so the witness below
  // can inspect that very node after the navigation.
  const markOrigin = () => page.evaluate(() => { window.__u51Origin = document.activeElement; });
  const focusEditor = async () => {
    await page.locator("#editor .cm-content").click();
    const focused = await page.evaluate(() => ({ inEditor: Boolean(document.activeElement?.closest?.("#editor")), className: typeof document.activeElement?.className === "string" ? document.activeElement.className : null }));
    assert.equal(focused.inEditor, true, `the case starts with the editor focused: ${JSON.stringify(focused)}`);
    await markOrigin();
  };
  const openMenuFromTab = async () => {
    await tabMain(NOTE).click({ button: "right", timeout: 20000 });
    await waitMenuOpen();
    await page.keyboard.press("ArrowDown");
    const item = await page.evaluate(() => document.activeElement?.getAttribute?.("data-tab-action") ?? null);
    assert.equal(item, "close", "ArrowDown lands on the menu's first enabled item");
  };

  await check("#429 fix2: a menu closed after a history navigation returns the focus to the live tab, never to a hidden origin", async () => {
    // This module writes its own Base fixture into the shared Vault (the badge scene does the
    // same for its own `.base`), so the check never depends on another scene's file.
    await fs.writeFile(path.join(vault, BASE_FILE), BASE_FIXTURE);
    await sleep(500);
    await page.goto(`${base}/app`);
    await page.waitForSelector(`.note[title="${NOTE}"]`, { timeout: 30000 });
    await baseRow.waitFor({ state: "visible", timeout: 30000 });
    await mode("live");
    // A.md -> the Base surface -> A.md again: the browser Back below really returns to the Base,
    // which is the navigation the review used.
    await open(NOTE);
    await waitNoteShown(NOTE);
    await clickBaseRow();
    await waitBaseShown();
    await sleep(250);
    await open(NOTE);
    await waitNoteShown(NOTE);
    await sleep(250);
    const start = await readFocus(NOTE);
    assert.equal(start.paths.includes(NOTE), true, `the A tab must be in the strip: ${JSON.stringify(start)}`);
    assert.equal(start.liveTab, true, `the A tab is the strip's live row: ${JSON.stringify(start)}`);

    // --- control: no navigation, so the origin is still visible and must keep the focus -------
    await focusEditor();
    await openMenuFromTab();
    await page.keyboard.press("Escape");
    await sleep(200);
    const control = await readFocus(NOTE);
    console.log(`u51 fix2 witness (control): ${JSON.stringify(control)}`);
    assert.equal(control.menuHidden, true, `Escape closes the menu: ${JSON.stringify(control)}`);
    assert.equal(control.focusIsOrigin, true, `the visible editor keeps the focus return (the fix must not fall back to the tab): ${JSON.stringify(control)}`);
    assert.equal(control.focusInEditor, true, `and it really is the editor pane: ${JSON.stringify(control)}`);

    // --- counterexample: the same menu, with a real Back to the Base surface ------------------
    await focusEditor();
    await openMenuFromTab();
    await page.goBack();
    await waitBaseShown();
    await sleep(300);
    const hidden = await readFocus(NOTE);
    console.log(`u51 fix2 witness (hidden origin): ${JSON.stringify(hidden)}`);
    assert.equal(hidden.baseShown, true, `the Back really returned to the Base surface: ${JSON.stringify(hidden)}`);
    assert.equal(hidden.menuHidden, false, "the menu stays open across the history navigation");
    assert.equal(hidden.menuTarget, NOTE, `and still names the operated tab: ${JSON.stringify(hidden)}`);
    assert.equal(hidden.originConnected, true, `the precondition: the saved origin node is still connected: ${JSON.stringify(hidden)}`);
    assert.equal(hidden.originHiddenAncestor, true, `... but its document view is [hidden] now: ${JSON.stringify(hidden)}`);
    assert.equal(hidden.originRects, 0, `... and it has no layout at all: ${JSON.stringify(hidden)}`);
    assert.equal(hidden.liveTab, true, `... while the A tab is still a live row in the strip: ${JSON.stringify(hidden)}`);

    await page.keyboard.press("Escape");
    await sleep(200);
    const after = await readFocus(NOTE);
    console.log(`u51 fix2 witness (escape): ${JSON.stringify(after)}`);
    assert.equal(after.menuHidden, true, `Escape closes the menu: ${JSON.stringify(after)}`);
    assert.equal(after.focusIsBody, false, `the focus return never lands on BODY: ${JSON.stringify(after)}`);
    assert.equal(after.focusIsOrigin, false, `and never on the hidden origin: ${JSON.stringify(after)}`);
    assert.equal(after.focusIsLiveTab, true, `the live A tab takes it instead: ${JSON.stringify(after)}`);
    assert.equal(after.focusInStrip, true, `the focus owner is the strip's own tab button: ${JSON.stringify(after)}`);
    assert.equal(after.focusConnected, true, `and it is still in the document: ${JSON.stringify(after)}`);
    assert.equal(after.focusPath, NOTE, `the tab it landed on is A: ${JSON.stringify(after)}`);
    assert.ok(after.focusRects > 0 && after.focusBoxWidth > 0 && after.focusBoxHeight > 0,
      `the node that takes the focus is really laid out (focusable and visible): ${JSON.stringify(after)}`);
    assert.deepEqual(after.paths, hidden.paths, `no tab action ran: ${JSON.stringify(after)}`);
  });
}
