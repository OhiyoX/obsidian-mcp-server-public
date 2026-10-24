// Admin no-JS gate — with scripting **disabled**, every page category must still complete one real
// write through its own markup (`<a href>` / `<form method="post">`), against the real server.
//
// Why this exists as a browser scene (and not only as HTTP tests): the claim under test is about the
// *markup* — "the plane is fully usable when the script never runs" — so the write has to be driven
// by clicking the rendered control in a scriptless browser, and the result has to be read back from
// the rendered page. The categories follow the lane brief: 账户 / Key / 客户端 / Token / 发布 / 审计 /
// 策略 / Git 修复.
//
// State is created by this scene itself wherever a destructive action is involved (a throwaway
// account, a throwaway DCR client with a real authorization-code grant, its own publication and its
// own policy), so the rows other scenes measure stay untouched. Two habits keep the assertions
// honest: a value is looked for **in a table row** (never in the whole page text, where a flash
// message would satisfy the check for a write that never landed), and a refusal is verified by
// re-opening the list instead of trusting the refusal page's own wording.
//
// The Git-repair category needs a *broken* config store, which the store only reads at boot, so it
// runs against its own short-lived fixture (`prepareData` plants the corrupt file first) and asserts
// that fixture's teardown too.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startAdminLayoutFixture } from './admin-layout-fixture.mjs';
import { REPAIR_CONFIRM_TEXT } from '../../src/admin/pages/vaults.js';

const VIEWPORT = { width: 1440, height: 900 };
const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' };

/* ------------------------------------------------------------------ scriptless plumbing */

async function noJsLogin(context, base, password) {
  const login = await context.request.post(`${base}/admin/auth/login`, { form: { password }, maxRedirects: 0 });
  assert.equal(login.status(), 303, 'the no-JS scene must be able to log in');
}

async function open(page, url) {
  const response = await page.goto(url, { waitUntil: 'load' });
  assert.ok(response, `no response for ${url}`);
  return response;
}

/** Rows of the main table whose text contains `needle` (the only place a value proves a write). */
function rows(page, needle) {
  return page.locator('.main .tbl tbody tr').filter({ hasText: needle });
}

/** Re-open a list page and report whether the row is (still) there — the state assertion. */
async function rowPresent(page, { base, url, needle }) {
  await open(page, `${base}${url}`);
  return (await rows(page, needle).count()) > 0;
}

/** The markup the write goes through, asserted before the write itself. */
async function assertRealPostForm(page, { selector, action, typed = null }) {
  const form = page.locator(selector).first();
  assert.ok(await form.count(), `无 JS 路径必须存在表单：${selector}`);
  const method = ((await form.getAttribute('method')) || 'get').toLowerCase();
  assert.equal(method, 'post', `${selector} 必须是 method="post"（得到 ${method}）`);
  const actual = await form.getAttribute('action');
  assert.ok(actual && actual.startsWith(action), `${selector} 的 action 是 ${actual}，期望 ${action}…`);
  assert.ok(await form.locator('input[name=csrf]').count() > 0, `${selector} 必须携带 CSRF 字段`);
  if (typed) {
    // A type-to-confirm field that cannot reach the form can never reach the server: the scriptless
    // browser posts the form's own controls (or a control associated through the HTML `form=`
    // attribute). Anything else is a no-JS dead end.
    //
    // The association is read from the browser itself (`input.form` is the resolved *form owner*:
    // the ancestor form, or the form named by the `form=` attribute) instead of comparing `form.id`
    // against the attribute by hand. `HTMLFormElement` has `[LegacyOverrideBuiltIns]` named access,
    // so a control called `id` — and every delete/revoke form carries `<input type=hidden name=id>`
    // — shadows `form.id` with that element, and the hand-rolled comparison silently reports "not
    // associated" for a form that is in fact correctly bound. `field.form` cannot be fooled that way,
    // and it is exactly the relation that decides whether the value is submitted.
    const reachesForm = await page.evaluate(([formSelector, name]) => {
      const form = document.querySelector(formSelector);
      if (!form) return false;
      return [...document.querySelectorAll(`[name="${name}"]`)].some((node) => node.form === form && node.disabled !== true);
    }, [selector, typed]);
    const present = await page.locator(`.modal [name=${typed}]`).count();
    assert.ok(present > 0, `确认页缺少 ${typed} 输入框`);
    assert.ok(reachesForm, `type-to-confirm 输入框 ${typed} 不是 POST 表单 ${selector} 的控件（既不在 form 内，也没有指向它的 form="…"，或已被 disabled）：无 JS 时它不会随表单提交`);
  }
  return form;
}

/** Fill real controls and submit with a real click. */
async function submitForm(page, { formSelector, fields = {}, submitSelector, submitScope = null }) {
  for (const [name, value] of Object.entries(fields)) {
    const input = page.locator(`${formSelector} [name="${name}"]`).first();
    assert.ok(await input.count(), `${formSelector} 里没有名为 ${name} 的字段`);
    await input.fill(String(value));
  }
  const checked = await page.locator(`${formSelector} input[type=checkbox]:checked`).count();
  assert.ok(checked > 0, `${formSelector} 里一个勾选项都没有（无 JS 时默认勾选必须可用）`);
  const submit = (submitScope ? page.locator(submitScope) : page).locator(submitSelector).first();
  assert.ok(await submit.count(), `提交控件不存在：${submitSelector}`);
  await Promise.all([page.waitForLoadState('load'), submit.click()]);
}

/** The client script may be declared in the markup, but with scripting off it must have done nothing. */
async function assertClientDidNothing(page) {
  const snapshot = await page.evaluate(`(() => ({
    scripts: [...document.querySelectorAll('script')].map((node) => ({ src: node.getAttribute('src'), type: node.getAttribute('type') })),
    toast: document.querySelectorAll('#toast').length,
    armed: typeof window.__adminInteraction !== 'undefined',
  }))()`);
  assert.equal(snapshot.toast, 0, '无 JS 时不应出现 toast 节点（增强脚本不该运行）');
  assert.equal(snapshot.armed, false, '无 JS 时增强脚本的观察器不该存在');
  for (const script of snapshot.scripts) {
    assert.equal(script.type, 'module', `无 JS 时页面仍只应声明同源 module，实际 ${JSON.stringify(script)}`);
    assert.ok(String(script.src || '').startsWith('/admin/auth/assets/'), `脚本必须来自同源白名单：${script.src}`);
  }
  return snapshot;
}

/* ------------------------------------------------------------------ category state (real routes) */

async function postForm(request, base, url, fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields || {})) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(key, String(item ?? ''));
  }
  return request.post(`${base}${url}`, { data: body.toString(), headers: FORM_HEADERS, maxRedirects: 0 });
}

async function adminCsrf(request, base) {
  const html = await (await request.get(`${base}/admin/auth?tab=accounts`)).text();
  const match = /name="csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the authenticated Admin page must expose the session CSRF token');
  return match[1];
}

/** A real dynamic client registration, so the clients/tokens categories own their own records. */
async function registerClient(base, name) {
  const response = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [`${base}/callback`], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  });
  const registered = await response.json();
  assert.ok(registered.client_id, `DCR 注册失败：${JSON.stringify(registered).slice(0, 200)}`);
  return registered.client_id;
}

/** A real authorization-code + PKCE exchange, so an active grant exists on the Tokens page. */
async function grantTokens({ base, clientId, username, password, scope = 'obsidian.read' }) {
  const verifier = `l4-noscript-verifier-${crypto.randomBytes(16).toString('hex')}`;
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(`${base}/oauth/authorize`);
  authorize.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: `${base}/callback`, code_challenge: challenge, code_challenge_method: 'S256', state: 'l4', resource: `${base}/mcp`, scope }).toString();
  const consent = await (await fetch(authorize)).text();
  const transaction = /name="transaction" value="([^"]+)"/.exec(consent)?.[1];
  assert.ok(transaction, 'the consent page must expose its transaction id');
  const approved = await fetch(`${base}/oauth/decision`, { method: 'POST', redirect: 'manual', headers: FORM_HEADERS, body: new URLSearchParams({ transaction, username, password, scope, decision: 'allow' }) });
  assert.equal(approved.status, 302, `consent decision must redirect with a code (got ${approved.status})`);
  const code = new URL(approved.headers.get('location')).searchParams.get('code');
  const tokens = await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: FORM_HEADERS, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: `${base}/callback`, resource: `${base}/mcp` }) })).json();
  assert.ok(tokens.refresh_token, `token exchange returned ${JSON.stringify(tokens).slice(0, 160)}`);
  return tokens;
}

async function mcpCall({ base, apiKey, name, args }) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': apiKey };
  const post = async (body, sessionId) => {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: sessionId ? { ...headers, 'mcp-session-id': sessionId } : headers, body: JSON.stringify(body) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { const line = text.split('\n').find((item) => item.startsWith('data: ')); if (line) json = JSON.parse(line.slice(6)); }
    return { sessionId: response.headers.get('mcp-session-id'), json, text };
  };
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'l4-noscript-gate', version: '1.0' } } });
  assert.ok(init.sessionId, `MCP initialize failed: ${init.text.slice(0, 160)}`);
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId);
  const call = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, init.sessionId);
  assert.equal(call.json?.result?.isError, undefined, `MCP ${name} failed: ${call.text.slice(0, 160)}`);
  return call.json.result;
}

/* ------------------------------------------------------------------ the gate */

/** Register one check per category. */
export async function registerNoScriptChecks(ctx, deps) {
  const { check } = ctx;
  const { browser, fixture, root, appRoot, serverErrors = [], outputRoot, tracePhase } = deps;
  const base = fixture.base;
  const trace = { startedAt: new Date().toISOString(), categories: [], gitRepair: null };
  const stamp = Date.now().toString(36);

  const setupContext = await browser.newContext();
  let state;
  try {
    await noJsLogin(setupContext, base, fixture.password);
    const csrf = await adminCsrf(setupContext.request, base);
    const clientName = `l4-noscript-client-${stamp}`;
    const clientId = await registerClient(base, clientName);
    await grantTokens({ base, clientId, username: 'layout-gate', password: fixture.password });
    const publishPath = `notes/l4-noscript-publish-${stamp}.md`;
    await mcpCall({ base, apiKey: fixture.apiKey, name: 'write_note', args: { path: publishPath, overwrite: true, content: '# no-JS publish probe\n' } });
    await mcpCall({ base, apiKey: fixture.apiKey, name: 'manage_publish', args: { action: 'publish', path: publishPath } });
    const policyLabel = `l4-noscript-policy-${stamp}`;
    const policyCreated = await postForm(setupContext.request, base, '/admin/auth/access-policy/create', {
      csrf, label: policyLabel, mode: 'suspend', enabled: 'false', timezone: 'Asia/Shanghai',
      startsAt: '', expiresAt: '', subjects: ['api-key:configured-env'], capabilities: 'scope:obsidian.read',
      weekly: 'mon 00:00-24:00', dateRanges: '',
    });
    assert.equal(policyCreated.status(), 303, '场景自己创建的一次性策略必须成功');
    state = { clientName, clientId, publishPath, policyLabel, account: `l4-noscript-${stamp}`, keyLabel: `无 JS Key ${stamp}` };
  } finally {
    await setupContext.close().catch(() => {});
  }
  trace.state = { clientName: state.clientName, clientId: state.clientId, publishPath: state.publishPath, policyLabel: state.policyLabel, account: state.account };

  const context = await browser.newContext({ viewport: VIEWPORT, javaScriptEnabled: false });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  try {
    await noJsLogin(context, base, fixture.password);

    await check('admin-nojs: 账户 — 无脚本仍能创建真实账户（经真实 POST 表单）', async () => {
      await open(page, `${base}/admin/auth?tab=accounts&id=new`);
      await assertRealPostForm(page, { selector: '#new-account', action: '/admin/auth/oauth/user/create' });
      await assertClientDidNothing(page);
      await submitForm(page, {
        formSelector: '#new-account',
        fields: { username: state.account, displayName: '无 JS 账户', password: `${state.account}-0123456789` },
        submitSelector: 'button[form=new-account]',
      });
      const present = await rowPresent(page, { base, url: '/admin/auth?tab=accounts', needle: state.account });
      assert.ok(present, `创建后账户列表（表格行）里没有 ${state.account}`);
      trace.categories.push({ id: 'accounts', ok: true, account: state.account });
    });

    await check('admin-nojs: Key — 无脚本仍能创建真实 Key（明文一次性展示）', async () => {
      await open(page, `${base}/admin/auth?tab=keys&id=new`);
      await assertRealPostForm(page, { selector: '#new-key', action: '/admin/auth/api-key/create' });
      await assertClientDidNothing(page);
      await submitForm(page, { formSelector: '#new-key', fields: { label: state.keyLabel }, submitSelector: 'button[form=new-key]' });
      const secret = await page.locator('.result .secret code').first().textContent().catch(() => null);
      assert.ok(secret && secret.startsWith('obmcp_'), `创建后必须一次性展示明文 Key，实际 ${String(secret).slice(0, 40)}`);
      const present = await rowPresent(page, { base, url: '/admin/auth?tab=keys', needle: state.keyLabel });
      assert.ok(present, `创建后 Key 列表（表格行）里没有 ${state.keyLabel}`);
      trace.categories.push({ id: 'keys', ok: true, secretPrefix: secret.slice(0, 12) });
    });

    // Token runs before 客户端: deleting a client also removes its grants, so the tokens category
    // needs its own grant to still exist when it revokes it.
    await check('admin-nojs: Token — 无脚本仍能撤销真实授权（撤销刷新 Token）', async () => {
      await open(page, `${base}/admin/auth?tab=tokens`);
      const row = rows(page, state.clientName).first();
      assert.ok(await row.count(), '前置授权（DCR 客户端 + PKCE 交换）没有出现在 Token 列表里');
      await row.locator('details.mn > summary').first().click();
      const revoke = row.locator('a[href*="confirm=token-revoke"][href*="type=refresh"]').first();
      assert.ok(await revoke.count(), 'Token 行菜单里没有撤销刷新 Token 的入口');
      await Promise.all([page.waitForLoadState('load'), revoke.click()]);
      await assertRealPostForm(page, { selector: '.modal form', action: '/admin/auth/oauth/token/revoke' });
      await Promise.all([page.waitForLoadState('load'), page.locator('.modal button[type=submit]').click()]);
      const result = await page.locator('.result').first().textContent().catch(() => '');
      assert.ok(String(result).includes('撤销'), `撤销后没有服务端结果行：${String(result).slice(0, 120)}`);
      await open(page, `${base}/admin/auth?tab=tokens`);
      const after = rows(page, state.clientName).first();
      const text = (await after.count()) ? await after.innerText() : '';
      assert.ok(/已撤销|撤销/.test(text), `撤销后该授权的状态没有变化：${text.replace(/\s+/g, ' ').slice(0, 160)}`);
      trace.categories.push({ id: 'tokens', ok: true, row: text.replace(/\s+/g, ' ').slice(0, 80) });
    });

    await check('admin-nojs: 客户端 — 无脚本仍能删除客户端（type-to-confirm 由服务端校验）', async () => {
      await open(page, `${base}/admin/auth?tab=clients`);
      assert.ok(await rows(page, state.clientName).count() > 0, '前置 DCR 客户端没有出现在列表里');
      const row = rows(page, state.clientName).first();
      await row.locator('details.mn > summary').first().click();
      const link = row.locator('a[href*="confirm=delete"]').first();
      assert.ok(await link.count(), '客户端行菜单里没有删除入口');
      await Promise.all([page.waitForLoadState('load'), link.click()]);
      await assertRealPostForm(page, { selector: '.modal form', action: '/admin/auth/oauth/client/delete', typed: 'confirm' });
      // 1) a wrong confirmation text is refused by the server (no script can bypass that check)
      await page.locator('.modal input[name=confirm]').fill('错的确认文本');
      await Promise.all([page.waitForLoadState('load'), page.locator('.modal button[type=submit]').click()]);
      assert.ok(await rowPresent(page, { base, url: '/admin/auth?tab=clients', needle: state.clientName }), '确认文本不匹配时客户端不应被删除');
      // 2) the exact text deletes it
      await open(page, `${base}/admin/auth?tab=clients&confirm=delete&id=${encodeURIComponent(state.clientId)}`);
      await page.locator('.modal input[name=confirm]').fill(state.clientName);
      await Promise.all([page.waitForLoadState('load'), page.locator('.modal button[type=submit]').click()]);
      assert.ok(!(await rowPresent(page, { base, url: '/admin/auth?tab=clients', needle: state.clientName })), '输入正确确认文本后客户端仍然在列表里');
      trace.categories.push({ id: 'clients', ok: true, clientName: state.clientName });
    });

    await check('admin-nojs: 发布 — 无脚本仍能撤销公开链接', async () => {
      await open(page, `${base}/admin/auth?tab=publishes`);
      const row = rows(page, path.basename(state.publishPath)).first();
      assert.ok(await row.count(), `前置发布记录（${state.publishPath}）没有出现在列表里`);
      await row.locator('details.mn > summary').first().click();
      const revoke = row.locator('a[href*="confirm=publish-revoke"]').first();
      assert.ok(await revoke.count(), '发布行菜单里没有撤销入口');
      await Promise.all([page.waitForLoadState('load'), revoke.click()]);
      await assertRealPostForm(page, { selector: '.modal form', action: '/admin/auth/publish/revoke' });
      await Promise.all([page.waitForLoadState('load'), page.locator('.modal button[type=submit]').click()]);
      const result = await page.locator('.result').first().textContent().catch(() => '');
      assert.ok(String(result).includes('撤销'), `撤销后没有服务端结果行：${String(result).slice(0, 120)}`);
      await open(page, `${base}/admin/auth?tab=publishes`);
      const after = rows(page, path.basename(state.publishPath)).first();
      const text = (await after.count()) ? await after.innerText() : '';
      assert.ok(!/公开中/.test(text), `撤销后该记录仍显示为公开中：${text.replace(/\s+/g, ' ').slice(0, 160)}`);
      trace.categories.push({ id: 'publishes', ok: true, result: String(result).trim().slice(0, 80) });
    });

    await check('admin-nojs: 审计 — 无脚本仍能清空审计日志（服务端校验确认文本）', async () => {
      await open(page, `${base}/admin/auth?tab=audit`);
      const before = await page.locator('.main .tbl tbody tr').count();
      await page.locator('.main .bar details.mn > summary').first().click();
      const link = page.locator('.main .bar details.mn .menu a[href*="confirm=clear"]').first();
      assert.ok(await link.count(), '审计页没有 ?confirm=clear 入口');
      await Promise.all([page.waitForLoadState('load'), link.click()]);
      await assertRealPostForm(page, { selector: '.modal form', action: '/admin/auth/audit/clear', typed: 'confirm' });
      await page.locator('.modal input[name=confirm]').fill('错的');
      await Promise.all([page.waitForLoadState('load'), page.locator('.modal button[type=submit]').click()]);
      await open(page, `${base}/admin/auth?tab=audit`);
      assert.equal(await page.locator('.main .tbl tbody tr').count(), before, '确认文本错误时审计日志不应被清空');
      await open(page, `${base}/admin/auth?tab=audit&confirm=clear`);
      await page.locator('.modal input[name=confirm]').fill('清空日志');
      await Promise.all([page.waitForLoadState('load'), page.locator('.modal button[type=submit]').click()]);
      const after = await page.locator('.main .tbl tbody tr').count();
      assert.ok(after < before, `清空后记录数没有减少（${before} → ${after}）`);
      trace.categories.push({ id: 'audit', ok: true, before, after });
    });

    await check('admin-nojs: 策略 — 无脚本仍能删除策略（服务端校验策略名）', async () => {
      await open(page, `${base}/admin/auth/access-policy`);
      const row = rows(page, state.policyLabel).first();
      assert.ok(await row.count(), `前置策略（${state.policyLabel}）没有出现在列表里`);
      await row.locator('details.mn > summary').first().click();
      const link = row.locator('a[href*="confirm=delete"]').first();
      assert.ok(await link.count(), '策略行菜单里没有删除入口');
      await Promise.all([page.waitForLoadState('load'), link.click()]);
      await assertRealPostForm(page, { selector: '.modal form', action: '/admin/auth/access-policy/delete', typed: 'confirm' });
      await page.locator('.modal input[name=confirm]').fill('错的策略名');
      await Promise.all([page.waitForLoadState('load'), page.locator('.modal button[type=submit]').click()]);
      assert.ok(await rowPresent(page, { base, url: '/admin/auth/access-policy', needle: state.policyLabel }), '确认文本错误时策略不应被删除');
      await open(page, `${base}/admin/auth/access-policy`);
      const rowAgain = rows(page, state.policyLabel).first();
      await rowAgain.locator('details.mn > summary').first().click();
      await Promise.all([page.waitForLoadState('load'), rowAgain.locator('a[href*="confirm=delete"]').first().click()]);
      await page.locator('.modal input[name=confirm]').fill(state.policyLabel);
      await Promise.all([page.waitForLoadState('load'), page.locator('.modal button[type=submit]').click()]);
      const stillThere = await rowPresent(page, { base, url: '/admin/auth/access-policy', needle: state.policyLabel });
      const serverSaid = await page.locator('.result').first().textContent().catch(() => '');
      assert.ok(!stillThere, `输入正确策略名后策略仍然在列表里（确认值必须随表单提交；删除页返回：${String(serverSaid).replace(/\s+/g, ' ').slice(0, 160)}）`);
      trace.categories.push({ id: 'policies', ok: true, label: state.policyLabel });
    });

    await check('admin-nojs: 无脚本时页面没有 page error，且脚本没有运行', async () => {
      assert.deepEqual(pageErrors, []);
    });
  } finally {
    await context.close().catch(() => {});
  }

  await check('admin-nojs: Git 修复 — 无脚本仍能修复损坏的 Git 配置存储（隔离损坏文件）', async () => {
    const repairRoot = path.join(root, 'admin-layout-noscript-repair');
    await fs.mkdir(repairRoot, { recursive: true });
    const fixtureB = await startAdminLayoutFixture({
      root: repairRoot,
      appRoot,
      serverErrors,
      // The store loads once at boot and fails closed from then on, so the corruption has to be in
      // place before the process starts (`git-config/store.js` reads `<dataRoot>/git-vaults.json`).
      prepareData: async (dataRoot) => { await fs.writeFile(path.join(dataRoot, 'git-vaults.json'), '{ this is not valid json'); },
    });
    const repairContext = await browser.newContext({ viewport: VIEWPORT, javaScriptEnabled: false });
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try { if ((await fetch(`${fixtureB.base}/healthz`)).ok) break; } catch { /* wait */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await noJsLogin(repairContext, fixtureB.base, fixtureB.password);
      const repairPage = await repairContext.newPage();
      const dataRoot = path.join(fixtureB.fixtureRoot, 'data');
      await open(repairPage, `${fixtureB.base}/admin/auth/vault-git`);
      assert.ok(await repairPage.locator('.banner.danger').count(), '损坏的存储必须给出 danger banner');
      const cta = repairPage.locator('a[href*="confirm=repair"]').first();
      assert.ok(await cta.count(), '损坏的存储必须给出 ?confirm=repair 的 GET 入口');
      await Promise.all([repairPage.waitForLoadState('load'), cta.click()]);
      await assertRealPostForm(repairPage, { selector: '.modal form', action: '/admin/auth/vault-git/repair', typed: 'confirm' });
      await repairPage.locator('.modal input[name=confirm]').fill('错的');
      await Promise.all([repairPage.waitForLoadState('load'), repairPage.locator('.modal button[type=submit]').click()]);
      assert.equal((await fs.readdir(dataRoot)).filter((name) => name.endsWith('.broken')).length, 0, '确认文本错误时不应隔离任何文件');
      await open(repairPage, `${fixtureB.base}/admin/auth/vault-git?confirm=repair`);
      await repairPage.locator('.modal input[name=confirm]').fill(REPAIR_CONFIRM_TEXT);
      await Promise.all([repairPage.waitForLoadState('load'), repairPage.locator('.modal button[type=submit]').click()]);
      const isolated = (await fs.readdir(dataRoot)).filter((name) => name.startsWith('git-vaults.json') && name.endsWith('.broken'));
      assert.equal(isolated.length, 1, `修复必须隔离损坏文件（实际 ${JSON.stringify(isolated)}）`);
      const result = await repairPage.locator('.result').first().textContent().catch(() => '');
      assert.ok(String(result).includes('修复'), `修复后必须给出服务端结果行：${String(result).slice(0, 120)}`);
      const intact = await fs.readFile(path.join(dataRoot, isolated[0]), 'utf8');
      assert.equal(intact, '{ this is not valid json', '被隔离的损坏文件必须原样保留（不是删除）');
      trace.gitRepair = { isolated, result: String(result).trim().slice(0, 120), intactBytes: intact.length };
    } finally {
      const shutdown = await fixtureB.stop();
      trace.gitRepair = { ...(trace.gitRepair ?? {}), shutdown };
      await fs.rm(repairRoot, { recursive: true, force: true }).catch(() => {});
      await repairContext.close().catch(() => {});
      assert.equal(shutdown.childExited, true, `修复 fixture 必须被回收：${JSON.stringify(shutdown)}`);
      assert.equal(shutdown.portReleased, true, '修复 fixture 的端口必须释放');
    }
  });

  await fs.mkdir(outputRoot, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(outputRoot, 'admin-noscript-trace.json'), JSON.stringify(trace, null, 1)).catch(() => {});
  tracePhase?.('admin-noscript', { categories: trace.categories.length, gitRepair: Boolean(trace.gitRepair) });
  return { trace };
}

export const NO_SCRIPT_CATEGORIES = Object.freeze(['accounts', 'keys', 'clients', 'tokens', 'publishes', 'audit', 'policies', 'git-repair']);
