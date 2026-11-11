// Admin design gate — the two items of Wave R that are **user decisions, not prototype parity**, plus
// the preview-card fix that was a real visible difference.
//
// Why a separate scene:
//   * Q12 (2026-10-18, user decision): the native `<select>` option list cannot be styled, so the
//     owner asked for the expanded list to be drawn by the plane. There is nothing to compare with
//     the prototype for the OPEN state — asserting "identical to the prototype" would be false by
//     construction. What IS asserted: the popup exists and paints the selected row, the closed
//     control still measures like the prototype's own `.sel`, and the real `<select>` stays in the
//     form so a submit carries the picked value.
//   * Q10 (2026-10-18, user decision): the prototype's `.ibtn.mobile-only[data-act=mmenu]` is a dead
//     marker (no rule, no handler), so the narrow-screen menu is an ADDITION the plane has to define:
//     overlay + scrim + focus + Esc + `pushState`, and a server-rendered `?nav=1` state so it works
//     without the script.
//   * Q11 (PAID BACK, ruling R9): it measured the 定时授权 page's 「当前状态预览」 card (its height, the
//     no-JS submit button that collapsed once the enhancement ran, the in-place verdict). Task 3 froze
//     the legacy page, so the card and its criterion went with the surface. Task 6 rebuilt that surface
//     as the per-Vault constraint editor, and the criterion is measured again there: the preview card
//     must be read-only, it must measure like the prototype's own card, and it must say which backend
//     decides. The retired `?capq=` capability-picker scene is paid back the same way, by the operation
//     picker's scene below (closed state, popup, keyboard mirror, negative controls).
//
// Every criterion here carries its own negative control, and each control says which judgement it
// expects to see red, so a green run cannot be an artefact of a probe that reports the same thing
// whatever happens.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderAuditPage } from '../../src/admin/pages/audit.js';
import { ADMIN_SSR_CSS } from '../../src/admin/assets/ssr-css.js';
import { PROTO_CSS } from '../../src/admin/assets/proto-css.js';

const AUTHZ = '/admin/auth/access-policy';
/**
 * R9's two payback scenes live in their own module (`admin-layout-constraints.mjs`): they measure the
 * per-Vault constraint editor, this module measures the shell-level design decisions, and the
 * line-budget rule keeps one scene file under 800 lines. Both are registered from `admin-layout.mjs`,
 * so a red run still names which criterion broke.
 */
/**
 * Q12's surface: the audit page. It is the one page whose `.sel.sm` controls still exist — the frozen
 * legacy editor renders no form and no select — and the prototype draws the same toolbar as `.sel.sm`.
 */
const AUDIT = '/admin/auth?tab=audit';
const NARROW = { width: 390, height: 844 };
const WIDE = { width: 1440, height: 900 };

async function login(context, base, password) {
  const response = await context.request.post(`${base}/admin/auth/login`, { form: { password }, maxRedirects: 0 });
  assert.equal(response.status(), 303, 'the design scene must be able to log in');
}

/* ------------------------------------------------------------------ Q12: self-drawn select */

/**
 * The judgement Q12's negative controls re-use: everything the popup must satisfy, expressed over the
 * live DOM. Returns failure strings (empty = healthy).
 */
const JUDGE_SELECT = () => {
  const failures = [];
  // The first enhanced select on the page, and ITS proxy. The negative controls move the select out of
  // its form and delete the popup; the judge must still find the control (otherwise a control "passes"
  // by losing the element it was meant to judge).
  const select = document.querySelector('select.sel[data-select-native]');
  if (!select) return ['页面上没有 select.sel'];
  const form = select.form;
  const sibling = select.nextElementSibling;
  const proxy = sibling && sibling.hasAttribute('data-select-proxy') ? sibling : document.querySelector('[data-select-proxy]');
  if (!proxy) failures.push('没有自绘控件（[data-select-proxy]）');
  if (!form) failures.push('真实 select 不在表单里（提交拿不到值）');
  if (proxy) {
    if (!proxy.classList.contains('sel')) failures.push('自绘控件的封闭态不是原型 .sel 形态');
    if (proxy.getAttribute('role') !== 'combobox') failures.push('自绘控件没有 role=combobox');
    if (proxy.getAttribute('aria-expanded') !== 'true' && document.querySelector('[data-select-popup]')) failures.push('弹层打开时 aria-expanded 不是 true');
  }
  const popup = document.querySelector('[data-select-popup]');
  if (!popup) {
    failures.push('弹层不存在（data-select-popup）');
    return failures;
  }
  if (popup.parentElement !== document.body) failures.push('弹层没有挂在 body 上（会被容器裁切）');
  if (getComputedStyle(popup).position !== 'fixed') failures.push('弹层不是 position:fixed');
  const options = [...popup.querySelectorAll('[role=option]')];
  if (!options.length) failures.push('弹层里没有 role=option');
  const selected = options.filter((option) => option.getAttribute('aria-selected') === 'true');
  if (selected.length !== 1) failures.push(`选中项的 aria-selected 不是恰好一个（${selected.length}）`);
  for (const option of selected) {
    if (!option.classList.contains('on')) failures.push('选中项没有 .on 样式');
    const check = option.querySelector('.sel-check');
    if (!check || getComputedStyle(check).visibility !== 'visible') failures.push('选中项没有可见的勾选标记');
    const paint = getComputedStyle(option).backgroundColor;
    const token = getComputedStyle(document.documentElement).getPropertyValue('--sel').trim();
    if (token && paint.replace(/\s/g, '') === 'rgba(0,0,0,0)') failures.push('选中项没有底色（--sel 未生效）');
  }
  if (proxy && selected.length === 1) {
    const expected = options.find((option) => option.dataset.value === select.value);
    if (expected && expected !== selected[0]) failures.push('弹层的选中项与真实 select 的值不一致');
    if (String(proxy.textContent).trim() !== String(select.options[select.selectedIndex]?.label ?? '').trim()) {
      failures.push('自绘控件上显示的值与真实 select 不一致');
    }
  }
  return failures;
};

const OPEN_SELECT = () => {
  const select = document.querySelector('select.sel[data-select-native]');
  const sibling = select ? select.nextElementSibling : null;
  const proxy = sibling && sibling.hasAttribute('data-select-proxy') ? sibling : document.querySelector('[data-select-proxy]');
  if (!proxy) return false;
  proxy.click();
  return true;
};

/* ------------------------------------------------------------------ Q10: narrow-screen nav */

/** The narrow-screen menu as the *server* rendered it (the no-JS state). */
const JUDGE_SSR_NAV = () => {
  const failures = [];
  const toggle = document.querySelector('[data-nav-toggle]');
  if (!toggle) return ['页栏没有移动端菜单控件（[data-nav-toggle]）'];
  const href = String(toggle.getAttribute('href') || '').trim();
  const expanded = toggle.getAttribute('aria-expanded') === 'true';
  if (!href) failures.push('菜单控件没有 href：无脚本时不可用');
  else if (!/^\/admin\/auth/.test(href)) failures.push(`菜单控件的 href 不是管理端 URL：${href}`);
  // Open: the same control is the way BACK (no `nav=1` in its href). Closed: it is the way to the
  // server's open state (`?nav=1`). Either half missing is a dead end without the script.
  if (expanded && /nav=1/.test(href)) failures.push('打开状态的菜单控件没有指回关闭后的 URL（无脚本时关不掉）');
  if (!expanded && !/nav=1/.test(href)) failures.push('关闭状态的菜单控件没有指向服务端 ?nav=1 状态');
  if (!expanded) return failures;
  if (toggle.getAttribute('aria-controls') !== 'admin-nav') failures.push('aria-controls 没有指向侧栏');
  const side = document.querySelector('aside#admin-nav');
  if (!side) return [...failures, '侧栏没有 id=admin-nav'];
  if (!side.classList.contains('nav-open')) failures.push('侧栏没有覆盖层展开状态（nav-open）');
  if (side.getAttribute('role') !== 'dialog') failures.push('覆盖层侧栏没有 role=dialog');
  // The no-JS state is a real server state; its ARIA must not over-claim. At a wide viewport the
  // sidebar is an ordinary always-visible column, so `aria-modal` there would tell a screen reader that
  // the rest of the page is inert. The client adds `aria-modal` only when it opens the overlay at
  // narrow widths (checked by the JS-on judgement below); the scroll lock is likewise narrow-only
  // (`body.nav-overlay-open` inside @media (max-width:720px)).
  if (side.getAttribute('aria-modal') !== null) failures.push('服务端 ?nav=1 不应声明 aria-modal（宽视口会谎报模态）');
  if (side.getAttribute('role') !== 'dialog') failures.push('覆盖层侧栏没有 role=dialog');
  const close = side.querySelector('[data-nav-close]');
  if (!close) failures.push('覆盖层侧栏没有关闭链接');
  else if (/nav=1/.test(String(close.getAttribute('href') || ''))) failures.push('关闭链接没有回到去掉 nav 的当前 URL');
  const scrim = document.querySelector('#mscrim[data-nav-scrim]');
  if (!scrim) failures.push('覆盖层没有 scrim');
  return failures;
};


export async function registerDesignChecks(ctx, { browser, fixture, repoRoot, protoUrl, outputRoot }) {
  const { check } = ctx;
  const evidence = {};
  const record = async (key, value) => { evidence[key] = value; };

  /* ---------------------------------------------------------------- Q12 */

  await check('admin-design: Q12 自绘下拉（用户裁决的设计变更，非 parity：弹层/选中态/封闭态仍是原型 .sel.sm）', async () => {
    const context = await browser.newContext({ viewport: WIDE, colorScheme: 'dark' });
    const proto = await browser.newContext({ viewport: WIDE, colorScheme: 'dark' });
    const problems = [];
    try {
      await login(context, fixture.base, fixture.password);
      const page = await context.newPage();
      // The audit page is the surface Q12 moved to: it is the page whose `.sel.sm` controls still exist
      // (the frozen legacy editor renders no form and no select at all), and the prototype draws the
      // same toolbar controls as `.sel.sm`.
      await page.goto(`${fixture.base}${AUDIT}`, { waitUntil: 'load' });
      await page.evaluate('document.fonts ? document.fonts.ready : true');
      await page.waitForSelector('select.sel[data-select-native]', { timeout: 5000 });
      const protoPage = await proto.newPage();
      await protoPage.goto(protoUrl(repoRoot, '#/audit'), { waitUntil: 'load' });
      await protoPage.evaluate('document.fonts ? document.fonts.ready : true');

      // 封闭态 = 原型的 `.sel.sm` 形态：同一测量把原型的原生 select 与我们的自绘控件放在一起比。
      // 宽度不比：原型与实现在窄屏/宽屏下的工具栏分配不同，宽度由 flex 决定，不是控件的形态。
      const proxyBox = await page.evaluate(() => {
        const select = document.querySelector('select.sel[data-select-native]');
        const sibling = select ? select.nextElementSibling : null;
        const node = sibling && sibling.hasAttribute('data-select-proxy') ? sibling : null;
        if (!select || !node) return null;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height), borderRadius: style.borderRadius, fontSize: style.fontSize, background: style.backgroundColor, nativeClipped: Boolean(select.hasAttribute('data-select-native')), nativeFrozen: getComputedStyle(select).pointerEvents === 'none', tail: String(node.textContent).trim().slice(-12), field: select.name, options: [...select.options].filter((option) => option.value).length };
      });
      const protoBox = await protoPage.evaluate(() => {
        const node = document.querySelector('select.sel.sm');
        if (!node) return null;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height), borderRadius: style.borderRadius, fontSize: style.fontSize };
      });
      record('q12Boxes', { proxyBox, protoBox });
      if (!proxyBox) problems.push('实现侧没有自绘控件（select.sel + [data-select-proxy]）');
      if (!protoBox) problems.push('原型侧没有可对照的 select.sel.sm');
      if (proxyBox && protoBox) {
        if (proxyBox.height !== protoBox.height) problems.push(`封闭态高度不同：原型 ${protoBox.height} / 实现 ${proxyBox.height}`);
        if (proxyBox.borderRadius !== protoBox.borderRadius) problems.push(`封闭态圆角不同：原型 ${protoBox.borderRadius} / 实现 ${proxyBox.borderRadius}`);
        if (proxyBox.fontSize !== protoBox.fontSize) problems.push(`封闭态字号不同：原型 ${protoBox.fontSize} / 实现 ${proxyBox.fontSize}`);
      }
      if (proxyBox && !proxyBox.nativeClipped) problems.push('真实 select 没有被视觉隐藏（aria-hidden + 裁切）');
      if (proxyBox && proxyBox.nativeFrozen !== true) problems.push('真实 select 仍然接收指针事件（会把点击抢走）');
      if (proxyBox && proxyBox.options < 2) problems.push(`被自绘的控件只有 ${proxyBox.options} 个非空选项，无法证明选择与提交`);

      // 弹层：打开 → 判据（含选中态样式）全绿。
      await page.evaluate(OPEN_SELECT);
      await page.waitForSelector('[data-select-popup]', { timeout: 5000 });
      const healthy = await page.evaluate(JUDGE_SELECT);
      if (healthy.length) problems.push(...healthy.map((line) => `[打开弹层] ${line}`));

      const popupStyles = await page.evaluate(() => {
        const option = document.querySelector('[data-select-popup] .sel-opt.on');
        const popup = document.querySelector('[data-select-popup]');
        const select = document.querySelector('select.sel[data-select-native]');
        const sibling = select ? select.nextElementSibling : null;
        const proxy = sibling && sibling.hasAttribute('data-select-proxy') ? sibling : null;
        return {
          position: getComputedStyle(popup).position,
          surface: getComputedStyle(popup).backgroundColor,
          optionHeight: option ? Math.round(option.getBoundingClientRect().height) : null,
          optionPaint: option ? getComputedStyle(option).backgroundColor : null,
          popupWidth: Math.round(popup.getBoundingClientRect().width),
          proxyWidth: proxy ? Math.round(proxy.getBoundingClientRect().width) : null,
        };
      });
      record('q12Popup', popupStyles);
      // `.sm` 档：行高 28（原型 .sel.sm 的档位）。
      if (popupStyles.optionHeight !== 28) problems.push(`弹层行高 ${popupStyles.optionHeight} ≠ 28（.sel.sm 档位）`);
      if (popupStyles.position !== 'fixed') problems.push(`弹层 position=${popupStyles.position} ≠ fixed（会被容器裁切）`);
      // “宽度对齐控件”：弹层的最小宽度跟随控件本身（不是 viewport，也不是内容）。
      if (popupStyles.popupWidth !== null && popupStyles.proxyWidth !== null && Math.abs(popupStyles.popupWidth - popupStyles.proxyWidth) > 2) {
        problems.push(`弹层宽度 ${popupStyles.popupWidth} 没有对齐控件 ${popupStyles.proxyWidth}`);
      }

      // Esc 关闭并把焦点还给控件；再开一次，用键盘选一项并验证镜像 + change。
      await page.keyboard.press('Escape');
      await page.waitForTimeout(120);
      const afterEsc = await page.evaluate(() => {
        const select = document.querySelector('select.sel[data-select-native]');
        const sibling = select ? select.nextElementSibling : null;
        const proxy = sibling && sibling.hasAttribute('data-select-proxy') ? sibling : null;
        return { open: Boolean(document.querySelector('[data-select-popup]')), focusOnProxy: Boolean(proxy) && document.activeElement === proxy };
      });
      if (afterEsc.open) problems.push('Esc 没有关闭弹层');
      if (!afterEsc.focusOnProxy) problems.push('Esc 关闭后焦点没有还给控件');

      // 键盘选一项：镜像回真实 select，并由工具栏自己的 GET 提交带出去。
      //
      // The audit toolbar is a `form[method=get]` and `admin-feature-lists.js` navigates on `change`
      // (the prototype's scripted `data-af` behaviour), so this block must read the mirror
      // SYNCHRONOUSLY and the submit evidence is the URL the client navigated to — not a hand-rolled
      // `requestSubmit()`, which the client's in-place path never uses.
      const keyboard = await page.evaluate(async () => {
        const select = document.querySelector('select.sel[data-select-native]');
        const sibling = select ? select.nextElementSibling : null;
        const proxy = sibling && sibling.hasAttribute('data-select-proxy') ? sibling : null;
        if (!select || !proxy) return null;
        const changes = [];
        select.addEventListener('change', () => changes.push(select.value));
        proxy.focus();
        const press = (key) => proxy.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        press('ArrowDown');
        press('ArrowDown');
        press('Enter');
        const wanted = [...select.options].filter((option) => option.value).map((option) => option.value);
        return {
          changes, value: select.value, wanted, field: select.name, inForm: Boolean(select.form),
          proxyText: String(proxy.textContent).trim(),
          optionLabel: String(select.options[select.selectedIndex]?.label ?? '').trim(),
        };
      });
      record('q12Keyboard', keyboard);
      if (!keyboard) problems.push('键盘镜像无法进行：页面上没有可操作的自绘控件');
      else {
        if (!keyboard.changes.length) problems.push('键盘选择没有派发 change（镜像失败）');
        if (!keyboard.value || !keyboard.wanted.includes(keyboard.value)) problems.push(`键盘选择后的值不在选项里：${keyboard.value}`);
        if (keyboard.proxyText !== keyboard.optionLabel) problems.push(`自绘控件的文案与选中项不一致：${keyboard.proxyText} ≠ ${keyboard.optionLabel}`);
        if (!keyboard.inForm) problems.push('真实 select 不在表单里（提交拿不到值）');
        // The picked value has to reach the real form's submission.
        await page.waitForFunction((field) => new URLSearchParams(location.search).get(field) !== null, keyboard.field, { timeout: 5000 }).catch(() => {});
        const carried = new URL(page.url()).searchParams.get(keyboard.field);
        if (carried === null) problems.push('选中后表单没有提交（URL 上没有该字段）');
        else if (carried !== keyboard.value) problems.push(`提交带的值 ${carried} ≠ select 的值 ${keyboard.value}`);
      }

      // type-ahead：按一个真实（未选中）选项的首字母，第一次按键就要跳到以它开头的选项。
      // A fresh load, because the keyboard step above let the toolbar navigate.
      await page.goto(`${fixture.base}${AUDIT}`, { waitUntil: 'load' });
      await page.waitForSelector('select.sel[data-select-native]', { timeout: 5000 });
      const typeahead = await page.evaluate(() => {
        const select = document.querySelector('select.sel[data-select-native]');
        const sibling = select ? select.nextElementSibling : null;
        const proxy = sibling && sibling.hasAttribute('data-select-proxy') ? sibling : null;
        if (!select || !proxy) return null;
        const target = [...select.options].find((option) => option.value && !option.selected && /^[\x20-\x7e\u4e00-\u9fff]/.test(String(option.label).trim()));
        if (!target) return null;
        const first = String(target.label).trim()[0];
        const before = select.value;
        proxy.focus();
        proxy.dispatchEvent(new KeyboardEvent('keydown', { key: first, bubbles: true, cancelable: true }));
        // Synchronous: the mirror runs on the same tick, the toolbar's navigation comes later.
        return { first, before, after: select.value, label: String(select.options[select.selectedIndex]?.label ?? '').trim() };
      });
      record('q12Typeahead', typeahead);
      if (!typeahead) problems.push('type-ahead 无法进行：没有可跳转的选项');
      else if (!typeahead.after || !typeahead.label.toLowerCase().startsWith(String(typeahead.first).toLowerCase())) {
        problems.push(`type-ahead 没有跳到以「${typeahead.first}」开头的选项（现在是「${typeahead.label}」）`);
      }

      // 负控：三个破坏各自必须让判据真红（顺序从“轻”到“重”：先只断开镜像，再拆弹层，最后把真实
      // select 移出表单，每步只在前一步的破坏上再叠一层，判据必须报出对应那一条）。
      const controls = await context.newPage();
      await controls.goto(`${fixture.base}${AUDIT}`, { waitUntil: 'load' });
      await controls.waitForSelector('select.sel[data-select-native]', { timeout: 5000 });
      await controls.evaluate(OPEN_SELECT);
      await controls.waitForSelector('[data-select-popup]', { timeout: 5000 });
      const clean = await controls.evaluate(JUDGE_SELECT);
      if (clean.length) problems.push(`负控基线不干净（打开弹层后就已经有失败）：${JSON.stringify(clean)}`);
      const breakMirror = await controls.evaluate(() => {
        const select = document.querySelector('select.sel[data-select-native]');
        if (!select || !select.options.length) return false;
        select.selectedIndex = select.options.length - 1;
        return true;
      });
      const afterMirror = await controls.evaluate(JUDGE_SELECT);
      if (!breakMirror) problems.push('负控 1 无法进行：没有可改的 select');
      else if (!afterMirror.some((line) => line.includes('与真实 select 不一致'))) problems.push(`负控 1（断开镜像）没有被判红：${JSON.stringify(afterMirror)}`);
      const removePopup = await controls.evaluate(() => { const node = document.querySelector('[data-select-popup]'); const had = Boolean(node); node?.remove(); return had; });
      const afterRemovePopup = await controls.evaluate(JUDGE_SELECT);
      if (!removePopup) problems.push('负控 2 无法进行：没有弹层可移除');
      else if (!afterRemovePopup.some((line) => line.includes('弹层不存在'))) problems.push(`负控 2（移除弹层）没有被判红：${JSON.stringify(afterRemovePopup)}`);
      // 负控 3: the real control loses its form association (`form=<missing id>` ⇒ `select.form` is
      // null). Appending it to `body` instead would work too, but then the FIRST enhanced select in
      // document order becomes a different control and the judgement would report on that one.
      const moveSelect = await controls.evaluate(() => {
        const select = document.querySelector('select.sel[data-select-native]');
        if (!select) return false;
        select.setAttribute('form', 'no-such-form-for-this-control');
        return true;
      });
      const afterMove = await controls.evaluate(JUDGE_SELECT);
      if (!moveSelect) problems.push('负控 3 无法进行：没有 select');
      else if (!afterMove.some((line) => line.includes('不在表单里'))) problems.push(`负控 3（把真实 select 移出表单）没有被判红：${JSON.stringify(afterMove)}`);
    } finally {
      await context.close().catch(() => {});
      await proto.close().catch(() => {});
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  /* ---------------------------------------------------------------- Q10 (JS on) */

  await check('admin-design: Q10 窄屏导航（用户裁决的设计新增：覆盖层/scrim/焦点/Esc/pushState）', async () => {
    const context = await browser.newContext({ viewport: NARROW, colorScheme: 'dark', isMobile: false });
    const problems = [];
    try {
      await login(context, fixture.base, fixture.password);
      const page = await context.newPage();
      await page.goto(`${fixture.base}${AUTHZ}`, { waitUntil: 'load' });
      await page.waitForTimeout(120);

      const visible = await page.evaluate(() => {
        const toggle = document.querySelector('[data-nav-toggle]');
        if (!toggle) return { present: false };
        const rect = toggle.getBoundingClientRect();
        return { present: true, width: Math.round(rect.width), height: Math.round(rect.height), display: getComputedStyle(toggle).display, expanded: toggle.getAttribute('aria-expanded') };
      });
      record('q10Toggle', visible);
      if (!visible.present) problems.push('窄屏下页栏没有菜单按钮');
      else {
        if (visible.display === 'none' || visible.width === 0) problems.push('窄屏下菜单按钮不可见');
        if (visible.expanded !== 'false') problems.push('初始 aria-expanded 不是 false');
      }

      await page.evaluate('window.__waveR = 1');
      const navigations = await page.evaluate(() => performance.getEntriesByType('navigation').length);
      await page.click('[data-nav-toggle]');
      await page.waitForTimeout(150);
      const open = await page.evaluate(() => {
        const side = document.querySelector('aside#admin-nav');
        const scrim = document.querySelector('#mscrim');
        const toggle = document.querySelector('[data-nav-toggle]');
        return {
          alive: window.__waveR === 1,
          navigations: performance.getEntriesByType('navigation').length,
          navOpen: Boolean(side?.classList.contains('nav-open')),
          sideVisible: side ? getComputedStyle(side).display !== 'none' : false,
          role: side?.getAttribute('role') ?? null,
          ariaModal: side?.getAttribute('aria-modal') ?? null,
          expanded: toggle?.getAttribute('aria-expanded') ?? null,
          scrimOn: Boolean(scrim && scrim.classList.contains('on')),
          scrollLocked: document.body.classList.contains('nav-overlay-open'),
          focusInside: Boolean(side && side.contains(document.activeElement)),
          url: `${location.pathname}${location.search}`,
        };
      });
      record('q10Open', { open, navigations });
      if (!open.alive || open.navigations !== navigations) problems.push('打开菜单触发了整页导航（必须是 pushState）');
      if (!open.navOpen || !open.sideVisible) problems.push('侧栏没有以覆盖层展开');
      if (open.role !== 'dialog' || open.ariaModal !== 'true') problems.push(`覆盖层缺少 dialog 语义（role=${open.role} aria-modal=${open.ariaModal}）`);
      if (open.expanded !== 'true') problems.push('打开后 aria-expanded 不是 true');
      if (!open.scrimOn) problems.push('没有 scrim');
      if (!open.scrollLocked) problems.push('页面滚动没有锁定');
      if (!open.focusInside) problems.push('焦点没有移入侧栏');
      if (!/nav=1/.test(open.url)) problems.push(`打开后 URL 没有 nav=1：${open.url}`);

      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      const closed = await page.evaluate(() => ({
        navOpen: Boolean(document.querySelector('aside#admin-nav')?.classList.contains('nav-open')),
        expanded: document.querySelector('[data-nav-toggle]')?.getAttribute('aria-expanded'),
        focusOnToggle: document.activeElement === document.querySelector('[data-nav-toggle]'),
        scrimOn: Boolean(document.querySelector('#mscrim')?.classList.contains('on')),
        url: `${location.pathname}${location.search}`,
        alive: window.__waveR === 1,
      }));
      record('q10Closed', closed);
      if (closed.navOpen) problems.push('Esc 没有关闭覆盖层');
      if (closed.expanded !== 'false') problems.push('关闭后 aria-expanded 不是 false');
      if (closed.scrimOn) problems.push('关闭后 scrim 仍然可见');
      if (!closed.focusOnToggle) problems.push('关闭后焦点没有还给按钮');
      if (/nav=1/.test(closed.url)) problems.push(`关闭后 URL 仍然带 nav=1：${closed.url}`);
      if (!closed.alive) problems.push('关闭菜单触发了整页重载');

      // scrim 点击也关闭；再打开且点一个导航项就离开本页。
      await page.click('[data-nav-toggle]');
      await page.waitForTimeout(150);
      // The scrim covers the whole viewport and the sidebar sits above its left edge, so click the
      // part of the scrim that is really exposed.
      await page.click('#mscrim', { position: { x: NARROW.width - 12, y: 420 } });
      await page.waitForTimeout(200);
      const afterScrim = await page.evaluate(() => Boolean(document.querySelector('aside#admin-nav')?.classList.contains('nav-open')));
      if (afterScrim) problems.push('点击 scrim 没有关闭覆盖层');
      await page.click('[data-nav-toggle]');
      await page.waitForTimeout(200);
      const beforeNavItem = page.url();
      await page.click('aside#admin-nav a.ni[href*="tab=accounts"]');
      await page.waitForTimeout(900);
      record('q10NavItem', { before: beforeNavItem, after: page.url() });
      if (!/tab=accounts/.test(page.url())) problems.push(`点击导航项后没有到达目标页：${beforeNavItem} → ${page.url()}`);
    } finally {
      await context.close().catch(() => {});
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  /* ---------------------------------------------------------------- Q10 (no JS) */

  await check('admin-design: Q10 无 JS 路径（?nav=1 服务端状态 + 关闭链接；反证：拿掉状态/拿掉 href 即红）', async () => {
    const context = await browser.newContext({ viewport: NARROW, javaScriptEnabled: false });
    const problems = [];
    try {
      await login(context, fixture.base, fixture.password);
      const page = await context.newPage();
      await page.goto(`${fixture.base}${AUTHZ}?nav=1`, { waitUntil: 'load' });
      await page.waitForTimeout(80);
      const open = await page.evaluate(JUDGE_SSR_NAV);
      record('q10NoJs', { open: open.length ? open : 'clean' });
      problems.push(...open.map((line) => `[?nav=1] ${line}`));
      const navItem = await page.evaluate(() => {
        const link = document.querySelector('aside#admin-nav a.ni[href*="tab=accounts"]');
        return link ? link.getAttribute('href') : null;
      });
      if (!navItem) problems.push('?nav=1 的覆盖层里没有可跳转的导航项');

      // 反证 1：把服务端的展开状态从 DOM 里拿掉（模拟“?nav=1 不生效”），同一判据必须红。
      await page.goto(`${fixture.base}${AUTHZ}?nav=1`, { waitUntil: 'load' });
      const strippedState = await page.evaluate(() => {
        const side = document.querySelector('aside#admin-nav');
        const scrim = document.querySelector('#mscrim[data-nav-scrim]');
        side?.classList.remove('nav-open');
        scrim?.remove();
        return Boolean(side);
      });
      const closedState = await page.evaluate(JUDGE_SSR_NAV);
      if (!strippedState) problems.push('反证 1 无法进行：没有侧栏');
      else if (!closedState.some((line) => line.includes('nav-open'))) problems.push(`反证 1（拿掉 ?nav=1 服务端状态）没有被判红：${JSON.stringify(closedState)}`);

      // 反证 2：把菜单控件改成纯 data-act（没有 href）→ 无脚本路径不可用，必须红。
      await page.goto(`${fixture.base}${AUTHZ}?nav=1`, { waitUntil: 'load' });
      const stripped = await page.evaluate(() => {
        const toggle = document.querySelector('[data-nav-toggle]');
        if (!toggle) return false;
        toggle.removeAttribute('href');
        toggle.setAttribute('data-act', 'mmenu');
        return true;
      });
      const afterStrip = await page.evaluate(JUDGE_SSR_NAV);
      if (!stripped) problems.push('反证 2 无法进行：没有菜单控件');
      else if (!afterStrip.some((line) => line.includes('没有 href'))) problems.push(`反证 2（菜单控件没有 href）没有被判红：${JSON.stringify(afterStrip)}`);

      // 无脚本下点导航项必须真的跳转（渲染器视角，不是 JS）。
      await page.goto(`${fixture.base}${AUTHZ}?nav=1`, { waitUntil: 'load' });
      const target = await page.evaluate(() => document.querySelector('aside#admin-nav a.ni[href*="tab=accounts"]')?.getAttribute('href') ?? null);
      if (!target) problems.push('无脚本页面拿不到导航项 href');
      else {
        await page.goto(`${fixture.base}${new URL(target, fixture.base).pathname}${new URL(target, fixture.base).search}`, { waitUntil: 'load' });
        const landed = await page.evaluate(() => ({ app: document.querySelector('.app')?.dataset.tab ?? null, hasTable: Boolean(document.querySelector('.main .tbl')) }));
        record('q10NoJsLanding', landed);
        if (landed.app !== 'accounts') problems.push(`无脚本点导航没有到达 accounts：${landed.app}`);
      }
    } finally {
      await context.close().catch(() => {});
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  /* ------------------------------------------------------------------ M 端（issues #603/#606/#607） */

  /**
   * Two measured properties of the mobile surface, neither of which the prototype fixes for us:
   *   * the bottom 「更多」 popover must stay inside the viewport on a 320–412px phone (issue #606);
   *   * the audit pager must not grow with the number of records (issue #607) — 2000 rows used to emit
   *     80 links / ~1.5k px. The pager is measured on a *rendered* page with a synthetic 2000-row
   *     snapshot, because seeding 2000 real audited actions in the fixture would test the seeder.
   * #603 (left clipping reported from a device screenshot) is NOT asserted here: it does not reproduce
   * in a fixture, so this gate must not pretend to cover it.
   */
  await check('admin-design: M 端几何（320/360/390/412：更多弹层不越界 + 分页不再随记录数增长）', async () => {
    const problems = [];
    const measured = [];

    // A) 「更多」弹层：真服务器 + 真浏览器，四个宽度逐个开弹层量。
    for (const width of [320, 360, 390, 412]) {
      const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: 'dark' });
      try {
        await login(context, fixture.base, fixture.password);
        const page = await context.newPage();
        await page.goto(`${fixture.base}${AUDIT}`, { waitUntil: 'load' });
        const opened = await page.evaluate(() => {
          const details = document.querySelector('.mnav .mmore');
          if (!details) return false;
          details.open = true;
          return true;
        });
        if (!opened) { problems.push(`${width}px：没有底部「更多」槽位`); continue; }
        const box = await page.evaluate(() => {
          const menu = document.querySelector('.mnav .mmore > .menu');
          const rect = menu.getBoundingClientRect();
          const item = menu.querySelector('a, .ni');
          return {
            left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width),
            viewport: window.innerWidth,
            itemDirection: item ? getComputedStyle(item).flexDirection : null,
            docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        });
        measured.push({ width, ...box });
        if (box.left < -1) problems.push(`${width}px：「更多」弹层左侧越界 ${box.left}`);
        if (box.right > box.viewport + 1) problems.push(`${width}px：「更多」弹层右侧越界（${box.right} > ${box.viewport}）`);
        if (box.width < 180) problems.push(`${width}px：「更多」弹层只有 ${box.width}px（跟随了槽位宽度）`);
        if (box.itemDirection !== 'row') problems.push(`${width}px：弹层菜单项继承了底导航的纵向排列（${box.itemDirection}）`);
        if (box.docOverflow > 1) problems.push(`${width}px：页面出现横向溢出 ${box.docOverflow}px`);
      } finally {
        await context.close().catch(() => {});
      }
    }

    // A2) 每一页都不许有内部横向滚动（业主 2026-10-20：「所有有表格的页都有问题」）。
    // 这一条覆盖 access-policy 的 .fut 芯片与只读策略视图的 fieldset，两处都曾让 .content 横向
    // 可滚 → scrollIntoView 把左边缘推出视口，正是实机截图里「左侧裁切」的机制。
    //
    // The legacy editor is a read-only `?edit=` view now (`?new=1` renders the frozen list: there is no
    // editor form to open), and a policy id is generated, so it is read from the list page's own rows.
    let policyViewPath = null;
    const probeContext = await browser.newContext();
    try {
      await login(probeContext, fixture.base, fixture.password);
      const listHtml = await (await probeContext.request.get(`${fixture.base}/admin/auth/access-policy`)).text();
      const policyId = /access-policy\?id=([0-9a-fA-F-]{8,})/.exec(listHtml)?.[1] ?? null;
      if (policyId) policyViewPath = `/admin/auth/access-policy?edit=${policyId}`;
    } finally {
      await probeContext.close().catch(() => {});
    }
    const PAGES_TO_SCAN = [
      ['overview', '/admin/auth?tab=overview'], ['accounts', '/admin/auth?tab=accounts'],
      ['keys', '/admin/auth?tab=keys'], ['clients', '/admin/auth?tab=clients'],
      ['tokens', '/admin/auth?tab=tokens'], ['publishes', '/admin/auth?tab=publishes'],
      ['audit', '/admin/auth?tab=audit'], ['access-policy', '/admin/auth/access-policy'],
      ...(policyViewPath ? [['access-policy-view', policyViewPath]] : []), ['vault-git', '/admin/auth/vault-git'],
    ];
    for (const width of [320, 390, 412]) {
      const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: 'dark' });
      try {
        await login(context, fixture.base, fixture.password);
        const page = await context.newPage();
        for (const [label, href] of PAGES_TO_SCAN) {
          await page.goto(`${fixture.base}${href}`, { waitUntil: 'load' });
          const scan = await page.evaluate(() => {
            const content = document.querySelector('.content');
            const offenders = [];
            for (const el of document.querySelectorAll('body *')) {
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              if (rect.left < -1 || rect.right > window.innerWidth + 1) {
                const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
                offenders.push(`${el.tagName.toLowerCase()}${cls}`);
                if (offenders.length >= 3) break;
              }
            }
            return {
              docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              contentOverflow: content ? content.scrollWidth - content.clientWidth : 0,
              offenders,
            };
          });
          measured.push({ width, label, ...scan });
          if (scan.docOverflow > 1) problems.push(`${width}px ${label}：页面横向溢出 ${scan.docOverflow}px`);
          if (scan.contentOverflow > 1) problems.push(`${width}px ${label}：内容区可横向滚动 ${scan.contentOverflow}px ${JSON.stringify(scan.offenders)}`);
        }
      } finally {
        await context.close().catch(() => {});
      }
    }

    // B) 分页：2000 条记录渲染出来的真实 HTML + 真实样式，在窄屏量节点数与几何。
    const syntheticRow = (index) => ({
      at: Date.now() - index * 60_000,
      ok: index % 7 !== 0,
      action: 'mcp.tool_call',
      credential: `API Key · 长凭据名称-${index}`,
      origin: `10.0.${index % 250}.${(index * 7) % 250}`,
      source: `obsidian-mcp-server/agent-${index}`,
      target: `_Workspace/40-Projects/note-${index}.md`,
    });
    const rendered = renderAuditPage({ snapshot: { audit: Array.from({ length: 2000 }, (_, index) => syntheticRow(index)) }, query: {}, csrf: 'gate-csrf', admin: { username: 'mobile' }, base: '/admin/auth' }).content;
    const pagerForm = /<form class="inline-form" method="get" action="\/admin\/auth">(.*?)<\/form>/s.exec(rendered)?.[1] ?? '';
    if (!/name="tab" value="audit"/.test(pagerForm)) problems.push('每页条数表单里没有 tab=audit（#604 会跳回概览）');
    const pagerHtml = /<div class="pg">(.*?)<\/div>/s.exec(rendered)?.[1] ?? '';
    const linkCount = (pagerHtml.match(/<a /g) || []).length + (pagerHtml.match(/<span class="(?:on|gap)"/g) || []).length;
    if (linkCount === 0) problems.push('分页器没有渲染任何页码');
    if (linkCount > 12) problems.push(`分页器渲染了 ${linkCount} 个页码节点（应与总页数无关，≤12）`);
    measured.push({ pagerLinks: linkCount });

    for (const width of [320, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      try {
        await page.setContent(`<!doctype html><html><head><style>${PROTO_CSS}${ADMIN_SSR_CSS}</style></head><body class="app"><div class="main"><div class="content scroll"><div class="page wide">${rendered}</div></div></div></body></html>`);
        const geometry = await page.evaluate(() => {
          const pg = document.querySelector('.pager .pg');
          const rect = pg.getBoundingClientRect();
          const offenders = [...document.querySelectorAll('body *')]
            .filter((el) => { const box = el.getBoundingClientRect(); return box.width > 0 && (box.left < -1 || box.right > window.innerWidth + 1); })
            .slice(0, 5)
            .map((el) => `${el.tagName.toLowerCase()}.${(typeof el.className === 'string' ? el.className : '').trim().split(/\s+/)[0] || ''}`);
          return { right: Math.round(rect.right), children: pg.children.length, viewport: window.innerWidth, offenders, docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        });
        measured.push({ width, pager: geometry });
        if (geometry.children > 12) problems.push(`${width}px：分页器 ${geometry.children} 个节点`);
        if (geometry.right > geometry.viewport + 1) problems.push(`${width}px：分页器右侧越界（${geometry.right} > ${geometry.viewport}）`);
        if (geometry.offenders.length) problems.push(`${width}px：页面上仍有元素越界 ${JSON.stringify(geometry.offenders)}`);
        if (geometry.docOverflow > 1) problems.push(`${width}px：页面出现横向溢出 ${geometry.docOverflow}px`);
      } finally {
        await page.close().catch(() => {});
      }
    }

    // 负控：把弹层改回修复前的形态（左锚定 + min-width 180px），判据必须报右侧越界。
    const negative = await browser.newContext({ viewport: { width: 320, height: 800 }, colorScheme: 'dark' });
    try {
      await login(negative, fixture.base, fixture.password);
      const page = await negative.newPage();
      await page.goto(`${fixture.base}${AUDIT}`, { waitUntil: 'load' });
      await page.addStyleTag({ content: '.mnav .mmore > .menu{left:0;right:auto;min-width:180px}' });
      const broken = await page.evaluate(() => {
        const details = document.querySelector('.mnav .mmore');
        if (!details) return null;
        details.open = true;
        const rect = document.querySelector('.mnav .mmore > .menu').getBoundingClientRect();
        return { right: Math.round(rect.right), viewport: window.innerWidth };
      });
      if (!broken) problems.push('负控无法进行：没有「更多」槽位');
      else if (broken.right <= broken.viewport + 1) problems.push(`负控（弹层改回左锚定）没有被判红：${broken.right} <= ${broken.viewport}`);
      measured.push({ negativeControl: broken });
    } finally {
      await negative.close().catch(() => {});
    }

    record('mobileGeometry', measured);
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  await fs.mkdir(outputRoot, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(outputRoot, 'admin-design-evidence.json'), JSON.stringify(evidence, null, 2)).catch(() => {});
}
