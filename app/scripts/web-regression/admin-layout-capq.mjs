// #406 → migrated: the capability picker's filter-and-save contract (RETURN-3 P1).
//
// **Migrated 2026-10-18 (lane w5-gates).** The previous revision asserted the deleted Admin UI v2
// markup (`#authz-edit`, `details.capability-group`, `[data-capability-count]`,
// `form.capability-search`, `input[name="capabilities"]`). The *criterion* is markup-independent and
// is what this module now pins:
//   * the capability control is a set of real checkboxes, not a native `<select multiple>` with a
//     hundred bare tokens (a filtered-away `<option>` cannot be "still selected");
//   * `?capq=` narrows the catalogue but must keep every **stored** selection rendered *and
//     checked* — the RETURN-3 P1 defect: a filtered-out selection came back unchecked, so the next
//     save silently revoked it while the panel still claimed 已选 N 项;
//   * an untouched filtered save, posted through the form the page itself rendered, leaves the
//     stored set unchanged.
//
// Nothing here names a lane-owned selector or field name: the editor URL is taken from the list
// page's own link, the capability control is identified as the page's largest same-name checkbox
// group (and then followed *by that name* through the filter), and the form is posted to its own
// `action`. If the page renders no such link/form the check fails loudly rather than skipping.
import assert from 'node:assert/strict';

const EDITOR_PROBE = `(() => {
  const main = document.querySelector('.main') || document.body;
  const boxes = [...main.querySelectorAll('input[type="checkbox"]')];
  const groups = new Map();
  for (const box of boxes) {
    const name = box.name || '(unnamed)';
    const group = groups.get(name) || { name, checked: [], unchecked: [] };
    (box.checked ? group.checked : group.unchecked).push(box.value);
    groups.set(name, group);
  }
  const forms = [...main.querySelectorAll('form')];
  const editor = forms
    .map((form) => ({ form, boxes: [...form.querySelectorAll('input[type="checkbox"]')] }))
    .sort((left, right) => right.boxes.length - left.boxes.length)[0] || null;
  return {
    multipleSelects: main.querySelectorAll('select[multiple]').length,
    selects: main.querySelectorAll('select').length,
    checkboxes: boxes.length,
    groups: [...groups.values()].map((group) => ({ name: group.name, count: group.checked.length + group.unchecked.length, checked: group.checked.sort(), unchecked: group.unchecked.sort() })),
    form: editor ? { action: editor.form.getAttribute('action'), method: (editor.form.getAttribute('method') || 'get').toLowerCase(), boxes: editor.boxes.length } : null,
  };
})()`;

/** Serialize the editor form exactly as the browser would submit it. */
const FORM_VALUES = `(() => {
  const main = document.querySelector('.main') || document.body;
  const form = [...main.querySelectorAll('form')]
    .map((candidate) => ({ candidate, boxes: candidate.querySelectorAll('input[type="checkbox"]').length }))
    .sort((left, right) => right.boxes - left.boxes)[0]?.candidate;
  if (!form) return null;
  const fields = [];
  for (const control of form.querySelectorAll('input[name], select[name], textarea[name]')) {
    if (control.disabled) continue;
    if (control.type === 'checkbox' || control.type === 'radio') { if (control.checked) fields.push([control.name, control.value]); continue; }
    fields.push([control.name, control.value ?? '']);
  }
  return { action: form.getAttribute('action'), fields };
})()`;

/** The editor URL offered by the list page itself (no lane-specific parameter name assumed). */
export function editorHref(hrefs, listPath) {
  const EDITOR_PARAM = /^(edit|id|policy|policyid|policy_id)$/i;
  const NON_EDITOR_PARAM = /^(tab|new|window|confirm|copy|weeklypreset|capq|q|page|pagesize|sort|order|outcome|action|credential|source|origin|focus)$/i;
  const paramsOf = (href) => {
    if (!String(href).includes('?')) return [];
    return [...new URLSearchParams(String(href).slice(String(href).indexOf('?') + 1))];
  };
  const usable = (href) => Boolean(href) && String(href).startsWith(listPath) && !String(href).includes('new=')
    && paramsOf(href).some(([name, value]) => value && !NON_EDITOR_PARAM.test(name));
  for (const href of hrefs || []) {
    if (!usable(href)) continue;
    if (paramsOf(href).some(([name, value]) => value && EDITOR_PARAM.test(name))) return href;
  }
  // Fallback: whatever link the page offers that is neither the list itself nor a known
  // non-editor view (window detail, delete confirm, copy-from, …).
  return (hrefs || []).find(usable) ?? null;
}

/** Append/replace query parameters *before* any fragment (`?edit=x#authz-edit&capq=y` is not a URL). */
export function withParams(href, params) {
  const [pathAndQuery, hash = ''] = String(href).split('#');
  const url = new URL(pathAndQuery, 'http://admin.invalid');
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return `${url.pathname}${url.search}${hash ? `#${hash}` : ''}`;
}

/** The page's largest same-name checkbox group: the capability catalogue. */
export function largestGroup(probe) {
  return [...(probe.groups || [])].sort((left, right) => right.count - left.count)[0] ?? null;
}

export async function registerCapabilityPickerCheck(ctx, { page, goto, postForm, tracePhase, authzListUrl }) {
  await ctx.check('admin-layout #406（迁移）: 能力选择器不是原生多选，?capq= 过滤保留已选，未改动的过滤保存不丢选项', async () => {
    await goto(authzListUrl);
    const hrefs = await page.evaluate(`(() => [...document.querySelectorAll('.main a[href]')].map((a) => a.getAttribute('href')))()`);
    const editor = editorHref(hrefs, '/admin/auth/access-policy');
    assert.ok(editor, `策略编辑器入口缺失：列表页没有任何指向策略编辑器的链接（hrefs=${JSON.stringify(hrefs.slice(0, 20))}）；无法核对 ?capq= 过滤保存契约`);
    await goto(editor);
    const unfiltered = await page.evaluate(EDITOR_PROBE);
    const capability = largestGroup(unfiltered);
    tracePhase('capability-editor', { editor, probe: unfiltered, capability: capability?.name ?? null });
    assert.equal(unfiltered.multipleSelects, 0, '能力选择器不能是原生 <select multiple>（迁移自 #406 的原判据）');
    assert.ok(capability, '编辑器没有渲染任何复选项');
    assert.ok(capability.count >= 10, `能力必须以复选项呈现（最大同名复选组至少 10 项），实际 ${capability.count} 项（组：${JSON.stringify(unfiltered.groups.map((group) => [group.name, group.count]))}）`);
    assert.ok(capability.checked.length >= 1, `编辑器没有渲染任何已选能力（组 ${capability.name} checked=${JSON.stringify(capability.checked)}）`);
    assert.ok(capability.unchecked.length >= 1, `编辑器没有渲染未选能力，无法验证过滤（组 ${capability.name}）`);
    assert.ok(unfiltered.form?.method === 'post', `能力表单必须是 POST（实际 ${unfiltered.form?.method}）`);

    // ?capq= must narrow the catalogue without touching the stored selection. The query comes from
    // the page's own unchecked values (most specific first) and is only accepted when it really
    // narrows: a filter that matches everything is not evidence that selections survive.
    const candidates = capability.unchecked.filter((value) => value.includes(':')).sort((left, right) => right.length - left.length).slice(0, 6);
    assert.ok(candidates.length, `能力组 ${capability.name} 没有带 key 的未选项，无法构造 ?capq= 查询：${JSON.stringify(capability.unchecked.slice(0, 10))}`);
    let query = null;
    let filtered = null;
    let filteredGroup = null;
    const attempted = [];
    for (const candidate of candidates) {
      await goto(withParams(editor, { capq: candidate }));
      const probe = await page.evaluate(EDITOR_PROBE);
      const group = (probe.groups || []).find((item) => item.name === capability.name) ?? null;
      attempted.push({ query: candidate, group: group?.count ?? null });
      if (group && group.count < capability.count) { query = candidate; filtered = probe; filteredGroup = group; break; }
    }
    tracePhase('capability-filter', { attempted, query, filtered: filteredGroup });
    assert.ok(filteredGroup, `?capq= 在 ${candidates.length} 个候选查询上都没有收窄能力组 ${capability.name}（${JSON.stringify(attempted)}）：过滤契约未实现`);
    for (const value of capability.checked) {
      assert.ok(filteredGroup.checked.includes(value), `过滤后已选能力 ${value} 被丢掉或取消勾选（RETURN-3 P1：下一次保存会静默撤销它）`);
    }
    assert.ok(filteredGroup.unchecked.some((value) => value.includes(query)), `?capq=${query} 没有保留匹配的候选`);
    assert.equal(filtered.multipleSelects, 0, '过滤后仍不得出现原生 <select multiple>');

    // An untouched filtered save must not change the stored set.
    const form = await page.evaluate(FORM_VALUES);
    assert.ok(form?.action, '过滤后的编辑器没有渲染可提交的表单');
    const submitted = await postForm(form.action, Object.fromEntries(form.fields));
    assert.equal(submitted.status(), 303, `未改动的过滤保存必须成功，实际 ${submitted.status()}`);
    await goto(editor);
    const after = await page.evaluate(EDITOR_PROBE);
    const afterGroup = (after.groups || []).find((item) => item.name === capability.name) ?? null;
    tracePhase('capability-after-filtered-save', { group: afterGroup });
    assert.ok(afterGroup, `保存后编辑器不再渲染能力组 ${capability.name}`);
    assert.deepEqual(afterGroup.checked, capability.checked, `未改动的过滤保存改变了已选能力：${JSON.stringify(capability.checked)} → ${JSON.stringify(afterGroup.checked)}`);
  });
}
