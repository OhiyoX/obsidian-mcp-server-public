// Prototype-parity — the **shape** gate's capture, judgment and negative controls.
//
// `shape.mjs` owns the probe and the comparison (the part that must be identical on both trees);
// this module owns the scene: it captures every state on the prototype and on this tree's plane,
// judges them, writes the evidence and proves its own discrimination. Registered into the Admin
// layout gate by `web-regression/admin-layout.mjs`.
//
// Six registered checks:
//   1. 形状一致      every state: the same normalized DOM skeleton + the same structural copy + the
//                    same record-detail entry points + the same search-box contract (the waivers are
//                    printed, line by line)
//   2. 豁免卫生      no wildcard, a real reason, a known kind, a budget, no two entries for the same
//                    (state, line, side), a `count` that matches the occurrences, `catalog` only on
//                    the catalogue region, `data` never on a region container
//   3. 负控 A         mutating the LIVE dom must turn the shape check red (region / class name / page
//                    bar / h2 copy / p.help / .btn href / switch checkbox / record region removal);
//                    the Q4 boundary (a swap INSIDE a record row is a data note) is asserted too
//   4. 负控 B         mutating the PROTOTYPE dom or its copy must turn it red (the prototype is read
//                    live, not compared against a golden copy)
//   5. 负控 C         abusing the waiver table must be rejected (wildcards, wrong kinds, a `data`
//                    waiver on a region, duplicates, a `count` mismatch, a stale entry, a `catalog`
//                    waiver off the catalogue) and an injected region must stay red under the real
//                    waiver table
//   6. 状态覆盖 + 抽屉棘轮   every state really rendered both sides (no silent skip), the drawers
//                    exist, their difference count may only go DOWN (ratchet), and their record
//                    entry points are asserted
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SHAPE_STATES, canonicalizeShape, compareShapeLabels, compareShapeLinks, compareShapeSearchBoxes, compareShapeState, probeShapeTree } from './shape.mjs';
import { SHAPE_LABEL_WAIVERS, SHAPE_LABEL_WAIVER_BUDGET, SHAPE_WAIVERS, SHAPE_WAIVER_BUDGET, SHAPE_WAIVER_KINDS, waiverFindings } from './shape-waivers.mjs';
import { runProbe } from './probe.mjs';
import { protoUrl } from './gate.mjs';
import { seedParityFixture } from './seed.mjs';

/**
 * Drawer states: pages whose row opens a real detail drawer in BOTH trees.
 *
 * **Scope note (Wave P, ratchet added in Wave Q).** The page states are asserted; the drawers are
 * captured and their difference count is reported and **capped** (`SHAPE_DRAWER_DIFF_CAP`): the
 * number may only go down. Reason for not asserting them line by line yet: the drawer's `?id=`
 * surface carries its own control vocabulary (nested POST forms, `<details>` disclosures, the `.kv`
 * field inventory) that `gate.mjs` already compares field by field, and normalising it to the same
 * skeleton is a second increment of the same work — it must be done with its own negative controls
 * rather than by widening the waiver table. What IS asserted for the drawers: they all render on
 * both sides, and their record/detail entry-point inventory (`compareShapeLinks`) matches. The
 * ratchet is deliberately not `> 0`: a wave that cleans the drawer up must be able to land
 * (tightening the cap in the same commit), it must not turn the gate red for being better.
 */
export const SHAPE_DRAWER_PAGES = Object.freeze(['accounts', 'keys', 'clients', 'vaults']);
export const SHAPE_DRAWER_ASSERTED = false;
/**
 * Drawer ratchet, measured as a SET OF STRUCTURAL SIGNATURES instead of a difference COUNT (Wave R).
 *
 * Why it changed: the Wave Q cap (`差异数 ≤ 136`) had **zero margin** and was DATA-DEPENDENT — the
 * same tree measured 136, 137 or 150 depending on how many records the fixture happened to hold, so
 * the number described the fixture, not the layout. A count is also blind in the other direction: two
 * hundred repetitions of one already-known difference cost nothing to notice, while a brand-new kind
 * of drift hiding behind a removed one keeps the total flat.
 *
 * What is frozen instead: the set of DISTINCT structural signatures the drawer comparison produces.
 * A signature is the failure's canonical line with the data part masked — the state prefix, record
 * ids/uuids, numbers and the value after `=` in a copy line (`Alice Chen` vs `layout-gate` is fixture
 * data, not layout). Consequences, stated so nobody over-reads it:
 *   * the check is data-independent: adding/removing records cannot change it;
 *   * a NEW kind of drift — even one line — is red (that is the tightening);
 *   * one known signature may still occur many times (that is the price: how many records carry the
 *     same drift is data, and the drawers are `SHAPE_DRAWER_ASSERTED === false`, i.e. reported not
 *     compared line by line);
 *   * a wave that cleans a drawer up prunes the signature in the same commit (subset, never equality:
 *     improving must not turn the gate red).
 */
export const SHAPE_DRAWER_SIGNATURE_BASELINE = Object.freeze([
  "原型有、实现没有：btn.btn.primary :: T",
  "原型有、实现没有：div :: -",
  "原型有、实现没有：div.fld :: -",
  "原型有、实现没有：div.grid# :: -",
  "原型有、实现没有：div.grow.pw :: -",
  "原型有、实现没有：form.dsec :: -",
  "原型有、实现没有：h#.ell :: T",
  "原型有、实现没有：ibtn [open=no] :: -",
  "原型有、实现没有：input [checked type=checkbox] :: -",
  "原型有、实现没有：input.inp [placeholder type=password] :: -",
  "原型有、实现没有：input.inp [type=number] :: -",
  "原型有、实现没有：input.inp.mono :: -",
  "原型有、实现没有：label :: T",
  "原型有、实现没有：label.chk :: -",
  "原型有、实现没有：small :: T",
  "原型有、实现没有：span :: T",
  "原型有、实现没有：span.d :: T",
  "原型有、实现没有：span.ell.sub :: T",
  "原型有、实现没有：span.help :: T",
  "原型有、实现没有：span.muted :: T",
  "原型有、实现没有：span.sub :: T",
  "原型有、实现没有：span.tag :: T",
  "原型有、实现没有：↻ div :: T { div.muted :: T span.mono :: N }",
  "原型有、实现没有：↻ div.futonly.k :: T { }",
  "原型有、实现没有：↻ div.mono :: T { div.help :: T }",
  "原型有、实现没有：↻ tr.row.cur :: - { div.nm :: - rowmenu :: - span.muted :: T span.ok.st :: T td :: - td.act :: - td.cellt :: T td.cellt.mono :: T }",
  "实现有、原型没有：b :: T",
  "实现有、原型没有：btn.btn :: T",
  "实现有、原型没有：btn.btn.primary :: T",
  "实现有、原型没有：div :: -",
  "实现有、原型没有：div.dsec :: -",
  "实现有、原型没有：div.fld :: -",
  "实现有、原型没有：div.grid# :: -",
  "实现有、原型没有：div.help :: T",
  "实现有、原型没有：form :: -",
  "实现有、原型没有：h# :: T",
  "实现有、原型没有：input.grow.inp [placeholder type=password] :: -",
  "实现有、原型没有：input.inp [type=number] :: -",
  "实现有、原型没有：input.inp.mono :: -",
  "实现有、原型没有：label :: T",
  "实现有、原型没有：small :: T",
  "实现有、原型没有：span :: -",
  "实现有、原型没有：span.cnt :: T",
  "实现有、原型没有：span.ell.sub :: T",
  "实现有、原型没有：span.help :: T",
  "实现有、原型没有：span.muted :: T",
  "实现有、原型没有：↻ div :: T { div.muted :: - span.mono :: N }",
  "实现有、原型没有：↻ div :: T { }",
  "结构位置的文案只在原型里：.bar h# = <v>",
  "结构位置的文案只在实现里：.bar h# = <v>",
  "结构位置的文案只在实现里：disclosure trigger = <v>",
  // 2026-10-22: the Vault 与 Git page bar carries one declared bootstrap control (`初始化准入` → the
  // `?confirm=admission` state; see `SHAPE_WAIVERS` for the `vaults` / `btn.btn` entry). The drawer
  // capture renders the whole page, so its label appears here too. Signatures only — the drawer's own
  // section inventory is compared exactly in `compareDrawer` and is unchanged.
  "结构位置的文案只在实现里：.btn = <v>",
  "实现有、原型没有：span.hide-m :: T",
]);

/** Mask everything a fixture decides (ids, counts, names) out of a drawer difference line. */
export function drawerSignature(line) {
  return String(line ?? '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/= .*$/, '= <v>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<v>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

const VIEWPORT = { width: 1440, height: 900 };

/**
 * R2 (Wave R): the shape scene's own prerequisite list, as a pure function so it can be judged in a
 * negative control as well as in the check. A page whose prototype renders a record region (`tbody`)
 * while the plane renders none is a seeding failure — the gate used to compare empty pages and report
 * the result as shape drift (3 of 7 checks green, ~150 "differences"). A drawer page with no record
 * entry point on either side is the same class of problem.
 */
export function prerequisiteFindings({ trace, seedErrors = [], drawerPages = SHAPE_DRAWER_PAGES }) {
  const problems = seedErrors.map((error) => `[seed] ${error}`);
  for (const state of SHAPE_STATES) {
    const entry = trace?.states?.[state.id];
    if (!entry?.proto?.probe || !entry?.live?.probe) continue;
    const hasRows = (probe) => (probe.nodes || []).some((node) => /^tbody\b/.test(node.sig));
    const protoRows = hasRows(entry.proto.probe);
    const liveRows = hasRows(entry.live.probe);
    if (protoRows && !liveRows) problems.push(`[${state.id}] 原型渲染了记录区（tbody），实现没有：fixture 未播种或播种失败`);
    if (!protoRows && liveRows) problems.push(`[${state.id}] 实现渲染了记录区，原型没有：原型的 fixture 没有加载`);
  }
  for (const page of drawerPages) {
    const drawer = trace?.drawers?.[page];
    if (!drawer?.protoCount) problems.push(`[${page}] 原型列表没有可配对的记录行`);
    if (!drawer?.liveCount) problems.push(`[${page}] 实现列表没有记录行（前置数据缺失：播种必须先成功）`);
  }
  return problems;
}

/**
 * R4 (Wave R): the drawer ratchet as a pure function — a signature outside the frozen baseline is
 * new drift, however few records carry it, while the NUMBER of difference lines is not compared at
 * all (it moved with the fixture: 136 / 137 / 150 for the same tree).
 */
export function ratchetFindings(signatures, baseline = SHAPE_DRAWER_SIGNATURE_BASELINE) {
  return signatures.filter((signature) => !baseline.includes(signature));
}

const liveRecordUrl = (page, id) => (page === 'vaults'
  ? `/admin/auth/vault-git?id=${encodeURIComponent(id)}`
  : `/admin/auth?tab=${page}&id=${encodeURIComponent(id)}`);
const protoRecordUrl = (page, id) => `#/${page}/${encodeURIComponent(id)}`;

async function captureShape(page, url) {
  try {
    const response = await page.goto(url, { waitUntil: 'load' });
    await page.evaluate('document.fonts ? document.fonts.ready : true');
    await page.waitForTimeout(60);
    return { url, status: response ? response.status() : null, probe: await runProbe(page, probeShapeTree) };
  } catch (error) {
    return { url, status: null, error: String(error?.message || error).split('\n')[0] };
  }
}

/** Capture every state on both trees (pages, record drawers, login). */
export async function captureShapeAll({ browser, repoRoot, base, password, onState = null }) {
  const protoContext = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'dark' });
  const liveContext = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'dark' });
  const anonContext = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'dark' });
  const protoPage = await protoContext.newPage();
  const livePage = await liveContext.newPage();
  const anonPage = await anonContext.newPage();
  const trace = { base, at: new Date().toISOString(), states: {}, drawers: {} };
  try {
    const login = await liveContext.request.post(`${base}/admin/auth/login`, { form: { password }, maxRedirects: 0 });
    assert.equal(login.status(), 303, `shape gate login must succeed, got ${login.status()}`);
    for (const state of SHAPE_STATES) {
      const protoTarget = state.anonymous ? anonPage : protoPage;
      const liveTarget = state.anonymous ? anonPage : livePage;
      const entry = {
        proto: await captureShape(protoTarget, protoUrl(repoRoot, state.proto)),
        live: await captureShape(liveTarget, `${base}${state.live}`),
      };
      trace.states[state.id] = entry;
      if (onState) await onState(state, entry);
    }
    for (const page of SHAPE_DRAWER_PAGES) {
      const list = trace.states[page];
      const protoRecords = (list?.proto?.probe?.records || []).filter((item) => item.page === page);
      const liveRecords = (list?.live?.probe?.records || []).filter((item) => item.page === page);
      trace.drawers[page] = { protoCount: protoRecords.length, liveCount: liveRecords.length };
      if (!protoRecords.length || !liveRecords.length) continue;
      const state = { id: `${page}-drawer`, anonymous: false };
      const entry = {
        proto: await captureShape(protoPage, protoUrl(repoRoot, protoRecordUrl(page, protoRecords[0].id))),
        live: await captureShape(livePage, `${base}${liveRecordUrl(page, liveRecords[0].id)}`),
      };
      trace.states[state.id] = entry;
      if (onState) await onState(state, entry);
    }
    return trace;
  } finally {
    await protoContext.close().catch(() => {});
    await liveContext.close().catch(() => {});
    await anonContext.close().catch(() => {});
  }
}

/** Waiver hygiene for the label table (same contract as `waiverFindings`). */
export function labelWaiverFindings(waivers, budget = SHAPE_LABEL_WAIVER_BUDGET) {
  const failures = [];
  if (waivers.length > budget) failures.push(`文案豁免 ${waivers.length} 条超过预算 ${budget} 条`);
  const seen = new Set();
  for (const waiver of waivers) {
    const label = `${waiver.state}: ${JSON.stringify(waiver.label)}`;
    if (!waiver.state) failures.push(`${label} 没有 state`);
    if (!waiver.reason || String(waiver.reason).length < 24) failures.push(`${label} 的 reason 太短（≥24 字）`);
    if (!SHAPE_WAIVER_KINDS.includes(waiver.kind)) failures.push(`${label} 的 kind=${JSON.stringify(waiver.kind)} 不在允许集合内`);
    if (/[*?]|TODO/.test(String(waiver.label ?? ''))) failures.push(`${label} 含通配符：文案豁免只允许精确匹配`);
    if (waiver.kind === 'no-js-submit' && !/^\.btn = /.test(String(waiver.label))) failures.push(`${label} 声明 no-js-submit 但目标不是一行 .btn 文案`);
    if (['state', 'data'].includes(waiver.kind) && !/^(\.btn|\.cap-h) = /.test(String(waiver.label))) {
      failures.push(`${label} 的 kind 只能用于无脚本提交按钮（.btn）或目录分组标题（.cap-h）：其它文案要写明是有意保留的额外控件（deliberate）`);
    }
    const key = `${waiver.state}||${waiver.label}`;
    if (seen.has(key)) failures.push(`${label} 重复文案豁免：同一 (state, label) 声明了两次，会互相遮蔽失效检测`);
    seen.add(key);
  }
  return failures;
}

/**
 * Judge one capture: every state's shape lines, structural copy and record-link inventory. Returns
 * the failures (assertion material), the data notes (never failures: row counts and "the same element
 * carries a different kind of datum"), and the waivers that were actually used (stale ones fail).
 */
export function compareShapeCapture(trace, { waivers = SHAPE_WAIVERS, labelWaivers = SHAPE_LABEL_WAIVERS, onReport = null, filter = null } = {}) {
  const failures = [];
  const notes = [];
  const waived = [];
  const waivedLabels = [];
  const evidence = {};
  for (const [stateId, entry] of Object.entries(trace.states)) {
    if (filter && !filter(stateId, entry)) continue;
    if (!entry.proto?.probe) { failures.push(`[${stateId}] 原型状态无法读取（${entry.proto?.url || 'no url'}）：${entry.proto?.error || 'no probe'}`); continue; }
    if (!entry.live?.probe) { failures.push(`[${stateId}] 实现状态无法读取（${entry.live?.url || 'no url'}）：${entry.live?.error || `status ${entry.live?.status}`}`); continue; }
    if (entry.live.status !== null && entry.live.status >= 400) failures.push(`[${stateId}] ${entry.live.url} 返回 ${entry.live.status}`);
    const shape = compareShapeState({ stateId, proto: entry.proto.probe, live: entry.live.probe, waivers });
    const labels = compareShapeLabels({ stateId, proto: entry.proto.probe, live: entry.live.probe, waivers: labelWaivers });
    const links = compareShapeLinks({ stateId, proto: entry.proto.probe, live: entry.live.probe });
    const search = compareShapeSearchBoxes({ stateId, proto: entry.proto.probe, live: entry.live.probe });
    failures.push(...shape.failures, ...labels.failures, ...links.failures, ...search.failures);
    for (const item of entry.live.probe.deadControls || []) failures.push(`[${stateId}] 看起来可点的控件在无脚本时无法操作：${item}`);
    notes.push(...shape.notes, ...links.notes, ...search.notes);
    waived.push(...shape.waived.map((item) => ({ state: stateId, ...item })));
    waivedLabels.push(...labels.waived.map((item) => ({ state: stateId, ...item })));
    evidence[stateId] = {
      protoLines: shape.protoLines.length, liveLines: shape.liveLines.length,
      waivers: shape.waived.length, labelWaivers: labels.waived.length,
      protoLinks: links.protoLinks, liveLinks: links.liveLinks,
      searchBoxes: { proto: search.protoBoxes, live: search.liveBoxes },
      diff: { protoOnly: shape.diff.removed.length, liveOnly: shape.diff.added.length },
    };
    if (onReport) onReport(stateId, shape);
  }
  return { failures, notes, waived, waivedLabels, evidence };
}

/** Register the shape checks. `ctx` is the shared web-regression context (fixture included). */
export async function registerProtoShapeChecks(ctx) {
  const { check, browser, appRoot, root, outputRoot, fixture } = ctx;
  const repoRoot = path.resolve(appRoot, '..');
  // R2 (Wave R) — **the gate seeds itself.** The old gate inherited its fixture from whichever scene
  // ran before it: on a clean fixture (shape scene alone) the live pages rendered their empty states
  // against the prototype's populated mock, which produced ~150 data-driven differences and only 3 of
  // its 7 checks green. `seedParityFixture` is idempotent by condition (see `seed.mjs`), so the gate
  // may call it unconditionally and the prerequisite is now part of the gate instead of the order.
  const seeded = await seedParityFixture({
    base: fixture.base, password: fixture.password, apiKey: fixture.apiKey,
    webUser: 'layout-gate', webPassword: fixture.password,
  });
  const trace = await captureShapeAll({ browser, repoRoot, base: fixture.base, password: fixture.password });
  const base = compareShapeCapture(trace, {
    // Drawer states are captured and reported, but only the page states are asserted (see
    // `SHAPE_DRAWER_ASSERTED`): their failures move to the report's drawer section.
    filter: (stateId) => SHAPE_DRAWER_ASSERTED || !/-drawer$/.test(stateId),
  });
  const drawerOnly = compareShapeCapture(trace, { filter: (stateId) => /-drawer$/.test(stateId) });
  const report = base;
  report.drawerFailures = drawerOnly.failures;
  report.drawerNotes = drawerOnly.notes;
  const hygiene = [...waiverFindings(SHAPE_WAIVERS), ...labelWaiverFindings(SHAPE_LABEL_WAIVERS)];

  /**
   * R2's second half: the report must SAY which differences are data-driven. A difference is data
   * when it names a record region (`↻` runs, `tbody`, a row/card kind) or when this side simply has
   * fewer record entry points than the prototype — both mean "the fixture holds different records",
   * which is exactly what a missing seed looked like. Everything else is structure. The classification
   * never excuses anything: both buckets are still asserted to be empty below.
   */
  const classify = (line) => {
    const stateId = /^\[([^\]]+)\]/.exec(line)?.[1] ?? '';
    const body = line.replace(/^\[[^\]]+\]\s*/, '');
    const entry = trace.states[stateId];
    const protoRecords = (entry?.proto?.probe?.records || []).length;
    const liveRecords = (entry?.live?.probe?.records || []).length;
    const recordish = /↻|\btbody\b|tr\.row|\bmcards\b|\.mc\b|\.pager\b|div\.empty\b/.test(body);
    return recordish || liveRecords < protoRecords ? 'data' : 'struct';
  };
  const structural = report.failures.filter((line) => classify(line) === 'struct');
  const dataDriven = report.failures.filter((line) => classify(line) === 'data');
  report.structural = structural;
  report.dataDriven = dataDriven;
  report.drawerSignatures = [...new Set(report.drawerFailures.map(drawerSignature))].sort();
  const rendered = Object.entries(trace.states).map(([id, entry]) => {
    const proto = canonicalizeShape(entry.proto?.probe?.nodes || []).lines;
    const live = canonicalizeShape(entry.live?.probe?.nodes || []).lines;
    return `## ${id}  (原型 ${entry.proto?.url} ⇄ 实现 ${entry.live?.url})\n### prototype\n${proto.join('\n')}\n### implementation\n${live.join('\n')}`;
  });
  const summary = [
    `# shape-parity report — ${new Date().toISOString()}`,
    `# prototype ${repoRoot}/docs/admin-ui-proto/index.html?dev=1&theme=dark  ⇄  live ${fixture.base}`,
    `# states: ${Object.keys(trace.states).length}（页面 ${SHAPE_STATES.length} + 抽屉 ${Object.keys(trace.drawers).filter((key) => trace.drawers[key].protoCount && trace.drawers[key].liveCount).length}）`,
    `# differences: ${report.failures.length}（结构 ${structural.length} / 数据驱动 ${dataDriven.length}）  |  waivers: ${report.waived.length}  |  label waivers: ${report.waivedLabels.length}  |  data notes: ${report.notes.length}`,
    `# 播种：${seeded.steps.map((step) => `${step.ok ? 'ok' : 'FAIL'} ${step.name}`).join(' | ')}`,
    `# 记录行内部差异（只有集合/取值变化；顺序不比 —— Q4 边界，见 shape.mjs）：${report.notes.filter((line) => line.includes('记录行内的元素集合')).length} 条`,
    `# 抽屉状态（本波只报告不断言）：${report.drawerFailures.length} 条差异 / ${report.drawerSignatures.length} 个结构签名（签名集合必须 ⊆ 冻结基线；条数不参与判定）`,
    '',
    '## differences（结构）',
    ...(structural.length ? structural : ['(none)']),
    '',
    '## differences（数据驱动 —— 记录行/记录区域，或本侧记录入口少于原型）',
    ...(dataDriven.length ? dataDriven : ['(none)']),
    '',
    '## drawer-state differences (captured + reported, not asserted this wave)',
    ...(report.drawerFailures.length ? report.drawerFailures.slice(0, 200) : ['(none)']),
    ...(report.drawerFailures.length > 200 ? [`… 其余 ${report.drawerFailures.length - 200} 条见 proto-shape-report.json`] : []),
    '',
    '## waivers (every one is an explicit, reviewed line)',
    ...(report.waived.length ? report.waived.map((item) => `[${item.state}][${item.kind}][${item.side}] ${item.line.trim()}\n    → ${item.reason}`) : ['(none)']),
    ...report.waivedLabels.map((item) => `[${item.state}][${item.kind}] ${item.label}\n    → ${item.reason}`),
    '',
    '## data notes (line counts, text-kind differences: never failures)',
    ...(report.notes.length ? report.notes : ['(none)']),
    '',
  ].join('\n');
  await fs.mkdir(outputRoot, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(outputRoot, 'proto-shape-report.txt'), summary).catch(() => {});
  await fs.writeFile(path.join(outputRoot, 'proto-shape-report.json'), JSON.stringify({ failures: report.failures, waivers: report.waived, labelWaivers: report.waivedLabels, notes: report.notes, evidence: report.evidence, drawers: trace.drawers, drawerFailures: report.drawerFailures, hygiene }, null, 1)).catch(() => {});
  await fs.writeFile(path.join(outputRoot, 'proto-shape-skeleton.txt'), rendered.join('\n\n')).catch(() => {});

  await check('proto-shape: 与原型逐状态整页 DOM 骨架一致（形状 + 结构文案 + 记录入口；数据差异逐条豁免）', async () => {
    assert.deepEqual(report.failures, [], `${report.failures.length} 条形状差异：\n${report.failures.join('\n')}`);
  });

  await check('proto-shape: 豁免卫生（无通配符 / 有理由 / 类型受限 / 预算内）', async () => {
    assert.deepEqual(hygiene, [], `豁免表不合法：\n${hygiene.join('\n')}`);
    assert.ok(SHAPE_WAIVERS.length <= SHAPE_WAIVER_BUDGET);
    assert.ok(SHAPE_LABEL_WAIVERS.length <= SHAPE_LABEL_WAIVER_BUDGET);
  });

  await check('proto-shape: 状态覆盖（每个状态两侧都真的渲染了，且抽屉状态存在）', async () => {
    const problems = [];
    for (const state of SHAPE_STATES) {
      const entry = trace.states[state.id];
      if (!entry?.proto?.probe) problems.push(`[${state.id}] 原型未渲染（${entry?.proto?.error || entry?.proto?.url}）`);
      if (!entry?.live?.probe) problems.push(`[${state.id}] 实现未渲染（${entry?.live?.error || entry?.live?.url}）`);
      if (entry?.proto?.probe && entry.proto.probe.nodes.length < 10) problems.push(`[${state.id}] 原型骨架只有 ${entry.proto.probe.nodes.length} 个节点，状态可能没加载`);
      if (entry?.live?.probe && entry.live.probe.nodes.length < 10) problems.push(`[${state.id}] 实现骨架只有 ${entry.live.probe.nodes.length} 个节点，状态可能没加载`);
    }
    for (const page of SHAPE_DRAWER_PAGES) {
      const drawer = trace.drawers[page];
      if (!drawer?.protoCount) problems.push(`[${page}] 原型的记录行没有可配对的 id，抽屉状态无法对照`);
      if (!drawer?.liveCount) problems.push(`[${page}] 实现的记录行没有 ?id= 入口，抽屉状态无法对照`);
      const stateId = `${page}-drawer`;
      const entry = trace.states[stateId];
      if (!entry?.proto?.probe) problems.push(`[${stateId}] 原型抽屉未渲染`);
      if (!entry?.live?.probe) problems.push(`[${stateId}] 实现抽屉未渲染`);
      else if (!entry.live.probe.nodes.some((node) => node.sig.startsWith('drawer.on'))) problems.push(`[${stateId}] 实现抽屉状态里没有 .drawer（?id= 页面没打开抽屉）`);
    }
    for (const line of report.drawerFailures) { void line; }
    assert.deepEqual(problems, [], `状态覆盖不足：\n${problems.join('\n')}`);
  });

  await check('proto-shape: 前置数据（门禁自带播种；列表页没有记录就明确红，而不是静默地比对空页）', async () => {
    // R2: the shape scene used to depend on another scene having seeded the fixture. Now it seeds
    // itself (above) and ASSERTS the prerequisite: a list page whose prototype renders records while
    // the plane renders none is a seeding failure and must say so — never a silent 3/7.
    const problems = prerequisiteFindings({ trace, seedErrors: seeded.errors });
    // 反证：同一函数对一份“空实现”痕迹必须报红（否则这条断言只是装饰）。
    const synthetic = { states: { overview: { proto: { probe: { nodes: [{ sig: 'tbody :: -' }] } }, live: { probe: { nodes: [] } } } }, drawers: {} };
    const syntheticFindings = prerequisiteFindings({ trace: synthetic, seedErrors: [], drawerPages: ['accounts'] });
    if (!syntheticFindings.some((line) => line.includes('实现没有'))) {
      problems.push(`反证失败：合成一份“实现没有记录区”的痕迹后，前置判据没有报红（${JSON.stringify(syntheticFindings)}）`);
    }
    assert.deepEqual(problems, [], `前置数据不足：\n${problems.join('\n')}`);
  });

  await check('proto-shape: 抽屉状态棘轮（结构签名集合 ⊆ 冻结基线，且记录入口两侧一致）', async () => {
    // R4 (Wave R): the ratchet is a SET OF STRUCTURAL SIGNATURES, not a difference COUNT. The Wave Q
    // cap (136) had zero margin and moved with the fixture's record count (136 / 137 / 150 for the
    // same tree), so it described the data, not the layout. Signatures mask exactly the data part
    // (ids, counts, the value after `=`); a signature the baseline does not know is red even if it is
    // one line long, and a known signature is free however many records carry it. A drawer that
    // becomes CLEANER stays green (subset, never equality) — turning improvement into red would tax
    // the next wave for fixing drift.
    const captured = SHAPE_DRAWER_PAGES.filter((page) => trace.states[`${page}-drawer`]?.proto?.probe && trace.states[`${page}-drawer`]?.live?.probe);
    assert.equal(captured.length, SHAPE_DRAWER_PAGES.length, `抽屉状态未全部捕获：${captured.join('/')}（共 ${SHAPE_DRAWER_PAGES.length}）`);
    const unknown = ratchetFindings(report.drawerSignatures);
    assert.deepEqual(unknown, [], `抽屉差异出现新的结构签名（冻结基线 ${SHAPE_DRAWER_SIGNATURE_BASELINE.length} 个）：\n${unknown.join('\n')}\n\n实际差异样例：\n${report.drawerFailures.filter((line) => unknown.includes(drawerSignature(line))).slice(0, 20).join('\n')}`);
    // 反证：一个不在基线里的签名必须被报出来（同一函数，不靠“基线为空才红”）。
    const synthetic = ratchetFindings(['这不是基线里的签名 :: T']);
    assert.deepEqual(synthetic, ['这不是基线里的签名 :: T'], '反证失败：冻结基线之外的签名没有被棘轮抓到');
    // A baseline entry that no longer matches any difference must FAIL. The frozen list is a ratchet:
    // it may only shrink (a commit that makes the plane better deletes its entries in that commit), and
    // an entry nobody can ever fail is a zombie — the structure could come back and the ratchet would
    // stay silent. Review v31-r1 asked for exactly this: the entries a slice adds must have a failure
    // form, the same way every waiver does (`waiverFindings` rejects stale ones).
    const prunable = SHAPE_DRAWER_SIGNATURE_BASELINE.filter((signature) => !report.drawerSignatures.includes(signature));
    assert.deepEqual(prunable, [], `冻结基线里有 ${prunable.length} 条签名已不再出现（本次提交里按棘轮规则删掉它们）：\n${prunable.join('\n')}`);
    const linkFailures = [];
    for (const page of SHAPE_DRAWER_PAGES) {
      const stateId = `${page}-drawer`;
      const entry = trace.states[stateId];
      if (!entry?.proto?.probe || !entry?.live?.probe) continue;
      linkFailures.push(...compareShapeLinks({ stateId, proto: entry.proto.probe, live: entry.live.probe }).failures);
    }
    assert.deepEqual(linkFailures, [], `抽屉里的记录入口两侧不一致：\n${linkFailures.join('\n')}`);
  });

  // ------------------------------------------------------------------ negative controls
  /**
   * Re-capture one live page after mutating its DOM and judge it with EVERY criterion — the skeleton,
   * the structural copy, the record entry points, the search-box contract and the “a control that
   * looks pressable must be able to act” contract — twice: once WITH the declared waiver tables (what
   * the gate itself does) and once with no waivers at all. Each control below says which judgement it
   * expects to see red, so a control can never pass by failing something else.
   */
  const liveMutation = async (stateId, mutate) => {
    const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'dark' });
    try {
      await context.request.post(`${fixture.base}/admin/auth/login`, { form: { password: fixture.password }, maxRedirects: 0 });
      const page = await context.newPage();
      const state = SHAPE_STATES.find((item) => item.id === stateId);
      await page.goto(`${fixture.base}${state.live}`, { waitUntil: 'load' });
      const removed = await page.evaluate(mutate);
      const live = await runProbe(page, probeShapeTree);
      const proto = trace.states[stateId].proto.probe;
      const judge = (waivers, labelWaivers) => [
        ...compareShapeState({ stateId, proto, live, waivers }).failures,
        ...compareShapeLabels({ stateId, proto, live, waivers: labelWaivers }).failures,
        ...compareShapeLinks({ stateId, proto, live }).failures,
        ...compareShapeSearchBoxes({ stateId, proto, live }).failures,
        ...(live.deadControls || []).map((item) => `[${stateId}] 看起来可点的控件在无脚本时无法操作：${item}`),
      ];
      return { removed, failures: judge(SHAPE_WAIVERS, SHAPE_LABEL_WAIVERS), strictFailures: judge([], []) };
    } finally {
      await context.close().catch(() => {});
    }
  };
  /** One mutation, one expected red: `expected` is matched against the declared-waiver judgement. */
  /**
   * R3 (Wave R) — the baseline judgement of a state, measured on the UNMUTATED capture.
   *
   * A negative control means "this mutation ADDED a failure", not "the page has absolutely zero
   * failures". With a data difference on the page (a fixture whose records differ from the
   * prototype's mock) the old absolute-zero assertion turned red for a reason the mutation had
   * nothing to do with — a gate lie in the safe direction, but still a lie. Every control below that
   * needs "nothing else changed" now diffs against this set instead.
   */
  const judgeCapture = (stateId, { waivers = SHAPE_WAIVERS, labelWaivers = SHAPE_LABEL_WAIVERS } = {}) => {
    const entry = trace.states[stateId];
    if (!entry?.proto?.probe || !entry?.live?.probe) return null;
    return [
      ...compareShapeState({ stateId, proto: entry.proto.probe, live: entry.live.probe, waivers }).failures,
      ...compareShapeLabels({ stateId, proto: entry.proto.probe, live: entry.live.probe, waivers: labelWaivers }).failures,
      ...compareShapeLinks({ stateId, proto: entry.proto.probe, live: entry.live.probe }).failures,
      ...compareShapeSearchBoxes({ stateId, proto: entry.proto.probe, live: entry.live.probe }).failures,
      ...(entry.live.probe.deadControls || []).map((item) => `[${stateId}] 看起来可点的控件在无脚本时无法操作：${item}`),
    ];
  };
  const expectRed = async (problems, label, stateId, mutate, expected) => {
    const result = await liveMutation(stateId, mutate);
    if (!result.removed) { problems.push(`${label} 无法进行：注入点不存在`); return result; }
    if (!result.failures.some((line) => expected.test(line))) {
      problems.push(`${label} 没有被判红（期望 /${expected.source}/）：${JSON.stringify((result.failures.length ? result.failures : result.strictFailures).slice(0, 4))}`);
    }
    return result;
  };

  await check('proto-shape: 负控 A — 往实现页注入结构 / 改类名 / 改顺序 / 去 href / 退回脚本控件 都必须真红', async () => {
    const problems = [];
    await expectRed(problems, '注入一条 .toolbar 区域', 'overview', `(() => {
      const page = document.querySelector('.main .page');
      if (!page) return 0;
      const box = document.createElement('div');
      box.className = 'toolbar parity-negative-control';
      const button = document.createElement('button');
      button.className = 'btn'; button.type = 'button'; button.textContent = '注入';
      box.appendChild(button);
      page.prepend(box);
      return 1;
    })()`, /parity-negative-control/);
    await expectRed(problems, '改掉一个类名', 'overview', `(() => {
      const node = document.querySelector('.main .sect-h');
      if (!node) return 0;
      node.className = 'sect-h parity-negative-control';
      return 1;
    })()`, /parity-negative-control|sect-h/);
    await expectRed(problems, '拿掉整条页头', 'accounts', `(() => {
      const bar = document.querySelector('.main header.bar');
      if (!bar) return 0;
      bar.remove();
      return 1;
    })()`, /header\.bar/);
    // Q1: the copy at a structural position is compared — a reworded `h2`, a deleted explanatory
    // paragraph and an emptied heading must each turn the copy criterion red.
    await expectRed(problems, '改掉分区标题 h2 文案', 'overview', `(() => {
      const node = document.querySelector('.main h2');
      if (!node) return 0;
      node.textContent = '改过的标题';
      return 1;
    })()`, /结构位置的文案/);
    await expectRed(problems, '拿掉整句说明 p.help', 'overview', `(() => {
      const node = document.querySelector('.main p.help');
      if (!node) return 0;
      node.remove();
      return 1;
    })()`, /结构位置的文案/);
    // Q4 — the boundary is ASSERTED, not assumed. A permutation INSIDE a record row is documented as
    // not gated (the two fixtures hold different records; see `shape.mjs`), so this control pins the
    // boundary itself: the swap must produce no failure (if a future wave adds an order criterion
    // without re-measuring, this control goes red and says so), while removing a whole record REGION
    // must.
    const swapped = await liveMutation('accounts', `(() => {
      const rows = [...document.querySelectorAll('.tbl tbody tr')];
      let touched = 0;
      for (const row of rows) {
        if (row.children.length < 2) continue;
        row.appendChild(row.children[0]);
        touched += 1;
      }
      return touched;
    })()`);
    // R3: “不得新增失败”，而不是“绝对零失败”。基线是本页未注入时的同一判据结果（正常树上为空）；
    // 数据差异（fixture 与原型 mock 的记录不同）不再把这条控制带成假红。
    const q4Baseline = judgeCapture('accounts') ?? [];
    const q4New = swapped.failures.filter((line) => !q4Baseline.includes(line));
    if (!swapped.removed) problems.push('Q4 边界控制无法进行：没有可交换的表格行');
    else if (q4New.length) {
      problems.push(`Q4 边界变了：行内顺序交换本应是“数据口径的 note”，却新增了 ${q4New.length} 条失败（基线 ${q4Baseline.length} 条）：${JSON.stringify(q4New.slice(0, 4))}`);
    }
    // 反证（R3）：同一套“新增失败”口径对一次真破坏必须报出新失败（否则它只是把控制调松了）。
    const regionRemoved = await liveMutation('accounts', `(() => {
      const body = document.querySelector('.tbl tbody');
      if (!body) return 0;
      body.remove();
      return 1;
    })()`);
    const regionNew = regionRemoved.failures.filter((line) => !q4Baseline.includes(line));
    if (!regionRemoved.removed) problems.push('R3 反证无法进行：没有可移除的 tbody');
    else if (!regionNew.length) problems.push(`R3 反证失败：拿掉整块 tbody 后“新增失败”为 0，基线差集口径形同虚设（基线 ${q4Baseline.length} 条）`);
    await expectRed(problems, '拿掉整块记录区域（tbody）', 'accounts', `(() => {
      const body = document.querySelector('.tbl tbody');
      if (!body) return 0;
      body.remove();
      return 1;
    })()`, /tbody/);
    // Q3: a search box reverted from a real GET form to the prototype's bare scripted label cannot
    // submit without script — the search-box contract (not a waiver) has to say so.
    await expectRed(problems, '搜索框退回 label.search（无脚本不能提交）', 'accounts', `(() => {
      const form = document.querySelector('form.search');
      if (!form) return 0;
      const label = document.createElement('label');
      label.className = 'search';
      while (form.firstChild) label.appendChild(form.firstChild);
      form.replaceWith(label);
      return 1;
    })()`, /没有脚本时无法提交/);
    // Q3: a `.btn` that is a link loses its href: the shape line does not carry a `.btn`'s href (the
    // prototype spells the same control as a scripted button), so the control contract must catch it.
    await expectRed(problems, '拿掉 .btn 链接的 href（死控件）', 'overview', `(() => {
      const link = [...document.querySelectorAll('a.btn[href]')].find((node) => node.getAttribute('href'));
      if (!link) return 0;
      link.removeAttribute('href');
      return 1;
    })()`, /无 href/);
    // Q3: the editor's switch keeps its `.switch` look but loses the real checkbox (the prototype's
    // own spelling is a scripted `<button>`): the switch may not be a dead control.
    await expectRed(problems, '把开关的真实 checkbox 换成脚本按钮', 'authz-editor', `(() => {
      const label = [...document.querySelectorAll('label.switch')].find((node) => node.querySelector('input[type=checkbox]'));
      if (!label) return 0;
      const button = document.createElement('button');
      button.className = label.className; button.type = 'button';
      label.replaceWith(button);
      return 1;
    })()`, /无脚本时不会生效的开关/);
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  await check('proto-shape: 负控 B — 往原型页注入同一处结构 / 改原型文案也必须真红（原型是现读，不是黄金副本）', async () => {
    const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'dark' });
    try {
      const page = await context.newPage();
      const state = SHAPE_STATES.find((item) => item.id === 'overview');
      await page.goto(protoUrl(repoRoot, state.proto), { waitUntil: 'load' });
      const injected = await page.evaluate(`(() => {
        const page_ = document.querySelector('.main .page');
        if (!page_) return 0;
        const box = document.createElement('div');
        box.className = 'toolbar parity-negative-control';
        page_.prepend(box);
        return 1;
      })()`);
      const probe = await runProbe(page, probeShapeTree);
      const mutations = compareShapeState({ stateId: 'overview', proto: probe, live: trace.states.overview.live.probe }).failures;
      const problems = [];
      if (!injected) problems.push('负控 B 无法进行：原型页没有 .main .page 注入点');
      if (!mutations.some((line) => line.includes('parity-negative-control'))) {
        problems.push(`往原型注入 .toolbar 后判据没有报红：${JSON.stringify(mutations.slice(0, 5))}`);
      }
      // Q1 on the prototype side: the copy at a structural position is read live too — rewording the
      // prototype's own heading must turn the copy criterion red just like rewording the plane's.
      await page.goto(protoUrl(repoRoot, state.proto), { waitUntil: 'load' });
      const edited = await page.evaluate(`(() => {
        const node = document.querySelector('.main h2');
        if (!node) return 0;
        node.textContent = '改过的原型标题';
        return 1;
      })()`);
      const editedProbe = await runProbe(page, probeShapeTree);
      const copyFailures = compareShapeLabels({ stateId: 'overview', proto: editedProbe, live: trace.states.overview.live.probe }).failures;
      if (!edited) problems.push('负控 B 无法进行：原型页没有 h2');
      else if (!copyFailures.some((line) => line.includes('结构位置的文案'))) {
        problems.push(`改原型的分区标题后文案判据没有报红：${JSON.stringify(copyFailures.slice(0, 5))}`);
      }
      assert.deepEqual(problems, [], problems.join('\n'));
    } finally {
      await context.close().catch(() => {});
    }
  });

  await check('proto-shape: 负控 C — 滥用豁免必须被拒绝（通配符 / 类型 / 重复 / 计数 / 覆盖区域 / 失效）', async () => {
    const problems = [];
    const wildcard = waiverFindings([{ state: 'overview', line: 'div.*', side: 'proto-only', kind: 'data', reason: 'x'.repeat(48) }]);
    if (!wildcard.some((line) => line.includes('通配符'))) problems.push('通配符豁免没有被拒绝');
    const badKind = waiverFindings([{ state: 'overview', line: 'div.sec-h :: T', side: 'proto-only', kind: 'whatever', reason: 'x'.repeat(48) }]);
    if (!badKind.some((line) => line.includes('kind'))) problems.push('未知 kind 的豁免没有被拒绝');
    const rowAsData = waiverFindings([{ state: 'overview', line: '↻ a.li [href=route:publish] :: - { b :: T }', side: 'proto-only', kind: 'data', reason: 'x'.repeat(48) }]);
    if (!rowAsData.some((line) => line.includes('整排行态集合'))) problems.push('用 data 豁免整排行态集合没有被拒绝');
    const fakeSubmit = waiverFindings([{ state: 'audit', line: 'div.sect :: -', side: 'live-only', kind: 'no-js-submit', reason: 'x'.repeat(48) }]);
    if (!fakeSubmit.some((line) => line.includes('no-js-submit'))) problems.push('把区域行声明成 no-js-submit 没有被拒绝');
    // Q3: a region is never “one datum differs” — `data` may not excuse a container line.
    const regionAsData = waiverFindings([{ state: 'authz-editor', line: 'div.cap-g :: -', side: 'live-only', kind: 'data', reason: 'x'.repeat(48) }]);
    if (!regionAsData.some((line) => line.includes('目录区域') || line.includes('区域容器'))) problems.push('用 data 豁免区域容器没有被拒绝');
    // Q2: two entries naming the same (state, line, side) would hide each other's staleness.
    const duplicate = waiverFindings([
      { state: 'audit', line: 'btn.btn.ghost.sm :: T', side: 'live-only', kind: 'no-js-submit', reason: 'x'.repeat(48) },
      { state: 'audit', line: 'btn.btn.ghost.sm :: T', side: 'live-only', kind: 'no-js-submit', reason: 'y'.repeat(48) },
    ]);
    if (!duplicate.some((line) => line.includes('重复豁免'))) problems.push('重复豁免（同一 state+line+side 两条）没有被拒绝');
    // Q2: `count` has to match the number of occurrences.
    const countMismatch = compareShapeState({
      stateId: 'audit', proto: trace.states.audit.proto.probe, live: trace.states.audit.live.probe,
      waivers: [{ state: 'audit', line: 'btn.btn.ghost.sm :: T', side: 'live-only', kind: 'no-js-submit', count: 1, reason: 'x'.repeat(48) }],
    });
    if (!countMismatch.failures.some((line) => line.includes('豁免数量不符'))) problems.push('豁免 count 与实际命中数不符没有被判红');
    if (!waiverFindings([{ state: 'audit', line: 'btn.btn.ghost.sm :: T', side: 'live-only', kind: 'no-js-submit', count: 0, reason: 'x'.repeat(48) }]).some((line) => line.includes('count'))) problems.push('count=0 没有被拒绝');
    // Q3: the catalog region exemption only applies to the catalog region.
    const catalogElsewhere = waiverFindings([{ state: 'overview', line: 'div.sect :: -', side: 'live-only', kind: 'catalog', reason: 'x'.repeat(48) }]);
    if (!catalogElsewhere.some((line) => line.includes('catalog'))) problems.push('把 catalog 用在非目录区域没有被拒绝');
    const stale = compareShapeState({
      stateId: 'overview', proto: trace.states.overview.proto.probe, live: trace.states.overview.live.probe,
      waivers: [{ state: 'overview', line: 'div.this-line-does-not-exist :: -', side: 'proto-only', kind: 'data', reason: 'x'.repeat(48) }],
    });
    if (!stale.failures.some((line) => line.includes('豁免失效'))) problems.push('失效豁免（不再命中任何差异）没有被判红');
    // A waiver must not be able to hide a *region*: the same injection as 负控 A, judged WITH the
    // declared waiver table (the judgement the gate itself runs), still has to name the injected
    // region. The older version of this control compared a value with itself and could never fail.
    const injected = await liveMutation('overview', `(() => {
      const page_ = document.querySelector('.main .page');
      if (!page_) return 0;
      const box = document.createElement('div');
      box.className = 'toolbar parity-negative-control';
      box.innerHTML = '<button class="btn" type="button">注入文案</button>';
      page_.prepend(box);
      return 1;
    })()`);
    if (!injected.removed) problems.push('负控 C 无法进行：注入点不存在');
    else if (!injected.failures.some((line) => line.includes('parity-negative-control') || line.includes('注入文案'))) {
      problems.push(`在已声明的豁免表下，注入的区域没有被报红（豁免吞掉了一整块区域）：${JSON.stringify(injected.failures.slice(0, 4))}`);
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  return { trace, report, hygiene };
}
