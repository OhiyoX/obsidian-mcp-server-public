// Grouped operation selection and saved-only preview contracts.
// Operation controls use canonical ids, preserve selections across search, and submit natively.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const WIDE = { width: 1440, height: 900 };
const AUTHZ_NEW = '/admin/auth/authz?new=1';

async function login(context, base, password) {
  const response = await context.request.post(`${base}/admin/auth/login`, { form: { password }, maxRedirects: 0 });
  assert.equal(response.status(), 303, 'the design scene must be able to log in');
}

export async function registerConstraintPageChecks(ctx, { browser, fixture, repoRoot, protoUrl, outputRoot }) {
  const { check } = ctx;
  const evidence = {};
  const record = async (key, value) => { evidence[key] = value; };

  /* ---------------------------------------------------------------- R9: operation picker */

  await check('admin-design: grouped operation checkboxes preserve selection and submit canonical ids', async () => {
    const context = await browser.newContext({ viewport: WIDE });
    try {
      await login(context, fixture.base, fixture.password);
      const page = await context.newPage();
      await page.goto(`${fixture.base}${AUTHZ_NEW}`);
      const target = page.locator('[data-operation-groups] input[value="get_note"]');
      await page.locator("[data-operation-search]").fill("get_note");
      await target.check();
      await page.locator('[data-operation-search]').fill('write_note');
      assert.equal(await target.isChecked(), true, 'filter preserves hidden selections');
      await page.locator('[data-operation-search]').fill('');
      const group = target.locator('xpath=ancestor::details');
      const toggle = group.locator('[data-operation-select-all]');
      assert.equal(await toggle.evaluate((e) => e.indeterminate), true);
      await toggle.check();
      assert.equal(await group.locator('input[name="capabilities"]:not(:checked)').count(), 0);
      await toggle.uncheck();
      await target.check();
      const payload = await page.locator('#authz-constraint').evaluate((form) => new FormData(form).getAll('capabilities'));
      assert.deepEqual(payload, ['get_note']);
    } finally { await context.close(); }
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

  await check('admin-design: R9 预览卡（只读判定、已保存状态、时间轴与负控）', async () => {
    const context = await browser.newContext({ viewport: WIDE, colorScheme: 'dark' });
    const problems = [];
    try {
      await login(context, fixture.base, fixture.password);
      const page = await context.newPage();
      await page.goto(`${fixture.base}${AUTHZ_NEW}`, { waitUntil: 'load' });
      await page.evaluate('document.fonts ? document.fonts.ready : true');
      await page.waitForSelector('[data-preview="constraints"]', { state: 'attached', timeout: 5000 });
      assert.equal(await page.locator('[data-preview="constraints"]').isVisible(), true,
        'the new rule preserves the preview sidebar');
      assert.equal(await page.locator('[data-preview] .verdict').count(), 0, 'the new rule has no saved verdict');
      await page.locator('[data-add-days="workdays"]').click();
      assert.equal(await page.locator('[data-draft-timeline] .w').count(), 5);
      await page.locator('[name="w_mon_from_0"]').fill('800');
      await page.locator('[name="w_mon_from_0"]').press('Tab');
      assert.equal(await page.locator('[name="w_mon_from_0"]').inputValue(), '08:00');
      const scheduleLayout = await page.evaluate(() => ({
        timeline: document.querySelector('[data-draft-timeline]').getBoundingClientRect().bottom,
        fields: document.querySelector('.weekly-schedule').getBoundingClientRect().top,
      }));
      assert.ok(scheduleLayout.timeline <= scheduleLayout.fields, 'the visual timeline stays above the daily fields');
      assert.equal(await page.locator('[data-preview] .verdict').count(), 0, 'draft edits do not create a verdict');
      const label = 'R9 saved preview';
      await page.locator('#authz-constraint input[name="label"]').fill(label);
      await page.locator('#authz-constraint input[name="subjects"]').first().check();
      await page.locator('[data-operation-search]').fill('get_note');
      await page.locator('[data-operation-groups] input[value="get_note"]').check();
      await page.locator('.ped-foot button[form="authz-constraint"]').click();
      await page.waitForURL('**/admin/auth/authz');
      const href = await page.locator('tr').filter({ hasText: label }).locator('a[href*="?edit="]').first().getAttribute('href');
      assert.ok(href, 'the new rule is listed after saving');
      await page.goto(new URL(href, fixture.base).href);

      // 只读：卡片里没有任何可提交的控件，也没有脚本入口。
      const judged = await page.evaluate(JUDGE_PREVIEW);
      if (judged.length) problems.push(...judged.map((line) => `[只读] ${line}`));

      const saved = await page.evaluate(() => {
        const box = document.querySelector('[data-preview="constraints"] .sumbox');
        const card = document.querySelector('[data-preview="constraints"]');
        return { height: Math.round(box?.getBoundingClientRect().height ?? 0), bars: card.querySelectorAll('.tl .w').length };
      });
      record('r9PreviewBox', saved);
      assert.equal(saved.bars, 5, 'the saved preview contains the five submitted time slots');
      await page.locator('[data-add-days="weekend"]').click();
      assert.equal(await page.locator('[data-draft-timeline] .w').count(), 7);
      assert.equal(await page.locator('[data-preview] .tl .w').count(), 5, 'the preview still shows the saved schedule');
      assert.equal(await page.locator('[data-preview-dirty]').isVisible(), true);

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
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  await fs.mkdir(outputRoot, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(outputRoot, 'admin-constraints-evidence.json'), JSON.stringify(evidence, null, 2)).catch(() => {});
}
