// Issue #337 Cut 3 — Bases table touch, in the mobile browser scene.
//
// Registered from `bases-mobile.mjs` (which owns the 360x800 `pointer: coarse` /
// `hover: none` context, the Base fixture Vault/server and the check recorder) and
// split into its own module purely for the architecture line budget: that file
// already holds the Cut 2 chrome scene and none of its six checks is touched here.
//
// What it characterises, all with real browser observations:
//   T1 the table container is a two-axis scroller (`overflow-x:auto` + an explicit
//      `touch-action:pan-x pan-y`) and a real finger pan scrolls it sideways;
//   T2 a vertical pan still scrolls vertically — and the same gesture stops doing so
//      when the declaration is narrowed to `pan-x`, which is what makes the
//      "horizontal scrolling must not block the vertical axis" claim falsifiable;
//   T3 every row is a 44px touch target on a coarse pointer;
//   T4 the column-resize boundary is hidden, not a hit target, does not swallow the
//      pan that starts on it and cannot resize anything;
//   T5 a tap selects exactly one row and a second tap clears it (visible paint);
//   T6 tapping a link cell navigates and never selects its row (a DOM mutation
//      observer records `aria-selected` changes, so a row handler that ran is caught
//      even though the link stops the event before any ancestor listener sees it).
//
// Real touch input goes through CDP `Input.dispatchTouchEvent` (the channel
// `touchscreen.tap` uses) because a synthetic JS event cannot scroll anything; this
// pipeline honours `touch-action` (`none` stops both axes, `pan-x` the vertical one),
// which is why T2's falsification is load-bearing rather than decorative.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const MOBILE_VIEWPORT = { width: 360, height: 800 };
// Short enough that the table has a real vertical overflow inside its own scroller:
// the container is the only vertical scroll owner in the Base surface (desktop
// invariant, unchanged by this cut), so this is where "vertical still works" is
// observable at all.
const SHORT_VIEWPORT = { width: 360, height: 420 };
const ROW_MIN_HEIGHT = 44;

export async function registerBasesTableTouchChecks({ check, sleep, page, record = () => {}, outputRoot = null }) {
  const cdp = await page.context().newCDPSession(page);
  const phases = [];
  const note = (name, payload) => {
    const entry = { check: name, at: Date.now(), ...payload };
    phases.push(entry);
    record(name, payload);
  };

  // --- observations ---------------------------------------------------------
  const tableState = () => page.evaluate(() => {
    const wrap = document.querySelector('.base-table-wrap');
    const table = document.querySelector('[data-base-table]');
    const rows = [...document.querySelectorAll('.base-table tbody tr')];
    const media = {
      coarse: matchMedia('(pointer: coarse)').matches,
      hoverNone: matchMedia('(hover: none)').matches,
      narrow: matchMedia('(max-width: 480px)').matches,
    };
    if (!wrap) return { media, present: false };
    const style = getComputedStyle(wrap);
    const rect = wrap.getBoundingClientRect();
    const firstCol = document.querySelector('col[data-column="file.name"]');
    return {
      media,
      present: true,
      band: { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      left: wrap.scrollLeft,
      top: wrap.scrollTop,
      clientWidth: wrap.clientWidth,
      clientHeight: wrap.clientHeight,
      scrollWidth: wrap.scrollWidth,
      scrollHeight: wrap.scrollHeight,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      touchAction: style.touchAction,
      overscrollBehavior: style.overscrollBehavior,
      tableWidth: table ? table.getBoundingClientRect().width : null,
      rowCount: rows.length,
      rowHeights: rows.map((row) => Number(row.getBoundingClientRect().height.toFixed(2))),
      selected: rows.filter((row) => row.getAttribute('aria-selected') === 'true').length,
      handles: [...document.querySelectorAll('.base-col-resize')].map((handle) => {
        const box = handle.getBoundingClientRect();
        return { display: getComputedStyle(handle).display, width: Number(box.width.toFixed(2)), touchAction: getComputedStyle(handle).touchAction };
      }),
      firstColWidth: firstCol ? firstCol.style.width : null,
      pageScrollTop: document.scrollingElement.scrollTop,
    };
  });
  const scrollState = () => page.evaluate(() => {
    const wrap = document.querySelector('.base-table-wrap');
    return { left: wrap.scrollLeft, top: wrap.scrollTop, pageScrollTop: document.scrollingElement.scrollTop };
  });
  const resetScroll = () => page.evaluate(() => {
    const wrap = document.querySelector('.base-table-wrap');
    wrap.scrollLeft = 0;
    wrap.scrollTop = 0;
  });
  // Every check sets the viewport it needs, so a failure in an earlier check cannot
  // leave later checks running in the wrong geometry (measured: an early failure in T2
  // used to leak the short viewport into T3-T6).
  const setViewport = async (width, height) => {
    await page.setViewportSize({ width, height });
    await sleep(300);
  };
  // Tap forensics: a capture-phase click log (target, row, and `detail`, i.e. the
  // click count) so a red run reports what the finger actually hit instead of only
  // "nothing was selected".
  const installTapLog = () => page.evaluate(() => {
    window.__u27TapLog = [];
    if (window.__u27TapListener) document.removeEventListener('click', window.__u27TapListener, true);
    window.__u27TapListener = (event) => {
      const rows = [...document.querySelectorAll('.base-table tbody tr')];
      window.__u27TapLog.push({
        type: event.type,
        detail: event.detail ?? null,
        tag: event.target?.tagName ?? null,
        className: String(event.target?.className ?? ''),
        rowIndex: rows.indexOf(event.target?.closest?.('tr')),
        x: Math.round(event.clientX),
        y: Math.round(event.clientY),
      });
    };
    document.addEventListener('click', window.__u27TapListener, true);
  });
  const readTapLog = () => page.evaluate(() => {
    const log = window.__u27TapLog ?? [];
    window.__u27TapLog = [];
    return log;
  });
  // --- the asserted input ---------------------------------------------------
  // The compositor only synthesises a `click` while its gesture pipeline is idle, so the
  // check waits for the container to come to rest before measuring anything and then
  // drains the remaining hazard explicitly (`disarmFling`, where the measurements live).
  const waitForStill = async (budgetMs = 4000, needed = 3, gapMs = 50) => {
    const started = Date.now();
    const samples = [];
    let previous = null;
    let stable = 0;
    while (Date.now() - started < budgetMs) {
      const left = await page.evaluate(() => Math.round(document.querySelector('.base-table-wrap').scrollLeft));
      samples.push(left);
      stable = left === previous ? stable + 1 : 0;
      previous = left;
      if (stable >= needed) return { stable: true, left, waitedMs: Date.now() - started, samples };
      await sleep(gapMs);
    }
    return { stable: false, left: previous, waitedMs: Date.now() - started, samples };
  };
  // Hit test at the tap point, taken at tap time: a point that stopped hitting the
  // intended cell (reflow / leftover overlay / a fling that moved the row) fails
  // with its own geometry instead of an unrelated assertion.
  const hitAt = (x, y) => page.evaluate(({ px, py }) => {
    const rows = [...document.querySelectorAll('.base-table tbody tr')];
    const node = document.elementFromPoint(px, py);
    const row = node?.closest?.('.base-table tbody tr') ?? null;
    return {
      hit: node ? { tag: node.tagName, className: String(node.className) } : null,
      rowIndex: rows.indexOf(row),
    };
  }, { px: x, py: y });
  // The first touch landing while a pan's fling is still armed is consumed as the fling-stop
  // and never becomes a click (`probe/probe-fling-tap.mjs`). That window is invisible from the
  // page (the offset is already clamped at 0, so `waitForStill` reads `[0,0,0,0]` while the
  // pipeline is busy) and it is a build property — `probe/which-chromium.mjs`,
  // `probe/fixc-fling-cancel-*.json`: `chrome-headless-shell` holds it past the 3 s budget where
  // the pinned full chrome usually does not. A *cancelled* touch drains it and can never click.
  const disarmFling = async () => {
    const point = await page.evaluate(() => {
      const box = document.querySelector('.base-table-wrap').getBoundingClientRect();
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await sleep(60);
    return point;
  };
  // The tap point, only measured after the container is provably at rest and its fling drained.
  const anchorForTap = async (selector) => {
    const drained = await waitForStill();
    const disarmed = await disarmFling();
    await resetScroll();
    const rearmed = await waitForStill();
    const point = await visiblePoint(selector);
    const landed = point ? await hitAt(point.x, point.y) : null;
    return { drained, disarmed, rearmed, point, landed };
  };
  // Tap, then wait for the click the browser synthesises from it. The wait is the
  // observation (a click synthesised late is still the same tap), not a relaxation.
  const tapAndWait = async (x, y, budgetMs = 3000) => {
    await page.touchscreen.tap(x, y);
    const started = Date.now();
    for (;;) {
      const clicks = await readTapLog();
      if (clicks.length > 0 || Date.now() - started >= budgetMs) {
        return { latencyMs: Date.now() - started, arrived: clicks.length > 0, clicks };
      }
      await sleep(40);
    }
  };

  // In-scene falsification hook: override the declaration at runtime and restore it.
  const setTouchAction = (value) => page.evaluate((override) => {
    const wrap = document.querySelector('.base-table-wrap');
    if (override === null) wrap.style.removeProperty('touch-action');
    else wrap.style.setProperty('touch-action', override);
  }, value);
  // A real finger: touchStart -> touchMoves -> touchEnd. A gesture with movement
  // longer than the touch slop never produces a click, so it cannot select a row.
  const pan = async (from, dx, dy, steps = 10) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
    for (let step = 1; step <= steps; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: from.x + (dx * step) / steps, y: from.y + (dy * step) / steps, id: 1 }],
      });
      await sleep(6);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(320);
  };
  // A tap point for `selector`: the centre of the intersection of the node with the
  // table band, plus the hit test at that point. A clipped or covered target fails
  // with its own geometry instead of an unrelated assertion.
  const visiblePoint = (selector) => page.evaluate((wanted) => {
    const node = document.querySelector(wanted);
    const wrap = document.querySelector('.base-table-wrap');
    if (!node || !wrap) return null;
    const band = wrap.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const left = Math.max(box.x, band.x);
    const right = Math.min(box.right, band.right);
    const top = Math.max(box.y, band.y);
    const bottom = Math.min(box.bottom, band.bottom);
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
      visibleWidth: Number((right - left).toFixed(2)),
      visibleHeight: Number((bottom - top).toFixed(2)),
      hit: hit ? { tag: hit.tagName, className: String(hit.className), own: hit === node || Boolean(hit.closest?.(wanted)) } : null,
    };
  }, selector);

  try {
    // --- T1: the container is a two-axis scroller ---------------------------
    await check('bases mobile table: the table container scrolls sideways for a real finger pan and leaves both axes open', async () => {
      await setViewport(MOBILE_VIEWPORT.width, MOBILE_VIEWPORT.height);
      await resetScroll();
      const before = await tableState();
      assert.equal(before.present, true, 'the table container must exist');
      assert.equal(before.media.coarse, true, 'this scene must run the pointer: coarse profile it characterises');
      assert.equal(before.overflowX, 'auto', `the container must be a horizontal scroller, saw overflow-x:${before.overflowX}`);
      assert.ok(
        before.scrollWidth > before.clientWidth + 8,
        `the table must really overflow horizontally at 360px (scrollWidth ${before.scrollWidth} vs clientWidth ${before.clientWidth})`,
      );
      assert.equal(
        before.touchAction,
        'pan-x pan-y',
        `the container must leave both pan axes to the browser, saw touch-action:${before.touchAction}`,
      );
      // Start on the container's own empty area (right of / below the last row) so the
      // pan cannot be confused with a row interaction.
      const from = { x: Math.round(before.band.right - 24), y: Math.round(before.band.bottom - 16) };
      await pan(from, -240, 0);
      const after = await scrollState();
      note('t1', { before, from, after });
      assert.ok(after.left > 0, `a horizontal finger pan must scroll the table container, saw scrollLeft=${after.left}`);
      assert.equal(after.top, 0, `a horizontal pan must not move the table vertically, saw scrollTop=${after.top}`);
      assert.equal(after.pageScrollTop, 0, `a horizontal pan must not scroll the page, saw page scrollTop=${after.pageScrollTop}`);
      await resetScroll();
    });

    // --- T2: the vertical axis is not captured ------------------------------
    await check('bases mobile table: a vertical touch pan over the table still scrolls vertically, including one that starts on a column boundary', async () => {
      await setViewport(SHORT_VIEWPORT.width, SHORT_VIEWPORT.height);
      await resetScroll();
      const short = await tableState();
      assert.ok(
        short.scrollHeight > short.clientHeight + 8,
        `this construction needs a real vertical overflow inside the container (${short.scrollHeight} vs ${short.clientHeight})`,
      );
      const from = { x: Math.round(short.band.x + 180), y: Math.round(short.band.y + 40) };
      await pan(from, 0, -160);
      const panned = await scrollState();
      note('t2', { short, from, panned });
      assert.ok(
        panned.top > 0,
        `a vertical finger pan over the table must scroll it vertically, saw scrollTop=${panned.top}`,
      );
      assert.equal(panned.left, 0, `a vertical pan must not be turned into a horizontal scroll, saw scrollLeft=${panned.left}`);
      assert.equal(panned.pageScrollTop, 0, `the vertical gesture must not scroll the page instead, saw ${panned.pageScrollTop}`);

      // The second origin is the column boundary: the pre-cut tree placed a 7px
      // `touch-action:none` handle exactly there, and that element swallowed this
      // gesture in both axes (measured `scrollTop:0` before the cut).
      await resetScroll();
      const boundary = await page.evaluate(() => {
        const th = document.querySelector('.base-table thead th');
        const rect = th.getBoundingClientRect();
        const point = { x: Math.round(rect.right - 3), y: Math.round(rect.y + rect.height / 2) };
        const hit = document.elementFromPoint(point.x, point.y);
        return { ...point, hitTag: hit ? hit.tagName : null, hitClass: hit ? String(hit.className) : null };
      });
      await pan({ x: boundary.x, y: boundary.y }, 0, -160);
      const fromBoundary = await scrollState();
      note('t2:boundary', { boundary, fromBoundary });
      assert.ok(
        fromBoundary.top > 0,
        `a vertical pan starting on the column boundary must scroll too, saw scrollTop=${fromBoundary.top}`,
      );
      assert.equal(fromBoundary.left, 0, `the boundary gesture must stay vertical, saw scrollLeft=${fromBoundary.left}`);

      // Falsification inside the scene: narrow the declaration and the very same
      // gesture stops delivering the vertical axis.
      await resetScroll();
      await setTouchAction('pan-x');
      await pan(from, 0, -160);
      const narrowed = await scrollState();
      await setTouchAction(null);
      await resetScroll();
      await pan(from, 0, -160);
      const restored = await scrollState();
      note('t2:falsify', { narrowed, restored });
      assert.equal(narrowed.top, 0, `touch-action:pan-x must drop the vertical axis, saw scrollTop=${narrowed.top}`);
      assert.ok(restored.top > 0, `restoring the two-axis declaration must restore vertical panning, saw scrollTop=${restored.top}`);
      await setViewport(MOBILE_VIEWPORT.width, MOBILE_VIEWPORT.height);
      await resetScroll();
    });

    // --- T3: 44px row touch targets -----------------------------------------
    await check('bases mobile table: every row is a 44px touch target on a coarse pointer', async () => {
      await setViewport(MOBILE_VIEWPORT.width, MOBILE_VIEWPORT.height);
      const state = await tableState();
      assert.equal(state.media.coarse, true, 'the row height rule is keyed on the coarse-pointer capability');
      assert.ok(state.rowCount >= 3, `the fixture view must render rows, saw ${state.rowCount}`);
      const tooShort = state.rowHeights.filter((height) => height < ROW_MIN_HEIGHT - 0.5);
      note('t3', { rowCount: state.rowCount, rowHeights: state.rowHeights, cellPadding: await page.evaluate(() => getComputedStyle(document.querySelector('.base-table tbody td')).padding) });
      assert.deepEqual(tooShort, [], `every row must reach ${ROW_MIN_HEIGHT}px, saw heights ${JSON.stringify(state.rowHeights)}`);
      const cell = await page.evaluate(() => Number(document.querySelector('.base-table tbody td').getBoundingClientRect().height.toFixed(2)));
      assert.ok(cell >= ROW_MIN_HEIGHT - 1.5, `the cell box must carry the touch target too, saw ${cell}px`);
    });

    // --- T4: the resize boundary is refused ---------------------------------
    await check('bases mobile table: the column-resize boundary is hidden, not a hit target and cannot resize on a coarse pointer', async () => {
      await setViewport(MOBILE_VIEWPORT.width, MOBILE_VIEWPORT.height);
      await resetScroll();
      const before = await tableState();
      assert.ok(before.handles.length > 0, 'the handle nodes must still exist (the DOM contract is unchanged; CSS hides them)');
      const visible = before.handles.filter((handle) => handle.display !== 'none');
      assert.deepEqual(visible, [], `every resize handle must be hidden on a coarse pointer, saw ${JSON.stringify(before.handles)}`);
      const boundary = await page.evaluate(() => {
        const th = document.querySelector('.base-table thead th');
        const rect = th.getBoundingClientRect();
        const x = Math.round(rect.right - 3);
        const y = Math.round(rect.y + rect.height / 2);
        const hit = document.elementFromPoint(x, y);
        return {
          x,
          y,
          thRight: Number(rect.right.toFixed(2)),
          hitTag: hit ? hit.tagName : null,
          hitClass: hit ? String(hit.className) : null,
          isHandle: Boolean(hit?.closest?.('.base-col-resize')),
        };
      });
      note('t4:boundary', { before, boundary });
      assert.equal(boundary.isHandle, false, `the column boundary must not be a resize hit target, hit=${JSON.stringify(boundary)}`);
      // A pan that starts exactly on the boundary must still scroll: on the pre-cut tree
      // the 7px `touch-action:none` handle swallowed exactly this gesture.
      await resetScroll();
      await pan({ x: boundary.x, y: boundary.y }, -200, 0);
      const panned = await scrollState();
      // ...and a finger drag across the boundary must not resize the column either.
      const colBefore = (await tableState()).firstColWidth;
      await pan({ x: boundary.x, y: boundary.y }, 60, 0);
      const after = await tableState();
      const stored = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('base-view-config')).map((key) => localStorage.getItem(key)));
      note('t4:gesture', { boundary, panned, colBefore, colAfter: after.firstColWidth, stored });
      assert.ok(panned.left > 0, `a pan starting on the column boundary must still scroll the table, saw scrollLeft=${panned.left}`);
      assert.equal(after.firstColWidth, colBefore, `a touch drag across the boundary must not resize the column (${colBefore} -> ${after.firstColWidth})`);
      assert.deepEqual(stored, [], `no column width may be persisted from a touch drag, saw ${JSON.stringify(stored)}`);
      assert.equal(after.selected, 0, 'the scroll gestures must not have selected a row');
      await resetScroll();
    });

    // --- T5: tap selection ---------------------------------------------------
    await check('bases mobile table: a tap selects exactly one row and tapping it again clears the selection', async () => {
      await setViewport(MOBILE_VIEWPORT.width, MOBILE_VIEWPORT.height);
      await resetScroll();
      await installTapLog();
      const start = await tableState();
      assert.equal(start.selected, 0, `the check must start from no selection, saw ${start.selected}`);
      const plainCell = '.base-table tbody tr:nth-child(2) td:nth-child(2)';
      const anchored = await anchorForTap(plainCell);
      const { point, landed } = anchored;
      assert.ok(
        point && point.visibleWidth >= 8 && point.visibleHeight >= 8 && point.hit?.own === true,
        `the second row's value cell must be hit-testable inside the band, saw ${JSON.stringify(point)}`,
      );
      assert.equal(landed?.rowIndex, 1, `the measured tap point must still hit the second row at tap time, saw ${JSON.stringify(landed)}`);
      const tap = await tapAndWait(point.x, point.y);
      const picks = tap.clicks;
      const picked = await page.evaluate(() => [...document.querySelectorAll('.base-table tbody tr')].map((row, index) => ({
        index,
        selected: row.getAttribute('aria-selected'),
        background: getComputedStyle(row).backgroundColor,
        className: row.className,
      })));
      note('t5:pick', { start, anchored, tap, picked, afterTapScroll: await scrollState() });
      assert.equal(
        picked.filter((row) => row.selected === 'true').length,
        1,
        `a tap must select exactly one row, saw ${JSON.stringify(picked)} — anchored ${JSON.stringify(anchored)} — clicks: ${JSON.stringify(picks)}`,
      );
      assert.equal(picked[1].selected, 'true', `the tapped row must be the selected one — clicks: ${JSON.stringify(picks)}`);
      assert.equal(picked[1].className.includes('is-selected'), true, `the selected row must carry its class, saw ${picked[1].className}`);
      assert.notEqual(picked[1].background, picked[0].background, 'the selection must be painted, not only stored in an attribute');

      // A second tap on the same row clears it (the state is a real transition, not
      // a one-way flag).
      await anchorForTap(plainCell);
      const tap2 = await tapAndWait(point.x, point.y);
      const clears = tap2.clicks;
      const cleared = await tableState();
      note('t5:clear', { cleared, clears, tap2 });
      assert.equal(
        cleared.selected,
        0,
        `tapping the selected row again must clear the selection, saw ${cleared.selected} — clicks: ${JSON.stringify(clears)}`,
      );
    });

    // --- T6: link click beats row selection ---------------------------------
    await check('bases mobile table: tapping a link cell opens the note and never selects its row', async () => {
      await setViewport(MOBILE_VIEWPORT.width, MOBILE_VIEWPORT.height);
      await resetScroll();
      await installTapLog();
      assert.equal((await tableState()).selected, 0, 'the link check must start from no selection');
      // Positive premise: the tap-selection affordance is live on this tree (red on the
      // pre-cut tree, where no row is selectable at all).
      const anchored = await anchorForTap('.base-table tbody tr:nth-child(2) td:nth-child(2)');
      const plain = anchored.point;
      assert.ok(plain && plain.hit?.own === true, `the premise cell must be hit-testable, saw ${JSON.stringify(plain)}`);
      assert.equal(anchored.landed?.rowIndex, 1, `the premise tap point must still hit the second row, saw ${JSON.stringify(anchored.landed)}`);
      const premiseTaps = (await tapAndWait(plain.x, plain.y)).clicks;
      assert.equal((await tableState()).selected, 1, `a tap must select a row (the premise of the priority contract) — clicks: ${JSON.stringify(premiseTaps)}`);
      await anchorForTap('.base-table tbody tr:nth-child(2) td:nth-child(2)');
      const clearTaps = (await tapAndWait(plain.x, plain.y)).clicks;
      assert.equal((await tableState()).selected, 0, `the premise must end with no selection — clicks: ${JSON.stringify(clearTaps)}`);

      // Watch the DOM, not the event: the link stops the click before any ancestor
      // listener runs, so only a mutation record can prove a row handler did *not* run.
      await page.evaluate(() => {
        window.__u27SelectionMutations = [];
        const tbody = document.querySelector('[data-base-table] tbody');
        const observer = new MutationObserver((records) => {
          for (const mutation of records) {
            if (mutation.type === 'attributes' && mutation.attributeName === 'aria-selected') {
              window.__u27SelectionMutations.push(mutation.target.getAttribute('aria-selected'));
            }
          }
        });
        observer.observe(tbody, { attributes: true, attributeFilter: ['aria-selected'], subtree: true });
      });
      // The link column is the last one: scroll it into the band first (which is also
      // the horizontal-scroll path a phone user needs).
      await page.evaluate(() => {
        const wrap = document.querySelector('.base-table-wrap');
        wrap.scrollLeft = wrap.scrollWidth - wrap.clientWidth;
      });
      await sleep(200);
      const link = await visiblePoint('.base-cell-link');
      assert.ok(
        link && link.visibleWidth >= 8 && link.hit?.own === true,
        `the link cell must be reachable inside the band after scrolling, saw ${JSON.stringify(link)}`,
      );
      const noteRequest = page.waitForResponse(
        (response) => response.request().method() === 'GET' && response.url().includes('/api/web/v1/note?') && response.status() === 200,
        { timeout: 10000 },
      );
      await waitForStill();
      await page.touchscreen.tap(link.x, link.y);
      await noteRequest;
      await page.waitForFunction(() => document.querySelector('#base-host')?.hidden === true, { timeout: 10000 });
      const mutations = await page.evaluate(() => window.__u27SelectionMutations);
      const linkTaps = await readTapLog();
      const currentPath = String((await page.locator('#current-path').textContent()) ?? '').trim();
      note('t6', { plain, link, mutations, linkTaps, currentPath });
      assert.deepEqual(mutations, [], `a link tap must never change a row's selection, observed ${JSON.stringify(mutations)}`);
      assert.ok(currentPath.toLowerCase().endsWith('.md'), `the link tap must have opened the target note, saw current path "${currentPath}"`);
    });
  } finally {
    if (outputRoot) {
      const payload = { startedAt: phases[0]?.at ?? Date.now(), finishedAt: Date.now(), viewport: MOBILE_VIEWPORT, shortViewport: SHORT_VIEWPORT, rowMinHeight: ROW_MIN_HEIGHT, phases };
      await fs.writeFile(path.join(outputRoot, 'bases-table-touch-trace.json'), `${JSON.stringify(payload, null, 2)}\n`).catch(() => {});
    }
  }
}
