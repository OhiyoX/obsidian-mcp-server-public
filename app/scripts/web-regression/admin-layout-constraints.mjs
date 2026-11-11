// Admin design gate — ruling R9's payback: the two scenes Task 3 retired, measured again on the
// per-Vault constraint editor (design §6.3, plan Task 6).
//
//   * the operation picker: the retired `?capq=` scene protected the capability control's filter-and-
//     save contract. The editor's picker is one `<select.sel>`, self-drawn by the plane (Q12's design
//     decision), so the criterion is: the CLOSED control measures like the prototype's own `.sel`, the
//     popup opens and paints the selected row, the keyboard mirrors a pick back into the real control,
//     the picked operation reaches the service through a real submit — and every destruction of those
//     facts is red;
//   * the preview card: Q11 measured the legacy 「当前状态预览」 card (height vs the prototype, the
//     no-JS submit button, the in-place verdict). The constraint editor's preview must be READ-ONLY
//     (no form, no control at all), must measure like the prototype's own card, and must state which
//     backend decides — a preview that offers a save is a promise the page cannot keep.
//
// No criterion here names a lane-owned selector: the picker is found by the marker the page itself
// renders (`data-operation-picker`), the card by `data-preview`, and the prototype is the reference for
// both shapes. Negative controls are part of every criterion, so a green run cannot be an artefact of a
// probe that reports the same thing whatever happens.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const WIDE = { width: 1440, height: 900 };
const AUTHZ_NEW = '/admin/auth/authz?new=1';

async function login(context, base, password) {
  const response = await context.request.post(`${base}/admin/auth/login`, { form: { password }, maxRedirects: 0 });
  assert.equal(response.status(), 303, 'the design scene must be able to log in');
}

/**
 * The control these two scenes drive: the editor's operation picker, marked by the page itself so a
 * scene never guesses which `select.sel` is which (the editor also carries the mode and the timezone).
 */
const PICKER = 'select.sel[data-operation-picker]';

/**
 * Ruling R9 paid back: the criteria Q12 proves for the audit toolbar, proved for the operation picker
 * the retired `?capq=` scene used to measure. Every failure is a sentence, so a red run names the
 * break instead of a bare boolean.
 */
const JUDGE_PICKER = (selector) => {
  const failures = [];
  const select = document.querySelector(selector);
  if (!select) return ['页面上没有操作选择器（select.sel[data-operation-picker]）'];
  const sibling = select.nextElementSibling;
  const proxy = sibling && sibling.hasAttribute('data-select-proxy') ? sibling : null;
  if (!proxy) failures.push('操作选择器没有自绘控件（[data-select-proxy]）');
  if (!select.form) failures.push('真实 select 不在表单里（提交拿不到值）');
  if (proxy) {
    if (!proxy.classList.contains('sel')) failures.push('封闭态不再是原型 .sel 形态');
    if (proxy.getAttribute('role') !== 'combobox') failures.push('自绘控件没有 role=combobox');
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
  if (proxy && selected.length === 1) {
    const expected = options.find((option) => option.dataset.value === select.value);
    if (expected && expected !== selected[0]) failures.push('弹层的选中项与真实 select 的值不一致');
    if (String(proxy.textContent).trim() !== String(select.options[select.selectedIndex]?.label ?? '').trim()) {
      failures.push('自绘控件上显示的值与真实 select 不一致');
    }
  }
  return failures;
};

const OPEN_PICKER = (selector) => {
  const select = document.querySelector(selector);
  const sibling = select ? select.nextElementSibling : null;
  const proxy = sibling && sibling.hasAttribute('data-select-proxy') ? sibling : null;
  if (!proxy) return false;
  proxy.click();
  return true;
};

export async function registerConstraintPageChecks(ctx, { browser, fixture, repoRoot, protoUrl, outputRoot }) {
  const { check } = ctx;
  const evidence = {};
  const record = async (key, value) => { evidence[key] = value; };

  /* ---------------------------------------------------------------- R9: operation picker */

  await check('admin-design: R9 操作选择器（封闭态对原型 .sel、弹层、键盘镜像、提交带值，外加负控）', async () => {
    const context = await browser.newContext({ viewport: WIDE, colorScheme: 'dark' });
    const proto = await browser.newContext({ viewport: WIDE, colorScheme: 'dark' });
    const problems = [];
    try {
      await login(context, fixture.base, fixture.password);
      const page = await context.newPage();
      await page.goto(`${fixture.base}${AUTHZ_NEW}`, { waitUntil: 'load' });
      await page.evaluate('document.fonts ? document.fonts.ready : true');
      await page.waitForSelector(PICKER, { timeout: 5000 });
      const protoPage = await proto.newPage();
      await protoPage.goto(protoUrl(repoRoot, '#/authz/new'), { waitUntil: 'load' });
      await protoPage.evaluate('document.fonts ? document.fonts.ready : true');

      // 封闭态 = 原型编辑器自己的 `select.sel` 形态：同高、同圆角、同字号。宽度不比（栏位由布局决定）。
      const closed = await page.evaluate((selector) => {
        const select = document.querySelector(selector);
        const sibling = select ? select.nextElementSibling : null;
        const proxy = sibling && sibling.hasAttribute('data-select-proxy') ? sibling : null;
        if (!select || !proxy) return null;
        const style = getComputedStyle(proxy);
        const rect = proxy.getBoundingClientRect();
        return {
          height: Math.round(rect.height), borderRadius: style.borderRadius, fontSize: style.fontSize,
          options: [...select.options].filter((option) => option.value).length,
          groups: new Set([...select.options].map((option) => option.parentElement?.label).filter(Boolean)).size,
          atoms: [...select.options].map((option) => option.value).filter((value) => value.includes(':')),
        };
      }, PICKER);
      const protoClosed = await protoPage.evaluate(() => {
        const node = document.querySelector('select.sel');
        if (!node) return null;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return { height: Math.round(rect.height), borderRadius: style.borderRadius, fontSize: style.fontSize };
      });
      record('r9PickerClosed', { closed, protoClosed });
      if (!closed) problems.push('实现侧没有操作选择器（select.sel[data-operation-picker] + 自绘控件）');
      if (!protoClosed) problems.push('原型侧没有可对照的 select.sel（编辑器仍应画时区选择）');
      if (closed && protoClosed) {
        if (closed.height !== protoClosed.height) problems.push(`封闭态高度不同：原型 ${protoClosed.height} / 实现 ${closed.height}`);
        if (closed.borderRadius !== protoClosed.borderRadius) problems.push(`封闭态圆角不同：原型 ${protoClosed.borderRadius} / 实现 ${closed.borderRadius}`);
        if (closed.fontSize !== protoClosed.fontSize) problems.push(`封闭态字号不同：原型 ${protoClosed.fontSize} / 实现 ${closed.fontSize}`);
      }
      if (closed && closed.options < 10) problems.push(`选择器只有 ${closed.options} 个操作，无法证明它真的列了目录`);
      if (closed && closed.groups < 2) problems.push(`操作没有按平面分组（optgroup ${closed.groups} 组）`);
      if (closed && closed.atoms.length) problems.push(`选择器里出现了历史原子：${JSON.stringify(closed.atoms.slice(0, 3))}`);

      // 弹层：打开即判，判据全绿。
      const opened = await page.evaluate(OPEN_PICKER, PICKER);
      if (!opened) problems.push('操作选择器无法打开（没有自绘控件）');
      else await page.waitForSelector('[data-select-popup]', { timeout: 5000 });
      const healthy = opened ? await page.evaluate(JUDGE_PICKER, PICKER) : [];
      if (healthy.length) problems.push(...healthy.map((line) => `[打开弹层] ${line}`));

      // 键盘：↓ ↓ Enter 选中一项，镜像回真实 select 并派发 change（表单收到这个值）。
      const keyboard = await page.evaluate((selector) => {
        const select = document.querySelector(selector);
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
        return {
          changes,
          value: select.value,
          label: String(select.options[select.selectedIndex]?.label ?? '').trim(),
          proxyText: String(proxy.textContent).trim(),
          field: select.name,
          inForm: Boolean(select.form),
        };
      }, PICKER);
      record('r9PickerKeyboard', keyboard);
      if (!keyboard) problems.push('键盘镜像无法进行：页面上没有可操作的自绘控件');
      else {
        if (!keyboard.changes.length) problems.push('键盘选择没有派发 change（镜像失败）');
        if (!keyboard.value) problems.push('键盘选择后真实 select 没有值');
        if (keyboard.proxyText !== keyboard.label) problems.push(`自绘控件文案与选中项不一致：${keyboard.proxyText} ≠ ${keyboard.label}`);
        if (!keyboard.inForm) problems.push('真实 select 不在表单里（提交拿不到值）');
      }

      // 提交带值：这就是被退役的 `?capq=` 场景真正保护的东西——选中的能力必须进到服务端。
      if (keyboard && keyboard.value) {
        await page.fill('input[name="label"]', 'gate operation picker');
        const picked = keyboard.value;
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'load' }),
          page.evaluate(() => document.querySelector('form#authz-constraint').requestSubmit()),
        ]);
        const landed = await page.evaluate((value) => ({
          url: `${location.pathname}${location.search}`,
          carried: document.body.innerHTML.includes(value),
          json: /"error"\s*:/.test(document.body.textContent || ''),
        }), picked);
        record('r9PickerSubmit', { picked, landed });
        if (landed.json) problems.push(`保存被拒绝而不是落盘：${landed.url}`);
        else if (!landed.carried) problems.push(`保存后页面上找不到刚选中的操作 ${picked}（${landed.url}）`);
      }

      // 负控：两个破坏各自必须让判据真红。
      const controls = await context.newPage();
      await controls.goto(`${fixture.base}${AUTHZ_NEW}`, { waitUntil: 'load' });
      await controls.waitForSelector(PICKER, { timeout: 5000 });
      await controls.evaluate(OPEN_PICKER, PICKER);
      await controls.waitForSelector('[data-select-popup]', { timeout: 5000 });
      const clean = await controls.evaluate(JUDGE_PICKER, PICKER);
      if (clean.length) problems.push(`负控基线不干净（打开弹层后就已经有失败）：${JSON.stringify(clean)}`);
      const brokeMirror = await controls.evaluate((selector) => {
        const select = document.querySelector(selector);
        // A fresh editor already sits on the placeholder (index 0), so the break has to move the REAL
        // control away from what the popup says: the last operation is the furthest it can go.
        if (!select || select.options.length < 2) return false;
        select.selectedIndex = select.options.length - 1;
        return true;
      }, PICKER);
      const afterMirror = await controls.evaluate(JUDGE_PICKER, PICKER);
      if (!brokeMirror) problems.push('负控 1 无法进行：没有可改的 select');
      else if (!afterMirror.some((line) => line.includes('与真实 select 不一致'))) problems.push(`负控 1（断开镜像）没有被判红：${JSON.stringify(afterMirror)}`);
      const removedPopup = await controls.evaluate(() => { const node = document.querySelector('[data-select-popup]'); const had = Boolean(node); node?.remove(); return had; });
      const afterRemove = await controls.evaluate(JUDGE_PICKER, PICKER);
      if (!removedPopup) problems.push('负控 2 无法进行：没有弹层可移除');
      else if (!afterRemove.some((line) => line.includes('弹层不存在'))) problems.push(`负控 2（移除弹层）没有被判红：${JSON.stringify(afterRemove)}`);
    } finally {
      await context.close().catch(() => {});
      await proto.close().catch(() => {});
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  /* ---------------------------------------------------------------- R9: the preview card */

  /** The read-only preview card, as a judgement over the live DOM (failures as sentences). */
  const JUDGE_PREVIEW = () => {
    const failures = [];
    const card = document.querySelector('[data-preview="constraints"]');
    if (!card) return ['编辑器没有渲染预览卡（[data-preview=constraints]）'];
    for (const forbidden of ['form', 'button', 'input', 'select', 'textarea']) {
      if (card.querySelector(forbidden)) failures.push(`预览卡里有可提交的 <${forbidden}>：它必须只读`);
    }
    if (!card.querySelector('.sumbox')) failures.push('预览卡里没有窗口摘要（.sumbox）');
    if (!card.querySelector('.tl')) failures.push('预览卡里没有 7 天时间窗（.tl）');
    if (!card.querySelector('.verdict')) failures.push('预览卡里没有判定行（.verdict）');
    const decides = card.querySelector('[data-preview-decides]');
    if (!decides) failures.push('预览卡没有声明哪个后端在判定（[data-preview-decides]）');
    return failures;
  };

  await check('admin-design: R9 预览卡（Q11 补账：只读判定 + 与原型同形 ±8px，负控必须红）', async () => {
    const context = await browser.newContext({ viewport: WIDE, colorScheme: 'dark' });
    const proto = await browser.newContext({ viewport: WIDE, colorScheme: 'dark' });
    const problems = [];
    try {
      await login(context, fixture.base, fixture.password);
      const page = await context.newPage();
      await page.goto(`${fixture.base}${AUTHZ_NEW}`, { waitUntil: 'load' });
      await page.evaluate('document.fonts ? document.fonts.ready : true');
      await page.waitForSelector('[data-preview="constraints"]', { timeout: 5000 });
      const protoPage = await proto.newPage();
      await protoPage.goto(protoUrl(repoRoot, '#/authz/new'), { waitUntil: 'load' });
      await protoPage.evaluate('document.fonts ? document.fonts.ready : true');

      // 只读：卡片里没有任何可提交的控件，也没有脚本入口。
      const judged = await page.evaluate(JUDGE_PREVIEW);
      if (judged.length) problems.push(...judged.map((line) => `[只读] ${line}`));

      // 形态：卡片里的窗口摘要与原型编辑器的 `.ped-side .sumbox` 同高（Q11 的 ±8px）。
      const mine = await page.evaluate(() => {
        const box = document.querySelector('[data-preview="constraints"] .sumbox');
        if (!box) return null;
        const rect = box.getBoundingClientRect();
        const card = document.querySelector('[data-preview="constraints"]');
        return { height: Math.round(rect.height), cardHeight: Math.round(card.getBoundingClientRect().height) };
      });
      const theirs = await protoPage.evaluate(() => {
        const box = document.querySelector('.ped-side .sumbox');
        if (!box) return null;
        return { height: Math.round(box.getBoundingClientRect().height) };
      });
      record('r9PreviewBox', { mine, theirs });
      if (!mine) problems.push('实现侧预览卡没有 .sumbox');
      if (!theirs) problems.push('原型侧编辑器没有可对照的 .ped-side .sumbox');
      if (mine && theirs && Math.abs(mine.height - theirs.height) > 8) {
        problems.push(`预览卡摘要高度 ${mine.height} 与原型 ${theirs.height} 相差超过 8px`);
      }

      // 卡片说的是哪种后端在判定：判据比较“页面声明的判定后端”（data-decides）与卡片自己的
      // 声明（data-preview-decides）。比较模式与模式自己永远相等，所以旧判据不会红。
      const claim = () => page.evaluate(() => ({
        served: document.querySelector('[data-decides]')?.getAttribute('data-decides') ?? null,
        claimed: document.querySelector('[data-preview-decides]')?.getAttribute('data-preview-decides') ?? null,
      }));
      const { served, claimed } = await claim();
      record('r9PreviewDecides', { served, claimed });
      if (served === null) problems.push('页面没有声明“谁在判定”（data-decides）');
      else if (claimed !== served) problems.push(`预览卡声明的判定后端 ${claimed} 与页面 ${served} 不一致`);

      // 负控：把卡片改成另一个后端名，同一判据必须真红。
      await page.evaluate(() => {
        const card = document.querySelector('[data-preview-decides]');
        if (!card) return;
        const current = card.getAttribute('data-preview-decides');
        card.setAttribute('data-preview-decides', current === 'constraints' ? 'legacy' : 'constraints');
      });
      const wrong = await claim();
      record('r9PreviewDecidesNegative', wrong);
      if (wrong.claimed === wrong.served) problems.push(`负控（卡片写错判定后端 ${wrong.claimed}）没有被判红`);

      // 负控：往卡片里塞一个提交按钮，只读判据必须真红。
      const injected = await page.evaluate(() => {
        const card = document.querySelector('[data-preview="constraints"]');
        if (!card) return false;
        const button = document.createElement('button');
        button.type = 'submit';
        button.textContent = '保存';
        card.appendChild(button);
        return true;
      });
      const afterInject = await page.evaluate(JUDGE_PREVIEW);
      record('r9PreviewNegative', afterInject);
      if (!injected) problems.push('负控无法进行：没有预览卡');
      else if (!afterInject.some((line) => line.includes('可提交的 <button>'))) problems.push(`负控（塞入提交按钮）没有被判红：${JSON.stringify(afterInject)}`);
    } finally {
      await context.close().catch(() => {});
      await proto.close().catch(() => {});
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  await fs.mkdir(outputRoot, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(outputRoot, 'admin-constraints-evidence.json'), JSON.stringify(evidence, null, 2)).catch(() => {});
}
