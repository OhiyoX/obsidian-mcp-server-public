// Phase 1-B shared-geometry gate, registered inside the Chromium suite.
//
// Uses the same core/harness as `scripts/render-parity-phase1-geometry.mjs`, so
// the standalone gate and the in-suite check can never drift. The geometry theme
// fixtures are written into the suite Vault by `scripts/web-regression/env.mjs`.
//
// It asserts each host's measured adjacent-block gap / table geometry against
// the value the real theme.css declared for the shared token, then runs the same
// negative control (mutated tokens must change what the probe measures).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ADJACENCIES,
  GEOMETRY_ALLOWLIST_RELATIVE,
  GEOMETRY_EXPECTED,
  GEOMETRY_PROBE_SOURCE,
  GEOMETRY_THEME_NAME,
  MUTATED_GEOMETRY_THEME_NAME,
  describeGeometryMismatch,
  evaluateAllocatorParity,
  evaluateGeometry,
  mutatedGeometryExpected,
} from '../render-parity-geometry-core.mjs';
import {
  ensureLiveTables,
  ensureReaderTables,
  probeSurfaceSettled,
  setThemeLink,
} from '../render-parity-geometry-harness.mjs';

const appRoot = new URL('../..', import.meta.url);
const allowlist = JSON.parse(fs.readFileSync(new URL(GEOMETRY_ALLOWLIST_RELATIVE, appRoot), 'utf8'));

// #780: `Title` + `===` is a heading, and Live Preview must give it the same surface as ATX —
// the heading face on the TITLE lines and the theme's after-space as its own line padding. The
// parser puts the setext `HeaderMark` on the UNDERLINE and spans title lines plus underline in
// one node, so the same scene also proves the underline hides while idle and returns at the
// caret. `collectSetext` is serialized into the page by `page.evaluate`, so it closes over nothing.
const SETEXT_PROBE_SOURCE = `STX1MARK setext title
===
GAPSTX1MARK paragraph after the setext heading

# ATXGAPMARK atx control title
GAPATXGAPMARK paragraph after the atx heading

STX2MARK level two title
---
GAPSTX2MARK paragraph after the level two heading
`;

// The hidden underline LINE must cost nothing: #785 collapsed its row (the class
// `cm-live-setext-underline-hidden`), so a setext heading is pinned to the ATX control's own gap.
// A non-zero value here would let the extra row come back unnoticed.
const SETEXT_EXTRA_ROW_MAX_PX = 0;

const collectSetext = () => {
  const lines = [...document.querySelectorAll('.cm-content .cm-line')];
  const find = (needle) => lines.find((line) => line.textContent.trim().startsWith(needle)) || null;
  const probe = (titleNeedle, afterNeedle) => {
    const title = find(titleNeedle);
    const after = find(afterNeedle);
    const underline = title ? lines[lines.indexOf(title) + 1] || null : null;
    const css = title ? getComputedStyle(title) : null;
    return {
      className: title ? title.className : '',
      fontSize: css ? Number.parseFloat(css.fontSize) : 0,
      fontWeight: css ? Number(css.fontWeight) : 0,
      paddingBottom: css ? Number.parseFloat(css.paddingBottom) : 0,
      bodyFontSize: after ? Number.parseFloat(getComputedStyle(after).fontSize) : 0,
      underlineText: underline ? underline.textContent : null,
      // Same "visible gap" rule as the geometry probe: the heading's own padding is part of the
      // gap, not of the heading, so paddingBottom is subtracted from its box bottom.
      visibleGap: title && after
        ? after.getBoundingClientRect().top - (title.getBoundingClientRect().bottom - (Number.parseFloat(css.paddingBottom) || 0))
        : NaN,
    };
  };
  return { h1: probe('STX1MARK', 'GAPSTX1MARK'), h2: probe('STX2MARK', 'GAPSTX2MARK'), atx: probe('ATXGAPMARK', 'GAPATXGAPMARK') };
};

export async function registerRenderGeometryParityChecks(ctx) {
  const { check, sleep, page, open, mode, base, fixture } = ctx;
  await check('heading-adjacent gaps and table geometry follow the shared theme tokens (Phase 1-B)', async () => {
    try {
      await open('A.md');
      await mode('live');
      await page.evaluate((text) => window.__testEditor.setValue(text, { resetHistory: true, silent: true }), GEOMETRY_PROBE_SOURCE);
      await setThemeLink(page, base, GEOMETRY_THEME_NAME, sleep);

      await mode('preview');
      await ensureReaderTables(page, sleep);
      await sleep(80);
      const reader = await probeSurfaceSettled(page, 'reader', sleep);

      await mode('live');
      await page.waitForFunction(() => document.querySelector('.document.mode-live') != null);
      await ensureLiveTables(page, sleep);
      const live = await probeSurfaceSettled(page, 'live', sleep);

      const diagnostics = await page.evaluate(() => ({
        mode: document.querySelector('.document')?.className || 'missing',
        lines: document.querySelectorAll('.cm-content .cm-line').length,
        tables: document.querySelectorAll('.cm-table-widget').length,
      }));
      const mismatches = [
        ...evaluateGeometry(reader, GEOMETRY_EXPECTED, allowlist),
        ...evaluateGeometry(live, GEOMETRY_EXPECTED, allowlist),
        ...evaluateAllocatorParity(reader, live, allowlist),
      ];
      assert.equal(
        mismatches.length,
        0,
        `${mismatches.map(describeGeometryMismatch).join('; ')} | host diagnostics ${JSON.stringify(diagnostics)}`,
      );

      // Negative control: a mutated theme file must change the measured geometry.
      await mode('preview');
      await setThemeLink(page, base, MUTATED_GEOMETRY_THEME_NAME, sleep);
      await ensureReaderTables(page, sleep);
      const readerAfter = await probeSurfaceSettled(page, 'reader', sleep);
      const mutated = mutatedGeometryExpected(GEOMETRY_EXPECTED);
      const control = evaluateGeometry(readerAfter, mutated, allowlist);
      assert.equal(control.length, 0, control.map(describeGeometryMismatch).join('; '));
      assert.notEqual(
        readerAfter.gaps[ADJACENCIES[0].id].visibleGap,
        reader.gaps[ADJACENCIES[0].id].visibleGap,
        'negative control: the heading after-space did not follow the mutated geometry token',
      );
      assert.notEqual(
        readerAfter.tables.narrow.overflowX,
        reader.tables.narrow.overflowX,
        'negative control: the table overflow policy did not follow the mutated geometry token',
      );

      // #780: a setext heading is a heading on the same terms as ATX.
      const spaceAfter = Number.parseFloat(GEOMETRY_EXPECTED['--md-heading-space-after']);
      const tolerance = Number.isFinite(Number(allowlist?.tolerancePx)) ? Number(allowlist.tolerancePx) : 1;
      await setThemeLink(page, base, GEOMETRY_THEME_NAME, sleep);
      await mode('live');
      await page.evaluate((text) => window.__testEditor.setValue(text, { resetHistory: true, silent: true }), SETEXT_PROBE_SOURCE);
      // Caret outside every heading: all heading marks are idle.
      await page.evaluate((length) => window.__testEditor.scrollToPosition(length), SETEXT_PROBE_SOURCE.length);
      await sleep(80);
      const setextIdle = await page.evaluate(collectSetext);
      const atxGap = setextIdle.atx.visibleGap;
      assert.ok(atxGap > 0, `ATX control: the heading must keep a visible gap to the next block, measured ${atxGap}px`);
      for (const [label, measured, level] of [['level one', setextIdle.h1, 1], ['level two', setextIdle.h2, 2]]) {
        for (const name of ['cm-live-heading', `cm-live-h${level}`, 'HyperMD-header', `HyperMD-header-${level}`]) {
          assert.ok(
            measured.className.split(/\s+/).includes(name),
            `setext ${label}: the title line must carry ${name} (class ${measured.className})`,
          );
        }
        assert.ok(
          Math.abs(measured.paddingBottom - spaceAfter) <= tolerance,
          `setext ${label}: the heading must own the theme after-space ${spaceAfter}px, measured ${measured.paddingBottom}px`,
        );
        assert.ok(
          measured.fontWeight >= 700 && measured.fontSize > measured.bodyFontSize,
          `setext ${label}: the title must be bold and larger than body text (${measured.fontWeight}/${measured.fontSize}px vs body ${measured.bodyFontSize}px)`,
        );
        assert.equal(measured.underlineText, '', `setext ${label}: the underline must be hidden while the caret is away`);
        // Pinned against the ATX control, so a second stray row cannot pass as "some gap".
        const extraRow = measured.visibleGap - atxGap;
        assert.ok(
          extraRow >= 0 && extraRow <= SETEXT_EXTRA_ROW_MAX_PX,
          `setext ${label}: the hidden underline row must cost at most ${SETEXT_EXTRA_ROW_MAX_PX}px against ATX, measured ${extraRow}px (setext ${measured.visibleGap}px vs ATX ${atxGap}px)`,
        );
      }

      // Caret inside the level one title: the underline comes back, the face stays.
      await page.evaluate(() => window.__testEditor.scrollToPosition(3));
      await sleep(80);
      const setextCaret = await page.evaluate(collectSetext);
      assert.equal(setextCaret.h1.underlineText, '===', 'a setext underline must return while the caret is in its heading');
      assert.ok(
        setextCaret.h1.className.split(/\s+/).includes('cm-live-heading'),
        `the heading face must stay while the title is edited (class ${setextCaret.h1.className})`,
      );
      assert.equal(setextCaret.h2.underlineText, '', 'a heading without the caret keeps its underline hidden');
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
