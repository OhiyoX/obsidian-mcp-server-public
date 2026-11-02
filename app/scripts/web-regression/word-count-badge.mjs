// Issue #430 — the body-pane word-count badge, exercised against the real application.
//
// The issue's mandatory matrix needs a real browser for the rows a Node contract test cannot
// honestly cover: the three rendering surfaces must agree, the badge must survive the ordinary
// document lifecycle without writing anything, it must never show another document's numbers,
// it must stay in the bottom-right corner (issue #469 / U57: right-aligned like the Obsidian
// status bar, clear of the scrollbar gutter and of the right rail) without covering content or
// creating scroll, and it must coalesce dense typing on a large document instead of recomputing
// once per keystroke.
//
// Registered last (after welcome-transition): this scene starts from its own hard load so no
// earlier scene's dirty editor or drawer state can leak in, and it is the final owner of the
// shared page. Every count assertion runs against fixtures THIS module writes, because earlier
// scenes mutate the shared `A.md` on disk.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { summarizeWordCount } from '../../frontend/app/features/document/word-count.js';
// Shipped throttle window; the pass-count bound below is normalised by it (no magic 120).
import { WORD_COUNT_THROTTLE_MS } from '../../frontend/app/features/document/word-count-badge.js';
// Shared DOM read + the #469 right-aligned placement contract (own module: line budget).
import { assertRightAligned, GEOMETRY_TOLERANCE_PX, readBadgeSnapshot, visibleGutter } from './word-count-badge-geometry.mjs';

const BADGE = '.word-count-badge';
// Own fixtures. `BADGE_NOTE` is the frozen integration document: real Markdown with CJK,
// emoji/ZWJ, frontmatter, a code fence, a link, an image and a task box. The triple is frozen
// here (26 / 70) and the 口径 itself is frozen by the hand-verified table in
// test/word-count.test.js; this constant pins the wiring to a document with all the syntax.
const BADGE_NOTE = [
  '---',
  'title: U52 badge fixture',
  'tags: [u52]',
  '---',
  '',
  '# 计数 标题',
  '',
  '**粗体** plain words 123',
  '',
  '- [ ] task item',
  '',
  '`inline code`',
  '',
  '![img alt](pixel.svg)',
  '',
  '> quoted line',
  '',
  '```js',
  'const notCounted = 1;',
  '```',
  '',
  'emoji \u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466} and \u{1F1E8}\u{1F1F3}',
  '',
  '中文测试，英文 words。',
  '',
].join('\n');
const BADGE_NOTE_COUNTS = { words: 26, characters: 70 };
const NOTE_MAIN = 'U52Badge.md';
const NOTE_B = 'U52B.md';
const NOTE_C = 'U52C.md';
const NOTE_SCRATCH = 'U52Scratch.md';
const NOTE_REFRESH = 'U52Refresh.md';
const NOTE_LONG = 'U52Long.md';
const NOTE_BASE = 'U52Badge.base';
const FIXTURES = {
  [NOTE_MAIN]: BADGE_NOTE,
  [NOTE_B]: '# U52 B\n\nbravo only two words\n',
  [NOTE_C]: '# U52 C\n\ncharlie has three words here\n',
  [NOTE_SCRATCH]: '# U52 scratch\n\nscratch body\n',
  [NOTE_REFRESH]: '# U52 refresh\n\nalpha line\nbravo line\n',
  [NOTE_BASE]: 'views:\n  - type: table\n    name: All\n    order:\n      - file.name\n',
};
const LONG_NOTE_BYTES = 1024 * 1024;
// Catastrophe detector ONLY — never a performance budget. Catch-up after the last keystroke on
// the ~1 MB document: 177-185 ms locally (U52 seat) versus 555 / 602 / 704 / 737 ms in CI under
// load (runs 37884798041 / 37885968166, attempt 1 and retry; the removed 500 ms gate also failed
// at 532 / 578 / 595 ms), i.e. it decided CI on machine load. The discriminating gate is now the
// load-independent pass count in the dense-typing check below.
const BADGE_CATASTROPHE_BUDGET_MS = 2000;
const SYNC_SANITY_BUDGET_MS = 15000;

const badgeSnapshot = (page) => readBadgeSnapshot(page, BADGE);

function longNote() {
  const paragraph = 'Word count performance paragraph with 中文汉字 mixed in and a [link](https://example.com/a) plus `code`.\n\n## Section heading\n\n- list item one\n- list item two with **bold** text\n\n';
  const parts = ['# 大文档性能\n\n'];
  let size = parts[0].length;
  let index = 0;
  while (size < LONG_NOTE_BYTES) {
    const block = `Block ${index}. ${paragraph}`;
    parts.push(block);
    size += block.length;
    index += 1;
  }
  return parts.join('');
}

const group = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const wordsText = (words) => `字数 ${group(words)}`;
const charactersText = (characters) => `字符 ${group(characters)}`;
const countsOf = (text) => summarizeWordCount(text);

const ready = (page, timeout = 10000) => page.waitForFunction(
  (selector) => document.querySelector(selector)?.dataset.state === 'ready',
  BADGE,
  { timeout },
);

const editorValue = (page) => page.evaluate(() => window.__testEditor.getValue());
const waitForWords = (page, words, timeout = 15000) => page.waitForFunction(
  ({ selector, expected }) => document.querySelector(selector)?.dataset.words === expected,
  { selector: BADGE, expected: words },
  { timeout },
);

export async function registerWordCountBadgeChecks(ctx) {
  const { check, sleep, page, vault, base, outputRoot } = ctx;

  // Every state-changing request the app makes during a measured window. The matrix's
  // "统计刷新 → 0 网络写入" row is asserted against this log.
  const writes = [];
  page.on('request', (request) => {
    const method = request.method();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    if (!request.url().includes('/api/web/')) return;
    writes.push(`${method} ${new URL(request.url()).pathname}`);
  });
  const geometryTrace = [];
  const openReady = async (name) => {
    await ctx.open(name);
    await ready(page);
    await sleep(150);
  };

  // Own fixtures + own hard load: a known state (welcome, no note) for the first assertions.
  for (const [name, body] of Object.entries(FIXTURES)) await fs.writeFile(path.join(vault, name), body);
  await sleep(500);
  await page.goto(`${base}/app`);
  await page.waitForSelector(`.note[title="${NOTE_MAIN}"]`, { timeout: 30000 });
  // This scene opens a ~1 MB document, so it needs more headroom than the shared page default.
  // Nothing runs after this module, so the raise is scoped to these checks.
  page.setDefaultTimeout(30000);
  await sleep(250);

  await check('#430 badge: loaded with no note open → badge hidden and empty', async () => {
    const snapshot = await badgeSnapshot(page);
    assert.equal(snapshot.present, true, 'the badge element must exist in the served markup');
    assert.equal(snapshot.nodeName, 'BUTTON');
    assert.equal(snapshot.type, 'button');
    assert.equal(snapshot.hidden, true);
    assert.equal(snapshot.display, 'none');
    assert.equal(snapshot.words, '');
    assert.equal(snapshot.characters, '');
    assert.equal(snapshot.statusBarCount, 0, 'U21: the removed status bar must stay gone');
  });

  await check('#430 badge: opening a note shows the frozen counts for that document', async () => {
    await openReady(NOTE_MAIN);
    const snapshot = await badgeSnapshot(page);
    assert.equal(snapshot.hidden, false);
    assert.equal(snapshot.words, wordsText(BADGE_NOTE_COUNTS.words), `${NOTE_MAIN} words; got ${snapshot.words}`);
    assert.equal(snapshot.characters, charactersText(BADGE_NOTE_COUNTS.characters), `${NOTE_MAIN} characters; got ${snapshot.characters}`);
    assert.equal(snapshot.ariaLabel, `${wordsText(BADGE_NOTE_COUNTS.words)}，${charactersText(BADGE_NOTE_COUNTS.characters)}（字符数不含空白）`);
    assert.equal(snapshot.ariaLive, null, 'the badge must not be a live region (no per-keystroke announcement)');
    assert.equal(snapshot.badgeCount, 1, 'exactly one badge instance');
  });

  await check('#430 badge: Live / RAW / Reader report identical counts from one source', async () => {
    // Self-sufficient (so the negative control can run this check alone): open the document first.
    await openReady(NOTE_MAIN);
    writes.length = 0;
    const reader = await badgeSnapshot(page);
    // The counts must equal the frozen triple of the committed Markdown SOURCE. Equality across
    // surfaces alone would still hold if every surface counted the same wrong thing (e.g. the
    // rendered Reader DOM), which is exactly what issue #430 forbids.
    assert.equal(reader.words, wordsText(BADGE_NOTE_COUNTS.words), 'the Reader must count the committed Markdown source');
    const surfaces = { reader };
    for (const name of ['live', 'raw']) {
      await ctx.mode(name);
      await sleep(250);
      surfaces[name] = await badgeSnapshot(page);
    }
    await ctx.mode('preview');
    await ready(page);
    await sleep(250);
    surfaces.readerAgain = await badgeSnapshot(page);
    for (const [name, snapshot] of Object.entries(surfaces)) {
      assert.equal(snapshot.words, wordsText(BADGE_NOTE_COUNTS.words), `${name} must count the source (got ${snapshot.words})`);
      assert.equal(snapshot.characters, charactersText(BADGE_NOTE_COUNTS.characters), `${name} must count the source (got ${snapshot.characters})`);
      assert.equal(snapshot.words, reader.words, `${name} words must match the reader`);
      assert.equal(snapshot.characters, reader.characters, `${name} characters must match the reader`);
      assert.equal(snapshot.sameNode, true, `${name} must reuse the same badge node`);
      assert.equal(snapshot.badgeCount, 1, `${name} must not add a second badge`);
    }
    assert.deepEqual(writes, [], `switching surfaces must not write anything (${writes.join(', ')})`);
  });

  await check('#430 badge: typing, undo and save stay live without a spurious write', async () => {
    await openReady(NOTE_SCRATCH);
    await ctx.mode('live');
    await ready(page);
    const before = await badgeSnapshot(page);
    writes.length = 0;
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n\nzebra yak 中文 42');
    await ready(page, 5000);
    await sleep(250);
    const typed = await badgeSnapshot(page);
    assert.notEqual(typed.words, before.words, 'the count must follow unsaved local edits');
    assert.equal(typed.words, wordsText(countsOf(await editorValue(page)).words), 'the badge must equal the pure count of the live source');
    assert.equal(typed.characters, charactersText(countsOf(await editorValue(page)).characters));
    assert.deepEqual(writes, [], `the count refresh itself must not write (${writes.join(', ')})`);

    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await ready(page, 5000);
    await sleep(400);
    assert.equal((await badgeSnapshot(page)).words, wordsText(countsOf(await editorValue(page)).words), 'undo must be reflected');
    assert.equal((await badgeSnapshot(page)).words, before.words, 'undo back to the initial text must restore the initial count');
    assert.equal(await page.locator('#save').isDisabled(), true, 'undo to the committed text must leave the document clean');

    // The explicit save is the only write this scene may produce.
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' saved marker');
    await ready(page, 5000);
    writes.length = 0;
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/web/v1/note') && response.request().method() === 'POST');
    await page.locator('#save').click();
    assert.equal((await saved).status(), 200);
    await sleep(300);
    assert.equal((await badgeSnapshot(page)).words, wordsText(countsOf(await editorValue(page)).words), 'the save response must not change the count');
    assert.deepEqual(writes, ['POST /api/web/v1/note'], `a manual save must be the only write (${writes.join(', ')})`);

    // Restore the fixture so a rerun starts from the same text. Re-open deterministically
    // instead of waiting on the live-update race: the external-update path has its own check
    // below, this step only guarantees the fixture is back and the badge follows it.
    await fs.writeFile(path.join(vault, NOTE_SCRATCH), FIXTURES[NOTE_SCRATCH]);
    await sleep(300);
    await openReady(NOTE_SCRATCH);
    const restored = await badgeSnapshot(page);
    assert.equal(
      restored.words,
      wordsText(countsOf(FIXTURES[NOTE_SCRATCH]).words),
      `restoring the fixture must refresh the count (hidden=${restored.hidden} state=${restored.state} path=${restored.dataPath})`,
    );
    assert.equal(await editorValue(page), FIXTURES[NOTE_SCRATCH], 'the editor must hold the restored text');
  });

  await check('#430 badge: a clean external update reaches the count (silent setValue is not missed)', async () => {
    await openReady(NOTE_REFRESH);
    const before = await badgeSnapshot(page);
    const remote = '# U52 refresh\n\nalpha line\nbravo line\n\u65b0\u589e\u4e2d\u6587\u884c zebra\n';
    await fs.writeFile(path.join(vault, NOTE_REFRESH), remote);
    await waitForWords(page, String(countsOf(remote).words), 10000).catch(() => {});
    await sleep(400);
    const updated = await badgeSnapshot(page);
    assert.equal(updated.words, wordsText(countsOf(remote).words), 'the clean external update must reach the badge');
    assert.notEqual(updated.words, before.words);
    assert.match(await editorValue(page), /zebra/, 'the editor must have silently adopted the external version');
  });

  await check('#430 badge: A → B → C follows the committed identity and never shows a stale document', async () => {
    await openReady(NOTE_B);
    const bCounts = countsOf(await editorValue(page));
    assert.equal((await badgeSnapshot(page)).dataPath, NOTE_B);
    await openReady(NOTE_MAIN);
    assert.equal((await badgeSnapshot(page)).words, wordsText(BADGE_NOTE_COUNTS.words));
    await openReady(NOTE_C);
    const final = await badgeSnapshot(page);
    assert.equal(final.dataPath, NOTE_C, 'the badge must follow the committed identity');
    assert.equal(final.words, wordsText(countsOf(await editorValue(page)).words));
    assert.notEqual(final.words, wordsText(bCounts.words));
  });

  await check('#430 badge: closing the last tab (welcome) hides the badge and clears the numbers', async () => {
    writes.length = 0;
    let guard = 0;
    while (await page.locator('#document-tabs .document-tab').count()) {
      guard += 1;
      assert.ok(guard < 12, 'too many tabs to close');
      await page.locator('#document-tabs .document-tab .document-tab-close').first().click();
      await sleep(180);
    }
    await sleep(350);
    const snapshot = await badgeSnapshot(page);
    assert.equal(snapshot.hidden, true, 'the welcome workspace must hide the badge');
    assert.equal(snapshot.words, '');
    assert.equal(snapshot.characters, '');
    assert.equal(snapshot.dataPath, '');
    assert.deepEqual(writes, [], `closing tabs must not write anything (${writes.join(', ')})`);
  });

  await check('#430 badge: an open Base surface hides the badge', async () => {
    await sleep(500);
    await page.reload();
    await page.waitForSelector(`.note[title="${NOTE_MAIN}"]`, { timeout: 30000 });
    await openReady(NOTE_MAIN);
    assert.equal((await badgeSnapshot(page)).hidden, false);
    await page.reload();
    const baseRow = `.note[data-kind="base"][title="${NOTE_BASE}"]`;
    await page.waitForSelector(baseRow, { timeout: 30000 });
    await page.locator(baseRow).click();
    await page.waitForFunction(() => document.querySelector('#base-host')?.hidden === false, null, { timeout: 30000 });
    await sleep(400);
    const snapshot = await badgeSnapshot(page);
    assert.equal(snapshot.hidden, true, 'a Base surface must not show a Markdown word count');
    assert.equal(snapshot.words, '');
  });

  await check('#430 badge: bottom-right placement, no occlusion, no new scrollbar (Reader + Live, rail open + closed)', async () => {
    await page.goto(`${base}/app`);
    await page.waitForSelector(`.note[title="${NOTE_MAIN}"]`, { timeout: 30000 });
    await openReady(NOTE_MAIN);
    // #469: the right edge relationship must hold with the docked rail open AND closed. The rail
    // is a shell grid sibling, so opening it narrows .document instead of covering it; the badge
    // must still keep its 20px inset and stay left of the rail's own left edge.
    const railHidden = await page.evaluate(() => document.querySelector('.shell').classList.contains('context-hidden'));
    if (railHidden) {
      await page.locator('#sidebar-toggle').click();
      await sleep(300);
    }
    const railState = await page.evaluate(() => ({
      hidden: document.querySelector('.shell').classList.contains('context-hidden'),
      railLeft: document.querySelector('#context-sidebar')?.getBoundingClientRect().left ?? null,
    }));
    assert.equal(railState.hidden, false, 'the rail must be docked for this pass');
    for (const mode of ['preview', 'live']) {
      if (mode === 'live') await ctx.mode(mode);
      await sleep(250);
      const atTop = await badgeSnapshot(page);
      assertRightAligned(atTop, `${mode} (rail open)`);
      assert.equal(atTop.railLeft !== null, true, `${mode}: the docked rail must be laid out`);
      assert.ok(
        Math.abs(atTop.railLeft - railState.railLeft) <= 1,
        `${mode}: the docked rail must not move during the pass (${atTop.railLeft} vs ${railState.railLeft})`,
      );
      assert.ok(
        atTop.rect.right <= atTop.railLeft + 1,
        `${mode}: the badge must stay clear of the docked rail (badge right ${atTop.rect.right}, rail left ${atTop.railLeft})`,
      );
      assert.ok(atTop.docRect.bottom - atTop.rect.bottom <= 24, `${mode}: the badge must sit at the bottom edge`);
      assert.ok(atTop.rect.top >= atTop.docRect.top && atTop.rect.bottom <= atTop.docRect.bottom + 1, `${mode}: the badge must stay inside the document pane`);
      assert.ok(atTop.documentScrollWidth <= atTop.innerWidth, `${mode}: no horizontal overflow (${atTop.documentScrollWidth} > ${atTop.innerWidth})`);
      assert.ok(atTop.documentScrollHeight <= atTop.innerHeight + 1, `${mode}: the badge must not create a page scrollbar`);
      await page.evaluate(() => {
        const preview = document.querySelector('#preview');
        const scroller = document.querySelector('.cm-scroller');
        if (preview && !preview.hidden) preview.scrollTop = preview.scrollHeight;
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
      await sleep(300);
      const atEnd = await badgeSnapshot(page);
      assert.ok(atEnd.lastLineBottom !== null, `${mode}: expected a rendered line to compare against`);
      assert.ok(
        atEnd.rect.top >= atEnd.lastLineBottom - GEOMETRY_TOLERANCE_PX,
        `${mode}: the badge must not cover the last line (badge top ${atEnd.rect.top}, last line bottom ${atEnd.lastLineBottom})`,
      );
      if (atEnd.preview) assert.ok(atEnd.preview.scrollWidth <= atEnd.preview.clientWidth + 1, `${mode}: #preview must not gain a horizontal axis`);
      if (atEnd.scroller) assert.ok(atEnd.scroller.scrollWidth <= atEnd.scroller.clientWidth + 1, `${mode}: .cm-scroller must not gain a horizontal axis`);
      geometryTrace.push({ mode, viewport: 'desktop-1440x1000', rail: 'open', scrollbarGutter: visibleGutter(atEnd), badge: atEnd.rect, documentPane: atEnd.docRect, lastLineBottom: atEnd.lastLineBottom, preview: atEnd.preview, scroller: atEnd.scroller, documentScrollWidth: atEnd.documentScrollWidth, innerWidth: atEnd.innerWidth });
    }
    // Same relationship with the rail closed (the wider .document): the right inset is measured
    // against the pane, so it must not follow the pane width.
    await ctx.mode('preview');
    await page.locator('#sidebar-toggle').click();
    await sleep(350);
    assert.equal(await page.evaluate(() => document.querySelector('.shell').classList.contains('context-hidden')), true, 'the rail must be closed for the second pass');
    const railClosed = await badgeSnapshot(page);
    assert.equal(railClosed.railLeft, null, 'the closed rail must not be laid out');
    assertRightAligned(railClosed, 'preview (rail closed)');
    assert.ok(railClosed.docRect.bottom - railClosed.rect.bottom <= 24, 'preview (rail closed): the badge must sit at the bottom edge');
    geometryTrace.push({ mode: 'preview', viewport: 'desktop-1440x1000', rail: 'closed', scrollbarGutter: visibleGutter(railClosed), badge: railClosed.rect, documentPane: railClosed.docRect, lastLineBottom: railClosed.lastLineBottom, preview: railClosed.preview, scroller: railClosed.scroller, documentScrollWidth: railClosed.documentScrollWidth, innerWidth: railClosed.innerWidth });
  });

  await check('#430 badge: mobile stays reachable inside the safe area without overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(350);
    const collapsed = await badgeSnapshot(page);
    assert.equal(collapsed.hidden, false, 'the badge must stay visible on narrow panes');
    assert.equal(collapsed.charactersVisible, false, 'the character count is the part narrow panes drop');
    assert.equal(collapsed.words, wordsText(BADGE_NOTE_COUNTS.words), 'the word count stays complete');
    assert.match(String(collapsed.ariaLabel), /字符 \d/, 'the aria-label must still describe both numbers');
    assert.ok(collapsed.rect.height >= 24, `touch target too small: ${collapsed.rect.height}`);
    assert.ok(collapsed.documentScrollWidth <= collapsed.innerWidth, 'no horizontal overflow on mobile');
    assertRightAligned(collapsed, 'mobile collapsed');
    assert.ok(collapsed.rect.left >= collapsed.docRect.left, 'mobile: the badge must stay inside the pane on the left too');
    await page.locator(BADGE).click();
    await sleep(200);
    const expanded = await badgeSnapshot(page);
    assert.equal(expanded.expanded, true, 'the control must reveal the full value by touch/click');
    assert.equal(expanded.charactersVisible, true);
    assert.equal(expanded.ariaPressed, 'true');
    assert.equal(expanded.characters, charactersText(BADGE_NOTE_COUNTS.characters));
    await page.evaluate(() => {
      const preview = document.querySelector('#preview');
      if (preview) preview.scrollTop = preview.scrollHeight;
    });
    await sleep(300);
    const atEnd = await badgeSnapshot(page);
    assert.ok(atEnd.lastLineBottom !== null, 'mobile: expected a rendered line to compare against');
    assert.ok(
      atEnd.rect.top >= atEnd.lastLineBottom - GEOMETRY_TOLERANCE_PX,
      `mobile: the badge must not cover the last line (badge top ${atEnd.rect.top}, last line bottom ${atEnd.lastLineBottom})`,
    );
    assert.ok(atEnd.rect.bottom <= atEnd.docRect.bottom + 1, 'mobile: the badge must stay inside the pane (safe area)');
    assertRightAligned(atEnd, 'mobile expanded');
    geometryTrace.push({ mode: 'preview', viewport: 'mobile-390x844', rail: 'drawer closed', scrollbarGutter: visibleGutter(atEnd), badge: atEnd.rect, documentPane: atEnd.docRect, lastLineBottom: atEnd.lastLineBottom });
    await page.locator(BADGE).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await sleep(300);
  });

  await check('#430 badge: dense typing on a ~1 MB document coalesces per throttle window, not per keystroke', async () => {
    const body = longNote();
    await fs.writeFile(path.join(vault, NOTE_LONG), body);
    await sleep(600);
    await page.reload();
    await page.waitForSelector(`.note[title="${NOTE_LONG}"]`, { timeout: 30000 });
    await openReady(NOTE_LONG);
    await ctx.mode('live');
    await ready(page, 30000);
    assert.equal((await badgeSnapshot(page)).words, wordsText(countsOf(body).words), 'the long document must be counted from its source');

    // Counted without touching product code: paint() always writes aria-label, and a MutationObserver cross-checks the same DOM writes.
    const probe = await page.evaluate((selector) => {
      const badge = document.querySelector(selector);
      const state = { patched: 0, observed: 0 };
      const setAttribute = badge.setAttribute.bind(badge);
      badge.setAttribute = (name, value) => { if (name === 'aria-label') state.patched += 1; return setAttribute(name, value); };
      new MutationObserver((records) => { state.observed += records.filter((record) => record.attributeName === 'aria-label').length; }).observe(badge, { attributes: true, attributeFilter: ['aria-label'] });
      return (window.__u53BadgePasses = state);
    }, BADGE);
    assert.equal(probe.patched + probe.observed, 0, 'the probe must be installed before any measured pass');

    // Deterministic invariant (no wall clock): 40 real editor transactions in ONE JS task are one throttle window, so ONE coalesced pass is expected, not 40 full 1 MB parses.
    const burstChars = 40;
    const grown = await page.evaluate((count) => {
      const view = window.__testEditor._view;
      for (let index = 0; index < count; index += 1) view.dispatch({ changes: { from: view.state.doc.length, insert: `x${index} ` } });
      return view.state.doc.toString();
    }, burstChars);
    await waitForWords(page, String(countsOf(grown).words));
    await sleep(400);
    const coalesced = await page.evaluate(() => ({ ...window.__u53BadgePasses }));
    assert.ok(coalesced.patched >= 1, 'the coalesced trailing pass must still run');
    assert.ok(coalesced.patched <= 2, `${burstChars} keystrokes inside one throttle window caused ${coalesced.patched} full-document passes (expected one)`);
    assert.equal(coalesced.observed, coalesced.patched, 'the DOM-side probe must see exactly the passes the wrapper counted');

    // Real keystrokes (the original scene): the bound is the OBSERVED burst duration / the shipped throttle window (+1 leading, +1 margin).
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    const burst = 'typing a burst of sixty characters 中文混合 abcdef';
    const passesBefore = coalesced.patched;
    const started = Date.now();
    await page.keyboard.type(burst, { delay: 0 });
    const typedAt = Date.now();
    const finalCounts = countsOf(await editorValue(page));
    await waitForWords(page, String(finalCounts.words));
    const caughtUpAt = Date.now();
    await sleep(300);
    const after = await badgeSnapshot(page);
    assert.equal(after.words, wordsText(finalCounts.words), 'the badge must catch up to the typed text');
    const passBound = Math.ceil((typedAt - started) / WORD_COUNT_THROTTLE_MS) + 2;
    const timings = { typingMs: typedAt - started, badgeCatchUpMs: caughtUpAt - typedAt, totalMs: caughtUpAt - started, passBound, passes: (await page.evaluate(() => window.__u53BadgePasses.patched)) - passesBefore };
    assert.ok(timings.passes <= passBound, `${burst.length} keystrokes over ${timings.typingMs} ms caused ${timings.passes} full-document passes (bound ${passBound} = one per ${WORD_COUNT_THROTTLE_MS} ms window + 1 leading + 1 margin)`);
    assert.ok(timings.badgeCatchUpMs <= BADGE_CATASTROPHE_BUDGET_MS, `the badge took ${timings.badgeCatchUpMs} ms to show the final count (catastrophe cap ${BADGE_CATASTROPHE_BUDGET_MS} ms; CI under load reads 555-737 ms)`);
    assert.ok(timings.totalMs <= SYNC_SANITY_BUDGET_MS, `dense typing + badge refresh took ${timings.totalMs} ms (sanity budget ${SYNC_SANITY_BUDGET_MS} ms)`);
    await fs.writeFile(path.join(outputRoot, 'word-count-badge-perf.json'), `${JSON.stringify({
      note: 'RECORD ONLY — the gates are the load-independent pass counts above plus the deterministic test/word-count*.test.js.',
      longDocumentBytes: Buffer.byteLength(body, 'utf8'), typedCharacters: burst.length, timings,
      sameTaskBurst: { keystrokes: burstChars, fullPasses: coalesced.patched, domObservedPasses: coalesced.observed },
    }, null, 2)}\n`).catch(() => {});
  });

  await check('#430 badge: geometry trace written for review, single instance kept, page error-free', async () => {
    await fs.writeFile(path.join(outputRoot, 'word-count-badge-geometry.json'), `${JSON.stringify({
      note: 'badge rect vs document pane vs last rendered line; desktop Reader/Live with the right rail open and closed, plus one mobile sample; rightInset is documentPane.right - badge.right',
      samples: geometryTrace,
    }, null, 2)}\n`).catch(() => {});
    // Record-only visual of the shipped placement (#469): the badge's bottom-right corner of the
    // document pane, which no numeric assertion can show. Never a gate.
    await page.locator('.document').screenshot({ path: path.join(outputRoot, 'word-count-badge-right.png') }).catch(() => {});
    assert.ok(geometryTrace.length >= 4, 'expected desktop reader/live with the rail open, desktop reader with the rail closed and one mobile sample');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.word-count-badge').length), 1);
  });
}
