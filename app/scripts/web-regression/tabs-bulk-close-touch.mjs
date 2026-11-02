// #429 — the touch half of the tab strip's batch close, on a real phone viewport.
//
// The issue requires a touch-reachable entry, not only a desktop right button, so this scene is a
// 390x844 `hasTouch` / `isMobile` context driving *trusted* touch input through CDP
// (`Input.dispatchTouchEvent`, the channel `touchscreen.tap` uses): a plain tap first proves the
// gesture pipeline really reaches the strip, then a held press (~700 ms, past the 500 ms long-press
// threshold) must open the same menu for the pressed background tab.
//
// Witnesses: the menu's own target/hidden attributes (a MutationObserver over the gesture window),
// the strip's real pointer/touch/click stream, `#current-path` for "the trailing click did not also
// activate the tab", a hit test for the press point and for the tap control, and the menu's box
// against the viewport for "not clipped on a phone".
//
// The second check is the review's second finding: the same held press, but on the row's close
// control, must open the menu *without* also closing the tab — while a plain tap on that control
// still closes it. Both are driven by trusted CDP touch input and real waits, never injected timers.
//
// Split out of tabs-bulk-close.mjs to keep both modules inside the architecture line budget;
// `registerTabsBulkCloseChecks` calls it, so the suite entry point still registers everything.
import assert from "node:assert/strict";

const PHONE = { width: 390, height: 844 };
const DRAWER_SETTLE_MS = 260; // the drawer transform transition is 160 ms
const HOLD_MS = 700; // > the 500 ms long-press threshold
const NOTE_A = "A.md";
const NOTE_B = "B.md";

// A phone context with A and B open and the drawer closed, plus the errors of that page.
async function openPhoneStrip({ browser, page, base, sleep }) {
  const phone = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  const touchPage = await phone.newPage();
  touchPage.setDefaultTimeout(7000);
  const pageErrors = [];
  touchPage.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
  await phone.addCookies(await page.context().cookies());
  await touchPage.goto(`${base}/app`);
  await touchPage.waitForSelector(`.note[title="${NOTE_A}"]`, { timeout: 10000 });
  // On a phone the Explorer is a drawer: it must be really open before a note can be picked.
  const drawerOpen = () => touchPage.evaluate(() => document.querySelector(".shell").classList.contains("sidebar-open"));
  const setDrawer = async (wanted) => {
    if (await drawerOpen() !== wanted) {
      await touchPage.locator("#menu").click();
      await sleep(DRAWER_SETTLE_MS);
    }
  };
  for (const notePath of [NOTE_A, NOTE_B]) {
    await setDrawer(true);
    await touchPage.locator(`.note[title="${notePath}"]`).click();
    await touchPage.waitForFunction((expected) => document.querySelector("#current-path")?.textContent.trim() === expected, notePath, { timeout: 10000 });
  }
  await setDrawer(false);
  return { phone, touchPage, pageErrors };
}

// What every assertion above reads, in one round trip.
const readTouchStrip = (touchPage) => touchPage.evaluate(() => ({
  paths: [...document.querySelectorAll("#document-tabs .document-tab")].map((row) => row.getAttribute("data-tab-path")),
  selected: [...document.querySelectorAll("#document-tabs .document-tab-main")].map((item) => item.getAttribute("aria-selected")),
  current: document.querySelector("#current-path").textContent.trim(),
  menuHidden: document.querySelector(".tabs-close-menu")?.hidden ?? null,
  menuTarget: document.querySelector(".tabs-close-menu")?.getAttribute("data-tab-menu-target") ?? null,
  pointerTrace: window.__u51PointerTrace ?? [],
  menuTrace: window.__u51MenuTrace ?? [],
}));

// A press point a real hit test proves lands on `notePath` — and, with `closeIndex`, on that row's
// close control. The drawer's close is a transform transition, so the first measurement can still
// be the moving layout: every attempt is reported when none lands.
async function pointOnStrip({ touchPage, sleep, selector, notePath, closeIndex = null }) {
  const attempts = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const box = await touchPage.locator(selector).boundingBox();
    if (!box) { await sleep(100); continue; }
    const candidate = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    const probe = await touchPage.evaluate(({ x, y }) => {
      const node = document.elementFromPoint(x, y);
      return {
        className: typeof node?.className === "string" ? node.className : null,
        path: node?.closest?.("[data-tab-path]")?.getAttribute("data-tab-path") ?? null,
        close: node?.closest?.("[data-tab-close]")?.getAttribute("data-tab-close") ?? null,
      };
    }, candidate);
    attempts.push({ candidate, probe, box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } });
    if (probe.path === notePath && (closeIndex === null || probe.close === closeIndex)) return candidate;
    await sleep(120);
  }
  throw new Error(`no touch point landed on ${notePath}${closeIndex === null ? "" : ` close control ${closeIndex}`}: ${JSON.stringify(attempts)}`);
}

export async function registerTabsBulkCloseTouchChecks({ check, sleep, page, browser, base, open, waitSettled }) {
  await check("#429: a held touch press opens the tab menu and its action runs the same batch", async () => {
    const { phone, touchPage, pageErrors } = await openPhoneStrip({ browser, page, base, sleep });
    try {
      assert.deepEqual((await readTouchStrip(touchPage)).paths, [NOTE_A, NOTE_B], "the phone strip holds the two opened notes");

      const cdp = await phone.newCDPSession(touchPage);
      const point = await pointOnStrip({ touchPage, sleep, selector: `#document-tabs .document-tab-main[data-tab-path="${NOTE_A}"]`, notePath: NOTE_A });
      // Record the strip's real gesture stream and the menu's own state through the whole press.
      await touchPage.evaluate(() => {
        window.__u51MenuTrace = [];
        window.__u51PointerTrace = [];
        const strip = document.querySelector("#document-tabs");
        for (const type of ["pointerdown", "pointerup", "pointercancel", "touchstart", "touchend"]) {
          strip.addEventListener(type, (event) => window.__u51PointerTrace.push({ type, pointerType: event.pointerType ?? null, target: typeof event.target?.className === "string" ? event.target.className : null, at: Math.round(performance.now()) }), true);
        }
        // Bubble phase, registered after the strip's own handler: what the app left the event as.
        strip.addEventListener("click", (event) => window.__u51PointerTrace.push({ type: "click:after", target: typeof event.target?.className === "string" ? event.target.className : null, defaultPrevented: event.defaultPrevented, tabPath: event.target?.closest?.("[data-tab-path]")?.getAttribute("data-tab-path") ?? null, at: Math.round(performance.now()) }), false);
        const menu = document.querySelector(".tabs-close-menu");
        if (menu) new MutationObserver(() => window.__u51MenuTrace.push({ hidden: menu.hidden, target: menu.getAttribute("data-tab-menu-target"), at: Math.round(performance.now()) }))
          .observe(menu, { attributes: true, attributeFilter: ["hidden", "data-tab-menu-target"] });
      });

      // Control: a plain tap on the strip's own empty area (never on a tab, so it cannot select
      // one) must reach the strip as a real touch gesture. Without that control the held press
      // below could not be trusted.
      const stripBox = await touchPage.locator("#document-tabs").boundingBox();
      const controlPoint = { x: Math.round(stripBox.x + stripBox.width - 12), y: Math.round(stripBox.y + stripBox.height / 2) };
      const controlHit = await touchPage.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className ?? "", controlPoint);
      assert.equal(controlHit, "document-tabs", `the control tap must land on the strip itself, never on a tab: ${JSON.stringify({ controlPoint, controlHit })}`);
      await touchPage.touchscreen.tap(controlPoint.x, controlPoint.y);
      await sleep(250);
      const controlTrace = await touchPage.evaluate(() => window.__u51PointerTrace ?? []);
      assert.ok(controlTrace.some((entry) => entry.type === "pointerdown") && controlTrace.some((entry) => entry.type === "click:after"),
        `the tap control must reach the strip: ${JSON.stringify({ controlPoint, controlTrace })}`);
      await touchPage.evaluate(() => { window.__u51PointerTrace = []; window.__u51MenuTrace = []; });

      const currentBeforeHold = (await readTouchStrip(touchPage)).current;
      assert.equal(currentBeforeHold, NOTE_B, "the held press starts from the document the strip shows");
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] });
      await sleep(HOLD_MS);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await touchPage.waitForSelector(".tabs-close-menu:not([hidden])", { timeout: 5000 }).catch(async (error) => {
        const dump = await readTouchStrip(touchPage);
        throw new Error(`${error.message} :: held-press dump ${JSON.stringify(dump)}`);
      });
      const touchMenu = await touchPage.evaluate(() => {
        const menu = document.querySelector(".tabs-close-menu");
        const box = menu.getBoundingClientRect();
        return {
          target: menu.getAttribute("data-tab-menu-target"),
          role: menu.getAttribute("role"),
          items: [...menu.querySelectorAll("[data-tab-action]")].map((item) => [item.getAttribute("data-tab-action"), item.disabled]),
          box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
          viewport: { width: innerWidth, height: innerHeight },
          current: document.querySelector("#current-path").textContent.trim(),
          paths: [...document.querySelectorAll("#document-tabs .document-tab")].map((row) => row.getAttribute("data-tab-path")),
        };
      });
      assert.equal(touchMenu.target, NOTE_A, `the held press opens the menu for the pressed tab: ${JSON.stringify(touchMenu)}`);
      assert.equal(touchMenu.role, "menu");
      assert.deepEqual(touchMenu.items, [["close", false], ["close-others", false], ["close-left", true], ["close-right", false], ["close-all", false]],
        `the phone menu carries the same five actions with the same plan-driven disabled set: ${JSON.stringify(touchMenu.items)}`);
      assert.equal(touchMenu.current, currentBeforeHold, `the held press does not also activate the tab: ${JSON.stringify(touchMenu)}`);
      assert.deepEqual(touchMenu.paths, [NOTE_A, NOTE_B], "and does not close anything by itself");
      assert.ok(touchMenu.box.left >= 0 && touchMenu.box.top >= 0 && touchMenu.box.right <= touchMenu.viewport.width && touchMenu.box.bottom <= touchMenu.viewport.height,
        `the touch menu must not be clipped on a phone viewport: ${JSON.stringify(touchMenu)}`);

      // A real tap on a menu item runs the batch (Close Others keeps the pressed background tab).
      const itemBox = await touchPage.locator('.tabs-close-menu [data-tab-action="close-others"]').boundingBox();
      await touchPage.touchscreen.tap(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2);
      await touchPage.waitForFunction((expected) => document.querySelector("#current-path")?.textContent.trim() === expected, NOTE_A, { timeout: 10000 });
      const afterTouch = await readTouchStrip(touchPage);
      assert.deepEqual(afterTouch.paths, [NOTE_A], `a tap on Close Others keeps the pressed tab only: ${JSON.stringify(afterTouch)}`);
      assert.deepEqual(afterTouch.selected, ["true"], "and the kept tab is the one the document shows");
      assert.equal(afterTouch.menuHidden, true, "the tapped menu closed");
      assert.equal(afterTouch.pointerTrace.some((entry) => entry.type === "click:after" && entry.defaultPrevented === true), true,
        `the held press's own click was swallowed, never a tab activation: ${JSON.stringify(afterTouch.pointerTrace)}`);
      assert.deepEqual(pageErrors, [], "no page error in the touch scene");
    } finally {
      await phone.close();
    }
    // Leave the shared page as the scenes after this one expect it: A.md open and clean.
    await page.goto(`${base}/app`);
    await page.waitForSelector(`.note[title="${NOTE_A}"]`, { timeout: 10000 });
    await open(NOTE_A);
    await waitSettled(NOTE_A);
  });

  await check("#429 fix: a held press on a tab's close control opens the menu without also closing the tab", async () => {
    const { phone, touchPage, pageErrors } = await openPhoneStrip({ browser, page, base, sleep });
    try {
      const before = await readTouchStrip(touchPage);
      assert.deepEqual(before.paths, [NOTE_A, NOTE_B], `the phone strip holds the two opened notes: ${JSON.stringify(before)}`);
      assert.equal(before.current, NOTE_B, "the press starts from the document the strip shows");
      assert.equal(before.menuHidden, true, "no menu is open before the press");

      // Trusted touch input on the row's close control, held past the long-press threshold. The
      // press point is a real hit test on that control (`data-tab-close="0"`), not the tab's centre.
      const cdp = await phone.newCDPSession(touchPage);
      const closeSelector = '#document-tabs .document-tab-close[data-tab-close="0"]';
      const point = await pointOnStrip({ touchPage, sleep, selector: closeSelector, notePath: NOTE_A, closeIndex: "0" });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] });
      await sleep(HOLD_MS);
      const held = await readTouchStrip(touchPage);
      assert.equal(held.menuHidden, false, `the held press opens the menu: ${JSON.stringify(held)}`);
      assert.equal(held.menuTarget, NOTE_A, `and it is bound to the pressed tab: ${JSON.stringify(held)}`);
      assert.deepEqual(held.paths, [NOTE_A, NOTE_B], `the hold itself closes nothing: ${JSON.stringify(held)}`);

      // The lift turns the gesture into a click on that same control. It is the tail of the menu
      // gesture, so it must be swallowed: one gesture cannot both open the menu and close the tab.
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await sleep(400);
      const lifted = await readTouchStrip(touchPage);
      assert.deepEqual(lifted.paths, [NOTE_A, NOTE_B], `the trailing click never also closes the tab: ${JSON.stringify(lifted)}`);
      assert.equal(lifted.current, NOTE_B, `and never switches the document: ${JSON.stringify(lifted)}`);
      assert.equal(lifted.menuHidden, false, `the menu the gesture opened is still usable: ${JSON.stringify(lifted)}`);

      // The plain close keeps its meaning: a real tap on the same control closes its tab once, and
      // the menu that operated on it goes with it.
      const tapPoint = await pointOnStrip({ touchPage, sleep, selector: closeSelector, notePath: NOTE_A, closeIndex: "0" });
      await touchPage.touchscreen.tap(tapPoint.x, tapPoint.y);
      await touchPage.waitForFunction(() => [...document.querySelectorAll("#document-tabs .document-tab")].map((row) => row.getAttribute("data-tab-path")).join(",") === "B.md",
        null, { timeout: 7000 });
      await sleep(200);
      const after = await readTouchStrip(touchPage);
      assert.deepEqual(after.paths, [NOTE_B], `a plain tap on the close control still closes its tab: ${JSON.stringify(after)}`);
      assert.equal(after.menuHidden, true, "and the menu of the removed tab is closed");
      assert.deepEqual(pageErrors, [], "no page error in the touch scene");
    } finally {
      await phone.close();
    }
    // Leave the shared page as the scenes after this one expect it: A.md open and clean.
    await page.goto(`${base}/app`);
    await page.waitForSelector(`.note[title="${NOTE_A}"]`, { timeout: 10000 });
    await open(NOTE_A);
    await waitSettled(NOTE_A);
  });
}
