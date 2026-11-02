// Prototype-parity gate — capture and checks.
//
// The gate runs two captures with one probe: the prototype (`docs/admin-ui-proto/index.html`,
// `?dev=1&theme=dark`) and the live Admin pages of this tree (real fixture server, real login), then
// diffs them page by page. The prototype side is read from the running prototype rather than from a
// copied expectation table, so a prototype edit cannot silently leave the gate behind; `spec.mjs`
// only pairs routes and records the column golden the unit test re-derives.
//
// Registered checks, each failing closed and printing every difference on its own line:
//   * 结构对照  columns (count/name/order/width/classes), required elements, `?id=` drawer inventory
//   * paint     verbatim prototype stylesheet + declaration-level + resolved paint
//   * 负控 A    removing a *live* required element / column must turn the gate red (DOM level)
//   * 负控 B    the comparator must report a dropped column and a dropped drawer section
//   * 负控 C    removing the tokens from the served stylesheet must empty the token probe
//   * 无 JS     every page still renders its main content with scripting disabled
//   * shell     `.ni` navigation, mobile nav, horizontal overflow, capability chip bounds
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BAR_HEIGHT_PX, CHIP_MAX_HEIGHT_PX, CHIP_MAX_WIDTH_PX, CREATE_DRAWER_IDS, DATA_CHOICE_FIELDS, ELEMENT_CANDIDATES, ELEMENT_EQUIVALENTS, PAINT_TOKENS, PARITY_PAGES } from './spec.mjs';
import { probeNoJs, probePage, probePaint, removeTokensProbe, runProbe } from './probe.mjs';
import { probeDocumentPolicy } from './interaction.mjs';
import { scriptInventoryFailures } from './policy.mjs';
import {
  compareChips, compareColumns, compareDrawer, compareElements, compareNav, compareOverflow, comparePrimaryButtons,
} from './compare.mjs';
import { extractPrototypeCss, extractServedCss, paintBrowserFailures, paintFindings, verbatimCssFailures } from './paint.mjs';
import { seedParityFixture } from './seed.mjs';

export const VIEWPORT = { width: 1440, height: 900 };

const PROBE_OPTIONS = { selectors: ELEMENT_CANDIDATES, dataChoiceFields: DATA_CHOICE_FIELDS };

const protoUrl = (repoRoot, hash) => `${pathToFileURL(path.join(repoRoot, 'docs', 'admin-ui-proto', 'index.html')).href}?dev=1&theme=dark${hash}`;

/** The prototype route for one hash, as a file:// URL (shared with the mid-word two-sided check). */
export { protoUrl };

/**
 * Append `params` to a URL with query semantics: `?` when the route has no query yet, `&` when it
 * already has one, and the fragment (if any) stays last.
 *
 * The vaults route has no query (`/admin/auth/vault-git`), so blindly appending `&id=` used to build
 * `/admin/auth/vault-git&id=default` — a 404 that then looked like a missing drawer and a page with
 * no capability chips (lane w5-gates-fix).
 */
export function withQuery(url, params) {
  const hashAt = String(url).indexOf('#');
  const path = hashAt < 0 ? String(url) : String(url).slice(0, hashAt);
  const fragment = hashAt < 0 ? '' : String(url).slice(hashAt);
  const query = new URLSearchParams(params).toString();
  return `${path}${path.includes('?') ? '&' : '?'}${query}${fragment}`;
}

async function capture(page, url) {
  try {
    const response = await page.goto(url, { waitUntil: 'load' });
    await page.evaluate('document.fonts ? document.fonts.ready : true');
    return { url, status: response ? response.status() : null, probe: await runProbe(page, probePage, PROBE_OPTIONS) };
  } catch (error) {
    return { url, status: null, error: String(error?.message || error).split('\n')[0] };
  }
}

/** Try the page's aliases in order (the editor's route may move); report every alias on failure. */
async function captureLivePage(page, base, entry) {
  const urls = (entry.aliases || [entry.live]).map((url) => `${base}${url}`);
  const attempts = [];
  for (const url of urls) {
    const captured = await capture(page, url);
    attempts.push(captured);
    if (!captured.error && captured.status !== null && captured.status < 400) return { ...captured, attempts: attempts.map((item) => item.url) };
  }
  return { ...attempts[attempts.length - 1], attempts: attempts.map((item) => `${item.url} → ${item.error || item.status}`) };
}

/** Resolve the id the prototype uses for one page's drawer (`#/accounts/<id>` or a row `data-id`). */
export function protoDrawerId(page, probe) {
  const prefix = page.drawer.protoPrefix;
  for (const href of probe.hrefs || []) {
    const match = new RegExp(`^${prefix}/([^/?#]+)`).exec(String(href).replace(/^[^#]*#/, '#'));
    if (match) return match[1];
  }
  return (probe.dataIds || [])[0] ?? null;
}

/** Resolve the id the live plane uses for one page's drawer (`?id=`). */
export function liveDrawerId(probe) {
  for (const href of probe.hrefs || []) {
    const match = /[?&]id=([^&#]+)/.exec(String(href));
    if (!match) continue;
    const id = decodeURIComponent(match[1]);
    // `?id=new` is the list page's 新建 link (the create drawer), not a record detail: the
    // prototype's `#/<page>/<id>` links are row links, so pairing the create drawer with a
    // prototype detail drawer would compare two different surfaces.
    if (CREATE_DRAWER_IDS.includes(id)) continue;
    return id;
  }
  return null;
}

async function captureAll({ browser, repoRoot, base, password }) {
  const trace = { startedAt: new Date().toISOString(), proto: {}, live: {}, drawers: {} };
  const protoContext = await browser.newContext({ viewport: VIEWPORT });
  const liveContext = await browser.newContext({ viewport: VIEWPORT });
  const protoPage = await protoContext.newPage();
  const livePage = await liveContext.newPage();
  const pageErrors = [];
  livePage.on('pageerror', (error) => pageErrors.push(String(error)));
  protoPage.on('pageerror', (error) => pageErrors.push(`proto: ${String(error)}`));
  try {
    const login = await liveContext.request.post(`${base}/admin/auth/login`, { form: { password }, maxRedirects: 0 });
    assert.equal(login.status(), 303, `fixture admin login must succeed, got ${login.status()}`);
    for (const entry of PARITY_PAGES) {
      trace.proto[entry.id] = await capture(protoPage, protoUrl(repoRoot, entry.proto));
      trace.live[entry.id] = await captureLivePage(livePage, base, entry);
    }
    for (const entry of PARITY_PAGES.filter((item) => item.drawer)) {
      const protoProbe = trace.proto[entry.id].probe;
      const liveProbe = trace.live[entry.id].probe;
      const protoId = protoProbe ? protoDrawerId(entry, protoProbe) : null;
      const liveId = liveProbe ? liveDrawerId(liveProbe) : null;
      trace.drawers[entry.id] = { protoId, liveId };
      if (protoId) trace.drawers[entry.id].proto = await capture(protoPage, protoUrl(repoRoot, `${entry.drawer.protoPrefix}/${protoId}`));
      if (liveId) trace.drawers[entry.id].live = await capture(livePage, `${base}${withQuery(entry.live, { id: liveId })}`);
    }
    return { trace, pageErrors };
  } finally {
    await protoContext.close().catch(() => {});
    await liveContext.close().catch(() => {});
  }
}

/** Compare every page and return every difference as one printable line. */
export function compareAll(trace) {
  const failures = [];
  const notes = [];
  const combine = (...parts) => ({
    failures: parts.flatMap((part) => part.failures ?? []),
    notes: parts.flatMap((part) => part.notes ?? []),
  });
  for (const page of PARITY_PAGES) {
    const proto = trace.proto[page.id];
    const live = trace.live[page.id];
    const results = [];
    if (!proto?.probe) {
      failures.push(`[${page.id}] 原型页无法读取（${page.proto}）：${proto?.error || 'no probe'}`);
      continue;
    }
    if (!live?.probe) {
      failures.push(`[${page.id}] 缺页面 ${page.live}（${live?.error || `status ${live?.status}`}；尝试过 ${(live?.attempts || []).join(' / ')}）`);
      continue;
    }
    if (live.status !== null && live.status >= 400) failures.push(`[${page.id}] ${page.live} 返回 ${live.status}`);
    const parts = [
      page.table ? compareColumns(page, proto.probe, live.probe) : { failures: [], notes: [] },
      compareElements(ELEMENT_CANDIDATES, proto.probe, live.probe, ELEMENT_EQUIVALENTS),
    ];
    if (page.table) {
      const protoPrimary = (proto.probe.buttons || []).filter((button) => button.classes.split(' ').includes('primary')).length;
      parts.push({ failures: comparePrimaryButtons(live.probe, protoPrimary), notes: [] });
    }
    results.push({ tag: '', ...combine(...parts) });
    if (page.drawer) {
      const drawer = trace.drawers[page.id] || {};
      const liveDrawerUrl = drawer.liveId ? withQuery(page.live, { id: drawer.liveId }) : page.live;
      if (!drawer.protoId) results.push({ tag: '/drawer', failures: [`原型列表页没有 ${page.drawer.protoPrefix}/<id> 入口，无法对照抽屉`], notes: [] });
      else if (!drawer.liveId) results.push({ tag: '/drawer', failures: [`实现列表页没有 ?id= 详情入口（原型通过 ?id= 打开 ${page.drawer.kind}）`], notes: [] });
      // A drawer URL that 404s renders a page with no drawer at all; report the status instead of
      // letting it read as "the drawer is missing" (the `&id=` join defect looked exactly like that).
      else if ((drawer.live?.status ?? 0) >= 400) results.push({ tag: '/drawer', failures: [`${liveDrawerUrl} 返回 ${drawer.live.status}（详情页无法加载）`], notes: [] });
      else if (!drawer.proto?.probe || !drawer.live?.probe) results.push({ tag: '/drawer', failures: [`抽屉页无法加载：原型 ${drawer.proto?.error || 'ok'} / 实现 ${drawer.live?.error || 'ok'}`], notes: [] });
      else results.push({ tag: '/drawer', ...compareDrawer(page, drawer.proto.probe, drawer.live.probe) });
    }
    for (const result of results) {
      for (const failure of result.failures) failures.push(`[${page.id}${result.tag}] ${failure}`);
      for (const note of result.notes || []) notes.push(`[${page.id}${result.tag}][note] ${note}`);
    }
  }
  return { failures, notes };
}

/**
 * Register the prototype-parity checks. `ctx` is the shared web-regression context:
 * `{ check, browser, root, appRoot, serverErrors, outputRoot, fixture }`.
 */
export async function registerProtoParityChecks(ctx) {
  const { check, browser, appRoot, outputRoot, fixture } = ctx;
  const repoRoot = path.resolve(appRoot, '..');
  const seeded = await seedParityFixture({
    base: fixture.base, password: fixture.password, apiKey: fixture.apiKey,
    webUser: 'layout-gate', webPassword: fixture.password,
  });
  const { trace, pageErrors } = await captureAll({ browser, repoRoot, base: fixture.base, password: fixture.password });
  const comparison = compareAll(trace);
  const report = [
    `# prototype-parity report — ${new Date().toISOString()}`,
    `# proto ${repoRoot}/docs/admin-ui-proto/index.html?dev=1&theme=dark  ↔ live ${fixture.base}`,
    `# seeded: ${seeded.steps.map((step) => `${step.ok ? 'ok' : 'FAIL'} ${step.name}`).join(' | ')}`,
    `# page errors: ${pageErrors.length}`,
    ...comparison.failures,
    ...comparison.notes,
    '',
  ].join('\n');
  await fs.mkdir(outputRoot, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(outputRoot, 'proto-parity-report.txt'), report).catch(() => {});
  await fs.writeFile(path.join(outputRoot, 'proto-parity-report.json'), JSON.stringify({ failures: comparison.failures, notes: comparison.notes, seeded: seeded.steps, pageErrors }, null, 1)).catch(() => {});
  await fs.writeFile(path.join(outputRoot, 'proto-parity-capture.json'), JSON.stringify(trace, null, 1)).catch(() => {});

  const failWith = (lines) => assert.equal(lines.length, 0, `${lines.length} 条差异：\n${lines.join('\n')}`);

  await check('proto-parity: 结构对照（列名/列数/顺序 + 必需元素 + ?id= 抽屉字段清单）', async () => {
    failWith([...seeded.errors.map((error) => `[seed] ${error}`), ...pageErrors.map((error) => `[pageerror] ${error}`), ...comparison.failures]);
  });

  await check('proto-parity: paint gate（原型样式表逐字副本 + token/52px 页头/主按钮不透明/.tw 边框）', async () => {
    const [head, module] = await Promise.all([
      fs.readFile(path.join(repoRoot, 'docs', 'admin-ui-proto', 'src', '1-head.html'), 'utf8'),
      fs.readFile(path.join(appRoot, 'src', 'admin', 'assets', 'proto-css.js'), 'utf8'),
    ]);
    const prototypeCss = extractPrototypeCss(head);
    const servedCss = extractServedCss(module);
    const declaration = paintFindings(servedCss, { barHeightPx: BAR_HEIGHT_PX });
    const failures = [...verbatimCssFailures({ prototypeCss, servedCss }), ...declaration.failures];
    const context = await browser.newContext({ viewport: VIEWPORT });
    try {
      const login = await context.request.post(`${fixture.base}/admin/auth/login`, { form: { password: fixture.password }, maxRedirects: 0 });
      assert.equal(login.status(), 303, 'fixture login must succeed for the paint probe');
      const page = await context.newPage();
      // Measure on a page that actually renders a table card; if none does, say so instead of
      // reporting a border it could never have had.
      const withCard = PARITY_PAGES.find((entry) => (trace.live[entry.id]?.probe?.elements['.main .tw']?.count ?? 0) > 0);
      if (!withCard) failures.push('没有任何 Admin 页面渲染 .tw 表格卡片（无法测量卡片边框）');
      await page.goto(`${fixture.base}${withCard ? withCard.live : PARITY_PAGES[0].live}`, { waitUntil: 'load' });
      const paint = await runProbe(page, probePaint);
      failures.push(...paintBrowserFailures(paint, { barHeightPx: BAR_HEIGHT_PX, requirePrimary: 0 }));
      await fs.writeFile(path.join(outputRoot, 'proto-parity-paint.json'), JSON.stringify({ declarations: declaration.evidence, page: withCard?.live ?? null, paint }, null, 1)).catch(() => {});
    } finally {
      await context.close().catch(() => {});
    }
    failWith(failures);
  });

  await check('proto-parity: 负控 C — 拿掉 paint token 后探针必须变空（判据真的在读样式表）', async () => {
    const context = await browser.newContext({ viewport: VIEWPORT });
    try {
      await context.request.post(`${fixture.base}/admin/auth/login`, { form: { password: fixture.password }, maxRedirects: 0 });
      const page = await context.newPage();
      await page.goto(`${fixture.base}/admin/auth?tab=overview`, { waitUntil: 'load' });
      const before = await runProbe(page, probePaint);
      const stripped = await page.evaluate(`(${removeTokensProbe.toString()})(${JSON.stringify(PAINT_TOKENS)})`);
      const problems = [];
      for (const token of PAINT_TOKENS) {
        if (!before.tokens[token]) problems.push(`负控前提不成立：未删除前 ${token} 就没有解析出值（tokens=${JSON.stringify(before.tokens)}）`);
        if (stripped.values[token]) problems.push(`删除后 ${token} 仍解析为 ${JSON.stringify(stripped.values[token])}（探针没有真的读服务端样式表）`);
      }
      const bodyAfter = await page.evaluate('getComputedStyle(document.body).backgroundColor');
      if (bodyAfter !== 'rgba(0, 0, 0, 0)') problems.push(`删除 --bg 后 body 背景仍是 ${bodyAfter}，负控无效`);
      if (stripped.removed < PAINT_TOKENS.length) problems.push(`只删到 ${stripped.removed} 条 token 声明`);
      failWith(problems);
    } finally {
      await context.close().catch(() => {});
    }
  });

  await check('proto-parity: 负控 A — 从真实 DOM 拿掉必需元素必须真红', async () => {
    const context = await browser.newContext({ viewport: VIEWPORT });
    try {
      await context.request.post(`${fixture.base}/admin/auth/login`, { form: { password: fixture.password }, maxRedirects: 0 });
      const page = await context.newPage();
      const problems = [];
      const entry = PARITY_PAGES.find((item) => item.id === 'overview');
      const protoProbe = trace.proto.overview?.probe;
      await page.goto(`${fixture.base}${entry.live}`, { waitUntil: 'load' });
      const liveProbe = await runProbe(page, probePage, PROBE_OPTIONS);
      const selector = ELEMENT_CANDIDATES.find((item) => (protoProbe?.elements[item]?.count ?? 0) > 0 && liveProbe.elements[item].count > 0);
      if (!selector) {
        problems.push('负控无法进行：概览页没有任何「原型有、实现也有」的必需元素，判据的鉴别力无法证明');
      } else {
        const removed = await page.evaluate(`(() => { const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})]; for (const node of nodes) node.remove(); return nodes.length; })()`);
        if (!removed) problems.push(`负控无效：${selector} 没有删掉任何节点`);
        const mutated = await runProbe(page, probePage, PROBE_OPTIONS);
        const failures = compareElements(ELEMENT_CANDIDATES, protoProbe, mutated, ELEMENT_EQUIVALENTS).failures;
        if (!failures.some((line) => line.includes(selector))) problems.push(`删掉 ${selector}（${removed} 个节点）后比较器没有报红：${JSON.stringify(failures)}`);
      }
      failWith(problems);
    } finally {
      await context.close().catch(() => {});
    }
  });

  await check('proto-parity: 负控 B — 比较器对拿掉列 / 拿掉抽屉分节必须报红', async () => {
    const problems = [];
    const page = PARITY_PAGES.find((entry) => entry.id === 'accounts');
    const proto = trace.proto.accounts?.probe;
    if (!proto) {
      problems.push('负控无法进行：原型 accounts 页未捕获');
    } else if (!proto.tables.length) {
      problems.push('负控无法进行：原型 accounts 页没有 .tbl');
    } else {
      // Positive control first: the prototype compared against itself must be difference-free, so a
      // "no differences" result cannot be an artefact of the comparator never comparing anything.
      const selfColumns = compareColumns(page, proto, structuredClone(proto));
      const selfElements = compareElements(ELEMENT_CANDIDATES, proto, structuredClone(proto), ELEMENT_EQUIVALENTS);
      if (selfColumns.failures.length || selfElements.failures.length) {
        problems.push(`正控失败：原型与自身比对出现差异 ${JSON.stringify([...selfColumns.failures, ...selfElements.failures])}`);
      }
      const dropped = structuredClone(proto);
      dropped.tables[0].headers.splice(1, 1);
      const failures = compareColumns(page, proto, dropped).failures;
      if (!failures.some((line) => line.includes('列数不同') || line.includes('顺序'))) problems.push(`拿掉一列表头后比较器没有报红：${JSON.stringify(failures)}`);
      const renamed = structuredClone(proto);
      renamed.tables[0].headers[0] = `${renamed.tables[0].headers[0]}（改）`;
      if (!compareColumns(page, proto, renamed).failures.some((line) => line.includes('名称不同'))) problems.push('改掉一列表头名称后比较器没有报红');
      const empty = structuredClone(proto);
      empty.tables = [];
      if (!compareColumns(page, proto, empty).failures.some((line) => line.includes('缺少列表表格'))) problems.push('把表格整个拿掉后比较器没有报红');
    }
    const drawer = trace.drawers.accounts;
    if (!drawer?.proto?.probe?.drawer) {
      problems.push('负控无法进行：原型 accounts 抽屉未捕获');
    } else {
      const protoDrawer = drawer.proto.probe;
      const shortened = structuredClone(protoDrawer);
      shortened.drawer.sections = shortened.drawer.sections.slice(1);
      if (!compareDrawer(page, protoDrawer, shortened).failures.some((line) => line.includes('抽屉分节'))) problems.push('拿掉一个抽屉分节后比较器没有报红');
      const noDrawer = structuredClone(protoDrawer);
      noDrawer.drawer = null;
      if (!compareDrawer(page, protoDrawer, noDrawer).failures.some((line) => line.includes('缺少 ?id= 详情抽屉'))) problems.push('把抽屉整个拿掉后比较器没有报红');
      const droppedKey = structuredClone(protoDrawer);
      droppedKey.drawer.kvKeys = droppedKey.drawer.kvKeys.slice(1);
      if (droppedKey.drawer.kvKeys.length && !compareDrawer(page, protoDrawer, droppedKey).failures.some((line) => line.includes('kv'))) problems.push('拿掉一个抽屉 kv 字段后比较器没有报红');
    }
    failWith(problems);
  });

  await check('proto-parity: 无 JS（禁用脚本后每个页面主内容仍可见；脚本策略按 D0：同源 module / 无 inline）', async () => {
    const context = await browser.newContext({ viewport: VIEWPORT, javaScriptEnabled: false });
    const page = await context.newPage();
    const failures = [];
    try {
      await context.request.post(`${fixture.base}/admin/auth/login`, { form: { password: fixture.password }, maxRedirects: 0 });
      for (const entry of PARITY_PAGES) {
        const url = `${fixture.base}${entry.live}`;
        try {
          const response = await page.goto(url, { waitUntil: 'load' });
          const probe = await runProbe(page, probeNoJs);
          if (response && response.status() !== 200) failures.push(`[${entry.id}] ${url} 返回 ${response.status()}`);
          if (!probe.hasMain) failures.push(`[${entry.id}] 无脚本时缺少 .main 容器`);
          if (!probe.hasContent) failures.push(`[${entry.id}] 无脚本时缺少 .main .content 内容容器`);
          if (!probe.heading) failures.push(`[${entry.id}] 无脚本时页头 .bar h1 为空`);
          const marks = probe.marks;
          if (!(marks.tw + marks.stats + marks.empty + marks.form + marks.ped > 0)) failures.push(`[${entry.id}] 无脚本时没有任何内容标记（.tw/.stat/.empty/form/.ped 全为 0）`);
          if (probe.textLength < 20) failures.push(`[${entry.id}] 无脚本时正文只有 ${probe.textLength} 字：${JSON.stringify(probe.text)}`);
          // D0 (2026-10-18) replaced the old "zero scripts" criterion: the plane now loads ONE
          // same-origin module on authenticated pages. The intent is unchanged and the assertion is
          // stronger — no inline script, no foreign origin, only the whitelisted entry module — and
          // both halves of the policy live in `proto-parity/interaction.mjs` so the JS-on scene
          // measures the served HTML the same way.
          const policy = await runProbe(page, probeDocumentPolicy);
          failures.push(...scriptInventoryFailures(policy, { authenticated: true }).map((line) => `[${entry.id}] ${line}`));
        } catch (error) {
          failures.push(`[${entry.id}] 无脚本加载失败：${String(error?.message || error).split('\n')[0]}`);
        }
      }
    } finally {
      await context.close().catch(() => {});
    }
    failWith(failures);
  });

  await check('proto-parity: shell 导航 .ni + 无横向溢出 + 能力 chip 边界', async () => {
    const failures = [];
    const protoNav = trace.proto.overview?.probe;
    const liveNav = trace.live.overview?.probe;
    if (!protoNav || !liveNav) failures.push('无法对照 shell：概览页未捕获');
    else failures.push(...compareNav(protoNav, liveNav).failures);
    let measuredChips = 0;
    for (const entry of PARITY_PAGES) {
      for (const [phase, probed] of [['list', trace.live[entry.id]?.probe], ['drawer', trace.drawers[entry.id]?.live?.probe]]) {
        if (!probed) continue;
        if (phase === 'list') failures.push(...compareOverflow(probed).map((line) => `[${entry.id}] ${line}`));
        const chips = compareChips(probed, { maxHeight: CHIP_MAX_HEIGHT_PX, maxWidth: CHIP_MAX_WIDTH_PX });
        measuredChips += probed.chips.length;
        failures.push(...chips.failures.map((line) => `[${entry.id}${phase === 'drawer' ? '/drawer' : ''}] ${line}`));
      }
    }
    // Load-bearing: the prototype renders capability chips (`.caps .cap` in the Vault drawer), so a
    // run that measured none must not report success.
    const protoChips = PARITY_PAGES.filter((entry) => (trace.drawers[entry.id]?.proto?.probe?.chips?.length ?? 0) > 0).map((entry) => entry.id);
    if (protoChips.length && measuredChips === 0) failures.push(`原型在 ${protoChips.join('/')} 抽屉渲染了能力 chip（.cap），实现页一个都没有：尺寸档位判据无法生效`);
    failWith(failures);
  });

  return { trace, comparison, seeded };
}
