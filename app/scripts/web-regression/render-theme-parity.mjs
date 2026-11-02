// Phase 1 real-theme.css inheritance gate, registered inside the Chromium suite.
//
// Uses the same core as scripts/render-parity-phase1-theme.mjs so the standalone
// gate and the in-suite check can never drift. The fixture themes are written
// into the suite Vault by scripts/web-regression/env.mjs.
import assert from 'node:assert/strict';
import {
  KINDS,
  EXPECTED,
  PROBE_SOURCE,
  THEME_NAME,
  MUTATED_THEME_NAME,
  collectThemePaint,
  describeMismatch,
  evaluatePaint,
  mutatedExpected,
} from '../render-parity-theme-core.mjs';

async function setThemeLink(page, base, name) {
  await page.evaluate(async ({ href }) => {
    const link = document.querySelector('#community-theme');
    if (!link) throw new Error('community theme link is missing');
    await new Promise((resolve, reject) => {
      link.onload = () => resolve();
      link.onerror = () => reject(new Error(`theme failed to load: ${href}`));
      link.disabled = false;
      link.href = href;
    });
  }, { href: `${base}/api/web/v1/theme.css?name=${encodeURIComponent(name)}` });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function probe(page, surface) {
  return page.evaluate(collectThemePaint, { kinds: KINDS, surface });
}

async function focusLive(page, atEnd) {
  await page.evaluate((end) => {
    const editor = window.__testEditor;
    const view = editor?._view;
    if (!view) return;
    const anchor = end ? view.state.doc.length : 0;
    editor.scrollToPosition?.(anchor);
    view.dispatch({ selection: { anchor } });
  }, atEnd);
}

// CodeMirror only renders the lines around the viewport, so one scroll position can
// miss a fixture line: the merged probe source (the block kinds plus the Live callout
// block widget) is taller than one rendered window, and probing only the end reported
// the top kinds as "missing" instead of reading their paint. This mirrors
// `scripts/render-parity-phase1-theme.mjs` (#321): probe both ends and keep every kind
// either pass rendered. The assertions themselves are unchanged, they just stop
// depending on where the fixture happens to land.
async function probeLive(page, sleep) {
  const merged = {};
  for (const atEnd of [true, false]) {
    await focusLive(page, atEnd);
    await sleep(80);
    const pass = await probe(page, 'live');
    for (const [id, entry] of Object.entries(pass)) if (!merged[id]?.found) merged[id] = entry;
  }
  return merged;
}

export async function registerRenderThemeParityChecks(ctx) {
  const { check, sleep, page, open, mode, base, fixture } = ctx;
  await check('every RenderKind inherits the real theme.css in Reader and Live (Phase 1)', async () => {
    try {
      await open('A.md');
      await mode('live');
      await page.evaluate((text) => window.__testEditor.setValue(text, { resetHistory: true, silent: true }), PROBE_SOURCE);
      await setThemeLink(page, base, THEME_NAME);

      await mode('preview');
      await sleep(80);
      const reader = await probe(page, 'reader');

      await mode('live');
      await sleep(120);
      await focusLive(page, true);
      await page.waitForSelector('.HyperMD-hr', { timeout: 3000 });
      await sleep(80);
      const live = await probeLive(page, sleep);

      const mismatches = [
        ...evaluatePaint(reader, EXPECTED, 'reader'),
        ...evaluatePaint(live, EXPECTED, 'live'),
      ];
      assert.equal(mismatches.length, 0, mismatches.map(describeMismatch).join('; '));

      // Negative control: a mutated theme file must change every computed value.
      await mode('preview');
      await setThemeLink(page, base, MUTATED_THEME_NAME);
      const readerAfter = await probe(page, 'reader');
      const mutated = mutatedExpected(EXPECTED);
      const control = evaluatePaint(readerAfter, mutated, 'reader', 'reader-mutated');
      assert.equal(control.length, 0, control.map(describeMismatch).join('; '));
      assert.notEqual(
        readerAfter['inline-code'].values.color,
        reader['inline-code'].values.color,
        'negative control: inline code colour did not follow the mutated theme',
      );
    } finally {
      await page.evaluate((text) => {
        const link = document.querySelector('#community-theme');
        if (link) {
          link.disabled = true;
          link.removeAttribute('href');
        }
        window.__testEditor.setMode('live');
        window.__testEditor.setValue(text, { resetHistory: true, silent: true });
      }, fixture);
      await sleep(50);
    }
  });
}
