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
