// Issue #284 §13 — real-Chromium characterisation of Explorer hover prefetch.
//
// Every check is RED on the pre-#284 base (no prefetch implementation exists) and must turn green
// once B1 (`lazy-controller.js` prefetch/cancelPrefetch) and B2 (`tree.js` pointerenter wiring)
// land, without rewriting a single assertion. It asserts only observable wire/DOM behaviour —
// never a base-only fact such as "there is no pointerenter listener", never a production symbol
// B1/B2 may rename — never swallows an assertion error, and never skips. Request accounting is the
// page's own `/api/web/v2/tree?parent=<parent>` log; DOM assertions use the selectors the shipped
// renderer already produces.
//
// Threshold fidelity (contract §13.1 "hover 149 ms then leave"): Node/CDP sleep plus pointer
// travel cannot hit 149 ms deterministically, so the sub-threshold phase holds the pointer for
// ~80 ms and samples the request log *while the pointer is still on the row* (nothing may be
// issued before the intent window elapses), then leaves early and re-samples; the positive phase
// hovers past the window and requires exactly one request. The request log, per-check
// expected/observed counts and hover/issue timestamps land in
// `<outputRoot>/explorer-prefetch-trace.json` as evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// Contract §8: browser-global interaction preference, `hover` (default) or `off`.
const PREFERENCE_KEY = 'obsidian.web.explorer.prefetch.v1';
const PREFERENCE_OFF = 'off';
const TREE_PATH = '/api/web/v2/tree';
const ROUTE_GLOB = `**${TREE_PATH}**`;
const AWAY = { x: 900, y: 420 };
const MAIN_VIEWPORT = { width: 1440, height: 1000 };

export async function registerExplorerPrefetchChecks(ctx) {
  const { check, sleep, page: sharedPage, browser, base, vault, outputRoot } = ctx;

  const trace = { startedAt: Date.now(), base, requests: [], phases: [] };
  // A tracker is an array of request entries for one page; `active` is the one the current
  // check measures (the module probe page, or a preference probe page).
  const track = (target, scope) => {
    const entries = [];
    target.on('request', (request) => {
      if (!request.url().includes(TREE_PATH)) return;
      const url = new URL(request.url());
      const entry = {
        at: Date.now(),
        scope,
        parent: url.searchParams.get('parent'),
        cursor: url.searchParams.get('cursor'),
        anchorPath: url.searchParams.get('anchorPath'),
        url: url.href,
      };
      entries.push(entry);
      trace.requests.push(entry);
    });
    return entries;
  };

  // Wait until a page's tree request log has been quiet for `quietMs` (the startup resync lands
  // after `#live-status` turns live, so live status alone is not a settled tree).
  const settleTree = async (entries, quietMs = 600, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    let seen = entries.length;
    let changedAt = Date.now();
    while (Date.now() < deadline && Date.now() - changedAt < quietMs) {
      await sleep(100);
      if (entries.length !== seen) { seen = entries.length; changedAt = Date.now(); }
    }
  };

  const rowOf = (parent) => `.tree-folder-row[data-folder-path=${JSON.stringify(parent)}]`;
  const buttonOf = (parent) => `${rowOf(parent)} .tree-folder`;
  const childrenOf = (parent) => `${rowOf(parent)} + .tree-children`;
  const noteOf = (parent, name) => `${childrenOf(parent)} .note[title=${JSON.stringify(`${parent}/${name}`)}]`;
  const requestsFor = (parent) => active.filter((entry) => entry.parent === parent);
  const clear = () => { active.length = 0; };
  const hover = async (parent) => { await page.locator(buttonOf(parent)).hover(); };
  const leave = async () => { await page.mouse.move(AWAY.x, AWAY.y); };
  const waitFor = async (predicate, timeoutMs = 2500, stepMs = 20) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) return false;
      await sleep(stepMs);
    }
    return true;
  };
  // Absolute per-parent request accounting: the failure message carries the whole observed log,
  // so a red run proves the failure instead of only naming it.
  const expect = (tag, parent, expected, message) => {
    const observed = requestsFor(parent);
    trace.phases.push({ check: tag, at: Date.now(), scope: observed[0]?.scope ?? null, parent, expected, observed: observed.length, urls: observed.map((entry) => entry.url) });
    assert.equal(
      observed.length,
      expected,
      `${message} — expected ${expected} tree request(s) for ${parent}, observed ${observed.length}: ${JSON.stringify(observed.map((entry) => entry.url))}`,
    );
    return observed;
  };
  const expectAtLeast = (parent, minimum, message) => {
    const observed = requestsFor(parent);
    assert.ok(
      observed.length >= minimum,
      `${message} — expected at least ${minimum} tree request(s) for ${parent}, observed ${observed.length}: ${JSON.stringify(observed.map((entry) => entry.url))}`,
    );
  };
  // `null` instead of a timeout rejection keeps a missing request reported by our own
  // assertion (with the contract clause) rather than by a Playwright timeout message.
  const treeResponse = (parent, timeoutMs) => page.waitForResponse(
    (response) => response.url().includes(TREE_PATH) && new URL(response.url()).searchParams.get('parent') === parent,
    { timeout: timeoutMs },
  ).catch(() => null);
  const renderedPaths = (parent) => page.locator(`${childrenOf(parent)} .note[data-path]`).evaluateAll((nodes) => nodes.map((node) => node.dataset.path));
  const expectServerOrder = (dom, body) => {
    const server = (body?.items ?? []).map((item) => item.path);
    assert.deepEqual(
      dom,
      server.filter((entry) => dom.includes(entry)),
      `the rendered level must keep the server page order: dom=${JSON.stringify(dom)} server=${JSON.stringify(server)}`,
    );
  };
  // Controllable response delay: the request still goes to the real application route, only its response is held back.
  const delayTreeResponses = async (parents, ms) => {
    const delayed = new Set(parents);
    const handler = async (route) => {
      if (delayed.has(new URL(route.request().url()).searchParams.get('parent'))) await sleep(ms);
      await route.continue();
    };
    await page.route(ROUTE_GLOB, handler);
    return { delayed, stop: () => page.unroute(ROUTE_GLOB, handler) };
  };
  // A fresh authenticated context with its own Explorer state and browser-local preference.
  const probePage = async ({ hasTouch = false, viewport = MAIN_VIEWPORT } = {}) => {
    const context = await browser.newContext({ viewport, hasTouch });
    await context.addCookies(await sharedPage.context().cookies());
    const probe = await context.newPage();
    probe.setDefaultTimeout(7000);
    return { context, probe };
  };
  const waitLive = (target) => target.waitForFunction(() => document.querySelector('#live-status')?.dataset.state === 'live', undefined, { timeout: 7000 }).catch(() => {});
  const openApp = async (probe) => {
    await probe.goto(`${base}/app`);
    await probe.waitForSelector('.note[title="A.md"]');
    await waitLive(probe);
  };
  // Every check runs against this dedicated page: the shared harness page may still sit at another
  // module's mobile viewport, and `bases.mjs` opens a note whose anchor-inclusive root page replaces
  // the root level with a files-only window. A fresh `/app` boot has the full folder level, an empty
  // cache and the default preferences.
  const { context: probeContext, probe } = await probePage();
  const page = probe;
  const main = track(page, 'main');
  let active = main;
  await openApp(page);
  // The Explorer boots through an SSE handshake that emits `vault.resync`
  // (`invalidateEverything()` + root reload) after the visible tree is already painted, so a
  // probe started immediately would have its request aborted by the startup resync. Wait for
  // the live status and then for the tree request log to hold still before probing.
  // Records whether the shipped "正在加载…" placeholder ever appeared inside one parent's children.
  const watchLoading = (parent) => page.evaluate((folder) => {
    window.__prefetchLoadingRows = [];
    const isPlaceholder = (node) => {
      const element = node.nodeType === 1 ? node : node.parentElement;
      const children = element?.closest?.('.tree-children');
      if (!children || children.previousElementSibling?.dataset?.folderPath !== folder) return false;
      return /正在加载/.test(element.textContent || '');
    };
    window.__prefetchLoadingObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (isPlaceholder(node)) window.__prefetchLoadingRows.push(node.textContent);
      }
    });
    window.__prefetchLoadingObserver.observe(document.querySelector('#note-list'), { childList: true, subtree: true });
  }, parent);
  const readLoading = () => page.evaluate(() => window.__prefetchLoadingRows ?? []);
  const stopWatchingLoading = () => page.evaluate(() => { window.__prefetchLoadingObserver?.disconnect(); window.__prefetchLoadingObserver = null; });
  const selectSort = async (spec) => {
    await page.locator('#explorer-sort-toggle').click();
    await page.locator(`#explorer-sort-menu [data-sort-key="${spec.key}"][data-sort-direction="${spec.direction}"]`).click();
    await sleep(150);
  };
  await settleTree(main);

  // §13.1 — intent window: nothing below it, exactly one request past it.
  await check('explorer prefetch intent: no request below the intent window, exactly one past it', async () => {
    const parent = 'PrefGate';
    try {
      await leave();
      await sleep(120);
      clear();
      await hover(parent);
      await sleep(80); // sampled while still hovering, i.e. below the intent window
      expect('intent:sub-threshold', parent, 0, 'a hold below the intent window must not issue a speculative request while the pointer is still on the row');
      await leave();
      await sleep(350);
      expect('intent:abandoned', parent, 0, 'leaving before the intent window must cancel the pending intent (no late request)');
      assert.equal(await page.locator(rowOf(parent)).evaluate((el) => el.matches(':hover')), false, `the probe pointer must really have left ${parent}`);

      clear();
      const startedAt = Date.now();
      await hover(parent);
      await waitFor(() => requestsFor(parent).length > 0);
      const issued = expect('intent:crossing', parent, 1, `hovering ${parent} past the intent window must issue exactly one speculative tree request (§13.1)`);
      trace.phases.push({ check: 'intent:issue-latency', at: Date.now(), parent, hoverToRequestMs: issued[0].at - startedAt, url: issued[0].url });
      assert.ok(issued[0].at - startedAt >= 90, `the speculative request must not be sent eagerly: it was issued ${issued[0].at - startedAt} ms after the hover started (intent window is 150 ms)`);
      assert.equal(issued[0].cursor, null, 'a speculative prefetch must never page (no cursor, §I06)');
      assert.equal(await page.locator(buttonOf(parent)).getAttribute('aria-expanded'), 'false', 'a speculative request must not expand the row (§I02)');
      assert.equal(await page.locator(childrenOf(parent)).evaluate((el) => el.hidden), true, 'a speculative request must not reveal children (§I02)');
    } finally {
      await leave();
    }
  });

  // §13.2 — a completed prefetch makes the same-parent click request-free and loading-free.
  await check('explorer prefetch hit: click after a successful hover adds no request and no loading row', async () => {
    const parent = 'PrefHit';
    try {
      await leave();
      await sleep(120);
      clear();
      const prefetch = treeResponse(parent, 3000);
      await hover(parent);
      await waitFor(() => requestsFor(parent).length > 0);
      expect('hit:prefetch', parent, 1, `hovering ${parent} past the intent window must issue exactly one speculative tree request (§13.2)`);
      const response = await prefetch;
      assert.ok(response, 'the speculative request must complete before the click probe can measure a cache hit (§13.2)');
      assert.equal(response.status(), 200, 'the speculative request must succeed');
      const body = await response.json();

      await watchLoading(parent);
      await page.locator(buttonOf(parent)).click();
      await page.waitForSelector(noteOf(parent, 'child-1.md'), { timeout: 1500 });
      await sleep(250);
      expect('hit:click', parent, 1, 'clicking a parent whose prefetch already succeeded must add zero tree requests');
      assert.equal(await page.locator(buttonOf(parent)).getAttribute('aria-expanded'), 'true', 'the click must expand the row');
      expectServerOrder(await renderedPaths(parent), body);
      const loading = await readLoading();
      assert.deepEqual(loading, [], `a cache hit must not render the "正在加载…" placeholder: ${JSON.stringify(loading)}`);
    } finally {
      await stopWatchingLoading();
      await leave();
    }
  });

  // §13.3 / I08 — promotion: prefetch in flight, click promotes the same request.
  await check('explorer prefetch in flight: same-parent click keeps one request and survives a late pointerleave', async () => {
    const parent = 'PrefDelay';
    const delay = await delayTreeResponses([parent], 1200);
    try {
      await leave();
      await sleep(120);
      clear();
      const promoted = treeResponse(parent, 4000);
      await hover(parent);
      await waitFor(() => requestsFor(parent).length > 0);
      expect('in-flight:issued', parent, 1, `hovering ${parent} past the intent window must issue exactly one speculative request before the click (§13.3)`);
      await page.locator(buttonOf(parent)).click(); // formal intent while the prefetch is still in flight
      await leave(); // the late pointerleave must not abort the promoted owner
      const response = await promoted;
      assert.ok(response, 'the promoted request must still complete after a late pointerleave (§13.3 / I08)');
      assert.equal(response.status(), 200, 'the promoted request must succeed');
      const rendered = await page.waitForSelector(noteOf(parent, 'child-1.md'), { timeout: 3000 }).then(() => true).catch(() => false);
      if (!rendered) {
        const seen = await page.locator(`${childrenOf(parent)} *`).evaluateAll((nodes) => nodes.map((node) => node.textContent)).catch(() => null);
        assert.fail(`after promotion the children must render normally: children=${JSON.stringify(seen)}`);
      }
      expect('in-flight:promote', parent, 1, 'prefetch plus same-parent click must stay at exactly one request for that parent (promote, never abort+resend)');
      assert.equal(await page.locator(`${childrenOf(parent)} .load-error, ${childrenOf(parent)} .empty`).count(), 0, 'a promoted load must not end in a visible error row');
    } finally {
      await delay.stop();
      await leave();
    }
  });

  // §13.4 / I05 — bounded speculative concurrency, formal requests are never queued behind it.
  await check('explorer prefetch budget: a third speculative hover is dropped while a formal toggle still fires immediately', async () => {
    const [first, second, third] = ['PrefBudgetA', 'PrefBudgetB', 'PrefBudgetC'];
    // The held responses must still be in flight when the third hover is sampled (~1s into the
    // check), so the delay is far larger than the probe sequence.
    const delay = await delayTreeResponses([first, second], 3000);
    let settled = 0;
    const onResponse = (response) => {
      if (!response.url().includes(TREE_PATH)) return;
      const parent = new URL(response.url()).searchParams.get('parent');
      if (parent === first || parent === second) settled += 1;
    };
    page.on('response', onResponse);
    // Adjudicated (docs/web-explorer-prefetch.md §10): real hovers leave A, and pointerleave(A) ->
    // cancelPrefetch(A) aborts it (measured ERR_ABORTED), so rows 2/3 get a synthetic pointerenter.
    const aborts = [];
    const onFailed = (request) => { if (request.url().includes(TREE_PATH)) aborts.push({ at: Date.now(), parent: new URL(request.url()).searchParams.get('parent'), error: request.failure()?.errorText ?? null }); };
    page.on('requestfailed', onFailed);
    const enterRow = (parent) => page.locator(buttonOf(parent)).evaluate((element) => element.dispatchEvent(new Event('pointerenter')));
    try {
      await leave();
      await sleep(120);
      clear();
      for (const [parent, enter] of [[first, hover], [second, enterRow]]) {
        await enter(parent);
        await waitFor(() => requestsFor(parent).length > 0);
        expect('budget:issued', parent, 1, `hovering ${parent} past the intent window must issue exactly one speculative request (§13.4)`);
      }
      await enterRow(third);
      await sleep(400); // well past the intent window, while both in-flight responses are still held
      assert.equal(settled, 0, 'the two speculative responses must still be pending when the third hover is measured (increase the delay if this fails)');
      expect('budget:third', third, 0, 'a third speculative request over the concurrency budget must be dropped, not queued (§13.4 / I05)');

      const startedAt = Date.now();
      await page.locator(buttonOf(third)).click();
      assert.equal(await waitFor(() => requestsFor(third).length > 0, 900), true, 'a formal toggle must not wait behind the speculative budget (§I05)');
      trace.phases.push({ check: 'budget:formal', at: Date.now(), parent: third, clickToRequestMs: requestsFor(third)[0].at - startedAt, url: requestsFor(third)[0].url });
      await page.waitForSelector(noteOf(third, 'child-1.md'), { timeout: 3000 });
      expect('budget:formal', third, 1, 'the formal toggle must issue exactly one request');
      // I04: `second` is still speculative and in flight; a real pointer leave must abort it.
      await hover(second); await leave();
      trace.phases.push({ check: 'budget:I04-leave-abort', at: Date.now(), parent: second, expected: '>= 1', observed: aborts.length, aborted: aborts });
      assert.ok(await waitFor(() => aborts.length >= 1, 1500), `real pointer leaving aborts the still-speculative request (I04) — expected at least 1 aborted tree request, observed ${aborts.length}: ${JSON.stringify(aborts)}`);
    } finally {
      await waitFor(() => settled === 2, 4200); // let the held responses drain before releasing the route
      page.off('requestfailed', onFailed);
      page.off('response', onResponse);
      await delay.stop();
      await leave();
    }
  });

  // §13.5 / I11 — an abandoned speculative page is evicted, so hovering again re-requests.
  await check('explorer prefetch reclaim: abandoning a completed hover evicts the speculative page and re-hovering re-requests', async () => {
    const parent = 'PrefReclaim';
    try {
      await leave();
      await sleep(120);
      clear();
      const prefetch = treeResponse(parent, 3000);
      await hover(parent);
      await waitFor(() => requestsFor(parent).length > 0);
      expect('reclaim:first', parent, 1, `hovering ${parent} past the intent window must issue exactly one speculative request (§13.5)`);
      const response = await prefetch;
      assert.ok(response, 'the speculative request must succeed before the eviction probe can measure it (§13.5)');
      assert.equal(response.status(), 200, 'the speculative request must succeed');

      await leave();
      await sleep(500);
      expect('reclaim:after-leave', parent, 1, 'leaving without a click must not issue a request by itself');
      assert.equal(await page.locator(buttonOf(parent)).getAttribute('aria-expanded'), 'false', 'a speculative page must never expand the row (§I02)');
      assert.equal(await page.locator(`${childrenOf(parent)} .note`).count(), 0, 'a speculative page must never render while the parent stays collapsed');

      await hover(parent);
      await waitFor(() => requestsFor(parent).length >= 2);
      expect('reclaim:second', parent, 2, 'after an abandoned hover the speculative page must be evicted, so re-hovering an unloaded collapsed parent must issue exactly one additional request (§13.5 / I11)');
      assert.equal(await page.locator(noteOf(parent, 'child-1.md')).count(), 0, 'the re-fetched page must stay invisible while the parent is collapsed (§I02)');
    } finally {
      await leave();
    }
  });

  // §13.6 / I03 — invalidate and sort changes fence stale pages out of the current DOM.
  await check('explorer prefetch fence: stale prefetch pages never reach the DOM after invalidate or sort', async () => {
    const invalidated = 'PrefStaleSse';
    const resorted = 'PrefStaleSort';
    const delay = await delayTreeResponses([invalidated, resorted], 1200);
    try {
      // (a) real filesystem change -> SSE invalidate while the prefetch is still in flight.
      await leave();
      await sleep(120);
      clear();
      await hover(invalidated);
      await waitFor(() => requestsFor(invalidated).length > 0);
      expect('fence:invalidate-prefetch', invalidated, 1, `hovering ${invalidated} past the intent window must issue exactly one speculative request before the invalidate (§13.6)`);
      await fs.writeFile(path.join(vault, invalidated, 'Late.md'), '# late\n');
      await sleep(1800); // the stale (pre-create) response lands here and must be fenced out
      assert.equal(await page.locator(noteOf(invalidated, 'Late.md')).count(), 0, 'a fenced stale page must not render into the DOM before the user expands the parent');
      assert.equal(await page.locator(buttonOf(invalidated)).getAttribute('aria-expanded'), 'false', 'a speculative or fenced response must never expand the row');

      delay.delayed.delete(invalidated);
      const refresh = treeResponse(invalidated, 3000);
      await page.locator(buttonOf(invalidated)).click();
      const freshResponse = await refresh;
      assert.ok(freshResponse, 'after an invalidate the parent must fetch again instead of consuming the stale prefetch page (§13.6)');
      const freshBody = await freshResponse.json();
      await page.waitForSelector(noteOf(invalidated, 'Late.md'), { timeout: 3000 });
      const invalidatedDom = await renderedPaths(invalidated);
      assert.ok(invalidatedDom.includes(`${invalidated}/Late.md`), `the invalidated parent must render the fresh server page (created note included): dom=${JSON.stringify(invalidatedDom)}`);
      expectServerOrder(invalidatedDom, freshBody);
      expectAtLeast(invalidated, 2, 'the stale prefetch page must not be consumed as the authoritative cache');

      // (b) sort change while the prefetch is still in flight: the stale (name asc) page must
      // not win over the fresh (name desc) page.
      let originalSort = await page.locator('#explorer-sort-menu [aria-checked="true"]').evaluate((el) => ({ key: el.dataset.sortKey, direction: el.dataset.sortDirection }));
      if (originalSort.key !== 'name' || originalSort.direction !== 'asc') {
        await selectSort({ key: 'name', direction: 'asc' });
        originalSort = { key: 'name', direction: 'asc' };
      }
      await leave();
      await sleep(120);
      clear();
      const stale = treeResponse(resorted, 3000);
      await hover(resorted);
      await waitFor(() => requestsFor(resorted).length > 0);
      expect('fence:sort-prefetch', resorted, 1, `hovering ${resorted} past the intent window must issue exactly one speculative request before the sort change (§13.6)`);
      const staleResponse = await stale;
      assert.ok(staleResponse, 'the speculative request must reach the route before the sort change (§13.6)');
      const staleBody = await staleResponse.json();
      await selectSort({ key: 'name', direction: 'desc' });
      await sleep(1600); // the stale response lands under the new spec and must be fenced out
      assert.equal(await page.locator(`${childrenOf(resorted)} .note`).count(), 0, 'a sort change must not render a fenced page into the collapsed parent');

      delay.delayed.delete(resorted);
      const resortedResponse = treeResponse(resorted, 3000);
      await page.locator(buttonOf(resorted)).click();
      const sortedResponse = await resortedResponse;
      assert.ok(sortedResponse, 'after a sort change the parent must fetch under the new spec instead of consuming the stale page (§13.6 / I03)');
      const sortedBody = await sortedResponse.json();
      await page.waitForSelector(noteOf(resorted, 'child-2.md'), { timeout: 3000 });
      const sortedDom = await renderedPaths(resorted);
      assert.equal(sortedDom.length, 2, `the resorted parent must render both children: dom=${JSON.stringify(sortedDom)}`);
      expectServerOrder(sortedDom, sortedBody);
      const staleOrder = (staleBody?.items ?? []).map((item) => item.path).filter((entry) => sortedDom.includes(entry));
      assert.notDeepEqual(sortedDom, staleOrder, `the stale pre-sort page order must not be what the DOM shows: dom=${JSON.stringify(sortedDom)} stale=${JSON.stringify(staleOrder)}`);
      expectAtLeast(resorted, 2, 'the stale pre-sort page must not be consumed as the authoritative cache');

      const current = await page.locator('#explorer-sort-menu [aria-checked="true"]').evaluate((el) => ({ key: el.dataset.sortKey, direction: el.dataset.sortDirection }));
      if (current.key !== originalSort.key || current.direction !== originalSort.direction) await selectSort(originalSort);
    } finally {
      await delay.stop();
      await leave();
    }
  });

  // §13.7 / I09 — preference off: no speculative request, formal path unchanged.
  await check('explorer prefetch preference off: hover issues no speculative request while the formal path is unchanged', async () => {
    const parent = 'PrefOffCtl';
    const { context, probe } = await probePage();
    // Track from before the first navigation so the boot handshake and its resync are part of
    // the quiet-window accounting on both boots.
    const probeEntries = track(probe, 'preference-off');
    try {
      await openApp(probe);
      await probe.evaluate(([key, value]) => localStorage.setItem(key, value), [PREFERENCE_KEY, PREFERENCE_OFF]);
      await probe.reload();
      await probe.waitForSelector('.note[title="A.md"]');
      await waitLive(probe);
      assert.equal(await probe.evaluate((key) => localStorage.getItem(key), PREFERENCE_KEY), PREFERENCE_OFF, 'the probe page must boot with the prefetch preference off');

      active = probeEntries;
      await settleTree(probeEntries);
      await probe.locator(buttonOf(parent)).hover();
      await sleep(400); // twice the intent window
      expect('preference:off', parent, 0, 'with the prefetch preference off a hover must issue no speculative request (§13.7 / I09)');
      assert.equal(await probe.locator(rowOf(parent)).evaluate((el) => el.matches(':hover')), true, 'the probe must have really hovered the row');
      const formal = probe.waitForResponse((response) => response.url().includes(TREE_PATH) && new URL(response.url()).searchParams.get('parent') === parent, { timeout: 3000 }).catch(() => null);
      await probe.locator(buttonOf(parent)).click();
      assert.ok(await formal, 'with the preference off the formal click must still request the level (§I09)');
      await probe.waitForSelector(noteOf(parent, 'child-1.md'), { timeout: 3000 });
      expect('preference:off-formal', parent, 1, 'the formal click must issue exactly one request with the preference off');
    } finally {
      active = main;
      await context.close();
      await leave();
    }

    // Positive control on the default (`hover`) preference: the same probe must prefetch, so
    // this check cannot pass vacuously on a base without any prefetch implementation.
    clear();
    await hover(parent);
    await waitFor(() => requestsFor(parent).length > 0);
    expect('preference:default', parent, 1, 'the default preference must issue exactly one speculative request for the same parent, otherwise the off-case above proves nothing (§13.7)');
  });

  // §13.8 / I10 — a hover-less (touch) profile must never prefetch.
  await check('explorer prefetch capability: a hover:none touch profile issues no speculative request', async () => {
    const parent = 'PrefTouchCtl';
    const { context, probe } = await probePage({ hasTouch: true });
    const probeEntries = track(probe, 'hover-none');
    try {
      await openApp(probe);
      assert.equal(await probe.evaluate(() => matchMedia('(hover: hover)').matches), false, 'the probe profile must report hover: none for this check to characterise anything (touch profile)');
      active = probeEntries;
      await settleTree(probeEntries);
      const box = await probe.locator(buttonOf(parent)).boundingBox();
      await probe.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(450); // three times the intent window
      expect('capability:hover-none', parent, 0, 'a hover:none profile must issue no speculative request even when the pointer rests on the row (§13.8 / I10)');
      const formal = probe.waitForResponse((response) => response.url().includes(TREE_PATH) && new URL(response.url()).searchParams.get('parent') === parent, { timeout: 3000 }).catch(() => null);
      await probe.locator(buttonOf(parent)).click();
      assert.ok(await formal, 'on a hover:none profile the formal click must still request the level');
      await probe.waitForSelector(noteOf(parent, 'child-1.md'), { timeout: 3000 });
    } finally {
      active = main;
      await context.close();
      await leave();
    }

    clear();
    await hover(parent);
    await waitFor(() => requestsFor(parent).length > 0);
    expect('capability:hover-capable', parent, 1, 'a hover-capable profile must issue exactly one speculative request for the same parent, otherwise the hover:none case above proves nothing (§13.8)');
  });

  await fs.writeFile(
    path.join(outputRoot, 'explorer-prefetch-trace.json'),
    `${JSON.stringify({ ...trace, finishedAt: Date.now() }, null, 2)}\n`,
  );
  await probeContext.close();
}
