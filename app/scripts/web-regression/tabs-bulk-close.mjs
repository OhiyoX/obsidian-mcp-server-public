// #429 — the document tab strip's batch close (Close / Others / Left / Right / All), on the real
// application in real Chromium against the fixture Vault.
//
// The product contract under test: the menu acts on the *operated* tab's path (right-click,
// Shift+F10/ContextMenu, and a held touch press — not only a desktop right button), a removal
// that does not contain the shown document is a pure list edit (no navigation, no dirty-guard
// dialog, no focus theft), a removal that does contain it navigates first and only then commits
// the whole new list once, and a refused guard removes **zero** tabs and leaves the document,
// the address, the unsaved buffer and the focus alone.
//
// Witnesses are browser-level, never inferred: the strip's paths/aria/tabindex read from the DOM,
// `#current-path` for the committed identity, `document.activeElement` for the focus owner,
// Playwright's request log for "no note was opened / no DELETE was sent / no document load", and
// the fixture files on disk for "the Vault is untouched".
//
// `options.tamper` exists for the lane's negative control (U51/verify/negative-control.mjs): with
// `disableDirtyGuard` the same assertions run against a page whose `window.confirm` always says
// yes, and the "a refused guard removes zero tabs" assertion must then be red.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
// The touch half of the same contract, split out for the architecture line budget; it
// registers one more check through this module, so the suite entry point stays a single line.
import { registerTabsBulkCloseTouchChecks } from "./tabs-bulk-close-touch.mjs";
// The third review round's counterexample (a hidden origin after a history navigation) lives in
// its own module for the architecture line budget, like the touch half above.
import { registerTabsBulkCloseHiddenOriginChecks } from "./tabs-bulk-close-hidden-origin.mjs";

const NOTE_A = "A.md";
const NOTE_B = "B.md";
const NOTE_C = "Target.md";
const NOTE_D = "Refresh.md";
const ORDER = [NOTE_A, NOTE_B, NOTE_C, NOTE_D];
const UNSAVED_PREFIX = "当前修改尚未保存，仍要";
const MENU_ITEMS = [
  ["close", "关闭"],
  ["close-others", "关闭其他"],
  ["close-left", "关闭左侧标签页"],
  ["close-right", "关闭右侧标签页"],
  ["close-all", "关闭全部"],
];
// action, operated tab, active document, the exact set that must survive, the document that must
// be on screen afterwards. Every row is a real user gesture: right-click the operated tab, pick
// the action, read the strip.
const MATRIX = [
  { action: "close", operated: NOTE_C, active: NOTE_A, survive: [NOTE_A, NOTE_B, NOTE_D], current: NOTE_A, navigates: false },
  { action: "close", operated: NOTE_B, active: NOTE_B, survive: [NOTE_A, NOTE_C, NOTE_D], current: NOTE_C, navigates: true },
  { action: "close-others", operated: NOTE_C, active: NOTE_A, survive: [NOTE_C], current: NOTE_C, navigates: true },
  { action: "close-others", operated: NOTE_B, active: NOTE_B, survive: [NOTE_B], current: NOTE_B, navigates: false },
  { action: "close-left", operated: NOTE_C, active: NOTE_D, survive: [NOTE_C, NOTE_D], current: NOTE_D, navigates: false },
  { action: "close-left", operated: NOTE_C, active: NOTE_A, survive: [NOTE_C, NOTE_D], current: NOTE_C, navigates: true },
  { action: "close-right", operated: NOTE_B, active: NOTE_A, survive: [NOTE_A, NOTE_B], current: NOTE_A, navigates: false },
  { action: "close-right", operated: NOTE_B, active: NOTE_D, survive: [NOTE_A, NOTE_B], current: NOTE_B, navigates: true },
];

export async function registerTabsBulkCloseChecks(ctx, options = {}) {
  const { check, sleep, page, open, mode, base, vault, browser } = ctx;
  const tamper = options.tamper ?? {};
  const tabMain = (notePath) => page.locator(`#document-tabs .document-tab-main[data-tab-path=${JSON.stringify(notePath)}]`);
  const menuItem = (action) => page.locator(`.tabs-close-menu [data-tab-action="${action}"]`);

  // Everything the assertions read, in one round trip, so a failure can quote the whole strip.
  const readStrip = () => page.evaluate(() => {
    const mains = [...document.querySelectorAll("#document-tabs .document-tab-main")];
    const row = document.querySelector(".document-tab-row");
    const focused = document.activeElement;
    return {
      paths: [...document.querySelectorAll("#document-tabs .document-tab")].map((item) => item.getAttribute("data-tab-path")),
      selected: mains.map((item) => item.getAttribute("aria-selected")),
      tabindex: mains.map((item) => item.getAttribute("tabindex")),
      current: document.querySelector("#current-path").textContent.trim(),
      pathname: location.pathname,
      search: location.search,
      focusPath: focused?.closest?.("#document-tabs") ? focused.getAttribute("data-tab-path") : null,
      focusTag: focused?.tagName ?? null,
      focusClass: typeof focused?.className === "string" ? focused.className : null,
      focusInEditor: Boolean(focused?.closest?.("#editor")),
      tabCount: document.querySelectorAll("#document-tabs .document-tab").length,
      hasDocumentTabs: document.querySelector(".workspace").classList.contains("has-document-tabs"),
      rowDisplay: getComputedStyle(row).display,
    };
  });
  const readMenu = () => page.evaluate(() => {
    const menu = document.querySelector(".tabs-close-menu");
    if (!menu) return null;
    const box = menu.getBoundingClientRect();
    return {
      hidden: menu.hidden,
      role: menu.getAttribute("role"),
      label: menu.getAttribute("aria-label"),
      target: menu.getAttribute("data-tab-menu-target"),
      position: getComputedStyle(menu).position,
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
      viewport: { width: innerWidth, height: innerHeight },
      hitTestAtCentre: document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(12, box.height / 2))?.closest?.(".tabs-close-menu") ? "menu" : "other",
      items: [...menu.querySelectorAll("[data-tab-action]")].map((item) => ({
        action: item.getAttribute("data-tab-action"),
        label: item.textContent,
        role: item.getAttribute("role"),
        type: item.getAttribute("type"),
        disabled: item.disabled,
        ariaDisabled: item.getAttribute("aria-disabled"),
      })),
    };
  });
  const expectMenu = (menu, target, { disabled = [], note = "" } = {}) => {
    assert.equal(menu.hidden, false, `the menu must be open${note}: ${JSON.stringify(menu)}`);
    assert.equal(menu.role, "menu", `role=menu${note}`);
    assert.equal(menu.position, "fixed", `a positional popup is placed from viewport coordinates${note}`);
    assert.equal(menu.target, target, `the menu is bound to the operated tab${note}: ${JSON.stringify(menu)}`);
    assert.match(menu.label, new RegExp(`^${target.replace(/\.md$/, "")}：`), `the menu names the operated tab${note}: ${JSON.stringify(menu)}`);
    assert.deepEqual(menu.items.map((item) => [item.action, item.label, item.role, item.type]), MENU_ITEMS.map(([action, label]) => [action, label, "menuitem", "button"]), `the five actions in contract order${note}`);
    assert.deepEqual(menu.items.map((item) => item.disabled), MENU_ITEMS.map(([action]) => disabled.includes(action)), `the disabled set must follow the plan${note}: ${JSON.stringify(menu.items)}`);
    assert.deepEqual(menu.items.map((item) => item.ariaDisabled), MENU_ITEMS.map(([action]) => String(disabled.includes(action))), `aria-disabled mirrors it${note}`);
    assert.equal(menu.hitTestAtCentre, "menu", `the menu must be the topmost element at its own centre${note}: ${JSON.stringify(menu)}`);
    assert.ok(menu.box.left >= 0 && menu.box.top >= 0 && menu.box.right <= menu.viewport.width && menu.box.bottom <= menu.viewport.height,
      `the menu must be inside the viewport (not clipped)${note}: ${JSON.stringify(menu)}`);
  };
  const waitSettled = async (notePath) => {
    await page.waitForFunction((expected) => document.querySelector("#current-path")?.textContent.trim() === expected, notePath, { timeout: 8000 });
    await page.waitForFunction(() => Boolean(window.__testEditor), null, { timeout: 10000 });
  };
  const openMenu = async (target) => {
    await tabMain(target).click({ button: "right" });
    await page.waitForSelector(".tabs-close-menu:not([hidden])", { timeout: 5000 });
    return readMenu();
  };
  const pick = async (action) => {
    await menuItem(action).click();
    await page.waitForSelector(".tabs-close-menu[hidden]", { timeout: 5000 }).catch(() => {});
    await sleep(120);
  };
  // One deterministic starting point: a hard load of the welcome workspace (the note route is an
  // opaque base64 document id, so the deep link is not hand-built here), then A is opened first
  // and the other three follow in first-open order, so the strip is always [A, B, C, D].
  const hardReset = async () => {
    await page.goto(`${base}/app`);
    await page.waitForSelector(".welcome", { state: "visible", timeout: 10000 });
    await page.waitForSelector(`.note[title="${NOTE_A}"]`, { timeout: 10000 });
  };
  const buildStrip = async (active) => {
    await hardReset();
    // A hard load resets the remembered surface to the reading view, where the editor node is
    // not visible at all; the focus assertions below need the real editor on screen.
    await mode("live");
    for (const notePath of ORDER) await open(notePath);
    await waitSettled(NOTE_D);
    if (active !== NOTE_D) {
      await tabMain(active).click();
      await waitSettled(active);
    }
    // The Explorer's startup resync must not be in flight while a case measures note requests.
    await page.waitForFunction(() => document.querySelector("#live-status")?.dataset?.state === "live", null, { timeout: 15000 }).catch(() => {});
    await sleep(250);
  };
  const readFixture = async () => Promise.all(ORDER.map((notePath) => fs.readFile(path.join(vault, notePath), "utf8")));

  await check("#429: the tab context menu acts on the operated tab and each action closes exactly its set", async () => {
    const filesBefore = await readFixture();
    const deleted = [];
    const onRequest = (request) => { if (request.method() === "DELETE") deleted.push(request.url()); };
    page.on("request", onRequest);
    const seen = [];
    try {
      for (const scenario of MATRIX) {
        await buildStrip(scenario.active);
        const before = await readStrip();
        assert.deepEqual(before.paths, ORDER, `the fixture strip must be [A, B, C, D]: ${JSON.stringify(before)}`);
        assert.equal(before.current, scenario.active, `the fixture document must be the case's active note: ${JSON.stringify(before)}`);
        // The user is working in the editor: a pointer-opened menu must give that focus back.
        await page.locator("#editor .cm-content").click();
        const focusBefore = await page.evaluate(() => ({ tag: document.activeElement?.tagName, inEditor: Boolean(document.activeElement?.closest?.("#editor")) }));
        assert.equal(focusBefore.inEditor, true, "the case starts with the editor focused");

        const menu = await openMenu(scenario.operated);
        expectMenu(menu, scenario.operated);
        const noteRequests = [];
        const documents = [];
        const onCase = (request) => {
          if (request.url().includes("/api/web/v1/note?")) noteRequests.push(new URL(request.url()).searchParams.get("path"));
          if (request.resourceType() === "document") documents.push(request.url());
        };
        page.on("request", onCase);
        await pick(scenario.action);
        await page.waitForFunction((expected) => document.querySelector("#current-path")?.textContent.trim() === expected, scenario.current, { timeout: 8000 }).catch(() => {});
        page.off("request", onCase);
        await sleep(150);

        const after = await readStrip();
        const label = `${scenario.action} on ${scenario.operated} while showing ${scenario.active}`;
        assert.deepEqual(after.paths, scenario.survive, `${label}: the exact surviving set`);
        assert.equal(after.current, scenario.current, `${label}: the committed document`);
        assert.deepEqual(after.selected, after.paths.map((notePath) => String(notePath === scenario.current)), `${label}: aria-selected stays unique and on the shown document`);
        assert.deepEqual(after.tabindex, after.paths.map((notePath) => (notePath === scenario.current ? "0" : "-1")), `${label}: roving tabindex follows the shown document`);
        assert.deepEqual(documents, [], `${label}: the batch never loads a page`);
        assert.equal(after.hasDocumentTabs, true, `${label}: the row stays in the layout while tabs remain`);
        assert.equal(await page.evaluate(() => document.querySelector(".tabs-close-menu")?.hidden), true, `${label}: the menu closed itself`);
        assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest?.(".tabs-close-menu"))), false, `${label}: focus never stays on a hidden menu item`);
        assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest?.("#editor"))), true, `${label}: the editor keeps the focus the menu opened with`);
        if (scenario.navigates) {
          assert.deepEqual([...new Set(noteRequests)].filter((notePath) => notePath !== scenario.active), [scenario.current],
            `${label}: the one navigation the plan decided (fetched: ${JSON.stringify(noteRequests)})`);
        } else {
          assert.deepEqual([...new Set(noteRequests)].filter((notePath) => notePath !== scenario.current), [],
            `${label}: a batch that keeps the shown document opens no other note (fetched: ${JSON.stringify(noteRequests)})`);
        }
        seen.push({ label, paths: after.paths, current: after.current, focus: after.focusClass });
      }
      assert.deepEqual(deleted, [], `no DELETE request may ever leave the page: ${JSON.stringify(deleted)}`);
      assert.deepEqual(await readFixture(), filesBefore, "the Vault files are byte-identical after every batch close");
      await page.screenshot({ path: path.join(ctx.outputRoot, "u51-tabs-bulk-close.png") }).catch(() => {});
      console.log(`u51: ${seen.length} batch-close cases verified ${JSON.stringify(seen)}`);
    } finally {
      page.off("request", onRequest);
    }
  });

  await check("#429: a background-only batch asks no guard, and the disabled items follow the plan", async () => {
    // Two tabs, and Close Left on the first one: nothing to remove, so the item is disabled and
    // picking is impossible — a disabled action must never be reported as a successful close.
    await hardReset();
    await mode("live");
    await open(NOTE_A);
    await waitSettled(NOTE_A);
    await open(NOTE_B);
    await waitSettled(NOTE_B);
    // The editor must own the focus *before* the menu opens: any pointer action afterwards would
    // dismiss the menu (its outside-press rule), which is exactly what the menu is meant to do.
    await page.locator("#editor .cm-content").click();
    const twoTab = await openMenu(NOTE_A);
    expectMenu(twoTab, NOTE_A, { disabled: ["close-left"] });
    assert.equal(await menuItem("close-left").isDisabled(), true);
    // Close Right on the first tab removes only the background B, so A must stay on screen and
    // the editor must keep the caret; no dialog and no note request may happen.
    const dialogsBefore = ctx.dialogs.length;
    const noteRequests = [];
    const onCase = (request) => { if (request.url().includes("/api/web/v1/note?")) noteRequests.push(new URL(request.url()).searchParams.get("path")); };
    page.on("request", onCase);
    await pick("close-right");
    await sleep(250);
    page.off("request", onCase);
    const after = await readStrip();
    assert.deepEqual(after.paths, [NOTE_A], `Close Right on the first tab removed the background tab: ${JSON.stringify(after)}`);
    assert.equal(after.current, NOTE_A, "the shown document is untouched");
    assert.equal(after.tabCount, 1);
    assert.equal(after.hasDocumentTabs, true, "the row is still in the layout for the one remaining tab");
    assert.deepEqual([...new Set(noteRequests)].filter((notePath) => notePath !== after.current), [],
      `a background-only batch opens no other note (fetched: ${JSON.stringify(noteRequests)})`);
    assert.equal(ctx.dialogs.length, dialogsBefore, "a background-only batch asks no unsaved-changes guard");
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest?.("#editor"))), true, "the editor keeps the focus");

    // With a single tab left, Close Others / Left / Right are disabled while Close and Close All
    // still remove that one tab.
    const single = await openMenu(NOTE_A);
    expectMenu(single, NOTE_A, { disabled: ["close-others", "close-left", "close-right"] });
    await page.keyboard.press("Escape");
    await sleep(120);
    assert.equal((await readMenu()).hidden, true, "Escape closes the menu");

    // Close All on the last tab reaches the in-app welcome workspace without a page load.
    const documents = [];
    const onDocument = (request) => { if (request.resourceType() === "document") documents.push(request.url()); };
    page.on("request", onDocument);
    await openMenu(NOTE_A);
    await pick("close-all");
    await page.waitForSelector(".welcome", { state: "visible", timeout: 5000 });
    await sleep(200);
    page.off("request", onDocument);
    const welcome = await readStrip();
    assert.deepEqual(documents, [], "the welcome workspace is built in place");
    assert.deepEqual(welcome.paths, []);
    assert.equal(welcome.tabCount, 0);
    assert.equal(welcome.hasDocumentTabs, false, "the second chrome band leaves the layout with the last tab");
    assert.equal(welcome.rowDisplay, "none");
    assert.equal(welcome.current, "尚未打开笔记");
  });

  await check("#429: a refused unsaved-changes guard removes zero tabs and keeps the document, address and focus", async () => {
    // The shared page auto-accepts dialogs; this check observes a refused one, so it takes the
    // handler over and restores the suite's accept-and-record handler in the finally block.
    page.removeAllListeners("dialog");
    const observed = [];
    let answer = "dismiss";
    page.on("dialog", async (dialog) => { observed.push({ type: dialog.type(), message: dialog.message(), answer }); if (answer === "accept") await dialog.accept(); else await dialog.dismiss(); });
    try {
      await buildStrip(NOTE_A);
      if (tamper.disableDirtyGuard) {
        // Negative-control only: the guard is forced to say yes, so the refusal path cannot run.
        await page.evaluate(() => { window.confirm = () => true; });
      }
      await mode("live");
      const dispatched = await page.evaluate(() => {
        const view = window.__testEditor?._view;
        if (!view) return false;
        view.dispatch({ changes: { from: 0, insert: "U51 dirty edit\n" } });
        return true;
      });
      assert.equal(dispatched, true, "the dirty edit went into the real editor");
      await page.waitForFunction(() => document.querySelector("#status").textContent.trim() === "尚未保存", null, { timeout: 5000 });
      const dirtyFile = await fs.readFile(path.join(vault, NOTE_A), "utf8");

      // (1) Close Others on a background tab while the shown document is dirty and refuses.
      await page.locator("#editor .cm-content").click();
      const before = await readStrip();
      const urlBefore = page.url();
      await openMenu(NOTE_B);
      await pick("close-others");
      const refused = await readStrip();
      assert.equal(observed.length, 1, `the guard was asked exactly once: ${JSON.stringify(observed)}`);
      assert.equal(observed[0].type, "confirm", `the shared guard uses the native confirm: ${JSON.stringify(observed)}`);
      assert.match(observed[0].message, new RegExp(`^${UNSAVED_PREFIX}`), `the shared guard message: ${JSON.stringify(observed)}`);
      assert.deepEqual(refused.paths, before.paths, `a refused batch removes zero tabs: ${JSON.stringify(refused)}`);
      assert.equal(refused.current, NOTE_A, "and keeps the document on screen");
      // The refusal must not strand the focus on the strip: the menu gives back the focus owner
      // it opened with (the editor here), never a tab and never a hidden menu item.
      assert.equal(refused.focusInEditor, true, `and gives the editor its focus back: ${JSON.stringify(refused)}`);
      assert.equal(page.url(), urlBefore, "and leaves the address alone");
      assert.equal(await page.locator("#status").textContent(), "尚未保存", "the document is still dirty");
      assert.equal(await page.evaluate(() => window.__testEditor.getValue().startsWith("U51 dirty edit")), true, "the unsaved buffer is intact");
      assert.equal(await fs.readFile(path.join(vault, NOTE_A), "utf8"), dirtyFile, "and nothing was written to disk");

      // (2) Close All with the same dirty document: refused, so neither the welcome workspace nor
      //     a single tab may appear. The `.welcome` node always exists in the SSR reading pane,
      //     so the witness is its real layout box, exactly like the #410 scene reads it.
      await openMenu(NOTE_B);
      await pick("close-all");
      const refusedAll = await readStrip();
      const welcomeBox = await page.evaluate(() => document.querySelector(".welcome")?.getBoundingClientRect().height ?? 0);
      assert.equal(observed.length, 2, `the last close asked the same guard: ${JSON.stringify(observed)}`);
      assert.deepEqual(refusedAll.paths, before.paths, "a refused Close All removes zero tabs");
      assert.equal(refusedAll.current, NOTE_A);
      assert.equal(welcomeBox, 0, `no welcome workspace is on screen without an accepted guard: ${JSON.stringify(refusedAll)}`);
      assert.equal(refusedAll.pathname.startsWith("/app/note"), true, `the address stays on the note: ${JSON.stringify(refusedAll)}`);

      // (3) The same Close All, accepted, commits the in-app transition and empties the strip.
      answer = "accept";
      await openMenu(NOTE_B);
      await pick("close-all");
      await page.waitForSelector(".welcome", { state: "visible", timeout: 5000 });
      await sleep(200);
      const committed = await readStrip();
      assert.equal(observed.length, 3);
      assert.deepEqual(committed.paths, [], "the accepted Close All empties the strip");
      // The committed welcome address must carry the trailing slash: the installed app resolves its
      // manifest `scope` to `/app/`, so a slash-less `/app` would leave the scope on reload/Forward
      // (#471). A regression to `location.replace("/app")` or `WELCOME_ROUTE = "/app"` fails here.
      assert.equal(committed.pathname, "/app/", `the welcome route is committed: ${JSON.stringify(committed)}`);
      assert.equal(committed.hasDocumentTabs, false);
      assert.equal(await fs.readFile(path.join(vault, NOTE_A), "utf8"), dirtyFile, "the Vault file is still untouched by a close");
    } finally {
      page.removeAllListeners("dialog");
      page.on("dialog", (dialog) => { ctx.dialogs.push({ type: dialog.type(), message: dialog.message() }); void dialog.accept(); });
      await page.evaluate(() => { delete window.confirm; }).catch(() => {});
    }
  });

  await check("#429: the menu is keyboard- and touch-reachable and follows the popup dismissal rules", async () => {
    await buildStrip(NOTE_A);
    assert.deepEqual((await readStrip()).paths, ORDER, "the keyboard case starts from [A, B, C, D]");
    // Keyboard: Shift+F10 on the focused tab opens the menu for that tab and lands on its first
    // enabled item; Escape closes it and hands the focus back to the operated tab.
    await tabMain(NOTE_C).focus();
    await page.keyboard.press("Shift+F10");
    await page.waitForSelector(".tabs-close-menu:not([hidden])", { timeout: 5000 });
    const viaKeyboard = await readMenu();
    expectMenu(viaKeyboard, NOTE_C, { note: ` (strip: ${JSON.stringify((await readStrip()).paths)})` });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute?.("data-tab-action") ?? null), "close", "a keyboard open lands on the first enabled item");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute?.("data-tab-action") ?? null), "close-others", "ArrowDown walks the enabled items");
    await page.keyboard.press("Escape");
    await sleep(150);
    assert.equal((await readMenu()).hidden, true, "Escape closes the menu");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute?.("data-tab-path") ?? null), NOTE_C, "Escape hands the focus back to the operated tab");
    assert.deepEqual((await readStrip()).paths, ORDER, "no action ran");

    // The ContextMenu key is the second keyboard entry point.
    await tabMain(NOTE_D).focus();
    await page.keyboard.press("ContextMenu");
    await page.waitForSelector(".tabs-close-menu:not([hidden])", { timeout: 5000 });
    expectMenu(await readMenu(), NOTE_D, { disabled: ["close-right"], note: ` (strip: ${JSON.stringify((await readStrip()).paths)})` });

    // A pointer press outside closes it; so do a scroll and a resize, because a positional popup
    // is out of date the moment its anchor moves.
    await page.locator(".topbar").click({ position: { x: 4, y: 4 } });
    await sleep(150);
    assert.equal((await readMenu()).hidden, true, "a press outside closes the menu");
    await openMenu(NOTE_C);
    // A real scroll of the document surface: the witness must really move (the control), and the
    // positional menu must leave with it instead of hanging over a moved anchor.
    const scrolled = await page.evaluate(() => {
      const node = document.querySelector(".cm-scroller") ?? document.querySelector(".markdown-preview-view");
      if (!node) return null;
      const before = node.scrollTop;
      node.scrollTop = 200;
      return { before, after: node.scrollTop };
    });
    assert.ok(scrolled && scrolled.after > scrolled.before, `the scroll witness must really move: ${JSON.stringify(scrolled)}`);
    await sleep(250);
    assert.equal((await readMenu()).hidden, true, "a scroll closes the menu");
    await openMenu(NOTE_C);
    await page.setViewportSize({ width: 1280, height: 900 });
    await sleep(250);
    assert.equal((await readMenu()).hidden, true, "a resize closes the menu");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await sleep(250);
    assert.deepEqual((await readStrip()).paths, ORDER, "the probes changed no tab");

    // The touch half of the contract lives in its own check/module (a phone context, trusted CDP
    // touch input): a held press on a background tab must open the same menu, and a tap on its
    // Close Others item must run the same batch.
  });

  await check("#429 fix: a re-render under the open menu keeps the focus return connected", async () => {
    // The review's first finding, reproduced exactly: two tabs with B on screen, focus on A,
    // Shift+F10 opens the menu for A; the browser then goes back to A, which re-renders the whole
    // strip; Escape must hand the focus to the A button that is *in the document*. Before the fix the
    // saved A button was detached, and Escape left `document.activeElement` on BODY.
    await hardReset();
    await mode("live");
    await open(NOTE_A);
    await waitSettled(NOTE_A);
    await open(NOTE_B);
    await waitSettled(NOTE_B);
    const before = await readStrip();
    assert.deepEqual(before.paths, [NOTE_A, NOTE_B], `the case starts from [A, B]: ${JSON.stringify(before)}`);
    assert.equal(before.current, NOTE_B, "B is the document on screen");

    await tabMain(NOTE_A).focus();
    // Two witnesses that the navigation below really rebuilt the strip: a live reference and a mark.
    await page.evaluate(() => {
      const anchor = document.querySelector('#document-tabs .document-tab-main[data-tab-path="A.md"]');
      anchor.setAttribute("data-u51-repaint-witness", "1");
      window.__u51StaleAnchor = anchor;
    });
    await page.keyboard.press("Shift+F10");
    await page.waitForSelector(".tabs-close-menu:not([hidden])", { timeout: 5000 });
    assert.equal((await readMenu()).target, NOTE_A, "the menu is bound to the operated tab");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute?.("data-tab-action") ?? null), "close", "the keyboard open lands on the first enabled item");

    // A real history navigation shows A again: the app commits that identity and re-renders the strip.
    await page.goBack();
    await page.waitForFunction((expected) => document.querySelector("#current-path")?.textContent.trim() === expected, NOTE_A, { timeout: 8000 });
    await sleep(250);
    const repaint = await page.evaluate(() => ({
      markedInStrip: document.querySelectorAll("#document-tabs [data-u51-repaint-witness]").length,
      staleConnected: window.__u51StaleAnchor ? window.__u51StaleAnchor.isConnected : null,
      staleIsCurrentA: window.__u51StaleAnchor === document.querySelector('#document-tabs .document-tab-main[data-tab-path="A.md"]'),
      liveA: Boolean(document.querySelector('#document-tabs .document-tab-main[data-tab-path="A.md"]')),
      menuHidden: document.querySelector(".tabs-close-menu")?.hidden ?? null,
      menuTarget: document.querySelector(".tabs-close-menu")?.getAttribute("data-tab-menu-target") ?? null,
      paths: [...document.querySelectorAll("#document-tabs .document-tab")].map((row) => row.getAttribute("data-tab-path")),
    }));
    console.log(`u51 fix witness (repaint): ${JSON.stringify(repaint)}`);
    assert.equal(repaint.liveA, true, `the strip shows A again: ${JSON.stringify(repaint)}`);
    assert.equal(repaint.markedInStrip, 0, `the marked A button is gone from the strip: ${JSON.stringify(repaint)}`);
    assert.notEqual(repaint.staleConnected, true, `the saved A button must not still be connected: ${JSON.stringify(repaint)}`);
    assert.notEqual(repaint.staleIsCurrentA, true, "and it is not the A button the strip shows now");
    assert.equal(repaint.menuTarget, NOTE_A, `the open menu still names the operated tab: ${JSON.stringify(repaint)}`);
    assert.equal(repaint.menuHidden, false, "an open menu survives a repaint of its own anchor");
    assert.deepEqual(repaint.paths, [NOTE_A, NOTE_B], "the navigation closed nothing");

    await page.keyboard.press("Escape");
    await sleep(200);
    const afterEscape = await page.evaluate(() => ({
      hidden: document.querySelector(".tabs-close-menu")?.hidden ?? null,
      isBody: document.activeElement === document.body,
      connected: document.activeElement?.isConnected === true,
      tag: document.activeElement?.tagName ?? null,
      className: typeof document.activeElement?.className === "string" ? document.activeElement.className : null,
      path: document.activeElement?.getAttribute?.("data-tab-path") ?? null,
      inStrip: Boolean(document.activeElement?.closest?.("#document-tabs")),
      isLiveA: document.activeElement === document.querySelector('#document-tabs .document-tab-main[data-tab-path="A.md"]'),
    }));
    console.log(`u51 fix witness (escape): ${JSON.stringify(afterEscape)}`);
    assert.equal(afterEscape.hidden, true, `Escape closes the menu: ${JSON.stringify(afterEscape)}`);
    assert.equal(afterEscape.isBody, false, `Escape never drops the focus on BODY: ${JSON.stringify(afterEscape)}`);
    assert.equal(afterEscape.connected, true, `the focus owner is still in the document: ${JSON.stringify(afterEscape)}`);
    assert.equal(afterEscape.inStrip, true, `and it is the strip's own tab button: ${JSON.stringify(afterEscape)}`);
    assert.equal(afterEscape.path, NOTE_A, `Escape hands the focus back to the operated tab: ${JSON.stringify(afterEscape)}`);
    assert.equal(afterEscape.isLiveA, true, `the live A button, never the detached one: ${JSON.stringify(afterEscape)}`);
    assert.deepEqual((await readStrip()).paths, [NOTE_A, NOTE_B], "no action ran");
  });

  // The review's third round: a menu closed after a history navigation must not return the focus
  // to an origin the shell has hidden meanwhile. Registered before the touch scene, which must
  // stay the last scene of this module (it leaves the shared page on A.md for the scenes after).
  await registerTabsBulkCloseHiddenOriginChecks({ check, sleep, page, open, mode, base, vault });
  await registerTabsBulkCloseTouchChecks({ check, sleep, page, browser, base, open, waitSettled });
}
