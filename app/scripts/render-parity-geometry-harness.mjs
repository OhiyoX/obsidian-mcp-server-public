// Playwright-driving helpers for the Phase 1-B shared geometry gate.
//
// Both the standalone gate (`render-parity-phase1-geometry.mjs`) and the
// in-suite Chromium check (`web-regression/render-geometry-parity.mjs`) import
// these, so the probing/theme-switching logic cannot drift between them. The
// DOM-side collector stays in `render-parity-geometry-probe.mjs`; this module
// only drives the page.

import {
  ADJACENCIES,
  GEOMETRY_TOKENS,
  TABLES,
} from "./render-parity-geometry-core.mjs";
import { collectGeometry } from "./render-parity-geometry-probe.mjs";

/** Point the production theme endpoint at `name` and settle one frame. */
export async function setThemeLink(page, base, name, sleep) {
  await page.evaluate(async ({ href }) => {
    const link = document.querySelector("#community-theme");
    if (!link) throw new Error("community theme link is missing");
    await new Promise((resolve, reject) => {
      link.onload = () => resolve();
      link.onerror = () => reject(new Error(`theme failed to load: ${href}`));
      link.disabled = false;
      link.href = href;
    });
  }, { href: `${base}/api/web/v1/theme.css?name=${encodeURIComponent(name)}` });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (sleep) await sleep(60);
}

/** Measure exactly one host. The inactive host is display:none, so never probe both. */
export async function probeSurface(page, surface) {
  return page.evaluate(collectGeometry, { surface, adjs: ADJACENCIES, tables: TABLES, tokens: GEOMETRY_TOKENS });
}

/** Bring a source position into the Live rendered viewport and settle a frame. */
async function revealLiveAnchor(page, needle) {
  await page.evaluate((value) => {
    const editor = window.__testEditor;
    const view = editor?._view;
    if (!view) return;
    const index = view.state.doc.toString().indexOf(value);
    if (index < 0) return;
    editor.scrollToPosition?.(index);
    view.requestMeasure?.();
  }, needle);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

const LIVE_ANCHORS = [
  ...ADJACENCIES.map((adj) => ({ kind: "gap", id: adj.id, needle: adj.liveHeading.needle })),
  ...TABLES.map((table) => ({ kind: "table", id: table.id, needle: table.needle })),
];

/**
 * CodeMirror only renders the lines inside its viewport, so a single Live probe
 * of a long document cannot see every measured pair. Scroll each anchor into the
 * rendered range and merge the entries; a settled measurement is independent of
 * scroll position. Table widgets mount only while their range is rendered, so
 * table anchors retry until the widget exists.
 */
export async function probeLiveSettled(page, sleep) {
  const merged = { surface: "live", gaps: {}, tables: {}, tokens: {} };
  for (const anchor of LIVE_ANCHORS) {
    const attempts = anchor.kind === "table" ? 8 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await revealLiveAnchor(page, anchor.needle);
      if (sleep) await sleep(anchor.kind === "table" ? 100 : 40);
      const snapshot = await probeSurface(page, "live");
      if (!Object.keys(merged.tokens).length) merged.tokens = snapshot.tokens;
      const entry = anchor.kind === "gap" ? snapshot.gaps[anchor.id] : snapshot.tables[anchor.id];
      if (entry?.found || !(anchor.kind === "gap" ? merged.gaps[anchor.id] : merged.tables[anchor.id])) {
        if (anchor.kind === "gap") merged.gaps[anchor.id] = entry;
        else merged.tables[anchor.id] = entry;
      }
      if (entry?.found) break;
    }
  }
  return merged;
}

/** One settled measurement for either host (Reader renders the whole document). */
export async function probeSurfaceSettled(page, surface, sleep) {
  return surface === "reader" ? probeSurface(page, "reader") : probeLiveSettled(page, sleep);
}

/** Wait until Reader has laid out every probe table (data-table-overflow set). */
export async function ensureReaderTables(page, sleep, expected = TABLES.length) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const ready = await page.evaluate(() => {
      const wrappers = [...document.querySelectorAll("#preview .table-scroll")];
      return wrappers.filter((w) => w.dataset.tableOverflow != null).length;
    });
    if (ready >= expected) return ready;
    if (sleep) await sleep(120);
  }
  return page.evaluate(() => document.querySelectorAll("#preview .table-scroll").length);
}

/**
 * Table Surface v2 mounts a table widget only while its character range is
 * inside the rendered viewport. Walk document positions until both probe tables
 * have mounted (bounded), then stop so the measurement is taken from a settled
 * view.
 */
export async function ensureLiveTables(page, sleep, expected = TABLES.length) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const mounted = await page.evaluate(() => document.querySelectorAll(".cm-table-widget").length);
    if (mounted >= expected) return mounted;
    await page.evaluate((index) => {
      const view = window.__testEditor?._view;
      if (!view) return;
      const total = view.state.doc.lines;
      const line = Math.max(1, Math.min(total, Math.round((total * (index + 1)) / 13)));
      const pos = view.state.doc.line(line).from;
      window.__testEditor.scrollToPosition?.(pos);
      view.dispatch({ selection: { anchor: pos } });
      view.requestMeasure?.();
    }, attempt);
    if (sleep) await sleep(120);
  }
  return page.evaluate(() => document.querySelectorAll(".cm-table-widget").length);
}
