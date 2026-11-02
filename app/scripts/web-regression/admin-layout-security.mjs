// Admin XSS / injection gate — write hostile strings into *real* data fields through the real
// routes, then assert what a browser actually has: no executable node, no `on*=` attribute, no
// `javascript:` URL, no CSP violation, no payload flag set — and that the client sources own no HTML
// sink in the first place.
//
// Two controls make the verdicts meaningful:
//   * **positive control**: every payload must be *visible as text* afterwards. An injection probe
//     that never reached the DOM proves nothing about the renderer, so a payload that is absent
//     fails the check instead of passing it silently.
//   * **negative control**: the scanners are pointed at a DOM that *does* carry an `on*=` attribute
//     and a `javascript:` URL (live) and at a source with an `innerHTML = data` sink (pure), and must
//     report them — a scanner that only ever says "clean" is not a scanner.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { armInteractionObservers } from '../proto-parity/interaction.mjs';
import { clientSinkFailures, probeInjectionSurface, XSS_PAYLOADS } from '../proto-parity/injection.mjs';
import { ADMIN_CLIENT_MODULES, CLIENT_SCRIPT_BASE } from '../proto-parity/policy.mjs';
import { runProbe } from '../proto-parity/probe.mjs';
import { PARITY_PAGES } from '../proto-parity/spec.mjs';

const VIEWPORT = { width: 1440, height: 900 };

async function postForm(request, base, url, fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields || {})) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(key, String(item ?? ''));
  }
  return request.post(`${base}${url}`, { data: body.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, maxRedirects: 0 });
}

/** One real MCP call with a caller-supplied `User-Agent`, so the audit row carries the payload. */
async function mcpCallWithUserAgent({ base, apiKey, userAgent, name, args }) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': apiKey, 'user-agent': userAgent };
  const post = async (body, sessionId) => {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: sessionId ? { ...headers, 'mcp-session-id': sessionId } : headers, body: JSON.stringify(body) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { const line = text.split('\n').find((item) => item.startsWith('data: ')); if (line) json = JSON.parse(line.slice(6)); }
    return { sessionId: response.headers.get('mcp-session-id'), json, text, status: response.status };
  };
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'l4-xss-gate', version: '1.0' } } });
  assert.ok(init.sessionId, `MCP initialize must open a session: ${init.status} ${init.text.slice(0, 160)}`);
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId);
  const call = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, init.sessionId);
  return call;
}

/**
 * Write the payloads through the real routes. Returns `{ steps, errors }`; a failed write is reported
 * (an unchecked vector would silently shrink the gate).
 */
async function injectPayloads({ request, base, apiKey }) {
  const steps = [];
  const errors = [];
  const step = async (name, run) => {
    try { steps.push({ name, ok: true, detail: String(await run()).slice(0, 120) }); }
    catch (error) { steps.push({ name, ok: false, detail: String(error?.message || error) }); errors.push(`${name}: ${error?.message || error}`); }
  };
  const csrfPage = await request.get(`${base}/admin/auth?tab=accounts`);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await csrfPage.text())?.[1];
  assert.ok(csrf, 'the injection fixture needs an admin CSRF token');

  await step('account displayName payload', async () => {
    const response = await postForm(request, base, '/admin/auth/oauth/user/create', {
      csrf, username: `l4-xss-${Date.now().toString(36)}`, displayName: XSS_PAYLOADS.accountDisplayName,
      password: 'l4-xss-account-0123456789', allowedScope: ['obsidian.read'], allowedVault: ['default'],
    });
    if (response.status() !== 303) throw new Error(`status ${response.status()}`);
    return '303';
  });

  await step('API key label payload', async () => {
    const response = await postForm(request, base, '/admin/auth/api-key/create', {
      csrf, label: XSS_PAYLOADS.keyLabel, allowedScope: ['obsidian.read'], allowedVault: ['default'],
    });
    if (response.status() !== 303) throw new Error(`status ${response.status()}`);
    return '303';
  });

  await step('access-policy label payload', async () => {
    // `enabled=false`: the payload must render, and a disabled policy restricts nothing (the other
    // scenes' MCP calls keep working).
    const response = await postForm(request, base, '/admin/auth/access-policy/create', {
      csrf, label: XSS_PAYLOADS.policyLabel, mode: 'suspend', enabled: 'false', timezone: 'Asia/Shanghai',
      startsAt: '', expiresAt: '', subjects: ['api-key:configured-env'], capabilities: 'scope:obsidian.read',
      weekly: 'mon 00:00-24:00', dateRanges: '',
    });
    if (response.status() !== 303) throw new Error(`status ${response.status()}`);
    return '303';
  });

  await step('audit User-Agent payload (real MCP call)', async () => {
    const call = await mcpCallWithUserAgent({ base, apiKey, userAgent: XSS_PAYLOADS.auditUserAgent, name: 'write_note', args: { path: 'notes/l4-xss-ua.md', overwrite: true, content: '# xss ua probe\n' } });
    if (call.json?.result?.isError) throw new Error(`MCP write_note failed: ${call.text.slice(0, 160)}`);
    return `session ${String(call.sessionId).slice(0, 8)}`;
  });

  return { steps, errors };
}

/**
 * Register the injection checks. `deps`: `{ browser, fixture, outputRoot, tracePhase }`.
 */
export async function registerSecurityChecks(ctx, deps) {
  const { check } = ctx;
  const { browser, fixture, outputRoot, tracePhase } = deps;
  const base = fixture.base;
  const trace = { startedAt: new Date().toISOString(), payloads: XSS_PAYLOADS, seeding: [], surfaces: [] };

  const setupContext = await browser.newContext({ viewport: VIEWPORT });
  let seeded;
  try {
    const login = await setupContext.request.post(`${base}/admin/auth/login`, { form: { password: fixture.password }, maxRedirects: 0 });
    assert.equal(login.status(), 303, 'the XSS scene must be able to log in');
    seeded = await injectPayloads({ request: setupContext.request, base, apiKey: fixture.apiKey });
    trace.seeding = seeded.steps;
  } finally {
    await setupContext.close().catch(() => {});
  }

  await check('admin-security: 注入落地（正控）— 4 个恶意串都写进了真实数据字段并渲染为文本', async () => {
    const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
    const context = page.context();
    try {
      await context.request.post(`${base}/admin/auth/login`, { form: { password: fixture.password }, maxRedirects: 0 });
      const surfaces = [];
      for (const [label, url] of [
        ['accounts', `${base}/admin/auth?tab=accounts`],
        ['keys', `${base}/admin/auth?tab=keys`],
        ['authz', `${base}${PARITY_PAGES.find((entry) => entry.id === 'authz').live}`],
        ['audit', `${base}/admin/auth?tab=audit`],
      ]) {
        await page.goto(url, { waitUntil: 'load' });
        surfaces.push({ label, ...(await runProbe(page, probeInjectionSurface, Object.values(XSS_PAYLOADS))) });
      }
      trace.surfaces = surfaces.map((surface) => ({ label: surface.label, visible: surface.visible, inlineHandlers: surface.inlineHandlers.length, javascriptUrls: surface.javascriptUrls.length }));
      const visiblePayloads = new Set(surfaces.flatMap((surface) => surface.visible.filter((item) => item.asText).map((item) => item.payload)));
      const missing = Object.entries(XSS_PAYLOADS).filter(([, payload]) => !visiblePayloads.has(payload)).map(([field]) => field);
      const failures = [...seeded.errors];
      if (missing.length) failures.push(`payload 没有出现在任何页面的文本里：${missing.join(', ')}（注入未落地 ⇒ 探针无法证明渲染器安全）`);
      await checkWrite(outputRoot, 'admin-security-surfaces.json', trace.surfaces);
      assert.equal(failures.length, 0, failures.join('\n'));
    } finally {
      await context.close().catch(() => {});
    }
  });

  await check('admin-security: 注入数据后无可执行节点 / 无 on* / 无 javascript: / 无 CSP 违规 / 无 payload 旗标', async () => {
    const context = await browser.newContext({ viewport: VIEWPORT });
    await context.addInitScript({ content: `(${armInteractionObservers.toString()})();` });
    const page = await context.newPage();
    try {
      await context.request.post(`${base}/admin/auth/login`, { form: { password: fixture.password }, maxRedirects: 0 });
      const failures = [];
      const payloadList = Object.values(XSS_PAYLOADS);
      const visited = [
        ['accounts 列表', '/admin/auth?tab=accounts'],
        ['keys 列表', '/admin/auth?tab=keys'],
        ['authz 列表', PARITY_PAGES.find((entry) => entry.id === 'authz').live],
        ['audit 列表', '/admin/auth?tab=audit'],
      ];
      for (const [label, url] of visited) {
        await page.goto(`${base}${url}`, { waitUntil: 'load' });
        await page.waitForTimeout(250);
        const surface = await runProbe(page, probeInjectionSurface, payloadList);
        trace.surfaces.push({ label, ...surface, visible: surface.visible.map((item) => `${item.payload.slice(0, 24)}→${item.asText}`) });
        if (surface.inlineHandlers.length) failures.push(`[${label}] DOM 里出现 on* 属性：${surface.inlineHandlers.slice(0, 5).join(', ')}`);
        if (surface.inlineScripts) failures.push(`[${label}] DOM 里出现 ${surface.inlineScripts} 个 inline <script> 节点（注入的 payload 生成了可执行节点，即使 CSP 会拦住它）`);
        if (surface.javascriptUrls.length) failures.push(`[${label}] DOM 里出现 javascript: URL：${surface.javascriptUrls.slice(0, 3).join(', ')}`);
        if (surface.scriptSources.some((source) => source !== '(inline)' && !source.includes(CLIENT_SCRIPT_BASE))) failures.push(`[${label}] 出现白名单之外的脚本：${surface.scriptSources.join(', ')}`);
        if (surface.violations) failures.push(`[${label}] 交互期间出现 ${surface.violations} 条 CSP 违规`);
        const flags = Object.entries(surface.flags).filter(([key, value]) => value === true && key !== "any").map(([key]) => key);
        if (flags.length) failures.push(`[${label}] 注入的 payload 真的执行了（旗标 ${flags.join(', ')}）`);
      }
      // The drawers are where the same values are rendered a second time (list → `?id=` detail).
      const accountDrawer = await firstHrefWith(page, 'a.cell-link', base);
      if (accountDrawer) {
        await page.goto(accountDrawer, { waitUntil: 'load' });
        const surface = await runProbe(page, probeInjectionSurface, payloadList);
        trace.surfaces.push({ label: 'account drawer', ...surface, visible: surface.visible.map((item) => `${item.payload.slice(0, 24)}→${item.asText}`) });
        if (surface.inlineHandlers.length) failures.push(`[抽屉] DOM 里出现 on* 属性：${surface.inlineHandlers.slice(0, 5).join(', ')}`);
        if (surface.inlineScripts) failures.push(`[抽屉] DOM 里出现 ${surface.inlineScripts} 个 inline <script> 节点`);
        if (surface.flags.any) failures.push('[抽屉] payload 执行了');
      }
      await checkWrite(outputRoot, 'admin-security-surfaces.json', trace.surfaces);
      assert.equal(failures.length, 0, `${failures.length} 条差异：\n${failures.join('\n')}`);
    } finally {
      await context.close().catch(() => {});
    }
  });

  await check('admin-security: 客户端脚本只用 textContent（服务端源码审计：无 innerHTML/insertAdjacentHTML/eval/…）', async () => {
    const context = await browser.newContext({ viewport: VIEWPORT });
    try {
      const sources = {};
      for (const name of ADMIN_CLIENT_MODULES) {
        const response = await context.request.get(`${base}${CLIENT_SCRIPT_BASE}${name}`);
        assert.equal(response.status(), 200, `白名单模块 ${name} 必须可取（实际 ${response.status()}）`);
        sources[name] = await response.text();
      }
      const failures = clientSinkFailures(sources);
      // Negative control: the same auditor must report a sink when one exists.
      const mutated = clientSinkFailures({ 'admin-client.js: 负控注入': 'export function f(data, el) {\n  el.innerHTML = data;\n}\n' });
      if (!mutated.some((line) => line.includes('innerHTML-assignment'))) failures.push('负控失败：把 `el.innerHTML = data` 交给审计器没有报红');
      trace.sources = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, source.length]));
      await checkWrite(outputRoot, 'admin-security-sources.json', { lengths: trace.sources, failures });
      assert.equal(failures.length, 0, `${failures.length} 条差异：\n${failures.join('\n')}`);
    } finally {
      await context.close().catch(() => {});
    }
  });

  await check('admin-security: 负控 — 注入 on* 属性与 javascript: URL 后扫描器必须报红', async () => {
    const context = await browser.newContext({ viewport: VIEWPORT });
    try {
      await context.request.post(`${base}/admin/auth/login`, { form: { password: fixture.password }, maxRedirects: 0 });
      const page = await context.newPage();
      await page.goto(`${base}/admin/auth?tab=accounts`, { waitUntil: 'load' });
      const injected = await page.evaluate(`(() => {
        const div = document.createElement('div');
        div.setAttribute('onmouseover', 'window.__xss_dom=1');
        div.textContent = 'negative control';
        document.querySelector('.main').appendChild(div);
        const anchor = document.createElement('a');
        anchor.setAttribute('href', 'javascript:window.__xss_dom=1');
        anchor.textContent = 'negative control link';
        document.querySelector('.main').appendChild(anchor);
        const script = document.createElement('script');
        script.textContent = 'window.__xss_dom=1';
        document.querySelector('.main').appendChild(script);
        return true;
      })()`);
      const surface = await runProbe(page, probeInjectionSurface, Object.values(XSS_PAYLOADS));
      const failures = [];
      if (!injected) failures.push('负控注入没有执行');
      if (!surface.inlineHandlers.length) failures.push('DOM 里真的存在 on* 属性，扫描器却没有报（on* 检测无效）');
      if (!surface.javascriptUrls.length) failures.push('DOM 里真的存在 javascript: URL，扫描器却没有报（URL 检测无效）');
      if (surface.inlineScripts < 1) failures.push('DOM 里真的存在注入的 inline <script>，扫描器却没有报（inline script 计数无效）');
      assert.equal(failures.length, 0, failures.join('\n'));
    } finally {
      await context.close().catch(() => {});
    }
  });

  tracePhase?.('admin-security', { seedingFailures: seeded.errors.length, surfaces: trace.surfaces.length });
  return { trace, seeded };
}

/** The absolute href of the first visible match (used to open a drawer URL). */
async function firstHrefWith(page, selector, base) {
  const locator = page.locator(selector).first();
  if (!(await locator.count())) return null;
  const href = await locator.getAttribute('href');
  if (!href) return null;
  return href.startsWith('http') ? href : new URL(href, `${base}/admin/auth`).href;
}

async function checkWrite(outputRoot, name, value) {
  await fs.mkdir(outputRoot, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(outputRoot, name), JSON.stringify(value, null, 1)).catch(() => {});
}

/** Exported for the unit test: the auditor is a pure function over sources. */
export { clientSinkFailures };
