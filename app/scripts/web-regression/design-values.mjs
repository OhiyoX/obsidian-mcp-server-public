// #622 — computed values for the reader's property pills.
//
// `reader-property-pills.test.js` pins the *source* contract (rule text + token arithmetic) and
// `css-liveness-622.test.js` proves that rule is live at top level. Neither measures the rendered
// box: a theme, a later rule, or an inherited size can still move it. This scene reads the values a
// browser actually computes and keeps the two of them honest about their own reach.
//
// The numbers are the owner-approved enlargement (2026-10-18, 「胶囊有点小了」): the pill rides the
// 13px properties row instead of desktop's 0.875em input size, so the inset is 0.65em × 13px =
// 8.45px and the box is line-height + 2 × 0.25em + the 1px outline = 21.5px. The negative control
// puts the pre-enlargement values back on the live page and requires the same judgement to go red.
//
// Colours are compared against the resolved `--tag-*` tokens through a probe element instead of a
// literal, so a theme change cannot turn this into a false red — only a pill that stops using the
// accent skin can.
import assert from 'node:assert/strict';

const PILL = '.preview .metadata-property-value .multi-select-pill';
const ROW = '.preview .properties';

/** Measured values for the row, one pill and one tag pill, plus the tokens they must agree with. */
const MEASURE = ({ pill, row }) => {
  const round = (value) => Math.round(Number.parseFloat(value) * 100) / 100;
  const read = (element) => {
    if (!element) return null;
    const style = getComputedStyle(element);
    return {
      fontSize: round(style.fontSize),
      lineHeight: round(style.lineHeight),
      paddingInlineStart: round(style.paddingInlineStart),
      paddingTop: round(style.paddingTop),
      borderRadius: round(style.borderTopLeftRadius),
      height: round(style.height),
      width: round(style.width),
      background: style.backgroundColor,
      color: style.color,
      whiteSpace: style.whiteSpace,
      boxSizing: style.boxSizing,
    };
  };
  // Resolve a token through a real element: `--tag-background` is a color-mix() expression, so
  // comparing the raw custom-property text with a computed colour would never match.
  const resolve = (property) => {
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;left:-9999px;background:var(${property});color:var(${property})`;
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const value = { background: style.backgroundColor, color: style.color };
    probe.remove();
    return value;
  };
  return {
    row: read(document.querySelector(row)),
    pill: read(document.querySelector(pill)),
    tag: read(document.querySelector(`${pill}[data-tag]`)),
    tagToken: resolve('--tag-background'),
    tagColorToken: resolve('--tag-color'),
    counts: {
      pills: document.querySelectorAll(pill).length,
      tags: document.querySelectorAll(`${pill}[data-tag]`).length,
    },
  };
};

/** The judgement the negative control re-runs. Returns failure strings (empty = healthy). */
function pillFailures(view) {
  const failures = [];
  const near = (actual, expected, tolerance, label) => {
    // `Number.isFinite` first: `Math.abs(NaN - x) > t` is false, so a NaN would pass silently.
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
      failures.push(`${label}: expected ≈${expected} (±${tolerance}), got ${actual}`);
    }
  };
  if (!view.row) failures.push('the properties row is not rendered');
  if (!view.pill) failures.push('no property pill is rendered');
  if (!view.tag) failures.push('no tags pill (data-tag) is rendered');
  if (!view.row || !view.pill || !view.tag) return failures;

  near(view.row.fontSize, 13, 0.01, 'properties row font size');
  near(view.pill.fontSize, 13, 0.01, 'pill font size (rides the row, not 0.875em)');
  near(view.pill.paddingInlineStart, 8.45, 0.05, 'pill inline inset (0.65em × 13px)');
  near(view.pill.paddingTop, 3.25, 0.05, 'pill block inset (0.25em × 13px)');
  near(view.pill.height, 21.5, 0.1, 'pill box height (line-height + 2 × 0.25em + 1px outline)');
  near(view.pill.borderRadius, 26, 0.1, 'pill radius (2em at the 13px row)');
  if (view.pill.whiteSpace !== 'nowrap') failures.push(`pill must not wrap, white-space is ${view.pill.whiteSpace}`);
  if (view.pill.boxSizing !== 'border-box') failures.push(`pill must be border-box, got ${view.pill.boxSizing}`);
  // The same box rules apply to every pill, so the tag pill is measured too: a later rule that
  // resizes only `[data-tag]` would otherwise keep the geometry green.
  near(view.tag.fontSize, 13, 0.01, 'tags pill font size');
  near(view.tag.paddingInlineStart, 8.45, 0.05, 'tags pill inline inset');
  near(view.tag.height, 21.5, 0.1, 'tags pill box height');
  near(view.tag.borderRadius, 26, 0.1, 'tags pill radius');
  if (view.tag.background !== view.tagToken.background) failures.push(`tags pill background must be --tag-background (${view.tagToken.background}), got ${view.tag.background}`);
  if (view.tag.color !== view.tagColorToken.color) failures.push(`tags pill colour must be --tag-color (${view.tagColorToken.color}), got ${view.tag.color}`);
  if (view.counts.tags < 1) failures.push('the fixture must render at least one tag pill');
  return failures;
}

export async function registerDesignValueChecks(ctx) {
  const { check, page, open, mode, sleep } = ctx;

  await check('属性胶囊：计算值达标（13px 行 / 8.45px 内边距 / ≈21.5px 盒子 / accent 皮肤）', async () => {
    await open('Properties.md');
    await mode('preview');
    await sleep(300);
    const view = await page.evaluate(MEASURE, { pill: PILL, row: ROW });
    const failures = pillFailures(view);
    assert.deepEqual(failures, [], `the rendered pill must match the approved enlargement: ${JSON.stringify(failures)}`);
    assert.ok(view.counts.pills >= 2, `the fixture must render several pills, got ${view.counts.pills}`);
  });

  await check('负控：把胶囊改回修复前的尺寸，同一判据必须红', async () => {
    // Pre-enlargement values: desktop's 0.875em input size (11.375px at this row), no inset, square
    // corners. This is what the page looked like before the owner asked for the bigger pill.
    // Start from a freshly opened note, so the control cannot pass on state left by the check above.
    await open('Properties.md');
    await mode('preview');
    await sleep(300);
    const handle = await page.addStyleTag({ content: `${PILL}{font-size:0.875em;padding:0;border-radius:0;line-height:1.2}` });
    try {
      const broken = await page.evaluate(MEASURE, { pill: PILL, row: ROW });
      const failures = pillFailures(broken);
      assert.ok(failures.length >= 4, `the control must fail on several values, got ${JSON.stringify(failures)}`);
      assert.ok(failures.some((line) => line.includes('pill font size')), `the font size must be named, got ${JSON.stringify(failures)}`);
      assert.ok(failures.some((line) => line.includes('inline inset')), `the inset must be named, got ${JSON.stringify(failures)}`);
      assert.ok(failures.some((line) => line.includes('box height')), `the height must be named, got ${JSON.stringify(failures)}`);
    } finally {
      await handle.evaluate((node) => node.remove());
    }
    // And the page is healthy again once the injection is gone, so the red came from the injection.
    const restored = await page.evaluate(MEASURE, { pill: PILL, row: ROW });
    assert.deepEqual(pillFailures(restored), [], 'removing the injection must restore the approved values');
  });
}
