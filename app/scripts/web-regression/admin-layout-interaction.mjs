// Admin interaction gate — JS-on behaviour parity against the running prototype, plus the host
// policy (CSP / script inventory / fragment fetch) that makes progressive enhancement safe.
//
// Design (lane l4-gates):
//
//   * **One probe, two trees.** Every measurement comes from `scripts/proto-parity/interaction.mjs`,
//     which is serialized into the page and run on the prototype
//     (`docs/admin-ui-proto/index.html`, the behaviour truth source) and on the live plane. The
//     prototype's own record must satisfy every `both` verdict *before* the live plane is judged:
//     a criterion nobody can satisfy fails as "原型侧基准不成立" instead of reading as a product bug.
//   * **One driver per tree, because the markup differs by design** (the prototype is a hash-routed
//     SPA with `[data-open]` rows and a scripted `#menu`; the plane is server-rendered with
//     `?id=`/`?confirm=` links and `<details class="mn">` menus). The driver only performs user
//     actions; it never measures.
//   * **A negative control per behaviour**: each verdict is re-run on the prototype with a sabotage
//     that breaks exactly that behaviour (`SABOTAGE`), and the verdict must go red. That is what
//     makes "it stayed green" mean something.
//   * **Host verdicts** (`HOST_VERDICT_IDS`) cannot be asked of the prototype — it *is* one inline
//     script — so they are asserted on the live plane with their own controls:
//     a deliberately injected inline `<script>` must be blocked by the browser (proving the
//     violation listener sees enforcement) and a deliberately cross-origin `fetch` must be recorded.
//
// The scene needs a real server, a real Chromium and a real account it may delete; it creates that
// throwaway account itself (the seeded rows other scenes measure stay untouched).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  HOST_VERDICT_IDS, PROTOTYPE_BEHAVIOUR, PROTOTYPE_VERDICT_IDS, armInteractionObservers, interactionVerdicts,
  probeDocumentPolicy, probeDrawerState, probeInteractionObservers, probeKbdState, probeMenuState, probeModalState,
  probeSearchState, probeThemeState, probeToastState,
} from '../proto-parity/interaction.mjs';
import { cspFailures, fragmentFetchPermitted, parseCsp, scriptInventoryFailures } from '../proto-parity/policy.mjs';
import { runProbe } from '../proto-parity/probe.mjs';
import { PARITY_PAGES } from '../proto-parity/spec.mjs';

const VIEWPORT = { width: 1440, height: 900 };
/** The menu criterion is measured in a short viewport so "stays inside the viewport" has to flip. */
const MENU_VIEWPORT = { width: 1440, height: 420 };
/** The interaction areas, so a sabotage run executes only the steps its verdict needs. */
const AREAS = Object.freeze({
  drawer: ['drawer'],
  menu: ['menu'],
  modal: ['modal'],
  toast: ['toast'],
  theme: ['theme'],
  shortcuts: ['shortcuts'],
});
const AREA_OF_VERDICT = Object.freeze({
  'drawer-opens-in-place': 'drawer', 'drawer-back-closes': 'drawer',
  'menu-floats-in-viewport': 'menu', 'menu-closes-on-outside-click': 'menu', 'menu-closes-on-escape': 'menu',
  'modal-centered': 'modal', 'modal-typed-input-focused': 'modal', 'modal-confirm-gated-by-text': 'modal', 'modal-escape-cancels': 'modal',
  'toast-shown-then-expires': 'toast',
  'theme-toggles-without-navigation': 'theme',
  'shortcut-question-mark-opens-panel': 'shortcuts', 'shortcut-slash-focuses-search': 'shortcuts',
});

/**
 * One sabotage per behaviour, applied to the **prototype** (its script is a classic inline script, so
 * `openMenu`, `setTheme`, `showKbd`, … are globals and can be replaced). Each one breaks exactly the
 * behaviour its verdict measures, so a green verdict cannot be an artefact of a probe that reports
 * the same thing whatever happens.
 */
const SABOTAGE = Object.freeze({
  'drawer-opens-in-place': `(() => { document.addEventListener('click', (event) => { const row = event.target.closest && event.target.closest('[data-open]'); if (!row) return; const id = row.dataset.id; setTimeout(() => { location.hash = '#/accounts/' + id; location.reload(); }, 0); }, true); })()`,
  // `addEventListener("popstate", onRoute)` captured the function *value*, so replacing `onRoute`
  // would not change the listener; what actually closes the drawer is `closeDrawer()` inside it,
  // which is late-bound.
  'drawer-back-closes': `closeDrawer = () => {};`,
  'menu-floats-in-viewport': `(() => { const original = openMenu; openMenu = (button, kind, id) => { original(button, kind, id); const menu = document.getElementById('menu'); menu.style.top = '-500px'; menu.style.left = '-500px'; }; })()`,
  'menu-closes-on-outside-click': `closeMenu = () => {};`,
  'menu-closes-on-escape': `closeMenu = () => {};`,
  'modal-centered': `(() => { const original = confirmBox; confirmBox = (options) => { original(options); const modal = document.getElementById('modal'); modal.style.left = '4px'; modal.style.transform = 'none'; }; })()`,
  'modal-typed-input-focused': `(() => { const original = confirmBox; confirmBox = (options) => { original(options); setTimeout(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }, 60); }; })()`,
  'modal-confirm-gated-by-text': `(() => { const original = confirmBox; confirmBox = (options) => { original(options); const ok = document.querySelector('#modal [data-act=mok]'); if (ok) ok.removeAttribute('disabled'); }; })()`,
  'modal-escape-cancels': `closeModal = () => {};`,
  'toast-shown-then-expires': `toast = (message) => { const node = document.getElementById('toast'); node.className = 'toast on'; node.textContent = String(message == null ? '' : message); };`,
  'theme-toggles-without-navigation': `setTheme = () => {};`,
  'shortcut-question-mark-opens-panel': `showKbd = () => {};`,
  // The `/` handler focuses *and selects*, and `select()` focuses the input on its own, so patching
  // `focus` would not break anything: the shortcut itself has to stop being delivered.
  'shortcut-slash-focuses-search': `(() => { document.addEventListener('keydown', (event) => { if (event.key === '/') event.stopImmediatePropagation(); }, true); })()`,
});

/* ------------------------------------------------------------------ form helpers (real HTTP) */

async function postForm(request, base, url, fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields || {})) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(key, String(item ?? ''));
  }
  return request.post(`${base}${url}`, { data: body.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, maxRedirects: 0 });
}

async function csrfFrom(request, base) {
  const response = await request.get(`${base}/admin/auth?tab=accounts`);
  const html = await response.text();
  const match = /name="csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the authenticated Admin page must expose the session CSRF token');
  return match[1];
}

/** A throwaway account this scene may delete, so the seeded rows other scenes measure stay intact. */
async function createThrowawayAccount({ request, base }) {
  const username = `l4-interaction-${Date.now().toString(36)}`;
  const csrf = await csrfFrom(request, base);
  const created = await postForm(request, base, '/admin/auth/oauth/user/create', {
    csrf, username, displayName: 'L4 交互门禁账户', password: `${username}-0123456789`,
    allowedScope: ['obsidian.read'], allowedVault: ['default'],
  });
  assert.equal(created.status(), 303, `创建一次性账户必须成功，实际 ${created.status()}`);
  return { username, csrf };
}

/* ------------------------------------------------------------------ drivers (actions only) */

/** Prototype driver: hash routes, `[data-open]` rows, scripted `#menu`, `[data-act=theme]`. */
function prototypeDriver({ repoRoot, protoUrl, viewport = VIEWPORT }) {
  const row = (page) => page.locator('.tbl tbody tr').last();
  return {
    id: 'proto',
    async goto(page) {
      await page.goto(protoUrl(repoRoot, '#/accounts'), { waitUntil: 'load' });
      await page.evaluate('document.fonts ? document.fonts.ready : true');
      await page.waitForTimeout(80);
    },
    async setViewport(page, size) { await page.setViewportSize(size); },
    async openRow(page) {
      // Click the row's own corner: the prototype's delegated handler ignores clicks that land on a
      // button/anchor/input inside a cell, so a centre click could hit the name link.
      await row(page).click({ position: { x: 3, y: 3 } });
    },
    async openMenu(page) { await row(page).locator('[data-menu]').first().click(); },
    dangerSelector: '#menu [data-mi=del]',
    themeSelector: '.side-foot [data-act=theme]',
    outsideSelector: '.main .bar h1',
    expected: {},
  };
}

/** Live driver: server-rendered links/`<details>`; the enhancement must keep them working in place. */
function liveDriver({ base, username, viewport = VIEWPORT }) {
  const row = (page) => page.locator('.tbl tbody tr').filter({ hasText: username }).first();
  return {
    id: 'live',
    async goto(page) {
      await page.goto(`${base}/admin/auth?tab=accounts`, { waitUntil: 'load' });
      await page.evaluate('document.fonts ? document.fonts.ready : true');
      await page.waitForTimeout(120);
    },
    async setViewport(page, size) { await page.setViewportSize(size); },
    async openRow(page) { await row(page).locator('a.cell-link').first().click(); },
    async openMenu(page) { await row(page).locator('details.mn > summary').first().click(); },
    dangerSelector: '#menu a.dz2, #menu [data-mi=del], details.mn .menu a.dz2, details.mn .menu a[href*="confirm=delete"]',
    themeSelector: '.side-foot form[action$="/theme"] button',
    outsideSelector: '.main .bar h1',
    expected: { username },
  };
}

/* ------------------------------------------------------------------ the scenario steps */

const measure = (page, probe, argument) => runProbe(page, probe, argument);

/**
 * Click the first *visible* match of the selector list. `locator.first()` is not enough: the live
 * row menu renders one `<details class="mn">` per row, so the first danger anchor in DOM order
 * usually sits in a **closed** menu and can never be clicked (lane l4-gates: this made the whole
 * modal step read as "危险入口没找到").
 */
async function clickFirstVisible(page, selectors) {
  for (const selector of selectors.split(',').map((item) => item.trim())) {
    const matches = page.locator(selector);
    const total = await matches.count();
    for (let index = 0; index < total; index += 1) {
      const candidate = matches.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      try { await candidate.click({ timeout: 4000 }); return selector; } catch { /* try the next match / spelling */ }
    }
  }
  return null;
}

async function stepDrawer(page, driver, record) {
  await driver.goto(page);
  const before = await measure(page, probeDrawerState);
  await driver.openRow(page);
  await page.waitForTimeout(300);
  const after = await measure(page, probeDrawerState);
  await page.goBack().catch(() => {});
  await page.waitForTimeout(400);
  const afterBack = await measure(page, probeDrawerState);
  record.rowOpen = { before, after, afterBack };
}

async function stepMenu(page, driver, record) {
  await driver.setViewport(page, MENU_VIEWPORT);
  await driver.goto(page);
  await page.evaluate(`(() => { const rows = document.querySelectorAll('.tbl tbody tr'); if (rows.length) rows[rows.length - 1].scrollIntoView({ block: 'end' }); })()`);
  await page.waitForTimeout(150);
  const closed = await measure(page, probeMenuState);
  await driver.openMenu(page);
  await page.waitForTimeout(300);
  const open = await measure(page, probeMenuState);
  await page.locator(driver.outsideSelector).first().click().catch(() => {});
  await page.waitForTimeout(250);
  const outside = await measure(page, probeMenuState);
  await driver.openMenu(page);
  await page.waitForTimeout(250);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const esc = await measure(page, probeMenuState);
  record.menu = { closed, open, outside, esc };
  await driver.setViewport(page, VIEWPORT);
}

async function stepModal(page, driver, record) {
  await driver.goto(page);
  await driver.openMenu(page);
  await page.waitForTimeout(200);
  const before = await measure(page, probeModalState);
  const clicked = await clickFirstVisible(page, driver.dangerSelector);
  assert.ok(clicked, `[${driver.id}] 危险入口没找到（选择器 ${driver.dangerSelector}）`);
  await page.waitForTimeout(350);
  const open = await measure(page, probeModalState);
  const target = open.typedTarget ?? '';
  let typed = null;
  let wrong = null;
  if (open.typedPresent) {
    await page.keyboard.type(target, { delay: 8 });
    await page.waitForTimeout(200);
    typed = await measure(page, probeModalState);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);
    wrong = await measure(page, probeModalState);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const esc = await measure(page, probeModalState);
  record.modal = { before, open, typed, wrong, esc, target };
}

async function stepToast(page, driver, record) {
  await driver.goto(page);
  await driver.openMenu(page);
  await page.waitForTimeout(200);
  const clicked = await clickFirstVisible(page, driver.dangerSelector);
  assert.ok(clicked, `[${driver.id}] 危险入口没找到（选择器 ${driver.dangerSelector}）`);
  await page.waitForTimeout(300);
  const modal = await measure(page, probeModalState);
  if (modal.typedPresent && modal.typedTarget) {
    await page.keyboard.type(modal.typedTarget, { delay: 8 });
    await page.waitForTimeout(150);
  }
  const before = await measure(page, probeToastState);
  const confirmed = await clickFirstVisible(page, '#modal [data-act=mok], .modal button[type=submit], .modal .btn.danger, .modal .btn.primary');
  assert.ok(confirmed, `[${driver.id}] 确认按钮没找到`);
  // Wave R: this step used to sample at three fixed offsets (80ms / +1000ms / +2700ms) and the
  // prototype side periodically landed red as `46/47`: under load the toast is created a few tens of
  // milliseconds after the click, so `immediately` sampled nothing, and the expiry was inferred from
  // a total wait instead of from the toast's own disappearance. The MEASUREMENT is now event-based —
  // wait for it to appear, wait for it to be gone — while the criterion keeps its full strength: it
  // must appear, it must still be there 1s in, and its own 3.2s timer must remove it (not before
  // ~2.5s, not stuck beyond the deadline).
  const clickAt = Date.now();
  const appeared = await waitForToast(page, true, 4000);
  await page.waitForTimeout(Math.max(0, 1000 - (Date.now() - clickAt)));
  const at1000 = await measure(page, probeToastState);
  const expired = await waitForToast(page, false, 7000);
  record.toast = {
    before,
    appeared: appeared ?? await measure(page, probeToastState),
    at1000,
    expired,
    appearedAfterMs: appeared ? appeared.at - clickAt : null,
    expiredAfterMs: expired ? expired.at - clickAt : null,
  };
}

/**
 * Poll until the toast is (or is no longer) visible and report WHEN that happened. Returns `null` on
 * timeout. See `stepToast` for why the criterion is measured this way (Wave R: the fixed offsets made
 * the prototype side flake as `46/47`; the criterion itself is unchanged).
 */
async function waitForToast(page, visible, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await measure(page, probeToastState);
    if (state.toastVisible === visible) return { ...state, at: Date.now() };
    await page.waitForTimeout(50);
  }
  return null;
}

async function stepTheme(page, driver, record) {
  await driver.goto(page);
  const before = await measure(page, probeThemeState);
  await page.keyboard.press('t');
  await page.waitForTimeout(250);
  const after = await measure(page, probeThemeState);
  await page.locator(driver.themeSelector).first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const afterClick = await measure(page, probeThemeState);
  record.theme = { before, after, afterClick };
}

async function stepShortcuts(page, driver, record) {
  await driver.goto(page);
  const closed = await measure(page, probeKbdState);
  await page.keyboard.press('?');
  await page.waitForTimeout(300);
  const open = await measure(page, probeKbdState);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  await page.locator(driver.outsideSelector).first().click().catch(() => {});
  await page.waitForTimeout(150);
  const searchBefore = await measure(page, probeSearchState);
  await page.keyboard.press('/');
  await page.waitForTimeout(250);
  const searchAfter = await measure(page, probeSearchState);
  record.kbd = { closed, open };
  record.search = { before: searchBefore, after: searchAfter };
}

/**
 * Run the requested areas and return `{ record, observers }`. `record.observers` is the aggregate of
 * every step's observer report (violations, cross-origin attempts, HTML sinks) — the same page
 * cannot hold them across navigations, so every step contributes its own reading.
 */
async function runSteps(page, driver, areaIds) {
  const record = {};
  const observers = [];
  for (const area of areaIds) {
    if (area === 'drawer') await stepDrawer(page, driver, record);
    else if (area === 'menu') await stepMenu(page, driver, record);
    else if (area === 'modal') await stepModal(page, driver, record);
    else if (area === 'toast') await stepToast(page, driver, record);
    else if (area === 'theme') await stepTheme(page, driver, record);
    else if (area === 'shortcuts') await stepShortcuts(page, driver, record);
    record[`${area}Observers`] = await measure(page, probeInteractionObservers);
    observers.push({ area, ...record[`${area}Observers`] });
  }
  const aggregate = {
    violations: observers.flatMap((entry) => entry.violations ?? []),
    crossOrigin: observers.flatMap((entry) => entry.crossOrigin ?? []),
    htmlSinks: observers.flatMap((entry) => entry.htmlSinks ?? []),
    actions: observers.reduce((total, entry) => total + (entry.actions ?? 0), 0),
    pushStates: observers.reduce((total, entry) => total + (entry.pushStates ?? 0), 0),
    perArea: observers.map((entry) => ({ area: entry.area, violations: (entry.violations ?? []).length, crossOrigin: (entry.crossOrigin ?? []).length, htmlSinks: (entry.htmlSinks ?? []).length, actions: entry.actions ?? 0 })),
  };
  return { record: { ...record, observers: aggregate }, observers };
}

/* ------------------------------------------------------------------ registration */

const ALL_AREAS = Object.freeze(['drawer', 'menu', 'modal', 'toast', 'theme', 'shortcuts']);

/**
 * Register the interaction + host-policy checks.
 * `deps`: `{ browser, fixture, repoRoot, protoUrl, outputRoot, tracePhase }`.
 */
export async function registerInteractionChecks(ctx, deps) {
  const { check } = ctx;
  const { browser, fixture, repoRoot, protoUrl, outputRoot, tracePhase } = deps;
  const base = fixture.base;

  // ---------------------------------------------------------------- host policy (HTTP level)
  const authedContext = await browser.newContext({ viewport: VIEWPORT });
  const openContext = await browser.newContext({ viewport: VIEWPORT });
  const trace = { startedAt: new Date().toISOString(), headers: {}, pages: [], reference: null, live: null, sabotages: [] };
  try {
    const login = await authedContext.request.post(`${base}/admin/auth/login`, { form: { password: fixture.password }, maxRedirects: 0 });
    assert.equal(login.status(), 303, 'the interaction scene must be able to log in');

    // 1. the frozen CSP header, byte for byte, plus the properties it encodes
    await check('admin-interaction: CSP 响应头 = D0 冻结值（script-src \'self\'，无 unsafe-inline/unsafe-eval/第三方）', async () => {
      const targets = [
        ['list', `${base}/admin/auth?tab=accounts`, authedContext.request],
        ['authz', `${base}${PARITY_PAGES.find((entry) => entry.id === 'authz').live}`, authedContext.request],
        ['vaults', `${base}${PARITY_PAGES.find((entry) => entry.id === 'vaults').live}`, authedContext.request],
        ['login (未认证)', `${base}/admin/auth/login`, openContext.request],
      ];
      const failures = [];
      for (const [id, url, request] of targets) {
        const response = await request.get(url, { maxRedirects: 0 });
        const header = response.headers()['content-security-policy'] ?? null;
        trace.headers[id] = header;
        failures.push(...cspFailures(header).map((line) => `[${id}] ${line}`));
        if (!header) continue;
        const directives = parseCsp(header);
        if (!(directives['script-src'] ?? []).includes("'self'")) failures.push(`[${id}] script-src 里没有 'self'`);
      }
      await fs.writeFile(path.join(outputRoot, 'admin-interaction-headers.json'), JSON.stringify(trace.headers, null, 1)).catch(() => {});
      assert.equal(failures.length, 0, `${failures.length} 条策略差异：\n${failures.join('\n')}`);
    });

    // 2. script inventory of every page: same-origin module only, no inline, no on*=, no javascript:
    await check('admin-interaction: 脚本策略（已认证页只有白名单同源 module / 0 inline / 0 on*= / 0 javascript:）', async () => {
      const failures = [];
      const policyPage = await authedContext.newPage();
      try {
        for (const entry of PARITY_PAGES) {
          await policyPage.goto(`${base}${entry.live}`, { waitUntil: 'load' });
          const inventory = await runProbe(policyPage, probeDocumentPolicy);
          const lines = scriptInventoryFailures(inventory, { authenticated: true });
          trace.pages.push({ id: entry.id, url: entry.live, scripts: inventory.scripts, inlineHandlers: inventory.inlineHandlers.length, javascriptUrls: inventory.javascriptUrls.length });
          failures.push(...lines.map((line) => `[${entry.id}] ${line}`));
        }
      } finally {
        await policyPage.close().catch(() => {});
      }
      const openPage = await openContext.newPage();
      try {
        for (const url of ['/admin/auth/login']) {
          await openPage.goto(`${base}${url}`, { waitUntil: 'load' });
          const inventory = await runProbe(openPage, probeDocumentPolicy);
          trace.pages.push({ id: url, url, scripts: inventory.scripts, inlineHandlers: inventory.inlineHandlers.length, javascriptUrls: inventory.javascriptUrls.length });
          failures.push(...scriptInventoryFailures(inventory, { authenticated: false }).map((line) => `[${url}] ${line}`));
        }
      } finally {
        await openPage.close().catch(() => {});
      }
      await fs.writeFile(path.join(outputRoot, 'admin-interaction-script-policy.json'), JSON.stringify(trace.pages, null, 1)).catch(() => {});
      assert.equal(failures.length, 0, `${failures.length} 条脚本策略差异：\n${failures.join('\n')}`);
    });

    // 3. the negative control that makes the violation counter trustworthy
    await check('admin-interaction: 负控 — 注入 inline script 必须被浏览器拦下（违规监听真的能看见阻断）', async () => {
      const page = await authedContext.newPage();
      try {
        await page.goto(`${base}/admin/auth?tab=accounts`, { waitUntil: 'load' });
        await runProbe(page, armInteractionObservers);
        const result = await page.evaluate(`(async () => {
          const inline = document.createElement('script');
          inline.textContent = 'window.__inlineRan = true';
          document.head.appendChild(inline);
          const external = document.createElement('script');
          external.src = 'https://example.invalid/blocked.js';
          document.head.appendChild(external);
          await new Promise((resolve) => setTimeout(resolve, 250));
          const state = window.__adminInteraction;
          return { inlineRan: window.__inlineRan === true, violations: state.violations.map((item) => item.directive), blocked: state.violations.map((item) => item.blockedURI) };
        })()`);
        const problems = [];
        if (result.inlineRan) problems.push('注入的 inline script 竟然执行了：CSP 没有生效或 script-src 被放宽');
        if (!result.violations.some((directive) => directive.startsWith('script-src'))) problems.push(`注入 inline script 后没有 script-src 违规记录：${JSON.stringify(result.violations)}`);
        if (!result.blocked.some((uri) => uri.includes('example.invalid'))) problems.push(`注入第三方脚本后没有记录被挡的 URL：${JSON.stringify(result.blocked)}`);
        trace.sabotages.push({ id: 'inline-script-blocked', ...result });
        assert.equal(problems.length, 0, problems.join('\n'));
      } finally {
        await page.close().catch(() => {});
      }
    });

    // 4. the fragment path the enhancement's drawer/menu/modal use
    await check('admin-interaction: 同源 fragment fetch 可用且 0 CSP 违规（connect-src 不得回落到 default-src \'none\'）', async () => {
      const page = await authedContext.newPage();
      try {
        await page.goto(`${base}/admin/auth?tab=accounts`, { waitUntil: 'load' });
        await runProbe(page, armInteractionObservers);
        const fragment = await page.evaluate(`(async () => {
          const violations = [];
          const listener = (event) => violations.push({ directive: event.violatedDirective, blockedURI: String(event.blockedURI || '').slice(0, 90) });
          document.addEventListener('securitypolicyviolation', listener);
          let ok = false; let status = null; let length = null; let error = null;
          try {
            const response = await fetch(location.href, { credentials: 'same-origin', headers: { 'x-admin-fragment': '1' } });
            status = response.status;
            const text = await response.text();
            length = text.length;
            ok = response.ok;
          } catch (caught) { error = String(caught && caught.message ? caught.message : caught); }
          await new Promise((resolve) => setTimeout(resolve, 80));
          document.removeEventListener('securitypolicyviolation', listener);
          return { ok, status, length, error, violations };
        })()`);
        const failures = interactionVerdicts['fragment-fetch-allowed']({ fragment });
        const header = trace.headers.list;
        if (!fragmentFetchPermitted(header)) failures.push(`策略里 connect-src 回落到 default-src：${JSON.stringify(parseCsp(header)['connect-src'] ?? parseCsp(header)['default-src'])}（需要显式 connect-src 'self'）`);
        trace.fragment = fragment;
        assert.equal(failures.length, 0, failures.join('\n'));
      } finally {
        await page.close().catch(() => {});
      }
    });
  } finally {
    await authedContext.close().catch(() => {});
    await openContext.close().catch(() => {});
  }

  // ---------------------------------------------------------------- reference + live records
  const httpContext = await browser.newContext({ viewport: VIEWPORT });
  let throwaway = null;
  try {
    const httpLogin = await httpContext.request.post(`${base}/admin/auth/login`, { form: { password: fixture.password }, maxRedirects: 0 });
    assert.equal(httpLogin.status(), 303, 'the interaction scene needs an authenticated request context');
    throwaway = await createThrowawayAccount({ request: httpContext.request, base });
  } finally {
    await httpContext.close().catch(() => {});
  }
  trace.throwaway = { username: throwaway.username };
  trace.behaviours = PROTOTYPE_BEHAVIOUR.map((entry) => ({ id: entry.id, plane: entry.plane, proto: entry.proto, requires: entry.requires }));

  const protoContext = await browser.newContext({ viewport: VIEWPORT });
  const liveContext = await browser.newContext({ viewport: VIEWPORT });
  await protoContext.addInitScript({ content: `(${armInteractionObservers.toString()})();` });
  await liveContext.addInitScript({ content: `(${armInteractionObservers.toString()})();` });
  let reference;
  let live;
  let runError = null;
  try {
    const auth = await liveContext.request.post(`${base}/admin/auth/login`, { form: { password: fixture.password }, maxRedirects: 0 });
    assert.equal(auth.status(), 303, 'the interaction scene needs its own authenticated live context');

    const protoPage = await protoContext.newPage();
    const protoErrors = [];
    protoPage.on('pageerror', (error) => protoErrors.push(String(error)));
    reference = await runSteps(protoPage, prototypeDriver({ repoRoot, protoUrl }), ALL_AREAS);
    reference.pageErrors = protoErrors;

    const livePage = await liveContext.newPage();
    const liveErrors = [];
    livePage.on('pageerror', (error) => liveErrors.push(String(error)));
    live = await runSteps(livePage, liveDriver({ base, username: throwaway.username }), ALL_AREAS);
    live.pageErrors = liveErrors;
  } catch (error) {
    // A driver that cannot find the markup is a *finding* (about the plane's markup or the
    // prototype's), so it turns the behaviour checks below red instead of aborting the scene setup.
    runError = String(error?.message || error).split('\n')[0];
  } finally {
    await protoContext.close().catch(() => {});
    await liveContext.close().catch(() => {});
  }
  const record = { reference: reference?.record ?? null, live: live?.record ?? null, runError };
  trace.reference = record.reference;
  trace.live = record.live;
  trace.runError = runError;
  await fs.mkdir(outputRoot, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(outputRoot, 'admin-interaction-record.json'), JSON.stringify(record, null, 1)).catch(() => {});

  /** Every behaviour check needs a completed scenario; a driver failure is reported as its own red. */
  const requireRun = (bundle) => {
    if (runError) assert.fail(`行为场景未能跑完（无法判定该行为）：${runError}`);
    if (!bundle) assert.fail('行为场景没有产出记录（无法判定该行为）');
    return bundle;
  };

  // 5. the prototype must satisfy every behaviour verdict (fail closed)
  await check('admin-interaction: 原型侧基准成立（每条行为判据都能在原型上通过）', async () => {
    const bundle = requireRun(record.reference);
    const failures = [];
    for (const id of PROTOTYPE_VERDICT_IDS) {
      failures.push(...interactionVerdicts[id](bundle).map((line) => `[${id}] ${line}`));
    }
    failures.push(...(reference?.pageErrors ?? []).map((error) => `[pageerror] ${error}`));
    assert.equal(failures.length, 0, `${failures.length} 条基准差异：\n${failures.join('\n')}`);
  });

  // 6. the live plane, judged with exactly the same functions
  const liveGroups = [
    ['抽屉（点行 / history / Back）', ['drawer-opens-in-place', 'drawer-back-closes']],
    ['⋯ 菜单（浮层 / 视口内 / 外点 / Esc）', ['menu-floats-in-viewport', 'menu-closes-on-outside-click', 'menu-closes-on-escape']],
    ['危险操作确认框（居中 / 聚焦 / 文本门禁 / Esc）', ['modal-centered', 'modal-typed-input-focused', 'modal-confirm-gated-by-text', 'modal-escape-cancels']],
    ['toast（出现 / 1s 仍在 / 3.2s 消失）', ['toast-shown-then-expires']],
    ['主题（t 键与侧栏按钮，均不导航）', ['theme-toggles-without-navigation']],
    ['快捷键（? 面板 / / 聚焦搜索）', ['shortcut-question-mark-opens-panel', 'shortcut-slash-focuses-search']],
  ];
  for (const [title, ids] of liveGroups) {
    await check(`admin-interaction: 实现侧 ${title}`, async () => {
      const bundle = requireRun(record.live);
      const failures = [];
      for (const id of ids) failures.push(...interactionVerdicts[id](bundle).map((line) => `[${id}] ${line}`));
      if (ids.includes('drawer-opens-in-place')) failures.push(...(live?.pageErrors ?? []).map((error) => `[pageerror] ${error}`));
      // A typed modal the enhancement could not gate must be VISIBLE, never silent (review v31-r1 ③):
      // locking the operator (F1) and quietly dropping the gate are both failures.
      if (ids.includes('modal-confirm-gated-by-text') && bundle.modal?.open?.typedDegraded) {
        failures.push('打字确认模态被标记为 data-typed-gate-degraded：声明了打字门禁却找不到目标串（既不该锁死操作员，也不该静默不设防）');
      }
      assert.equal(failures.length, 0, `${failures.length} 条差异：\n${failures.join('\n')}`);
    });
  }

  // 7. host verdicts on the live record (policy already asserted at HTTP level; these are the runtime halves)
  await check('admin-interaction: 实现侧 隐私（全程 0 CSP 违规 / 0 跨源请求）+ 值只用 textContent', async () => {
    const bundle = requireRun(record.live);
    const failures = [
      ...HOST_VERDICT_IDS.filter((id) => id === 'no-cross-origin-and-no-csp-violation' || id === 'client-writes-values-with-textContent')
        .flatMap((id) => interactionVerdicts[id](bundle).map((line) => `[${id}] ${line}`)),
    ];
    assert.equal(failures.length, 0, `${failures.length} 条差异：\n${failures.join('\n')}`);
  });

  // 8. the confirmation dialogue's structure and geometry must be the prototype's
  await check('admin-interaction: 确认框结构与几何与原型一致（逐子元素 ±8px）', async () => {
    const expected = requireRun(record.reference).modal?.open ?? null;
    const actual = requireRun(record.live).modal?.open ?? null;
    if (!expected?.box) assert.fail('原型侧没有测到确认框，无法对照');
    if (!actual?.box) assert.fail('实现侧没有测到确认框（确认框没出现）');
    const failures = [];
    for (const key of ['left', 'top', 'width']) {
      const delta = Math.abs(expected.box[key] - actual.box[key]);
      if (delta > 8) failures.push(`${key}: 原型 ${expected.box[key]} / 实现 ${actual.box[key]}（差 ${delta}px）`);
    }
    const expectedOutline = expected.outline ?? [];
    const actualOutline = actual.outline ?? [];
    const render = (outline) => outline.map((node) => `${node.tag}${node.classes ? `.${node.classes}` : ''}@${node.height}`).join(' | ');
    if (expectedOutline.length !== actualOutline.length) {
      failures.push(`子元素个数不同：原型 ${expectedOutline.length}（${render(expectedOutline)}）/ 实现 ${actualOutline.length}（${render(actualOutline)}）`);
    } else {
      for (let index = 0; index < expectedOutline.length; index += 1) {
        const [left, right] = [expectedOutline[index], actualOutline[index]];
        if (left.tag !== right.tag || left.classes !== right.classes) failures.push(`第 ${index + 1} 个子元素不同：原型 ${left.tag}.${left.classes} / 实现 ${right.tag}.${right.classes}`);
        else if (Math.abs(left.height - right.height) > 8) failures.push(`第 ${index + 1} 个子元素高度不同：原型 ${left.tag}.${left.classes}@${left.height} / 实现 @${right.height}`);
      }
    }
    if (expected.typedInsideActions !== actual.typedInsideActions) {
      failures.push(`type-to-confirm 输入框的位置与原型不同：原型 typedInsideActions=${expected.typedInsideActions}（父元素 .${expected.typedParentClasses}）/ 实现 ${actual.typedInsideActions}（父元素 .${actual.typedParentClasses}）`);
    }
    assert.equal(failures.length, 0, `${failures.length} 条差异：\n${failures.join('\n')}`);
  });

  // 8b. The admission bootstrap entry must stay usable WITH the enhancement script. Review v31-r1 found
  //     the blocker this pins: `gateTypedConfirm` adopted the dialog's per-Vault `confirm` CHECKBOX as
  //     the typed gate (a checkbox's `value` is the Vault id, the target string is empty), so the
  //     primary action stayed permanently disabled in every script browser and a fresh deployment still
  //     could not be switched to multi-vault from the UI. The HTTP half (real POST → gate armed) is
  //     pinned by `test/vault-admission-bootstrap.test.js`; this is the browser half.
  await check('admin-interaction: 准入 bootstrap 入口在脚本下可用（主操作未被文本门禁误禁）', async () => {
    const context = await browser.newContext({ viewport: VIEWPORT });
    try {
      const login = await context.request.post(`${base}/admin/auth/login`, { form: { password: fixture.password }, maxRedirects: 0 });
      assert.equal(login.status(), 303, '准入入口探针需要已认证上下文');
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto(`${base}/admin/auth/vault-git`, { waitUntil: 'load' });
      const entry = page.locator('a[href$="?confirm=admission"]');
      assert.equal(await entry.count(), 1, '全新部署必须恰好提供一条准入 bootstrap 入口');
      await entry.click();
      const modal = page.locator('.modal.show');
      await modal.waitFor({ state: 'visible', timeout: 5000 });
      const submit = modal.locator('button[type="submit"]').first();
      assert.equal(await submit.isDisabled(), false, '带脚本时主操作必须可点（文本门禁不得认领复选框）');
      const choices = await modal.evaluate((node) => {
        const form = node.querySelector('form');
        const boxes = [...node.querySelectorAll('input[type=checkbox][name=confirm]')];
        return { total: boxes.length, outsideForm: boxes.filter((box) => !form || box.form !== form).length };
      });
      assert.equal(choices.total > 0, true, '确认框必须携带逐库 confirm 选项');
      assert.equal(choices.outsideForm, 0, '每个 confirm 复选框都必须属于该 POST 表单（否则提交会丢值）');
      assert.deepEqual(errors, [], `页面不得出现 pageerror：${errors.join(' / ')}`);
    } finally {
      await context.close().catch(() => {});
    }
  });

  // 9. per-behaviour negative controls on the prototype
  await check('admin-interaction: 负控 — 破坏原型行为后对应判据必须真红（抽屉/菜单/确认框）', async () => {
    const targets = ['drawer-opens-in-place', 'drawer-back-closes', 'menu-floats-in-viewport', 'menu-closes-on-outside-click', 'menu-closes-on-escape', 'modal-centered', 'modal-typed-input-focused', 'modal-confirm-gated-by-text', 'modal-escape-cancels'];
    const problems = await runSabotages({ browser, repoRoot, protoUrl, targets });
    trace.sabotages.push(...problems.controls);
    assert.equal(problems.failures.length, 0, problems.failures.join('\n'));
  });

  await check('admin-interaction: 负控 — 破坏原型行为后对应判据必须真红（toast/主题/快捷键）', async () => {
    const targets = ['toast-shown-then-expires', 'theme-toggles-without-navigation', 'shortcut-question-mark-opens-panel', 'shortcut-slash-focuses-search'];
    const problems = await runSabotages({ browser, repoRoot, protoUrl, targets });
    trace.sabotages.push(...problems.controls);
    assert.equal(problems.failures.length, 0, problems.failures.join('\n'));
  });

  await fs.writeFile(path.join(outputRoot, 'admin-interaction-trace.json'), JSON.stringify(trace, null, 1)).catch(() => {});
  tracePhase?.('admin-interaction', { referenceAreas: record.reference ? Object.keys(record.reference).length : 0, liveAreas: record.live ? Object.keys(record.live).length : 0, runError });
  return { trace, ...record };
}

/**
 * Run each sabotage on the prototype and require the matching verdict to go red. A sabotage that
 * leaves the verdict green means the verdict does not measure that behaviour.
 */
async function runSabotages({ browser, repoRoot, protoUrl, targets }) {
  const controls = [];
  const failures = [];
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript({ content: `(${armInteractionObservers.toString()})();` });
  try {
    for (const id of targets) {
      const sabotage = SABOTAGE[id];
      if (!sabotage) { failures.push(`[${id}] 没有对应的负控实现`); continue; }
      const page = await context.newPage();
      const areas = AREAS[AREA_OF_VERDICT[id]];
      const baseDriver = prototypeDriver({ repoRoot, protoUrl });
      // The sabotage has to be re-applied after every load: each step navigates, and a sabotage
      // injected once into the previous document is gone (that is exactly how
      // `onRoute = () => {}` used to leave the Back verdict green).
      const driver = {
        ...baseDriver,
        async goto(page_) { await baseDriver.goto(page_); await page_.evaluate(sabotage); },
      };
      try {
        await driver.goto(page);
        const { record: sabotageRecord } = await runSteps(page, driver, areas);
        const lines = interactionVerdicts[id](sabotageRecord);
        const area = AREA_OF_VERDICT[id];
        controls.push({
          id, sabotage, verdictFailures: lines.length, lines: lines.slice(0, 3),
          evidence: JSON.stringify(sabotageRecord[area] ?? sabotageRecord.rowOpen ?? {}).slice(0, 500),
        });
        if (lines.length === 0) failures.push(`[${id}] 破坏行为之后判据仍然全绿：负控无效（sabotage=${sabotage.slice(0, 60)}…）`);
      } catch (error) {
        failures.push(`[${id}] 负控无法执行：${String(error?.message || error).split('\n')[0]}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await context.close().catch(() => {});
  }
  return { controls, failures };
}

export const INTERACTION_SCENE_CONSTANTS = Object.freeze({ VIEWPORT, MENU_VIEWPORT, ALL_AREAS });
// Exported for `test/admin-redo/parity.test.js`: the negative-control table and the area map are part
// of the gate's contract (a verdict without a sabotage would be unproven).
export { SABOTAGE, AREA_OF_VERDICT, ALL_AREAS };
