// Issue #337 Cut 1 — Explorer touch-prefetch characterisation in the mobile browser scene.
//
// The mobile half of the browser matrix, registered after the desktop scenarios in
// `scripts/web-regression.mjs`. It runs its own Chromium context — viewport 390x844, `hasTouch`,
// `isMobile`, i.e. the `pointer: coarse` / `hover: none` profile a phone reports — with its own
// cookies, cache and preferences, so the desktop page and the #284 hover probes stay untouched
// (the isolation discipline `explorer-prefetch.mjs` uses). It asserts only observable behaviour:
// the page's own `/api/web/v2/tree` traffic (both the wire observer and an in-page record of every
// fetch the app initiates), `aria-expanded` and the drawer's `scrollTop`. Timelines and per-phase
// counts land in `<outputRoot>/explorer-touch-prefetch-trace.json`. Each check is red on base.
//
// Real touch input goes through CDP `Input.dispatchTouchEvent` (the channel Playwright's
// `touchscreen.tap` uses), and the pen phase through `Input.dispatchMouseEvent({pointerType:'pen'})`,
// so the page sees genuine pointer events. Phases that must keep a pointer down across probes
// dispatch a real `PointerEvent` on the real rendered row — same binding, same intent module, same
// network — exactly as `explorer-prefetch.mjs` §13.4 does for hover.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const TREE_PATH = '/api/web/v2/tree';
const ROUTE_GLOB = `**${TREE_PATH}**`;
const MOBILE_VIEWPORT = { width: 390, height: 844 };
// Frozen by the Cut 1 contract, mirrored for readability of the probes.
const TOUCH_SLOP_PX = 10;

export async function registerMobileChecks(ctx) {
  const { check, sleep, page: sharedPage, browser, base, outputRoot } = ctx;

  const trace = { startedAt: Date.now(), base, viewport: MOBILE_VIEWPORT, requests: [], phases: [] };
  const context = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  });
  let page;
  let cdp;
  const pageErrors = [];
  try {
    await context.addCookies(await sharedPage.context().cookies());
    page = await context.newPage();
    page.setDefaultTimeout(7000);
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
    cdp = await context.newCDPSession(page);

    const entries = [];
    page.on('request', (request) => {
      if (!request.url().includes(TREE_PATH)) return;
      const url = new URL(request.url());
      const entry = {
        at: Date.now(),
        parent: url.searchParams.get('parent'),
        cursor: url.searchParams.get('cursor'),
        anchorPath: url.searchParams.get('anchorPath'),
        url: url.href,
      };
      entries.push(entry);
      trace.requests.push(entry);
    });

    const rowOf = (parent) => `.tree-folder-row[data-folder-path=${JSON.stringify(parent)}]`;
    const buttonOf = (parent) => `${rowOf(parent)} .tree-folder`;
    const childrenOf = (parent) => `${rowOf(parent)} + .tree-children`;
    const noteOf = (parent, name) => `${childrenOf(parent)} .note[title=${JSON.stringify(`${parent}/${name}`)}]`;
    const requestsFor = (parent) => entries.filter((entry) => entry.parent === parent);
    const clear = () => { entries.length = 0; };
    const waitFor = async (predicate, timeoutMs = 2500, stepMs = 20) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) return false;
        await sleep(stepMs);
      }
      return true;
    };
    // Absolute per-parent accounting: the failure message carries the whole observed log, so a
    // red run proves the failure instead of only naming it.
    const expect = (tag, parent, expected, message) => {
      const observed = requestsFor(parent);
      trace.phases.push({ check: tag, at: Date.now(), parent, expected, observed: observed.length, urls: observed.map((entry) => entry.url) });
      const urls = JSON.stringify(observed.map((entry) => entry.url));
      assert.equal(observed.length, expected, `${message} — expected ${expected} tree request(s) for ${parent}, observed ${observed.length}: ${urls}`);
      return observed;
    };
    const expanded = (parent) => page.locator(buttonOf(parent)).getAttribute('aria-expanded');
    // Wait until the page's tree request log has been quiet (the boot SSE resync reloads the root
    // after the first paint, so a probe started early would race that request).
    const settleTree = async (quietMs = 600, timeoutMs = 6000) => {
      const deadline = Date.now() + timeoutMs;
      let seen = entries.length;
      let changedAt = Date.now();
      while (Date.now() < deadline && Date.now() - changedAt < quietMs) {
        await sleep(100);
        if (entries.length !== seen) { seen = entries.length; changedAt = Date.now(); }
      }
    };
    // Controllable response delay: the request still reaches the real route, only its response is
    // held back, so an owner stays in flight while the next step is measured. Best-effort
    // continuation: a request K5 aborts on purpose has nothing left to continue.
    const delayTreeResponses = async (parents, ms) => {
      const delayed = new Set(parents);
      const handler = async (route) => {
        if (delayed.has(new URL(route.request().url()).searchParams.get('parent'))) await sleep(ms);
        await route.continue().catch(() => {});
      };
      await page.route(ROUTE_GLOB, handler);
      return { delayed, stop: () => page.unroute(ROUTE_GLOB, handler) };
    };

    // --- real touch input (CDP) ---------------------------------------------
    const touchPoint = (point, id) => ({ x: point.x, y: point.y, id });
    const touchStart = (point, id = 1) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint(point, id)] });
    const touchMove = (point, id = 1) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touchPoint(point, id)] });
    const touchEnd = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    // The Cut 1 contract is "primary touch/pen pointerdown". A pen pointer uses the browser's mouse
    // input path, which is not deferred the way a real touch is (see K1), so the 100 ms window is
    // measurable there.
    const penDown = async (point) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'pen' });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' });
    };
    const penUp = (point) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
    // A real row button, tapped inside its own left third: the 44 px `+` control sits at the row's
    // right edge at this width, and the add path is a different (formal) load.
    const tapPoint = async (parent) => {
      const locator = page.locator(buttonOf(parent));
      await locator.scrollIntoViewIfNeeded();
      await settleListScroll();
      const box = await locator.boundingBox();
      assert.ok(box, `the ${parent} row must be laid out in the open mobile drawer`);
      const point = { x: box.x + Math.min(box.width / 3, 48), y: box.y + box.height / 2 };
      assert.ok(
        point.x > 0 && point.x < MOBILE_VIEWPORT.width && point.y > 0 && point.y < MOBILE_VIEWPORT.height,
        `the ${parent} row must be reachable inside the mobile viewport: point=${JSON.stringify(point)} box=${JSON.stringify(box)}`,
      );
      return point;
    };
    // A real finger's pointer events, dispatched on the real rendered row (bubbling, so the
    // delegated host seam sees them). `syntheticHold` times the release on the page's own clock.
    const pointerEventInit = (id, point) => ({ bubbles: true, cancelable: true, composed: true, pointerId: id, pointerType: 'touch', isPrimary: true, clientX: point.x, clientY: point.y });
    const dispatchPointer = (parent, type, { id, point }) => page
      .locator(buttonOf(parent))
      .evaluate((element, init) => element.dispatchEvent(new PointerEvent(init.type, init.eventInit)), { type, eventInit: pointerEventInit(id, point) });
    const syntheticHold = (parent, { id, point, holdMs, release = 'pointerup' }) => page
      .locator(buttonOf(parent))
      .evaluate((element, init) => {
        const fire = (type) => element.dispatchEvent(new PointerEvent(type, init.eventInit));
        fire('pointerdown');
        if (init.release) setTimeout(() => fire(init.release), init.holdMs);
      }, { eventInit: pointerEventInit(id, point), holdMs, release });

    // A capture-phase log of the input events (for the ordering proofs and as failure evidence) and
    // the page's own record of every tree fetch it *initiates* — an aborted request can be invisible
    // to the wire observer, and both halves stay in the page's clock domain.
    const startPointerLog = () => page.evaluate(() => {
      window.__mobilePointerLog = [];
      if (window.__mobilePointerLogBound) return;
      window.__mobilePointerLogBound = true;
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave', 'pointerout', 'click']) {
        document.addEventListener(type, (event) => window.__mobilePointerLog.push({
          type,
          at: Date.now(),
          pointerId: event.pointerId ?? null,
          pointerType: event.pointerType ?? null,
          target: event.target?.className ?? event.target?.nodeName ?? null,
        }), true);
      }
    });
    const readPointerLog = () => page.evaluate(() => window.__mobilePointerLog ?? []);
    const startFetchLog = () => page.evaluate(() => {
      window.__mobileFetchLog = [];
      if (window.__mobileFetchLogBound) return;
      window.__mobileFetchLogBound = true;
      const original = window.fetch;
      window.fetch = function (...args) {
        try {
          const url = new URL(String(args[0]), location.href);
          if (url.pathname.endsWith('/api/web/v2/tree')) {
            window.__mobileFetchLog.push({
              at: Date.now(),
              parent: url.searchParams.get('parent'),
              cursor: url.searchParams.get('cursor'),
              anchorPath: url.searchParams.get('anchorPath'),
            });
          }
        } catch { /* never break the app's own request */ }
        return original.apply(this, args);
      };
    });
    const readFetchLog = () => page.evaluate(() => window.__mobileFetchLog ?? []);
    const listScrollTop = () => page.evaluate(() => document.querySelector('#note-list')?.scrollTop ?? -1);
    // A tap that lands while the list is still flinging only stops the scroll (the browser never
    // makes it a click), so the probes wait for the list to hold still before pointing at a row.
    const settleListScroll = async (quietMs = 150, timeoutMs = 1500) => {
      const deadline = Date.now() + timeoutMs;
      let last = await listScrollTop();
      let changedAt = Date.now();
      while (Date.now() < deadline && Date.now() - changedAt < quietMs) {
        await sleep(50);
        const current = await listScrollTop();
        if (current !== last) { last = current; changedAt = Date.now(); }
      }
    };
    const openExplorer = async () => {
      await page.waitForSelector(buttonOf('PrefGate'), { state: 'attached' });
      if (!(await page.evaluate(() => document.querySelector('.shell')?.classList.contains('sidebar-open')))) await page.locator('#menu').click();
      await page.waitForFunction(() => document.querySelector('.shell')?.classList.contains('sidebar-open'));
      await sleep(260); // the drawer transform transition is 160 ms
      assert.equal(await page.evaluate(() => document.querySelector('#panel-files')?.hidden), false, 'the files panel must be visible');
    };

    await page.goto(`${base}/app`);
    await page.waitForSelector('.note[title="A.md"]', { state: 'attached' });
    await page.waitForFunction(() => document.querySelector('#live-status')?.dataset.state === 'live', undefined, { timeout: 7000 }).catch(() => {});
    await settleTree();
    await openExplorer();
    clear();

    // K1 — the mobile emulation premise, then the held-pointer issue + tap promotion.
    //
    // The pen phase owns the window itself: this profile defers main-thread work ~110 ms after a real
    // touch pointerdown (measured: a plain `setTimeout(fn, 0)` scheduled in the row's pointerdown
    // listener ran 116 ms later), so touch timing cannot show that a 100 ms window exists. A pen
    // pointer has no such deferral (its 0 ms timer runs at +16 ms, the window timer at +107 ms).
    await check('mobile touch prefetch issues a speculative request while the pointer is held past the 100 ms window and the tap promotes it', async () => {
      const touchParent = 'PrefTouchCtl';
      const penParent = 'PrefStaleSse';
      assert.equal(await page.evaluate(() => matchMedia('(hover: none)').matches), true, 'the mobile profile must report hover: none for this scenario to characterise anything');
      assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true, 'the mobile profile must report pointer: coarse');
      const held = await delayTreeResponses([touchParent, penParent], 1200);
      try {
        clear();
        const point = await tapPoint(touchParent);
        await startPointerLog();
        await startFetchLog();
        await touchStart(point);
        assert.equal(
          await waitFor(() => requestsFor(touchParent).length > 0, 2500),
          true,
          'holding a finger on an unloaded folder row past the 100 ms intent window must issue one speculative tree request',
        );
        const issued = expect('touch-hold:issued', touchParent, 1, 'a held finger must issue exactly one speculative tree request');
        const touchLog = await readPointerLog();
        const touchFetch = (await readFetchLog()).find((entry) => entry.parent === touchParent);
        const down = touchLog.find((entry) => entry.type === 'pointerdown');
        trace.phases.push({ check: 'touch-hold:timeline', at: Date.now(), parent: touchParent, pointerLog: touchLog, fetch: touchFetch ?? null, url: issued[0].url });
        assert.ok(down && touchFetch, `the held finger must produce a real pointerdown and one tree fetch: ${JSON.stringify(touchLog)}`);
        assert.equal(
          touchLog.some((entry) => entry.type === 'pointerup'),
          false,
          'the speculative request must be issued while the finger is still down, before any release or click',
        );
        assert.equal(issued[0].cursor, null, 'a speculative touch prefetch must never page (no cursor, §I06)');
        assert.equal(issued[0].anchorPath, null, 'a speculative touch prefetch must never anchor (no anchorPath, §I06)');
        assert.equal(await expanded(touchParent), 'false', 'a speculative request must not expand the row (§I02)');
        assert.equal(await page.locator(`${childrenOf(touchParent)} .note`).count(), 0, 'a speculative request must not reveal children (§I02)');

        // The tap completes while the response is still held: the click must adopt that owner.
        await touchEnd();
        const rendered = await page.waitForSelector(noteOf(touchParent, 'child-1.md'), { timeout: 4000 }).then(() => true).catch(() => false);
        assert.equal(rendered, true, 'the promoted request must render the children once it lands');
        expect(
          'touch-hold:promote',
          touchParent,
          1,
          `the same-parent tap must promote the in-flight prefetch (one request), never abort and re-issue — pointer log=${JSON.stringify(touchLog)}`,
        );
        assert.equal(await expanded(touchParent), 'true', 'the tap must expand the row');

        // Pen phase: the intent window, measured where the platform does not mask it.
        clear();
        const penPoint = await tapPoint(penParent);
        await startPointerLog();
        await startFetchLog();
        await penDown(penPoint);
        assert.equal(
          await waitFor(() => requestsFor(penParent).length > 0, 2500),
          true,
          'holding a pen on an unloaded folder row past the 100 ms intent window must issue one speculative tree request',
        );
        expect('pen-hold:issued', penParent, 1, 'a held pen must issue exactly one speculative tree request');
        const penLog = await readPointerLog();
        const penFetch = (await readFetchLog()).find((entry) => entry.parent === penParent);
        const penDownEntry = penLog.find((entry) => entry.type === 'pointerdown');
        trace.phases.push({ check: 'pen-hold:timeline', at: Date.now(), parent: penParent, pointerLog: penLog, fetch: penFetch ?? null });
        assert.equal(penDownEntry?.pointerType, 'pen', `the probe must deliver a pen pointerdown: ${JSON.stringify(penLog)}`);
        assert.ok(penFetch, 'the held pen must initiate a tree fetch');
        assert.ok(
          penFetch.at - penDownEntry.at >= 90,
          `the pen request must not be sent eagerly: it was issued ${penFetch.at - penDownEntry.at} ms after the pen pointerdown, and a pen pointer is not deferred the way a touch is (the window is 100 ms)`,
        );
        assert.equal(penFetch.cursor, null, 'a speculative pen prefetch must never page (no cursor, §I06)');
        assert.equal(penFetch.anchorPath, null, 'a speculative pen prefetch must never anchor (no anchorPath, §I06)');
        assert.equal(await expanded(penParent), 'false', 'a speculative request must not expand the row (§I02)');
        await penUp(penPoint);
        const penRendered = await page.waitForSelector(noteOf(penParent, 'child-1.md'), { timeout: 4000 }).then(() => true).catch(() => false);
        assert.equal(penRendered, true, 'the promoted pen request must render the children once it lands');
        expect('pen-hold:promote', penParent, 1, 'the pen release must promote the in-flight prefetch (one request), never abort and re-issue');
        assert.equal(await expanded(penParent), 'true', 'the pen tap must expand the row');
      } finally {
        await touchEnd().catch(() => {});
        await held.stop();
      }
    });

    // K3 — inside the window a release cancels; the same gesture held past it issues.
    await check('mobile touch prefetch intent window: a release inside it issues nothing while a hold past it does', async () => {
      const released = 'PrefDelay';
      clear();
      const releasedPoint = await tapPoint(released);
      // Released 40 ms into the gesture, on the page's own clock: still inside the 100 ms window.
      await syntheticHold(released, { id: 11, point: releasedPoint, holdMs: 40 });
      await sleep(600);
      expect('window:released-inside', released, 0, 'releasing the finger inside the 100 ms intent window must cancel the pending intent (no request)');
      assert.equal(await expanded(released), 'false');

      const held = 'PrefReclaim';
      const heldPoint = await tapPoint(held);
      await dispatchPointer(held, 'pointerdown', { id: 12, point: heldPoint });
      assert.equal(
        await waitFor(() => requestsFor(held).length > 0, 2500),
        true,
        'the same gesture held past the 100 ms intent window must issue a speculative request',
      );
      await dispatchPointer(held, 'pointerup', { id: 12, point: heldPoint });
      await sleep(600); // past the 250 ms commit grace
      expect('window:held-past', held, 1, 'a hold past the window must issue exactly one request, and its later release must not issue a second');
      assert.equal(await expanded(held), 'false', 'a speculative request must never expand the row');
    });

    // K4 — the speculative budget of 2 is shared with hover and never queues a third intent.
    await check('mobile touch prefetch budget: a third speculative touch intent is dropped while its formal tap still fires immediately', async () => {
      const [first, second, third] = ['PrefBudgetA', 'PrefBudgetB', 'PrefBudgetC'];
      const held = await delayTreeResponses([first, second], 3000);
      let settled = 0;
      const onResponse = (response) => {
        if (!response.url().includes(TREE_PATH)) return;
        const parent = new URL(response.url()).searchParams.get('parent');
        if (parent === first || parent === second) settled += 1;
      };
      page.on('response', onResponse);
      try {
        clear();
        // Two fingers held on two rows fill the speculative budget (each pointerId is its own
        // gesture); their responses are held back, so both owners are provably still in flight
        // when the third intent is measured.
        for (const [id, parent] of [[101, first], [102, second]]) {
          const point = await tapPoint(parent);
          await dispatchPointer(parent, 'pointerdown', { id, point });
          assert.equal(await waitFor(() => requestsFor(parent).length > 0, 2500), true, `holding ${parent} must issue one speculative request`);
          expect('budget:issued', parent, 1, `holding ${parent} past the window must issue exactly one speculative request`);
        }
        const thirdPoint = await tapPoint(third);
        await startPointerLog();
        await dispatchPointer(third, 'pointerdown', { id: 103, point: thirdPoint });
        await sleep(400); // well past the intent window, while both held responses are pending
        assert.equal(settled, 0, 'the two speculative responses must still be pending when the third intent is measured (increase the delay if this fails)');
        expect('budget:third', third, 0, 'a third speculative touch prefetch over the concurrency budget of 2 must be dropped, not queued (§I05)');

        const startedAt = Date.now();
        // Playwright's own touchscreen tap (touchStart + touchEnd on the CDP input channel) is the
        // canonical way to produce a real tap click; the held/scroll phases above need the raw
        // channel only because they must control the timing and the intermediate moves.
        await page.touchscreen.tap(thirdPoint.x, thirdPoint.y);
        const tapped = await waitFor(() => requestsFor(third).length > 0, 900);
        if (!tapped) {
          const pointerLog = await readPointerLog();
          trace.phases.push({ check: 'budget:formal-missed', at: Date.now(), parent: third, pointerLog, requests: entries.map((entry) => entry.url) });
          assert.fail(`a formal tap must not wait behind the speculative budget (§I05) — pointer log=${JSON.stringify(pointerLog)} allRequests=${JSON.stringify(entries.map((entry) => entry.url))}`);
        }
        trace.phases.push({ check: 'budget:formal', at: Date.now(), parent: third, pointerdownToRequestMs: requestsFor(third)[0].at - startedAt, url: requestsFor(third)[0].url });
        await page.waitForSelector(noteOf(third, 'child-1.md'), { timeout: 3000 });
        expect('budget:formal', third, 1, 'the formal tap must issue exactly one request for its own parent');
      } finally {
        page.off('response', onResponse);
        // Release the two held gestures so their owners stop being speculative, then drop the
        // delay; nothing here asserts on those cancellations (they belong to K5).
        for (const [id, parent] of [[101, first], [102, second]]) {
          await dispatchPointer(parent, 'pointercancel', { id, point: { x: 10, y: 10 } }).catch(() => {});
        }
        await held.stop();
      }
    });

    // K5 — leaving the row cancels: silently inside the window, owner-safe after it.
    await check('mobile touch prefetch cancels the speculative request when the pointer leaves the row before the tap', async () => {
      const parent = 'PrefStaleSort';
      const held = await delayTreeResponses([parent], 1200);
      const aborts = [];
      const onFailed = (request) => {
        if (request.url().includes(TREE_PATH) && new URL(request.url()).searchParams.get('parent') === parent) {
          aborts.push({ at: Date.now(), error: request.failure()?.errorText ?? null });
        }
      };
      page.on('requestfailed', onFailed);
      try {
        clear();
        const point = await tapPoint(parent);
        // (a) leaving inside the intent window: nothing was issued, nothing is cancelled.
        await syntheticHold(parent, { id: 21, point, holdMs: 30, release: 'pointerleave' });
        await sleep(500);
        expect('leave:before-window', parent, 0, 'leaving the row inside the 100 ms intent window must cancel the pending intent (no request)');

        // (b) leaving after the issue: the speculative owner is released in place.
        await syntheticHold(parent, { id: 22, point, holdMs: 0, release: null });
        assert.equal(await waitFor(() => requestsFor(parent).length > 0, 2500), true, 'the held finger must have issued before the leave is measured');
        expect('leave:issued', parent, 1, 'the held finger must issue exactly one speculative request before leaving');
        await dispatchPointer(parent, 'pointerleave', { id: 22, point });
        assert.equal(
          await waitFor(() => aborts.length >= 1, 2000),
          true,
          `leaving the row releases the still-speculative request (§I04) — expected at least 1 aborted tree request, observed ${aborts.length}: ${JSON.stringify(aborts)}`,
        );
        trace.phases.push({ check: 'leave:abort', at: Date.now(), parent, aborted: aborts.length, errors: aborts.map((entry) => entry.error) });
        expect('leave:after-issue', parent, 1, 'leaving must cancel in place, never abort and re-issue');
        assert.equal(await expanded(parent), 'false', 'a cancelled speculative request must never expand the row');
      } finally {
        page.off('requestfailed', onFailed);
        await held.stop();
      }
    });
    // K2 — a fast tap and a scroll swipe must never pre-issue a request.
    //
    // Runs last on purpose: measured on this profile, Chromium does not synthesise a click for the
    // first tap that follows a canceled scroll gesture (`pointerdown>pointerup` with no
    // `mousedown`/`mouseup`/`click`) — the platform's own "stop the scroll" behaviour, not this
    // feature. The swipe is therefore the last real gesture of the scene.
    await check('mobile touch prefetch issues no speculative request for a fast tap or a scroll swipe', async () => {
      const tapped = 'PrefGate';
      clear();
      const point = await tapPoint(tapped);
      await startPointerLog();
      await startFetchLog();
      await touchStart(point);
      await sleep(60); // released inside the 100 ms window
      await touchEnd();
      assert.equal(
        await waitFor(() => requestsFor(tapped).length > 0, 2500),
        true,
        'a tap released inside the intent window must still load the level through its formal click path',
      );
      const first = requestsFor(tapped)[0];
      const tapLog = await readPointerLog();
      const down = tapLog.find((entry) => entry.type === 'pointerdown');
      const up = tapLog.find((entry) => entry.type === 'pointerup');
      const tapFetch = (await readFetchLog()).find((entry) => entry.parent === tapped);
      trace.phases.push({ check: 'fast-tap', at: Date.now(), parent: tapped, pointerdown: down?.at ?? null, pointerup: up?.at ?? null, fetch: tapFetch?.at ?? null, request: first.at, url: first.url });
      assert.ok(down && up && tapFetch, `the fast tap must produce a real pointerdown/pointerup pair and one tree fetch: ${JSON.stringify(tapLog)}`);
      // Nothing may be requested while the finger is still down: only the tap's own click asks for
      // the level. (This profile defers main-thread work after a touch pointerdown, so a fast tap
      // cannot discriminate the window *length*; K1's pen phase does that.)
      assert.ok(
        tapFetch.at >= up.at,
        `a tap released inside the intent window must not pre-issue a request: fetch=${tapFetch.at} pointerdown=${down.at} pointerup=${up.at} (${first.url})`,
      );
      expect('fast-tap', tapped, 1, 'a fast tap must issue exactly one request — the formal click, never a prefetch plus a click request');
      await page.waitForSelector(noteOf(tapped, 'child-1.md'), { timeout: 3000 });

      const swiped = 'PrefHit';
      clear();
      const before = await listScrollTop();
      const swipe = await tapPoint(swiped);
      await startFetchLog();
      await touchStart(swipe);
      for (const dy of [20, 40, 60]) {
        await touchMove({ x: swipe.x, y: swipe.y - dy });
        await sleep(16);
      }
      await touchEnd();
      await sleep(700); // well past the intent window
      expect('swipe', swiped, 0, `a swipe that travels more than the ${TOUCH_SLOP_PX} px slop must cancel the intent before the window elapses`);
      const swipeFetches = (await readFetchLog()).filter((entry) => entry.parent === swiped);
      trace.phases.push({ check: 'swipe:fetches', at: Date.now(), parent: swiped, fetchCount: swipeFetches.length, fetches: swipeFetches });
      assert.equal(
        swipeFetches.length,
        0,
        `the swipe must not initiate a single tree fetch in the page either — an aborted request can be invisible to the wire observer: ${JSON.stringify(swipeFetches)}`,
      );
      assert.equal(await expanded(swiped), 'false', 'a scroll gesture must never expand the folder row');
      assert.equal(
        await listScrollTop() > before,
        true,
        'the swipe must scroll the note list natively (the touch seam must not preventDefault)',
      );
    });

  } finally {
    trace.finishedAt = Date.now();
    trace.pageErrors = pageErrors;
    await fs.writeFile(
      path.join(outputRoot, 'explorer-touch-prefetch-trace.json'),
      `${JSON.stringify(trace, null, 2)}\n`,
    ).catch(() => {});
    // A page error in this scene is a real defect in the touch path, so it fails the run the
    // same way the shared harness page does.
    assert.deepEqual(pageErrors, [], `the mobile scene must not raise page errors: ${JSON.stringify(pageErrors)}`);
    await context.close();
  }
}
