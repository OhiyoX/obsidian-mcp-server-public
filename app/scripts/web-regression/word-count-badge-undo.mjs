// Issue #430 review follow-up — the throttled-undo race, against the real application.
//
// The badge coalesces recomputes with a 120 ms leading/trailing throttle. When the live text
// returns to exactly what is already painted while a queued job still holds an intermediate edit
// (`one` -> `one two` -> `one` inside one window), that queued job must be dropped: the trailing
// edge used to repaint the edit the user just undid (the review seat reproduced 166/975 ->
// 170/994 in the real app). The deterministic unit test lives in `test/word-count-badge.test.js`;
// this module is the real-browser regression the seat asked for.
//
// Registered after word-count-badge.mjs (it hard-loads its own page and is the final owner).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { summarizeWordCount } from '../../frontend/app/features/document/word-count.js';

const BADGE = '.word-count-badge';
const NOTE_UNDO = 'U52Undo.md';
const FIXTURE = '# U52 undo\n\nalpha line\nbravo line\n';

const group = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const wordsText = (words) => `字数 ${group(words)}`;
const editorValue = (page) => page.evaluate(() => window.__testEditor.getValue());
const ready = (page, timeout = 5000) => page.waitForFunction(
  (selector) => document.querySelector(selector)?.dataset.state === 'ready',
  BADGE,
  { timeout },
);
const badgeSnapshot = (page) => page.evaluate((selector) => {
  const element = document.querySelector(selector);
  return {
    hidden: element.hidden,
    words: element.querySelector('.word-count-badge-words')?.textContent ?? null,
    ariaLabel: element.getAttribute('aria-label'),
    state: element.dataset.state ?? null,
    dataPath: element.dataset.path ?? null,
  };
}, BADGE);

export async function registerWordCountBadgeUndoChecks(ctx) {
  const { check, sleep, page, vault, base } = ctx;

  await fs.writeFile(path.join(vault, NOTE_UNDO), FIXTURE);
  await sleep(400);
  await page.goto(`${base}/app`);
  await page.waitForSelector(`.note[title="${NOTE_UNDO}"]`, { timeout: 30000 });
  await ctx.open(NOTE_UNDO);
  await ctx.mode('live');
  await ready(page);
  await sleep(150);

  await check('#430 badge: an edit undone inside one throttle window keeps the original count', async () => {
    const original = await editorValue(page);
    const before = await badgeSnapshot(page);
    assert.equal(before.hidden, false);
    assert.equal(before.words, wordsText(summarizeWordCount(original).words), 'probe precondition: the original text is painted');

    // Deterministic same-window probe: two real editor transactions in ONE task, so the app's own
    // onChange -> session.noteLocalEdit -> presenter -> badge.update path sees the edit and the
    // restore well inside the same 120 ms throttle window.
    const restored = await page.evaluate((text) => {
      const view = window.__testEditor._view;
      const from = view.state.doc.length;
      const insert = '\n\nquick undo probe zebra';
      view.dispatch({ changes: { from, insert } });
      view.dispatch({ changes: { from, to: from + insert.length, insert: '' } });
      return view.state.doc.toString() === text;
    }, original);
    assert.equal(restored, true, 'the probe must return the editor to the original text');

    // Let any queued trailing job fire (pre-fix it repaints the intermediate text here).
    await ready(page);
    await sleep(400);
    const after = await badgeSnapshot(page);
    assert.equal(
      after.words,
      before.words,
      `an edit undone inside one throttle window must keep the original count (editor restored to ${JSON.stringify(original)}, badge showed ${after.words})`,
    );
    assert.equal(after.words, wordsText(summarizeWordCount(await editorValue(page)).words));

    // Real-keystroke round trip with no sleep between the keystrokes and the undo. The window is
    // not guaranteed by the harness (each CDP keystroke is a round trip), so this is recorded as
    // evidence; the assertion is the end state the user can see: badge == editor text.
    const startedAt = Date.now();
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' zzz', { delay: 0 });
    await page.keyboard.press('Control+z');
    const undoneAt = Date.now();
    await ready(page);
    await sleep(400);
    const typed = await badgeSnapshot(page);
    const finalText = await editorValue(page);
    assert.equal(
      typed.words,
      wordsText(summarizeWordCount(finalText).words),
      `the badge must agree with the editor after a quick keyboard undo (badge ${typed.words})`,
    );
    console.log(`[#430 undo] real keyboard edit+undo took ${undoneAt - startedAt} ms (throttle window 120 ms; editor restored=${finalText === original})`);

    // Leave the fixture and the editor in the committed state for any rerun.
    await fs.writeFile(path.join(vault, NOTE_UNDO), FIXTURE);
    await ctx.open(NOTE_UNDO);
    await ready(page);
    const settled = await badgeSnapshot(page);
    assert.equal(settled.words, wordsText(summarizeWordCount(FIXTURE).words));
    assert.equal(await editorValue(page), FIXTURE);
  });
}
