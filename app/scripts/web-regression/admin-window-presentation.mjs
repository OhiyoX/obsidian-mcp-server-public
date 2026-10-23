// #434 Lane B browser regression: the 定时授权 window column and its table-external detail card.
//
// The Admin plane is server-rendered and has no script (CSP `default-src 'none'`), so every
// criterion here is about *rendered* markup: is the merged summary visible and short, are the
// date/start/expiry markers visible (not only in a `title`), is the scope disclaimer visible, can
// the detail card be reached from the row with the keyboard alone, and does that GET stay a GET.
//
// The seat ruling (#434.2 / #434.4) requires: one `presentAccessPolicyWindow` view-model for the
// cell **and** the card (same source), the detail outside the table (the #406 card pattern), a
// summary of at most two visual lines, an in-row keyboard entry, text selection + light/dark
// readability + no overflow on desktop and narrow screens, a GET that does not write, an edit
// round trip that leaves the window unchanged, and a frozen-clock AuthZ / `nextChangeAt`.
//
// The clock is not merely observed, it is *injected*: this module starts its fixture server with
// `test/preload-frozen-clock.mjs` (through `NODE_OPTIONS --import`) and `WEB_TEST_FROZEN_NOW`, and
// the AuthZ check asserts the injected instant itself plus the concrete decision, next-change and
// next-allowed values it implies. Freezing the browser clock would prove nothing: the Admin plane
// is server-rendered and the decision comes from the server's clock.
//
// Negative controls (proved by mutation, recorded in `I434/HANDOFF-B.md` §「返修」): deleting the
// date-range marker from the cell makes check A red, and so does starting the fixture without the
// clock injection or moving this policy's expiry away from the asserted next change.
//
// Registered by the shared scene (`admin-layout.mjs` / `run-admin-layout-checks.mjs`) once #443 is
// merged; until then run it directly with `node scripts/run-admin-window-checks.mjs`.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { POLICY_SEED, VIEWPORT, startAdminLayoutFixture } from './admin-layout-fixture.mjs';

const TAB = '/admin/auth/access-policy';
/** Mon–Fri 09:00–18:00: merges into one group, so the summary is the merged form, not the grid. */
const WINDOW_WEEKLY = 'mon 09:00-18:00\ntue 09:00-18:00\nwed 09:00-18:00\nthu 09:00-18:00\nfri 09:00-18:00';
const RANGE_FROM = '2026-10-01';
const RANGE_TO = '2026-10-07';
const STARTS_AT = '2026-10-05T01:00:00.000Z';
/** The policy expires 3h after the injected instant, so its expiry *is* its next state change. */
const EXPIRES_AT = '2026-10-05T05:00:00.000Z';
/**
 * The instant injected into the fixture server (Mon 2026-10-05 10:00 Asia/Shanghai). It is inside
 * the weekly interval, the date range and [startsAt, expiresAt), so the decision is a plain allow
 * and every boundary below is a real, deterministic value of the pure evaluator rather than
 * "whatever the host clock happens to produce". The expectations are literals on purpose: deriving
 * them from the fixture inputs would make the assertion a tautology again.
 */
const FROZEN_NOW = '2026-10-05T02:00:00.000Z';
const EXPECTED_DECISION = '允许';
const EXPECTED_TIMEZONE = 'Asia/Shanghai';
/** Earlier than the Mon 18:00 Asia/Shanghai weekly close (2026-10-05T10:00:00.000Z). */
const EXPECTED_NEXT_CHANGE = '2026-10-05T05:00:00.000Z';
/** Allowed right now, so the next allowed instant is the injected instant itself. */
const EXPECTED_NEXT_ALLOWED = FROZEN_NOW;
/** Test-only `--import` preload that pins the fixture server's `Date.now` (see that file's header). */
const FROZEN_CLOCK_PRELOAD = path.resolve(import.meta.dirname, '..', '..', 'test', 'preload-frozen-clock.mjs');
const MERGED_SUMMARY = '工作日 09:00–18:00';
const MARKERS = ['另有限定日期', '另有开始时间', '另有截止时间'];
const DISCLAIMER = '仅表示生效时间窗口，不代表永久有效或当前允许';
const PROBE_SUBJECT = 'api-key:configured-env';
const VIEWPORT_NARROW = { width: 390, height: 844 };
/** The pre-#434 cell text (raw editor formatters joined the way the old `windowSummary` did), used to measure the row height this wiring replaced. */
const LEGACY_SUMMARY = 'mon 09:00-18:00 · tue 09:00-18:00 · wed 09:00-18:00 · thu 09:00-18:00 · fri 09:00-18:00 · 2026-10-01..2026-10-07 · 起 2026-10-05T01:00:00.000Z · 止 2026-10-05T05:00:00.000Z';

const SUMMARY_NODE = '[data-window-cell] [data-window-summary]';
const ENTRY_LINK = 'td[data-label="窗口"] a[data-window-open]';

/** Rendered geometry, the summary line count and the "inside its own box" facts. */
const PRESENTATION = `(() => {
  const table = document.querySelector('table.data-table');
  const row = table?.querySelector('tbody tr');
  const cells = [...(row?.querySelectorAll('td') ?? [])];
  const node = document.querySelector('${SUMMARY_NODE}');
  const wrap = document.querySelector('[data-window-cell]');
  const range = document.createRange();
  if (node) range.selectNodeContents(node);
  const rects = node ? [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5) : [];
  const summaryRect = node?.getBoundingClientRect();
  const wrapRect = wrap?.getBoundingClientRect();
  const cellRect = node?.closest('td')?.getBoundingClientRect();
  return {
    rowCount: table?.querySelectorAll('tbody tr').length ?? 0,
    rowHeight: Math.round(row?.getBoundingClientRect().height ?? 0),
    columns: cells.map((cell) => Math.round(cell.getBoundingClientRect().width)),
    labels: cells.map((cell) => cell.dataset.label),
    summaryText: node?.textContent ?? null,
    summaryAttr: node?.dataset.windowSummary ?? null,
    summaryLines: new Set(rects.map((r) => Math.round(r.top))).size,
    markers: [...document.querySelectorAll('[data-window-cell] [data-window-marker]')].map((el) => el.textContent),
    disclaimer: document.querySelector('[data-window-disclaimer]')?.textContent ?? null,
    disclaimerVisible: Boolean(document.querySelector('[data-window-disclaimer]')?.getClientRects().length),
    cardPresent: Boolean(document.querySelector('#authz-window')),
    summaryInsideCell: Boolean(summaryRect && cellRect && summaryRect.left >= cellRect.left - 1 && summaryRect.right <= cellRect.right + 1),
    wrapInsideViewport: Boolean(wrapRect && wrapRect.left >= -1 && wrapRect.right <= window.innerWidth + 1),
    documentOverflow: Math.round(document.documentElement.scrollWidth - window.innerWidth),
    viewport: window.innerWidth,
  };
})()`;

const FOCUS_ENTRY = `(() => {
  const link = document.querySelector('${ENTRY_LINK}');
  link?.focus();
  return { focused: document.activeElement === link, tag: link?.tagName ?? null, href: link?.getAttribute('href') ?? null, tabIndex: link?.tabIndex ?? null };
})()`;

/** The row height the same policy produced before #434, measured on a clone of today's row. */
const LEGACY_ROW = `(() => {
  const row = document.querySelector('table.data-table tbody tr');
  const clone = row.cloneNode(true);
  clone.querySelector('td[data-label="\u7a97\u53e3"]').innerHTML = '<span class="breakable">${LEGACY_SUMMARY}</span>';
  row.parentElement.appendChild(clone);
  const height = Math.round(clone.getBoundingClientRect().height);
  const lines = clone.querySelector('td[data-label="\u7a97\u53e3"] span') ? clone.querySelector('td[data-label="\u7a97\u53e3"] span').getClientRects().length : null;
  clone.remove();
  return { height, lines };
})()`;

/** A real document selection of the summary: proves the text is copyable text, not paint. */
const COPY_SUMMARY = `(() => {
  const node = document.querySelector('${SUMMARY_NODE}');
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return { selected: selection.toString(), expected: node.textContent, userSelect: getComputedStyle(node).userSelect };
})()`;

/** The card facts + the two toggled states, read from the real DOM. */
const CARD = `(() => {
  const card = document.querySelector('#authz-window');
  if (!card) return null;
  const days = [...card.querySelectorAll('[data-window-day]')].map((li) => ({
    key: li.dataset.windowDay, state: li.querySelector('[data-window-day-state]')?.dataset.windowDayState ?? null, text: li.textContent.trim(),
  }));
  const body = card.querySelector('.create-body');
  const rect = card.getBoundingClientRect();
  return {
    tag: card.tagName, open: card.open, inTable: Boolean(card.closest('table')),
    summaryAttr: card.dataset.windowSummary,
    dayCount: days.length, dayKeys: days.map((day) => day.key), states: days.map((day) => day.state),
    emptyDayText: days.some((day) => day.text.includes('该日无生效时段')),
    hasTimezone: card.textContent.includes('Asia/Shanghai'),
    hasDateRange: card.textContent.includes('${RANGE_FROM}..${RANGE_TO}'),
    hasStartsAt: card.textContent.includes('${STARTS_AT}'),
    hasExpiresAt: card.textContent.includes('${EXPIRES_AT}'),
    scope: card.querySelector('[data-window-scope]')?.textContent ?? null,
    bodyVisible: Boolean(body?.checkVisibility?.({ checkVisibilityCSS: true }) ?? body?.getClientRects().length),
    left: Math.round(rect.left), right: Math.round(rect.right),
  };
})()`;

const FORM_VALUES = `(() => {
  const form = document.querySelector('#authz-edit form[action$="/update"]');
  const fields = {};
  for (const field of form.querySelectorAll('input[name], select[name], textarea[name]')) {
    if (field.type === 'checkbox' || field.type === 'radio') { if (field.checked) (fields[field.name] ??= []).push(field.value); continue; }
    (fields[field.name] ??= []).push(field.value ?? '');
  }
  return fields;
})()`;

/** Contrast of the visible window text against its resolved background, under any colour scheme. */
const CONTRAST = `(() => {
  const parse = (value) => { const match = /rgba?\\(([^)]+)\\)/.exec(value); if (!match) return null; const parts = match[1].split(',').map((part) => Number.parseFloat(part)); return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }; };
  const channel = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const background = (el) => { for (let node = el; node; node = node.parentElement) { const bg = parse(getComputedStyle(node).backgroundColor); if (bg && bg.a > 0.9) return bg; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const sample = (el) => { if (!el) return null; const fg = parse(getComputedStyle(el).color); const bg = background(el); const hi = Math.max(luminance(fg), luminance(bg)); const lo = Math.min(luminance(fg), luminance(bg)); return { fg: getComputedStyle(el).color, bg: 'rgb(' + bg.r + ', ' + bg.g + ', ' + bg.b + ')', ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 }; };
  return {
    summary: sample(document.querySelector('${SUMMARY_NODE}')),
    disclaimer: sample(document.querySelector('[data-window-disclaimer]')),
    cardBody: sample(document.querySelector('#authz-window .create-body')),
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
  };
})()`;

const revisionOf = (body) => /当前 revision <code>([^<]*)<\/code>/.exec(body)?.[1] ?? null;
const previewOf = (body) => ({
  decision: /<span class="badge[^"]*">([^<]*)<\/span>/.exec(body)?.[1] ?? null,
  // `当前 <code>` cannot match the `当前 revision <code>` paragraph, so this is the preview's now.
  now: /当前 <code>([^<]*)<\/code>/.exec(body)?.[1] ?? null,
  timezone: /时区 <code>([^<]*)<\/code>/.exec(body)?.[1] ?? null,
  nextChangeAt: /下一次状态变化 <code>([^<]*)<\/code>/.exec(body)?.[1] ?? null,
  nextAllowedAt: /下一次允许 <code>([^<]*)<\/code>/.exec(body)?.[1] ?? null,
});

/**
 * Start the fixture with an injected server clock. `startAdminLayoutFixture` inherits the caller's
 * environment, so the preload and the pinned instant reach the server child through the
 * environment and are removed again the moment the child exists - no later scene can inherit them
 * (the suite registers scenes sequentially). Throws when no instant is pinned, so a silent
 * "unfrozen" run cannot happen by accident.
 */
async function startFixtureWithFrozenClock({ root, appRoot, serverErrors }) {
  if (!FROZEN_NOW) throw new Error('the #434 window gate must pin the fixture server clock');
  const previous = { nodeOptions: process.env.NODE_OPTIONS, frozenNow: process.env.WEB_TEST_FROZEN_NOW };
  const preload = pathToFileURL(FROZEN_CLOCK_PRELOAD).href;
  process.env.NODE_OPTIONS = `${previous.nodeOptions ? `${previous.nodeOptions} ` : ''}--import=${preload}`;
  process.env.WEB_TEST_FROZEN_NOW = FROZEN_NOW;
  try {
    return await startAdminLayoutFixture({ root, appRoot, serverErrors });
  } finally {
    if (previous.nodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous.nodeOptions;
    if (previous.frozenNow === undefined) delete process.env.WEB_TEST_FROZEN_NOW;
    else process.env.WEB_TEST_FROZEN_NOW = previous.frozenNow;
  }
}

/**
 * Register the #434 window-presentation checks. `ctx` is the shared scene context
 * (`{ check, sleep, browser, root, appRoot, serverErrors, tracePhase, outputRoot }`); this module
 * owns its own fixture under `<root>/admin-window`, so it can also run standalone.
 */
export async function registerAdminWindowPresentationChecks(ctx) {
  const { check, sleep, browser, root, appRoot, serverErrors = [] } = ctx;
  const tracePhase = typeof ctx.tracePhase === 'function' ? ctx.tracePhase : () => {};
  const readings = { desktop: null, narrow: null, dark: null, authz: null };

  // Unique subdirectory: `startAdminLayoutFixture` always nests its own `admin-layout` under the
  // caller's root, so passing `<root>/admin-window` keeps this fixture's Vault/data/catalog
  // separate from a scene that already runs one.
  const fixture = await startFixtureWithFrozenClock({ root: path.join(root, 'admin-window'), appRoot, serverErrors });
  const { base, password, child } = fixture;
  const goto = async (page, url) => {
    await page.goto(`${base}${url}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await sleep(120);
  };
  /** POST a real HTML form body (Playwright's `form` helper cannot send repeated keys). */
  const postForm = async (target, url, fields) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item ?? ''));
    return target.request.post(`${base}${url}`, { data: params.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, maxRedirects: 0 });
  };

  const contexts = [];
  const openContext = async (options) => {
    const context = await browser.newContext({ viewport: VIEWPORT, ...options });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    const entry = { context, page, errors };
    contexts.push(entry);
    const login = await page.request.post(`${base}/admin/auth/login`, { form: { password }, maxRedirects: 0 });
    assert.equal(login.status(), 303, 'the window-presentation fixture login must succeed');
    // The fixture server runs on the injected clock, and Express derives `Expires` from `Date.now`,
    // so the login cookie is stamped with an instant the *browser* (on its real clock) already
    // considers past - it drops the cookie before the first navigation, and every later request
    // would silently land on the login page. Re-add the same cookie as a session cookie
    // (`expires: -1`); the server-side session is still validated against the same frozen clock.
    const setCookie = login.headers()['set-cookie'];
    assert.ok(setCookie, `the fixture login must set the admin session cookie, got headers ${JSON.stringify(login.headers())}`);
    const [pair, ...attributes] = String(setCookie).split(';');
    const separator = pair.indexOf('=');
    entry.cookie = {
      name: pair.slice(0, separator),
      path: /path=([^;]+)/i.exec(attributes.join(';'))?.[1] ?? '/',
      expires: /expires=([^;]+)/i.exec(String(setCookie))?.[1] ?? null,
    };
    await context.addCookies([{
      name: entry.cookie.name,
      value: pair.slice(separator + 1),
      domain: new URL(base).hostname,
      path: entry.cookie.path,
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
      expires: -1,
    }]);
    return entry;
  };

  try {
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try { if ((await fetch(`${base}/healthz`)).ok) { ready = true; break; } } catch { /* keep waiting */ }
      if (child.exitCode !== null) break;
      await sleep(100);
    }
    assert.ok(ready, 'the window-presentation fixture server must become ready');

    const { page, errors } = await openContext();
    await goto(page, TAB);
    const csrf = await page.evaluate(`document.querySelector('input[name="csrf"]')?.value ?? ''`);
    const created = await postForm(page, `${TAB}/create`, {
      ...POLICY_SEED,
      label: 'window-presentation-policy',
      subjects: [PROBE_SUBJECT],
      weekly: WINDOW_WEEKLY,
      dateRanges: `${RANGE_FROM}..${RANGE_TO}`,
      startsAt: STARTS_AT,
      expiresAt: EXPIRES_AT,
      csrf,
    });
    assert.equal(created.status(), 303, `the fixture policy create must succeed, got ${created.status()}`);
    const list = await page.request.get(`${base}${TAB}`);
    const listBody = await list.text();
    const policyId = /data-window-open href="[^"]*[?]window=([^&#"]+)/.exec(listBody)?.[1] ?? null;
    assert.ok(policyId, 'the list page must carry the window entry link with the policy id');
    await goto(page, TAB);

    await check('admin-window #434: the row cell shows the merged summary, visible markers and the disclaimer in <= 2 lines', async () => {
      await goto(page, TAB);
      const view = await page.evaluate(PRESENTATION);
      const legacy = await page.evaluate(LEGACY_ROW);
      readings.desktop = { ...view, legacyRowHeight: legacy.height, legacySummaryLines: legacy.lines };
      tracePhase('window-desktop', readings.desktop);
      assert.equal(view.rowCount, 1, `exactly one policy row, got ${view.rowCount}`);
      assert.equal(view.summaryText, MERGED_SUMMARY, `the merged summary must render, got "${view.summaryText}"`);
      assert.equal(view.summaryAttr, MERGED_SUMMARY, 'the cell exposes the same view-model summary value');
      assert.ok(view.summaryLines >= 1 && view.summaryLines <= 2, `the summary must be <= 2 visual lines, got ${view.summaryLines} (rowHeight ${view.rowHeight}px, width ${view.viewport}px)`);
      for (const marker of MARKERS) assert.ok(view.markers.includes(marker), `the visible marker "${marker}" must render in the cell, got ${JSON.stringify(view.markers)}`);
      assert.equal(view.disclaimer, DISCLAIMER, 'the scope disclaimer must be visible in the cell');
      assert.ok(view.disclaimerVisible, 'the disclaimer must be painted, not hidden');
      assert.equal(view.cardPresent, false, 'the list view ships no detail card until ?window= is requested');
      assert.ok(view.summaryInsideCell, `the summary must stay inside its cell (viewport ${view.viewport}px)`);
      assert.ok(view.wrapInsideViewport, `the window cell must not overflow the viewport (document overflow ${view.documentOverflow}px)`);
      assert.ok(legacy.height > 0, `the legacy row measurement must be a real reading, got ${legacy.height}`);
    });

    await check('admin-window #434: the in-row entry is keyboard-focusable, its GET performs no write, and the text is selectable', async () => {
      await goto(page, TAB);
      const focus = await page.evaluate(FOCUS_ENTRY);
      tracePhase('window-focus', focus);
      assert.equal(focus.tag, 'A', 'the entry is a native anchor');
      assert.ok(focus.focused, 'the entry must be reachable through the keyboard (focusable)');
      assert.ok(focus.tabIndex >= 0, `the entry must be in the tab order, got tabIndex ${focus.tabIndex}`);
      assert.ok(focus.href?.includes(`?window=${policyId}#authz-window`), `the entry targets the standalone card, got ${focus.href}`);

      const copy = await page.evaluate(COPY_SUMMARY);
      tracePhase('window-copy', copy);
      assert.equal(copy.selected, MERGED_SUMMARY, `the summary must be real selectable text, got "${copy.selected}"`);
      assert.notEqual(copy.userSelect, 'none', 'the summary text must not be user-select:none');

      const revisionBefore = revisionOf(await (await page.request.get(`${base}${TAB}`)).text());
      const writes = [];
      const listener = (request) => {
        const url = request.url();
        if (request.method() !== 'GET' || /\/(create|update|toggle|delete|repair|preview)([?#]|$)/.test(url)) writes.push(`${request.method()} ${url}`);
      };
      page.on('request', listener);
      try {
        await Promise.all([page.waitForURL(/[?]window=/, { timeout: 15000 }), page.keyboard.press('Enter')]);
      } finally {
        page.off('request', listener);
      }
      assert.deepEqual(writes, [], `the ?window= GET must not submit anything, saw ${JSON.stringify(writes)}`);
      assert.equal(page.url().includes(`?window=${policyId}`), true, `opening the card must be a GET navigation, got ${page.url()}`);
      const after = await page.request.get(`${base}${TAB}`);
      assert.equal(revisionOf(await after.text()), revisionBefore, 'a read-only ?window= GET must not change the store revision');
    });

    await check('admin-window #434: the card is outside the table and lists 7 days, the IANA timezone and the full bounds', async () => {
      await goto(page, `${TAB}?window=${policyId}`);
      const card = await page.evaluate(CARD);
      tracePhase('window-card', card);
      assert.ok(card, 'the card must render for ?window=');
      assert.equal(card.tag, 'DETAILS', 'the card is a native disclosure');
      assert.equal(card.open, true, 'the card is open when requested');
      assert.equal(card.inTable, false, 'the card must never live inside the table');
      assert.equal(card.summaryAttr, MERGED_SUMMARY, 'the card carries the same view-model summary as the cell');
      assert.equal(card.dayCount, 7, `the card lists Mon→Sun, got ${card.dayCount} (${card.dayKeys.join(',')})`);
      assert.deepEqual(card.dayKeys, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], 'the days are in week order');
      assert.ok(card.emptyDayText, 'a day without an interval must show 该日无生效时段');
      assert.ok(card.states.includes('empty'), `the empty-day state must be explicit, got ${card.states.join(',')}`);
      assert.ok(card.hasTimezone, 'the IANA timezone must render in the card');
      assert.ok(card.hasDateRange, `the date range ${RANGE_FROM}..${RANGE_TO} must render in full`);
      assert.ok(card.hasStartsAt && card.hasExpiresAt, 'startsAt and expiresAt must render in full');
      assert.equal(card.scope, DISCLAIMER, 'the card repeats the scope disclaimer');
      assert.ok(card.right <= VIEWPORT.width + 1 && card.left >= -1, `the card must not overflow the desktop viewport (${card.left}..${card.right})`);

      // Expand / collapse: the native disclosure toggles without script and the body follows.
      await page.locator('#authz-window > summary').click();
      const collapsed = await page.evaluate(CARD);
      assert.equal(collapsed.open, false, 'clicking the summary collapses the card');
      assert.equal(collapsed.bodyVisible, false, 'a collapsed card shows no body');
      await page.locator('#authz-window > summary').click();
      const expanded = await page.evaluate(CARD);
      assert.equal(expanded.open, true, 'clicking the summary expands the card again');
      assert.equal(expanded.bodyVisible, true, 'the expanded card shows its body');
    });

    const narrow = await openContext({ viewport: VIEWPORT_NARROW });
    await check('admin-window #434: the narrow layout keeps the summary short, the entry focusable and the card inside the viewport', async () => {
      await goto(narrow.page, TAB);
      const view = await narrow.page.evaluate(PRESENTATION);
      const focus = await narrow.page.evaluate(FOCUS_ENTRY);
      await goto(narrow.page, `${TAB}?window=${policyId}`);
      const card = await narrow.page.evaluate(CARD);
      readings.narrow = { ...view, card: { left: card?.left, right: card?.right }, focusable: focus.focused };
      tracePhase('window-narrow', readings.narrow);
      assert.equal(view.summaryText, MERGED_SUMMARY, 'the narrow layout keeps the merged summary');
      assert.ok(view.summaryLines <= 2, `the narrow summary must stay <= 2 lines, got ${view.summaryLines}`);
      assert.ok(view.wrapInsideViewport, `the narrow window cell must not overflow (${view.viewport}px wide)`);
      assert.ok(focus.focused, 'the entry stays keyboard-focusable at the narrow width');
      assert.ok(card && card.inTable === false, 'the narrow card is outside the table');
      assert.ok(card.right <= VIEWPORT_NARROW.width + 1 && card.left >= -1, `the narrow card must fit the viewport (${card.left}..${card.right} of ${VIEWPORT_NARROW.width})`);
    });

    const dark = await openContext({ colorScheme: 'dark' });
    await check('admin-window #434: the window text stays readable under a dark colour-scheme preference', async () => {
      await goto(dark.page, TAB);
      const listContrast = await dark.page.evaluate(CONTRAST);
      await goto(dark.page, `${TAB}?window=${policyId}`);
      const cardContrast = await dark.page.evaluate(CONTRAST);
      readings.dark = { list: listContrast, card: cardContrast };
      tracePhase('window-dark', readings.dark);
      assert.ok(cardContrast.prefersDark, 'the dark context must report prefers-color-scheme: dark');
      for (const [name, sample] of [['summary', listContrast.summary], ['disclaimer', listContrast.disclaimer], ['card body', cardContrast.cardBody]]) {
        assert.ok(sample, `the ${name} must render under the dark preference`);
        assert.ok(sample.ratio >= 4.5, `the ${name} must stay readable (contrast ${sample.ratio}:1, ${sample.fg} on ${sample.bg})`);
      }
    });

    await check('admin-window #434: an untouched edit round trip keeps the window text identical', async () => {
      await goto(page, `${TAB}?edit=${policyId}`);
      const before = await page.evaluate(FORM_VALUES);
      const beforeRevision = Number(revisionOf((await (await page.request.get(`${base}${TAB}`)).text())) ?? -1);
      const updated = await postForm(page, `${TAB}/update`, before);
      assert.equal(updated.status(), 303, `an untouched update must succeed, got ${updated.status()}`);
      await goto(page, TAB);
      const after = await page.evaluate(PRESENTATION);
      tracePhase('window-roundtrip', { before: { weekly: before.weekly, dateRanges: before.dateRanges, startsAt: before.startsAt, expiresAt: before.expiresAt }, afterSummary: after.summaryText });
      assert.equal(after.summaryText, MERGED_SUMMARY, `the window text must survive the edit round trip, got "${after.summaryText}"`);
      await goto(page, `${TAB}?edit=${policyId}`);
      const again = await page.evaluate(FORM_VALUES);
      assert.deepEqual(again.weekly, before.weekly, 'the weekly textarea is unchanged by an untouched save');
      assert.deepEqual(again.dateRanges, before.dateRanges, 'the date-range textarea is unchanged');
      assert.deepEqual(again.startsAt, before.startsAt, 'startsAt is unchanged');
      assert.deepEqual(again.expiresAt, before.expiresAt, 'expiresAt is unchanged');
      const afterRevision = Number(revisionOf(await (await page.request.get(`${base}${TAB}`)).text()) ?? -1);
      assert.equal(afterRevision, beforeRevision + 1, 'the untouched save is exactly one revision, not a rewrite loop');
    });

    // The injected clock is the criterion, not a coincidence: `now` proves the preload reached the
    // server, and the decision / next-change / next-allowed literals are the values the pure
    // evaluator produces for that instant. A server on its own clock reports this window expired
    // (decision 暂停中（suspend）, `nextChangeAt` = `—`) - exactly the pair that used to satisfy the
    // old "not null + before === after" assertion no matter what the time was.
    await check('admin-window #434: the frozen-clock AuthZ preview keeps the expected decision, next change and next allowed time across the ?window= GET', async () => {
      await goto(page, TAB);
      const csrfToken = await page.evaluate(`document.querySelector('input[name="csrf"]')?.value ?? ''`);
      const sample = async () => previewOf(await (await postForm(page, `${TAB}/preview`, { csrf: csrfToken, subject: PROBE_SUBJECT })).text());
      const before = await sample();
      await goto(page, `${TAB}?window=${policyId}`);
      const after = await sample();
      readings.authz = {
        injectedNow: FROZEN_NOW,
        expected: { decision: EXPECTED_DECISION, timezone: EXPECTED_TIMEZONE, nextChangeAt: EXPECTED_NEXT_CHANGE, nextAllowedAt: EXPECTED_NEXT_ALLOWED },
        before, after, cookie: contexts[0]?.cookie ?? null,
      };
      tracePhase('window-authz-frozen', readings.authz);
      assert.equal(before.now, FROZEN_NOW, `the fixture server must run on the injected clock (WEB_TEST_FROZEN_NOW=${FROZEN_NOW}), got now=${before.now}`);
      assert.equal(before.decision, EXPECTED_DECISION, `the injected instant is inside the window, expected ${EXPECTED_DECISION}, got ${before.decision}`);
      assert.equal(before.timezone, EXPECTED_TIMEZONE, `expected the policy timezone ${EXPECTED_TIMEZONE}, got ${before.timezone}`);
      assert.equal(before.nextChangeAt, EXPECTED_NEXT_CHANGE, `the next state change is this policy's expiry (2026-10-05 13:00 Asia/Shanghai), earlier than the Mon 18:00 close, got ${before.nextChangeAt}`);
      assert.equal(before.nextAllowedAt, EXPECTED_NEXT_ALLOWED, `an allowed subject is allowed at the injected instant, got ${before.nextAllowedAt}`);
      assert.deepEqual(after, before, `a read-only window GET must not move the AuthZ decision, now or nextChangeAt: ${JSON.stringify({ before, after })}`);
    });

    await Promise.all(contexts.map((item) => item.context.close().catch(() => {})));
    const shutdown = await fixture.stop();
    tracePhase('window-fixture-stop', shutdown);

    await check('admin-window #434: no page error, no server error, and the fixture releases its process, port and scratch directory', async () => {
      assert.deepEqual(contexts.flatMap((item) => item.errors), [], 'no browser context may raise a page error');
      const fatal = serverErrors.filter((line) => /unhandled|UnhandledPromiseRejection|TypeError|ReferenceError/.test(line));
      assert.deepEqual(fatal, [], `the fixture server must not log a fatal error: ${JSON.stringify(fatal.slice(0, 2))}`);
      assert.equal(shutdown.childExited, true, `the fixture child must be reaped: ${JSON.stringify(shutdown)}`);
      assert.equal(shutdown.portReleased, true, `the fixture port must be free after the run: ${JSON.stringify(shutdown)}`);
      assert.equal(shutdown.fixtureRootRemoved, true, `the fixture scratch directory must be gone: ${JSON.stringify(shutdown)}`);
    });

    return readings;
  } finally {
    await Promise.all(contexts.map((item) => item.context.close().catch(() => {})));
    await fixture.stop();
  }
}
