// Mid-word break contract for the Admin layout browser gate (#401 / #403 / #405, RETURN-2).
//
// **Migrated 2026-10-18 (lane w5-gates).** The previous revision scoped the scan to the deleted
// Admin UI v2 vocabulary (`code.keep`, `.col-cred`, `.cred-name`, `td.col-actions`,
// `.badge[title]`, `.col-tool`, `.label-keep`). The Admin plane was rebuilt on the prototype
// stylesheet, whose unbreakable contexts are `.tbl` cells and their contents: `th` and `.cellt` /
// `.nm b` / `.nm .sub2` / `.idc` / `.tag` all declare `white-space:nowrap` (plus
// `overflow:hidden; text-overflow:ellipsis`), so a long token is clipped to one line by
// declaration, not by font luck. The *criterion* is unchanged and still the load-bearing one:
//   * a declared-keep token must render on exactly one line, and the declaration must still be
//     there (a matched context that lost `white-space:nowrap` is itself a violation);
//   * a human label may wrap (that is legal), and so may a token in a context that declares
//     `word-break:keep-all` (a hyphen is a legal break point), but both are recorded as a trace
//     and never asserted - the RETURN-2 lesson (a criterion two machines can disagree about is
//     not a criterion);
//   * the scan must have matched real cells, and the synthetic worst-case token must be injected
//     into a real declared-keep cell, so "no violations" cannot mean "nothing scanned".
//
// **Measurement corrected 2026-10-19 (lane w5-gates-fix).** Two measurement defects were making
// that criterion report things that are not line breaks, and the semantics above are untouched:
//
//   1. *One line counted as two.* Chromium reports a line that `text-overflow:ellipsis` truncated as
//      **two** range rects - the untruncated run and the clipped run - in the same vertical band
//      (`td.cellt.mono` with a long token: rects `[x,y,376,20]` and `[x,y,205,20]`). A line is now
//      a **band** (rects whose top *and* bottom agree within a pixel are one line), which is also
//      why an `inline-flex` chip could never have been counted per rect.
//   2. *Not-rendered subtrees were measured.* The plane ships its row-detail box (`td.act .uax`,
//      `word-break:break-all`, full of `.mono` tokens) inside a closed `<details>`, so the tokens
//      are in the DOM but the browser is not rendering them - and their geometry is degenerate
//      (an 11-character token measured as **10** stacked lines, inside a 14px-wide box). The
//      prototype builds the same box only once the row is opened, so measuring it on one side
//      compared a rendered tree with an unrendered one. `checkVisibility()` now gates every
//      measurement; hidden content is skipped on both sides instead of being counted on one.
//
// `assertMidwordParity` then requires the two sides to agree on the same synthetic token in the
// same cell: the classes that break must be the *same* classes, or the verdict is not about the
// documents. Both trees are measured with this one module, so the comparison is symmetric by
// construction - the lesson of the two defects above.
import assert from 'node:assert/strict';

import { KEEP_CONTRACT_SELECTOR } from '../proto-parity/spec.mjs';

export { KEEP_CONTRACT_SELECTOR };

/** A 60-character, whitespace-free label: long enough to wrap if the CSS allows it to. */
export const PROBE_LABEL = `gate-policy-probe-${'segment-'.repeat(6)}`.slice(0, 60);

/** Long enough to overflow any column: the worst case for `table-layout:fixed` + nowrap. */
export const WORST_CASE_TOKEN = 'mcp.tool.write_note_and_a_very_long_tool_name_indeed';

/** The scan must match at least this many declared-keep tokens per page, or "clean" is meaningless. */
export const MIN_KEEP_CONTRACTS = 3;

/** Two rects within this many pixels vertically are the same line box. */
export const LINE_TOLERANCE_PX = 1;

/**
 * The shared in-page measurement primitives, injected into every probe below. A line is a vertical
 * **band**, and nothing the browser is not rendering is measured.
 *
 * Exported as source so the unit test can run the *same* lines of code against recorded rect data
 * (the two rects Chromium produces for one ellipsis-truncated line, and two rects that really are
 * two lines) instead of asserting a copy of the rule.
 */
export const LINE_MEASUREMENT_SOURCE = `
  const LINE_TOLERANCE_PX = ${LINE_TOLERANCE_PX};
  const lineBoxes = (node) => {
    const bands = [];
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width <= 0.5 || rect.height <= 0.5) continue;
      if (bands.some((band) => Math.abs(band.top - rect.top) < LINE_TOLERANCE_PX && Math.abs(band.bottom - rect.bottom) < LINE_TOLERANCE_PX)) continue;
      bands.push({ top: rect.top, bottom: rect.bottom });
    }
    return bands.length;
  };
  const rendered = (element) => (typeof element.checkVisibility === 'function'
    ? element.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true })
    : element.getClientRects().length > 0);
`;

const SCAN_SOURCE = `
  ${LINE_MEASUREMENT_SOURCE}
  function scanMidword() {
    const CONTRACT = ${JSON.stringify(KEEP_CONTRACT_SELECTOR)};
    const violations = [];
    const traces = [];
    let contracts = 0;
    let skipped = 0;
    const tables = [...document.querySelectorAll('.tbl')];
    for (const table of tables) {
      const walker = document.createTreeWalker(table, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const token = (node.textContent || '').trim();
        if (token.length < 4 || /\\s/.test(token)) continue;
        if (!/[A-Za-z0-9]/.test(token)) continue;
        const el = node.parentElement;
        if (!el) continue;
        // Closed <details> / content-visibility:hidden: in the DOM, not rendered, degenerate
        // geometry. Nothing to judge, and the prototype does not build its equivalent at all.
        if (!rendered(el)) { skipped += 1; continue; }
        const contract = el.closest(CONTRACT);
        const style = getComputedStyle(el);
        const declaration = style.whiteSpace === 'nowrap' || style.whiteSpace === 'pre'
          || (style.wordBreak === 'keep-all' && style.overflowWrap === 'normal');
        const nowrap = style.whiteSpace === 'nowrap' || style.whiteSpace === 'pre';
        const lines = lineBoxes(node);
        const cell = el.closest('td, th');
        const classes = String(el.className || '').trim().split(/\\s+/).filter(Boolean);
        const record = {
          token: token.slice(0, 60), lines,
          cell: cell ? [...cell.classList].join('.') || cell.tagName : '?',
          element: el.tagName.toLowerCase() + (classes.length ? '.' + classes.join('.') : ''),
          context: contract ? 'declared-keep' : 'human-label',
        };
        if (!contract) { if (lines > 1) traces.push({ ...record, kind: 'human-label' }); continue; }
        contracts += 1;
        if (!declaration) { violations.push({ ...record, kind: 'declaration-missing' }); continue; }
        if (lines <= 1) continue;
        if (!nowrap && token.includes('-')) { traces.push({ ...record, kind: 'semantic-hyphen' }); continue; }
        violations.push({ ...record, kind: 'mid-word-break' });
      }
    }
    return { violations, traces, contracts, skipped, tables: tables.length };
  }
`;

/** Page-wide scan over every `.tbl` on the page. */
export const MIDWORD = `(() => {${SCAN_SOURCE} return scanMidword();})()`;

/**
 * Synthetic worst case: clone a real row, put {@link WORST_CASE_TOKEN} into every declared-keep
 * cell and read the line count of each. `{ found, injected, results }`.
 *
 * The injected target is the first **rendered** `.cellt` / `.nm b` / `.nm .sub2` / `.idc` / `.mono`
 * in the cell (the cell itself when it has none): injecting into a closed detail box measured
 * content nobody can see and made the plane's row-detail markup look like a broken column.
 */
export const WORST_CASE_PROBE = `(() => {${LINE_MEASUREMENT_SOURCE}
  const token = ${JSON.stringify(WORST_CASE_TOKEN)};
  const row = document.querySelector('.tbl tbody tr');
  if (!row) return { found: false, injected: 0, results: [] };
  const targetOf = (cell) => [...cell.querySelectorAll('.cellt, .nm b, .nm .sub2, .idc, .mono')].find(rendered) || cell;
  const clone = row.cloneNode(true);
  let injected = 0;
  const results = [];
  for (const cell of clone.querySelectorAll('td')) {
    const target = targetOf(cell);
    target.textContent = token;
    injected += 1;
  }
  row.parentElement.appendChild(clone);
  for (const cell of clone.querySelectorAll('td')) {
    const target = targetOf(cell);
    const style = getComputedStyle(target);
    results.push({
      cell: [...cell.classList].join('.') || '(none)',
      target: target.tagName.toLowerCase() + (String(target.className || '').trim() ? '.' + String(target.className).trim().split(/\\s+/).join('.') : ''),
      targetIsCell: target === cell,
      lines: rendered(target) ? lineBoxes(target) : 0,
      rendered: rendered(target),
      whiteSpace: style.whiteSpace,
      cellWidth: Math.round(cell.getBoundingClientRect().width),
    });
  }
  clone.remove();
  return { found: true, injected, results };
})()`;

/** Assert one scan: no declared-keep context broke, and the scan really matched cells. */
export function assertMidwordScan(scan, where, minContracts = MIN_KEEP_CONTRACTS) {
  assert.deepEqual(scan.violations, [], `${where}: declared-keep 上下文里出现断词/丢声明：${JSON.stringify(scan.violations)}`);
  assert.ok(scan.contracts >= minContracts, `${where}: declared-keep 命中 ${scan.contracts} 个 token，少于 ${minContracts} 个，扫描面过小（"没违规" 不能等于 "没扫到"）`);
}

/** The key one synthetic cell is known by on both trees: its cell classes plus its target classes. */
export const worstCaseKey = (item) => `${item.cell}|${item.target}`;

/**
 * The two-sided requirement, as a pure function: the same token injected into the same cell class
 * must get the same verdict on the prototype and on the implementation. Only cells the two sides
 * share are comparable; one-sided entries are returned separately as `only` (evidence, not a
 * failure) so a page whose rows differ in shape is visible instead of silent.
 *
 * Returns `{ disagreements, only }`, each a list of printable lines.
 */
export function worstCaseParity(protoWorst, liveWorst) {
  const index = (worst) => new Map((worst?.results ?? []).map((item) => [worstCaseKey(item), item]));
  const proto = index(protoWorst);
  const live = index(liveWorst);
  const disagreements = [];
  const only = [];
  for (const [key, item] of proto) {
    const other = live.get(key);
    if (!other) { only.push(`[原型独有] ${key} lines=${item.lines} width=${item.cellWidth}`); continue; }
    const left = item.lines > 1 ? '断行' : '一行';
    const right = other.lines > 1 ? '断行' : '一行';
    if (left !== right) {
      disagreements.push(`${key}：同一 token 两侧判定不一致 — 原型 ${left}（lines=${item.lines}, white-space:${item.whiteSpace}, 列宽 ${item.cellWidth}）×  实现 ${right}（lines=${other.lines}, white-space:${other.whiteSpace}, 列宽 ${other.cellWidth}）`);
    }
  }
  for (const [key, item] of live) {
    if (!proto.has(key)) only.push(`[实现独有] ${key} lines=${item.lines} width=${item.cellWidth}`);
  }
  return { disagreements, only };
}

/**
 * One side of the scan: the natural page content and the synthetic worst case, on one tree.
 * `go` loads that tree's page for `url` (the live route or the prototype hash route).
 */
async function measureSide({ page, go, url, side, entry, tracePhase }) {
  await go(url);
  const scan = await page.evaluate(MIDWORD);
  const worst = await page.evaluate(WORST_CASE_PROBE);
  tracePhase(`midword-${entry.id}-${side}`, scan);
  tracePhase(`worst-case-${entry.id}-${side}`, worst);
  return { scan, worst };
}

/**
 * Register the migrated mid-word checks. `goto` loads a live Admin URL on the scene's logged-in
 * page; `gotoProto` loads one prototype hash route; `tablePages` is the list of `{ id, live, proto }`
 * entries the gate knows about.
 */
export async function registerMidwordChecks(ctx, { page, goto, gotoProto, tracePhase, tablePages }) {
  await ctx.check('admin-layout #401/#403/#458（迁移）: .tbl 里声明为不换行的 token 不断词，合成最坏情况行仍是一行', async () => {
    const problems = [];
    let scannedPages = 0;
    for (const entry of tablePages) {
      const { scan, worst } = await measureSide({ page, go: goto, url: entry.live, side: 'live', entry, tracePhase });
      if (scan.tables === 0) continue; // the structure gate owns "the table is missing"
      scannedPages += 1;
      try {
        assertMidwordScan(scan, `${entry.id} 的 .tbl`);
      } catch (error) {
        problems.push(`[${entry.id}] ${error.message}`);
      }
      if (!worst.found) problems.push(`[${entry.id}] 表格没有数据行，无法注入最坏情况 token`);
      else {
        const broken = worst.results.filter((item) => item.lines > 1);
        if (broken.length) problems.push(`[${entry.id}] 合成最坏情况行有 ${broken.length} 个单元格断了行：${JSON.stringify(broken)}`);
      }
    }
    if (scannedPages === 0) problems.push('没有任何页面渲染了可扫描的 .tbl（占位页面无法满足断词判据）');
    assert.equal(problems.length, 0, `${problems.length} 条断词差异：\n${problems.join('\n')}`);
  });

  // Two-sided: the same measurement, the same token, the prototype and the plane. Without this a
  // violation can always be blamed on the other tree — which is exactly how the ellipsis/hidden-box
  // measurement defects survived the previous revision.
  await ctx.check('admin-layout #401/#403/#458（迁移）: 原型与实现同一 token 的断词判定一致（两侧同测）', async () => {
    const problems = [];
    const notes = [];
    let comparedCells = 0;
    for (const entry of tablePages) {
      const proto = await measureSide({ page, go: gotoProto, url: entry.proto, side: 'proto', entry, tracePhase });
      const live = await measureSide({ page, go: goto, url: entry.live, side: 'live', entry, tracePhase });
      for (const [side, label] of [[proto, '原型'], [live, '实现']]) {
        if (side.scan.tables === 0) continue;
        try {
          assertMidwordScan(side.scan, `${entry.id} 的 .tbl（${label}）`);
        } catch (error) {
          problems.push(`[${entry.id}] ${error.message}`);
        }
        if (!side.worst.found) continue; // the live-side check above already owns "no rows"
        const broken = side.worst.results.filter((item) => item.lines > 1);
        if (broken.length) problems.push(`[${entry.id}/${label}] 合成最坏情况行在${label}侧断了行：${JSON.stringify(broken)}`);
      }
      const parity = worstCaseParity(proto.worst, live.worst);
      problems.push(...parity.disagreements.map((line) => `[${entry.id}] ${line}`));
      comparedCells += Math.min(proto.worst.results.length, live.worst.results.length);
      notes.push(`[${entry.id}] 两侧同 token 对照 ${Math.min(proto.worst.results.length, live.worst.results.length)} 个单元格（原型 ${proto.worst.results.length} / 实现 ${live.worst.results.length}）；单侧独有 ${parity.only.length} 项：${parity.only.join(' ')}`);
    }
    if (comparedCells === 0) problems.push('没有任何页面在两侧都有可对照的单元格，"两侧一致" 无法证明');
    assert.equal(problems.length, 0, `${problems.length} 条两侧差异：\n${problems.join('\n')}`);
    for (const note of notes) tracePhase('midword-parity', { note });
  });
}
