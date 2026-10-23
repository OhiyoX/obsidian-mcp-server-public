// Issue #337 Cut 2 — Bases mobile chrome (toolbar overflow menu, full-width overlay
// panel, backdrop dismissal, safe area, visual viewport) in the mobile browser scene.
//
// The Bases half of the mobile matrix. It runs in its own Chromium context and its own
// fixture Vault/server — viewport 360x800, `hasTouch`, `isMobile`, i.e. the
// `pointer: coarse` / `hover: none` profile a phone reports — because the Base surface
// needs the `.base` fixture documents the shared harness Vault does not carry. The
// desktop half of the same feature lives in `web-bases-checks.mjs` (parity items
// 18-44) and stays untouched: these checks only characterise the `<=480px` chrome.
//
// Every assertion is a real browser observation: computed styles, bounding rects, hit
// testing on the backdrop, `aria-expanded` state and the `visualViewport` metrics the
// runtime publishes. Measurements land in `<outputRoot>/bases-mobile-chrome-trace.json`.
// Each check is red on base (no hamburger, no overlay, no backdrop, no safe-area or
// visual-viewport channel).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWebBasesFixtureVault } from '../web-bases-fixtures.mjs';
// Issue #337 Cut 3 (table touch) is registered from here: it needs this scene's
// 360x800 coarse-pointer context and Base fixture server. Kept in its own module for
// the architecture line budget; none of the six Cut 2 checks above is touched.
import { registerBasesTableTouchChecks } from './bases-table-touch.mjs';

const MOBILE_VIEWPORT = { width: 360, height: 800 };
// One step above the mobile breakpoint and far below the desktop matrix width: the
// desktop chrome must be back here, which is what makes the breakpoint load-bearing.
const WIDE_PROBE_WIDTH = 520;
// The action vocabulary the toolbar must keep reachable on a phone (cut 2 keeps the
// desktop set: no action is dropped, only moved).
const ACTIONS = [
  ['sort', '排序'],
  ['filter', '筛选'],
  ['properties', '属性'],
  ['search', '搜索'],
  ['new', '新建'],
];

export async function registerBasesMobileChecks(ctx) {
  const { check, sleep, browser, root, appRoot, serverErrors, outputRoot } = ctx;

  const trace = { startedAt: Date.now(), viewport: MOBILE_VIEWPORT, breakpointPx: 480, phases: [] };
  const fixtureRoot = path.join(root, 'web-bases-mobile');
  const fixtures = await createWebBasesFixtureVault(fixtureRoot);
  const port = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(24).toString('hex');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: appRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), DATA_PATH: path.join(fixtureRoot, 'data'),
      OAUTH_ENABLED: 'true', PUBLIC_BASE_URL: base, OAUTH_INITIAL_USERNAME: 'browser-test', OAUTH_INITIAL_PASSWORD: password,
      OAUTH_ADMIN_PASSWORD: password, API_KEY: '', GIT_ENABLED: 'false', GIT_AUTO_COMMIT: 'false', GIT_AUTO_PUSH: 'false',
      EMBEDDING_PROVIDER: 'disabled', EMBEDDING_EDGE_PROVIDER: 'disabled', EMBEDDING_EDGE_BASE_URL: '', EMBEDDING_EDGE_REGISTRY_URL: '',
      RETRIEVAL_AUTO_EMBED: 'false', WEB_FILE_WATCH_DEBOUNCE_MS: '50', ...fixtures.serverEnv,
    },
  });
  child.stderr.on('data', (data) => serverErrors.push(data.toString()));
  child.stdout.resume();

  const context = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  });
  let page;
  const pageErrors = [];
  try {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* keep waiting */ }
      if (child.exitCode !== null) throw new Error('Web Bases mobile test server exited');
      await sleep(100);
    }
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));

    const response = await page.request.post(`${base}/auth/login`, { form: { username: 'browser-test', password } });
    assert.equal(response.status(), 200, `Web Bases mobile login failed with ${response.status()}`);
    await page.goto(`${base}/app`);
    await page.waitForSelector('.note[title="Readme.md"]', { timeout: 20000 });

    // Open the fixture Base the way a phone user does: through the Explorer drawer.
    await page.locator('#menu').click();
    await page.waitForFunction(() => document.querySelector('.shell')?.classList.contains('sidebar-open'));
    await sleep(260); // the drawer transform transition is 160 ms
    await page.locator(`.note.note-base[data-path="${fixtures.files.projectBase}"]`).first().click();
    await page.waitForSelector('#base-host:not([hidden])', { timeout: 20000 });
    await page.waitForSelector('[data-base-table] tbody tr', { timeout: 20000 });
    // Dismiss the drawer again (its scrim is the app's own narrow-drawer dismissal) so
    // every coordinate and hit test below is unambiguous.
    if (await page.locator('.shell').evaluate((element) => element.classList.contains('sidebar-open'))) {
      await page.touchscreen.tap(348, 700);
      await page.waitForFunction(() => !document.querySelector('.shell')?.classList.contains('sidebar-open'));
    }
    await sleep(200);

    // --- helpers -------------------------------------------------------------
    const q = (selector) => page.locator(selector);
    const count = (selector) => q(selector).count();
    const visible = async (selector) => (await count(selector)) > 0 && q(selector).first().isVisible();
    const geometry = (selector) => page.evaluate((wanted) => {
      const node = document.querySelector(wanted);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom,
        display: style.display, visibility: style.visibility, position: style.position,
        paddingLeft: style.paddingLeft, paddingTop: style.paddingTop, zIndex: style.zIndex,
      };
    }, selector);
    const viewport = () => page.evaluate(() => ({
      width: innerWidth,
      height: visualViewport?.height ?? innerHeight,
      offsetTop: visualViewport?.offsetTop ?? 0,
      layoutHeight: innerHeight,
      coarse: matchMedia('(pointer: coarse)').matches,
      hoverNone: matchMedia('(hover: none)').matches,
      narrow: matchMedia('(max-width: 480px)').matches,
    }));
    const customProperty = (selector, name) => page.evaluate(({ wanted, property }) => {
      const node = document.querySelector(wanted);
      return node ? getComputedStyle(node).getPropertyValue(property).trim() : null;
    }, { wanted: selector, property: name });
    const setWidth = async (width, height = MOBILE_VIEWPORT.height) => {
      await page.setViewportSize({ width, height });
      await sleep(260);
      assert.equal(await page.evaluate((want) => innerWidth === want, width), true, `the layout viewport must be ${width}px wide`);
    };
    // Escapes whatever the previous check left open (the panels' own keyboard dismissal).
    const resetChrome = async () => {
      await page.keyboard.press('Escape');
      await sleep(160);
      if (await count('.base-panel')) {
        await page.keyboard.press('Escape');
        await sleep(160);
      }
      assert.equal(await count('.base-panel'), 0, 'the reset must leave no open panel behind');
      assert.equal(await count('.base-action-row.is-menu-open'), 0, 'the reset must leave no open menu behind');
    };
    // Opens one of the five panels through the mobile chrome itself (hamburger menu),
    // never through a raw DOM click: reachability is part of what is asserted. When the
    // mobile chrome is absent (the pre-Cut-2 base build) the helper falls back to the
    // desktop action button so the overlay/backdrop/channel assertions below still run
    // and fail on their own evidence instead of all collapsing into one.
    const openPanelFromMenu = async (id) => {
      if (await visible('[data-base-overflow]')) {
        await q('[data-base-overflow]').click();
        await sleep(160);
        assert.equal(await visible('.base-action-row'), true, 'the hamburger must reveal the action menu before an action can be picked');
      }
      await q(`.base-action-row [data-base-action="${id}"]`).click();
      await sleep(200);
      assert.equal(await count(`.base-panel[data-base-panel="${id}"]`), 1, `the ${id} panel must open from the mobile menu`);
    };
    const record = (name, payload) => trace.phases.push({ check: name, at: Date.now(), ...payload });

    // Q1 — the toolbar overflow itself: the gap is "no action is reachable at 360px".
    await check('bases mobile chrome: at 360px the right-hand actions collapse into a keyboard-operable hamburger menu', async () => {
      await setWidth(MOBILE_VIEWPORT.width);
      await resetChrome();
      const premise = await viewport();
      assert.equal(premise.coarse, true, 'this scene must run the pointer: coarse profile it characterises');
      assert.equal(premise.hoverNone, true, 'this scene must run the hover: none profile');
      assert.equal(premise.narrow, true, 'the 480px mobile breakpoint must apply at 360px');

      // (a) collapsed: the hamburger is the only way in, and it is present and visible.
      assert.equal(await visible('[data-base-overflow]'), true, 'the 360px tool row must expose the hamburger');
      assert.equal(await visible('.base-action-row'), false, 'the desktop action row must be collapsed at 360px');
      for (const [id] of ACTIONS) {
        assert.equal(
          await visible(`[data-base-action="${id}"]`),
          false,
          `${id} must not stay an always-visible desktop control at 360px (it belongs to the menu)`,
        );
      }
      const overflow = await geometry('[data-base-overflow]');
      assert.ok(overflow.width >= 44 && overflow.height >= 44, `the hamburger must be a touch target, saw ${JSON.stringify(overflow)}`);
      assert.equal(await q('[data-base-overflow]').getAttribute('aria-expanded'), 'false', 'a closed hamburger must report aria-expanded=false');
      const controls = await q('[data-base-overflow]').getAttribute('aria-controls');
      assert.ok(controls, 'the hamburger must name the element it expands');
      assert.equal(await count(`#${controls}`), 1, `aria-controls must resolve to the action menu (${controls})`);
      assert.equal(await q(`#${controls}`).getAttribute('data-base-action-row') !== null, true, 'the controlled element must be the action row');

      // (b) revealed by a real tap: every desktop action is reachable, labelled and
      //     inside the viewport with a touch-sized target.
      await q('[data-base-overflow]').click();
      await sleep(200);
      assert.equal(await q('[data-base-overflow]').getAttribute('aria-expanded'), 'true', 'an open menu must report aria-expanded=true');
      const band = await viewport();
      const menu = await geometry('.base-action-row');
      for (const [id, label] of ACTIONS) {
        const action = `.base-action-row [data-base-action="${id}"]`;
        assert.equal(await visible(action), true, `${id} must be visible once the menu is open`);
        assert.equal((await q(`${action} .base-action-label`).textContent()).trim(), label, `${id} must keep its desktop label`);
        const box = await geometry(action);
        assert.ok(box.height >= 44, `${id} must be a 44px touch target, saw ${box.height}px`);
        assert.ok(box.y >= 0 && box.bottom <= band.height, `${id} must be inside the viewport: ${JSON.stringify(box)} vs ${JSON.stringify(band)}`);
      }
      record('q1', { premise, overflow, menu, band });

      // (c) keyboard: Escape dismisses the disclosure, Enter re-opens it (a real button).
      await page.keyboard.press('Escape');
      await sleep(180);
      assert.equal(await visible('.base-action-row'), false, 'Escape must dismiss the mobile menu');
      assert.equal(await q('[data-base-overflow]').getAttribute('aria-expanded'), 'false', 'Escape must reset aria-expanded');
      await q('[data-base-overflow]').focus();
      await page.keyboard.press('Enter');
      await sleep(180);
      assert.equal(await visible('.base-action-row'), true, 'Enter on the focused hamburger must re-open the menu');
      await page.keyboard.press('Escape');
      await sleep(160);

      // (d) and an action picked from the menu really opens its panel.
      await openPanelFromMenu('filter');
      assert.equal(await visible('.base-panel[data-base-panel="filter"]'), true, 'the filter panel must be on screen after picking it from the menu');
      await resetChrome();
    });

    // Q2 — the panel strategy: a full-width overlay with its own close control.
    await check('bases mobile chrome: an action panel renders as a full-width fixed overlay with a header close button', async () => {
      await setWidth(MOBILE_VIEWPORT.width);
      await resetChrome();
      await openPanelFromMenu('new');
      const band = await viewport();
      const panel = await geometry('.base-panel');
      const close = await geometry('[data-base-panel-close]');
      const header = await geometry('.base-panel-header');
      record('q2', { band, panel, close, header });

      assert.equal(panel.position, 'fixed', `the panel must leave the desktop popover flow, saw position:${panel.position}`);
      assert.ok(Math.abs(panel.x) <= 0.5, `the overlay must start at the viewport edge, saw x=${panel.x}`);
      assert.ok(Math.abs(panel.width - band.width) <= 0.5, `the overlay must span the viewport width (${panel.width} vs ${band.width})`);
      assert.ok(panel.height >= 300, `the overlay must be a real panel, not a content-sized tooltip (height ${panel.height})`);
      assert.ok(panel.bottom <= band.height + 0.5, `the overlay must stay inside the visual viewport (${panel.bottom} > ${band.height})`);
      // The close control is the header's own button, and the header is inside the panel.
      assert.ok(close && close.width >= 44 && close.height >= 44, `the close control must be a 44px touch target, saw ${JSON.stringify(close)}`);
      assert.ok(header && header.height >= 40, `the overlay must render its header row, saw ${JSON.stringify(header)}`);
      assert.ok(close.y >= header.y - 0.5 && close.bottom <= header.bottom + 0.5, 'the close control must sit inside the panel header');
      assert.ok(header.y >= panel.y - 0.5 && header.bottom <= panel.bottom + 0.5, 'the panel header must sit inside the overlay');
      // The collapsed row must not paint a menu box under the overlay.
      assert.equal(await visible('.base-action-row [data-base-action="sort"]'), false, 'the collapsed row must stay unpainted under the overlay');
      // And the close control is the real dismissal, not decoration.
      await q('[data-base-panel-close]').click();
      await sleep(200);
      assert.equal(await count('.base-panel'), 0, 'the header close button must dismiss the overlay');
      assert.equal(await visible('.base-action-row'), false, 'closing the overlay must leave no menu behind');
    });

    // Q3 — the backdrop: reachable below the panel, and it dismisses on tap.
    await check('bases mobile chrome: the overlay backdrop covers the area below the panel and dismisses it on tap', async () => {
      await setWidth(MOBILE_VIEWPORT.width);
      await resetChrome();
      await openPanelFromMenu('new');
      const band = await viewport();
      const panel = await geometry('.base-panel');
      const backdrop = await geometry('.base-panel-backdrop');
      record('q3', { band, panel, backdrop });

      assert.ok(backdrop, 'the overlay must render a backdrop element');
      assert.equal(backdrop.display !== 'none', true, 'the overlay must render a backdrop');
      assert.equal(backdrop.position, 'fixed', `the backdrop must cover the window, saw position:${backdrop.position}`);
      assert.ok(Math.abs(backdrop.width - band.width) <= 0.5 && backdrop.height >= band.height - 1, `the backdrop must cover the viewport: ${JSON.stringify(backdrop)}`);
      assert.ok(panel.bottom < band.height - 8, `this panel must leave a tappable backdrop below it (panel bottom ${panel.bottom}, band ${band.height})`);
      // What is actually under the finger below the panel?
      const hit = await page.evaluate(() => {
        const node = document.elementFromPoint(180, 700);
        return node ? { tag: node.tagName, backdrop: node.hasAttribute('data-base-panel-backdrop'), className: String(node.className) } : null;
      });
      assert.ok(hit && hit.backdrop === true, `the area below the panel must belong to the backdrop, hit=${JSON.stringify(hit)}`);
      await page.touchscreen.tap(180, 700);
      await sleep(240);
      assert.equal(await count('.base-panel'), 0, 'a tap on the backdrop must dismiss the overlay');
      assert.equal(await count('.base-panel-backdrop'), 0, 'dismissing must remove the backdrop too');
      assert.equal(await visible('.base-action-row'), false, 'the menu must not reappear after a backdrop dismissal');
    });

    // Q4 — the two channels the overlay is built on: safe area and live visual viewport.
    await check('bases mobile chrome: the overlay consumes the safe-area channel and publishes the live visual viewport', async () => {
      await setWidth(MOBILE_VIEWPORT.width);
      await resetChrome();
      await openPanelFromMenu('properties');
      const band = await viewport();
      const published = await customProperty('[data-base-action-row]', '--base-visual-viewport-height');
      const publishedOffset = await customProperty('[data-base-action-row]', '--base-visual-viewport-offset-top');
      const before = await geometry('.base-panel');
      record('q4', { band, published, publishedOffset, before });

      assert.ok(published, 'the surface must publish the visual-viewport height as a custom property');
      assert.ok(Math.abs(parseFloat(published) - band.height) <= 1, `the published height must track visualViewport.height (${published} vs ${band.height})`);
      assert.ok(publishedOffset, 'the surface must publish the visual-viewport offset as a custom property');
      assert.equal(await customProperty('#base-host', '--base-safe-area-left') !== null, true, 'the surface host must expose the safe-area channel');
      assert.equal(before.paddingLeft, '14px', `the naked overlay keeps its base inset, saw ${before.paddingLeft}`);

      // Override the safe-area channel the way an iPhone notch would and watch the
      // overlay and the tool row follow it (no hardcoded 44px anywhere).
      await page.evaluate(() => {
        document.querySelector('#base-host').style.setProperty('--base-safe-area-left', '44px');
        document.querySelector('#base-host').style.setProperty('--base-safe-area-top', '30px');
      });
      await sleep(160);
      const after = await geometry('.base-panel');
      const toolbar = await geometry('.base-surface-toolbar');
      record('q4:inset', { after, toolbar });
      await page.evaluate(() => {
        document.querySelector('#base-host').style.removeProperty('--base-safe-area-left');
        document.querySelector('#base-host').style.removeProperty('--base-safe-area-top');
      });
      assert.equal(after.paddingLeft, '44px', `the overlay must consume the safe-area left inset, saw ${after.paddingLeft}`);
      assert.equal(after.paddingTop, '30px', `the overlay must consume the safe-area top inset, saw ${after.paddingTop}`);
      assert.equal(toolbar.paddingLeft, '44px', `the tool row must consume the safe-area left inset, saw ${toolbar.paddingLeft}`);
      assert.ok(after.x >= 0 && after.width <= band.width + 0.5, 'a real inset must not push the overlay outside the viewport');
      await resetChrome();
    });

    // Q5 — keyboard口径 (declared in the handoff): a soft keyboard cannot be emulated,
    // so this asserts the observable behaviour that stands in for it — the overlay
    // re-anchors to the shrunk visual viewport (a real `visualViewport` resize) and the
    // focused input stays inside the visible band.
    await check('bases mobile chrome: the overlay follows a visual-viewport shrink and keeps the focused input inside the visible band', async () => {
      await setWidth(MOBILE_VIEWPORT.width);
      await resetChrome();
      await openPanelFromMenu('search');
      await q('[data-search-input]').click();
      assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-search-input')), true, 'the search input must be focused');
      const before = { band: await viewport(), panel: await geometry('.base-panel') };
      assert.ok(before.panel.height >= 319, `the open overlay must occupy its minimum band first (height ${before.panel.height})`);

      await page.setViewportSize({ width: MOBILE_VIEWPORT.width, height: 300 });
      await sleep(300);
      const after = { band: await viewport(), panel: await geometry('.base-panel'), input: await geometry('[data-search-input]') };
      const published = await customProperty('[data-base-action-row]', '--base-visual-viewport-height');
      record('q5', { before, after, published });

      assert.ok(after.band.height <= 320, `the visual viewport must have shrunk, saw ${after.band.height}`);
      assert.ok(Math.abs(parseFloat(published) - after.band.height) <= 1, `the published band must follow the shrink (${published} vs ${after.band.height})`);
      assert.ok(after.panel.height <= after.band.height + 0.5, `the overlay must not stay taller than the visible band (${after.panel.height} > ${after.band.height})`);
      assert.ok(after.panel.bottom <= after.band.offsetTop + after.band.height + 0.5, `the overlay must not extend past the visible band (${after.panel.bottom} > ${after.band.offsetTop + after.band.height})`);
      assert.ok(after.panel.height < before.panel.height, `the overlay must shrink with the visual viewport (${before.panel.height} -> ${after.panel.height})`);
      assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-search-input')), true, 'the resize must not steal focus from the active input');
      assert.ok(
        after.input.y >= after.band.offsetTop - 0.5 && after.input.bottom <= after.band.offsetTop + after.band.height + 0.5,
        `the focused input must stay inside the visible band: input=${JSON.stringify(after.input)} band=${JSON.stringify(after.band)}`,
      );

      // Restoring the viewport restores the band (no stale inline geometry, no reload).
      await page.setViewportSize(MOBILE_VIEWPORT);
      await sleep(300);
      const restored = await geometry('.base-panel');
      record('q5:restored', { restored });
      assert.ok(restored.height > after.panel.height, `the overlay must grow back with the viewport (${after.panel.height} -> ${restored.height})`);
      await resetChrome();
    });

    // Q6 — the breakpoint is width-driven: above it the desktop popover chrome is back,
    // below it (again, without a reload) the mobile chrome takes over.
    await check('bases mobile chrome: the 480px breakpoint is width-driven, so a wider viewport keeps the desktop popover chrome', async () => {
      await setWidth(WIDE_PROBE_WIDTH);
      await resetChrome();
      const wide = await viewport();
      assert.equal(wide.coarse, true, 'the capability is unchanged — only the width differs');
      assert.equal(wide.narrow, false, `the mobile breakpoint must not apply at ${WIDE_PROBE_WIDTH}px`);
      assert.equal(await visible('[data-base-overflow]'), false, 'the hamburger must be mobile-width only');
      for (const [id] of ACTIONS) {
        assert.equal(await visible(`[data-base-action="${id}"]`), true, `${id} must be a visible desktop control again at ${WIDE_PROBE_WIDTH}px`);
      }
      await q(`.base-action-row [data-base-action="filter"]`).click();
      await sleep(220);
      const panel = await geometry('.base-panel');
      record('q6:wide', { wide, panel });
      assert.ok(panel, 'the desktop action must still open its panel');
      assert.equal(panel.position, 'absolute', `above the breakpoint the panel must stay the anchored desktop popover, saw position:${panel.position}`);
      assert.equal(await visible('.base-panel-backdrop'), false, 'there is no overlay backdrop above the breakpoint');
      assert.equal(await visible('[data-base-panel-close]'), false, 'there is no overlay close button above the breakpoint');
      await page.keyboard.press('Escape');
      await sleep(180);
      assert.equal(await count('.base-panel'), 0, 'the desktop dismissal path must still work above the breakpoint');

      // Rotation back to a phone width re-arms the mobile chrome with no reload.
      await setWidth(MOBILE_VIEWPORT.width);
      const narrow = await viewport();
      record('q6:narrow', { narrow });
      assert.equal(narrow.narrow, true, 'the mobile breakpoint must re-apply after the width change');
      assert.equal(await visible('[data-base-overflow]'), true, 'a width change must re-arm the hamburger without a reload');
      assert.equal(await visible('.base-action-row'), false, 'and re-collapse the action row');
      await resetChrome();
    });

    // Issue #337 Cut 3 — Bases table touch (horizontal pan / 44px rows / resize policy
    // / tap selection / link priority). Runs last: its link check navigates away from
    // the Base surface.
    await registerBasesTableTouchChecks({ check, sleep, page, record, outputRoot });
  } finally {
    trace.finishedAt = Date.now();
    trace.pageErrors = pageErrors;
    await fs.writeFile(path.join(outputRoot, 'bases-mobile-chrome-trace.json'), `${JSON.stringify(trace, null, 2)}\n`).catch(() => {});
    assert.deepEqual(pageErrors, [], `the Bases mobile scene must not raise page errors: ${JSON.stringify(pageErrors)}`);
    await context.close();
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    }
  }
}
