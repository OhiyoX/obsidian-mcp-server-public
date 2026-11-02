// Issue #371 (U29) — the Web mobile shell reflow, in the real-Chromium mobile scene.
//
// The shell half of the mobile matrix: one unconditional chrome band (`<=720px`: the topbar,
// with the rail's show/hide control in it), a document tab row that only enters the layout while
// the strip has a tab, two side drawers that share one scrim and exclude each other, two side
// pane headers of the same shape, and exactly one owner of the notch inset.
//
// It runs in its own contexts (390x844 `hasTouch` / `isMobile` / `pointer: coarse` for the phone
// half, 1440x1000 for the desktop contrast) against the shared fixture Vault server, with the
// harness cookies, so neither the shared page nor the other scenes are touched. Everything
// asserted here is a real browser observation: computed styles, bounding rects, `elementFromPoint`
// hit testing, class/ARIA state and an injected non-zero top inset. Measurements land in
// <outputRoot>/mobile-shell-trace.json, and every check is red on the pre-#371 shell (the welcome
// page carried a second, empty bar with an orphan toggle; `<=720px` allowed both drawers at once;
// the tab row was unconditional; no band owned the inset channel; the no-note rail said less).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1440, height: 1000 };
const DRAWER_SETTLE_MS = 260; // the drawer transform transition is 160 ms

export async function registerMobileShellChecks(ctx) {
  const { check, sleep, page: sharedPage, browser, base, outputRoot } = ctx;

  const trace = { startedAt: Date.now(), base, viewports: { mobile: MOBILE_VIEWPORT, desktop: DESKTOP_VIEWPORT }, phases: [] };
  const phone = await browser.newContext({ viewport: MOBILE_VIEWPORT, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  const desktop = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
  const pageErrors = [];
  const page = await phone.newPage();
  const wide = await desktop.newPage();
  try {
    const cookies = await sharedPage.context().cookies();
    await phone.addCookies(cookies);
    await desktop.addCookies(cookies);
    page.setDefaultTimeout(7000);
    wide.setDefaultTimeout(7000);
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
    wide.on('pageerror', (error) => pageErrors.push(error.stack || error.message));

    // One snapshot of everything the shell checks read, taken inside the page, so a failure can
    // quote the whole observed state instead of only the field it asserted on.
    const snapshot = (target = page) => target.evaluate(() => {
      const shell = document.querySelector('.shell');
      const visible = (el) => Boolean(el) && el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none';
      const rect = (el) => {
        if (!el) return null;
        const box = el.getBoundingClientRect();
        return { top: box.top, left: box.left, width: box.width, height: box.height, bottom: box.bottom };
      };
      const toggle = document.querySelector('#sidebar-toggle');
      const row = document.querySelector('.document-tab-row');
      return {
        url: location.pathname,
        shellClasses: [...shell.classList],
        sidebarOpen: shell.classList.contains('sidebar-open'),
        contextOpen: shell.classList.contains('context-open'),
        contextHidden: shell.classList.contains('context-hidden'),
        hasDocumentTabs: document.querySelector('.workspace').classList.contains('has-document-tabs'),
        visibleChrome: [...document.querySelectorAll('.topbar, .document-tab-row')].filter(visible).map((el) => el.className.split(' ')[0]),
        topbar: rect(document.querySelector('.topbar')),
        row: rect(row),
        rowDisplay: getComputedStyle(row).display,
        tabCount: document.querySelectorAll('#document-tabs .document-tab').length,
        sidebarVisible: visible(document.querySelector('.sidebar')),
        contextVisible: visible(document.querySelector('#context-sidebar')),
        scrimCount: document.querySelectorAll('.scrim').length,
        toggleCount: document.querySelectorAll('#sidebar-toggle').length,
        toggle: rect(toggle),
        toggleVisible: visible(toggle),
        togglePressed: toggle?.getAttribute('aria-pressed') ?? null,
        toggleTitle: toggle?.getAttribute('title') ?? null,
        toggleControls: toggle?.getAttribute('aria-controls') ?? null,
        toggleGlyph: toggle?.querySelector('use')?.getAttribute('href') ?? null,
        // U38 (#571): the client resolver (`ui/icons.js`) reads this back, so the assertion
        // below ties every runtime-built glyph to the shell's published URL.
        spriteUrl: document.documentElement.getAttribute('data-icon-sprite'),
        toggleInTopbar: Boolean(toggle?.closest('.topbar')),
        toggleInRow: Boolean(toggle?.closest('.document-tab-row')),
        toggleInRail: Boolean(toggle?.closest('#context-sidebar')),
        toggleInScrim: Boolean(toggle?.closest('.scrim')),
      };
    });
    const record = async (tag, target = page) => {
      const state = await snapshot(target);
      trace.phases.push({ check: tag, at: Date.now(), state });
      return state;
    };

    // The drawer entry points are the real controls: the topbar hamburger (left) and the topbar
    // rail toggle (right). Nothing is driven by setting classes from the outside.
    const openLeft = async () => { await page.locator('#menu').click(); await sleep(DRAWER_SETTLE_MS); };
    const openRight = async () => { await page.locator('#sidebar-toggle').click(); await sleep(DRAWER_SETTLE_MS); };
    const closeIfOpen = async (side) => {
      const property = side === 'left' ? 'sidebarOpen' : 'contextOpen';
      if ((await snapshot())[property]) await clickScrim(side);
    };
    // The shared scrim is only the strip the open drawer does not cover, so the click lands on the
    // overlay itself: proven with `elementFromPoint` before the click, never assumed.
    const clickScrim = async (side) => {
      const point = side === 'left' ? { x: MOBILE_VIEWPORT.width - 20, y: 620 } : { x: 20, y: 620 };
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className ?? '', point);
      assert.match(hit, /scrim/, `the shared scrim must be the topmost element at ${JSON.stringify(point)} (hit: ${hit})`);
      await page.mouse.click(point.x, point.y);
      await sleep(DRAWER_SETTLE_MS);
    };
    const welcome = async () => {
      await page.goto(`${base}/app`);
      await page.waitForSelector('.welcome', { state: 'visible' });
      await sleep(120);
    };
    const withNote = async () => {
      await welcome();
      await openLeft();
      await page.locator('.note[title="A.md"]').click();
      await page.waitForFunction(() => document.querySelectorAll('#document-tabs .document-tab').length > 0);
      await closeIfOpen('left');
    };

    await check('mobile shell: the welcome workspace keeps one topbar and the rail toggle lives in it', async () => {
      await welcome();
      const state = await record('welcome');
      assert.deepEqual(state.visibleChrome, ['topbar'], `the welcome page must keep exactly one chrome band: ${JSON.stringify(state.visibleChrome)}`);
      assert.ok(state.topbar.height >= 44, `the single bar must be a real band: ${JSON.stringify(state.topbar)}`);
      assert.equal(state.rowDisplay, 'none', 'the tab row must not be in the layout without a tab');
      assert.equal(state.hasDocumentTabs, false, 'the workspace mirrors the empty tab model');
      assert.equal(state.tabCount, 0, 'no tab is rendered without a document');
      assert.equal(state.toggleCount, 1, 'exactly one rail toggle exists');
      assert.equal(state.toggleInTopbar, true, 'the rail toggle lives in the topbar');
      assert.equal(state.toggleInRow, false, 'and not in the tab row');
      assert.equal(state.toggleInRail, false, 'and not inside the rail');
      assert.equal(state.toggleInScrim, false, 'and not inside the shared scrim');
      assert.equal(state.toggleVisible, true, 'the toggle stays reachable with no document open');
      assert.equal(state.togglePressed, 'false', 'a closed rail reports aria-pressed=false');
      assert.equal(state.toggleControls, 'context-sidebar', 'the toggle keeps its aria-controls');
      assert.match(String(state.spriteUrl),/^\/app\/assets\/icons\.svg\?v=[0-9a-f]{16}$/,'the shell publishes the versioned sprite URL');
      assert.equal(state.toggleGlyph, `${state.spriteUrl}#panel-right`, 'the toggle keeps the mirrored panel glyph');
      assert.ok(state.toggle.width >= 44 && state.toggle.height >= 44, `the toggle keeps a 44px touch target: ${JSON.stringify(state.toggle)}`);
      assert.equal(state.scrimCount, 1, 'the shell ships exactly one scrim');
    });

    await check('mobile shell: the no-note rail explains itself instead of showing a blank panel', async () => {
      await welcome();
      await openRight();
      const state = await page.evaluate(() => {
        const rail = document.querySelector('#context-sidebar');
        const view = [...rail.querySelectorAll('[data-context-view-panel]')].find((panel) => !panel.hidden);
        return {
          open: document.querySelector('.shell').classList.contains('context-open'),
          railVisible: rail.getBoundingClientRect().height > 0,
          view: view?.getAttribute('data-context-view-panel') ?? null,
          text: view?.querySelector('.context-empty')?.textContent?.trim() ?? null,
        };
      });
      trace.phases.push({ check: 'no-note-rail', at: Date.now(), state });
      assert.equal(state.open, true, 'the no-note rail really opens (the toggle is not a dead end)');
      assert.equal(state.railVisible, true, 'and it is on screen');
      assert.equal(state.view, 'outline', 'the default context view is the outline');
      assert.equal(state.text, '打开笔记后显示大纲与反链', `the no-note rail must explain itself: ${JSON.stringify(state)}`);
      await clickScrim('right');
    });

    await check('mobile shell: opening a note brings the document tab row back under the single topbar', async () => {
      await withNote();
      const state = await record('note');
      assert.equal(state.hasDocumentTabs, true, 'opening a note mirrors the committed tab model');
      assert.ok(state.tabCount >= 1, `the strip renders the open note (got ${state.tabCount})`);
      assert.notEqual(state.rowDisplay, 'none', 'the tab row enters the layout with a tab');
      assert.ok(state.row.height > 0, `the tab row must be a real band: ${JSON.stringify(state.row)}`);
      assert.ok(state.topbar.height > 0, 'the topbar stays visible next to the tab row');
      assert.ok(state.row.top >= state.topbar.top + state.topbar.height - 1, `the tab row must sit under the topbar: ${JSON.stringify({ topbar: state.topbar, row: state.row })}`);
      assert.deepEqual(state.visibleChrome, ['topbar', 'document-tab-row'], `exactly the two bands, in that order: ${JSON.stringify(state.visibleChrome)}`);
      assert.equal(state.toggleVisible, true, 'the rail toggle stays visible with a document open');
      assert.equal(state.toggleInTopbar, true, 'and it stays in the topbar (no state-dependent second control)');
      assert.equal(state.toggleInRow, false, 'the tab row carries no rail control');
      assert.equal(state.toggleCount, 1, 'still exactly one rail toggle');
    });

    await check('mobile shell: the two side drawers exclude each other and share one scrim', async () => {
      await withNote();
      await openLeft();
      const left = await record('drawer:left');
      assert.deepEqual([left.sidebarOpen, left.contextOpen], [true, false], `the files drawer opens alone: ${JSON.stringify(left.shellClasses)}`);
      assert.equal(left.togglePressed, 'false', 'and the rail toggle must not claim an open rail');
      // The open drawer's scrim owns the "tap outside" gesture, so it also covers the topbar: a
      // pointer aimed at the rail toggle lands on the scrim (measured, never assumed). The drawer
      // entries that the exclusion still has to survive are the non-pointer activations.
      const covered = await page.evaluate(() => {
        const toggle = document.querySelector('#sidebar-toggle');
        const box = toggle.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return { hit: hit?.className ?? '', scrim: hit?.classList.contains('scrim') ?? false };
      });
      assert.equal(covered.scrim, true, `the shared scrim must intercept the covered toggle: ${JSON.stringify(covered)}`);
      await page.evaluate(() => document.querySelector('#sidebar-toggle').focus());
      await page.keyboard.press('Enter');
      await sleep(DRAWER_SETTLE_MS);
      const right = await record('drawer:right');
      assert.deepEqual([right.contextOpen, right.sidebarOpen], [true, false], `opening the rail drawer closes the files drawer: ${JSON.stringify(right.shellClasses)}`);
      assert.equal(right.togglePressed, 'true', 'the toggle reports the open rail');
      assert.equal(right.toggleTitle, '隐藏右侧栏', 'with the existing open-rail wording');
      await clickScrim('right');
      const afterScrim = await record('drawer:scrim');
      assert.deepEqual([afterScrim.sidebarOpen, afterScrim.contextOpen], [false, false], `the shared scrim closes the current drawer: ${JSON.stringify(afterScrim.shellClasses)}`);
      assert.equal(afterScrim.togglePressed, 'false', 'and the toggle follows again');
      assert.equal(afterScrim.scrimCount, 1, 'the shell never grows a second overlay');
      // The reverse direction, through the hamburger the topbar keeps in the layout layer.
      await openRight();
      await page.evaluate(() => document.querySelector('#menu').focus());
      await page.keyboard.press('Enter');
      await sleep(DRAWER_SETTLE_MS);
      const leftAgain = await record('drawer:left-again');
      assert.deepEqual([leftAgain.sidebarOpen, leftAgain.contextOpen], [true, false], `opening the files drawer closes the rail drawer: ${JSON.stringify(leftAgain.shellClasses)}`);
      assert.equal(leftAgain.togglePressed, 'false', 'and the toggle follows the real drawer state immediately');
      // The pane-level rail close is the second, symmetric exit of that same one state.
      await clickScrim('left');
      await openRight();
      await page.locator('#context-drawer-close').click();
      await sleep(DRAWER_SETTLE_MS);
      const afterPaneClose = await record('drawer:pane-close');
      assert.equal(afterPaneClose.contextOpen, false, 'the pane-level close closes the rail drawer');
      assert.equal(afterPaneClose.togglePressed, 'false', 'through the same state the layout toggle owns');
    });

    await check('mobile shell: both side pane headers expose the same switcher + close shape', async () => {
      await withNote();
      const paneHead = (target, headerSelector) => target.evaluate((selector) => {
        const head = document.querySelector(selector);
        const close = head.querySelector('[data-pane-slot="close"]');
        if (!close) throw new Error(`the pane header ${selector} exposes no pane-level close (U29)`);
        const box = head.getBoundingClientRect();
        const closeBox = close.getBoundingClientRect();
        return {
          height: box.height,
          slots: [...head.querySelectorAll('[data-pane-slot]')].map((el) => el.getAttribute('data-pane-slot')),
          switcher: head.querySelectorAll('[data-pane-slot="switch"]').length,
          closeCount: head.querySelectorAll('[data-pane-slot="close"]').length,
          closeLabel: close.getAttribute('aria-label'),
          closeGlyph: close.querySelector('use')?.getAttribute('href') ?? null,
          closeWidth: closeBox.width,
          closeHeight: closeBox.height,
        };
      }, headerSelector);
      await openLeft();
      const left = await paneHead(page, '.sidebar-head');
      await clickScrim('left');
      await openRight();
      const right = await paneHead(page, '.context-view-header');
      trace.phases.push({ check: 'pane-heads', at: Date.now(), state: { left, right } });
      assert.deepEqual(left.slots, ['switch', 'close'], 'the left pane header exposes the switcher then the close');
      assert.deepEqual(right.slots, left.slots, 'the right pane header exposes the same slots in the same order');
      assert.deepEqual([left.switcher, left.closeCount], [1, 1], 'one switcher and exactly one close per pane header');
      assert.deepEqual([right.switcher, right.closeCount], [1, 1], 'one switcher and exactly one close per pane header');
      assert.equal(left.closeGlyph, right.closeGlyph, 'both pane closes draw the same glyph');
      assert.match(left.closeGlyph, /#x$/, 'the pane close is the ✕ control');
      assert.equal(left.closeLabel, '折叠侧栏');
      assert.equal(right.closeLabel, '折叠笔记上下文');
      assert.ok(Math.abs(left.height - right.height) <= 1, `the two pane headers are the same band: ${JSON.stringify({ left: left.height, right: right.height })}`);
      assert.ok(left.closeWidth >= 44 && left.closeHeight >= 44, `the left close keeps the 44px target: ${JSON.stringify(left)}`);
      assert.ok(right.closeWidth >= 44 && right.closeHeight >= 44, `the right close keeps the 44px target: ${JSON.stringify(right)}`);
      assert.ok(Math.abs(left.closeWidth - right.closeWidth) <= 1 && Math.abs(left.closeHeight - right.closeHeight) <= 1, 'and both closes are the same size');
      await clickScrim('right');
    });

    await check('mobile shell: the top inset has exactly one owner and it follows the topmost band', async () => {
      await withNote();
      // A headless viewport has no notch, so the inset is injected through the published
      // `--app-inset-top` channel: exactly one band may react to it, and the owner must be
      // whichever band is on top.
      const probe = () => page.evaluate(() => {
        const pad = (el) => (el ? Number.parseFloat(getComputedStyle(el).paddingTop) || 0 : 0);
        const height = (el) => (el ? el.getBoundingClientRect().height : 0);
        const parts = {
          topbar: document.querySelector('.topbar'),
          row: document.querySelector('.document-tab-row'),
          sidebar: document.querySelector('.sidebar'),
          context: document.querySelector('#context-sidebar'),
        };
        return {
          declared: getComputedStyle(document.querySelector('.shell')).getPropertyValue('--app-inset-top').trim(),
          owners: Object.entries(parts).filter(([, el]) => pad(el) > 0).map(([name]) => name),
          topbarHeight: height(parts.topbar),
          topbarPad: pad(parts.topbar),
          rowPad: pad(parts.row),
          sidebarPad: pad(parts.sidebar),
          contextPad: pad(parts.context),
        };
      });
      const withInset = async (value, fn) => {
        await page.evaluate((inset) => document.querySelector('.shell').style.setProperty('--app-inset-top', inset), value);
        try {
          await sleep(60);
          return await fn();
        } finally {
          await page.evaluate(() => document.querySelector('.shell').style.removeProperty('--app-inset-top'));
          await sleep(60);
        }
      };
      const natural = await probe();
      const injected = await withInset('24px', probe);
      assert.equal(natural.owners.length, 0, `an untouched viewport adds no top inset: ${JSON.stringify(natural)}`);
      assert.equal(injected.declared, '24px', 'the probe really overrides the published inset channel');
      assert.deepEqual(injected.owners, ['topbar'], `exactly the topmost band owns the inset: ${JSON.stringify(injected)}`);
      assert.equal(injected.topbarPad, 24, 'the topbar consumes the inset once');
      assert.ok(Math.abs(injected.topbarHeight - natural.topbarHeight - 24) <= 1, `and its height grows by exactly that inset: ${JSON.stringify({ natural: natural.topbarHeight, injected: injected.topbarHeight })}`);
      assert.equal(injected.rowPad, 0, 'the tab row never adds the same inset again');
      assert.equal(injected.sidebarPad, 0, 'and neither does a closed pane');
      assert.equal(injected.contextPad, 0, 'and neither does the other closed pane');
      // A drawer covers the topbar, so the drawer becomes the owner and the covered topbar gives it back.
      await openLeft();
      const drawer = await withInset('24px', probe);
      trace.phases.push({ check: 'safe-area', at: Date.now(), state: { natural, injected, drawer } });
      assert.deepEqual(drawer.owners, ['sidebar'], `the open drawer takes the inset over: ${JSON.stringify(drawer)}`);
      assert.equal(drawer.topbarPad, 0, 'the covered topbar gives the inset back (never two owners)');
      assert.equal(drawer.sidebarPad, 24, 'and the drawer consumes it exactly once');
      await clickScrim('left');
    });

    await check('mobile shell: desktop keeps both panes docked and never uses the drawer classes', async () => {
      await wide.goto(`${base}/app`);
      await wide.waitForSelector('.note[title="A.md"]');
      await wide.locator('.note[title="A.md"]').click();
      await wide.waitForFunction(() => document.querySelectorAll('#document-tabs .document-tab').length > 0);
      await sleep(160);
      const docked = await record('desktop', wide);
      await wide.locator('#sidebar-toggle').click();
      await sleep(160);
      const toggled = await record('desktop:toggled', wide);
      assert.equal(docked.sidebarOpen || docked.contextOpen, false, `desktop must not use the drawer classes: ${JSON.stringify(docked.shellClasses)}`);
      assert.equal(docked.sidebarVisible, true, 'the left pane is docked and visible');
      assert.equal(docked.contextVisible, true, 'the right pane is docked and visible at the same time (no exclusion above the breakpoint)');
      assert.ok(docked.row.height > 0, 'the tab row is a real band on desktop too');
      assert.ok(docked.row.top >= docked.topbar.top + docked.topbar.height - 1, 'and it sits under the topbar');
      assert.equal(docked.toggleInTopbar, true, 'the rail toggle is a topbar action on desktop too');
      assert.equal(toggled.contextHidden, true, 'the topbar toggle keeps the desktop docked preference');
      assert.equal(toggled.contextOpen, false, 'and never turns the docked rail into a drawer');
      assert.equal(toggled.sidebarVisible, true, 'the left pane is untouched by the rail toggle');
      assert.equal(await wide.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'desktop has no horizontal overflow');
    });
  } finally {
    trace.finishedAt = Date.now();
    trace.pageErrors = pageErrors;
    await fs.writeFile(path.join(outputRoot, 'mobile-shell-trace.json'), `${JSON.stringify(trace, null, 2)}\n`).catch(() => {});
    assert.deepEqual(pageErrors, [], `the mobile shell scene must not raise page errors: ${JSON.stringify(pageErrors)}`);
    await phone.close();
    await desktop.close();
  }
}
