// UI driver for the frozen Web Bases browser contract (Wave D / D3 parity items).
//
// Since #309 the Base toolbar panels are desktop-shaped floating popovers: the 排序
// menu has no per-direction button any more. It adds a 排序依据 row whose 属性 / 方向
// selects carry the same frozen hooks (an <option> with data-sort-key + data-sort-dir),
// so the frozen parity item 21 drives the popover instead of a per-direction button.
// The driver lives here because `web-bases-checks.mjs` is line-budget-frozen (it may
// only shrink, see scripts/line-budget-baseline.json).

export function createSortDriver(page, sleep) {
  return async function applySortViaPopover(key, dir) {
    const panel = '[data-base-panel="sort"]';
    const row = page.locator(`${panel} [data-sort-row]`).first();
    await page.locator('[data-sort-add]').click();
    await sleep(200);
    await row.locator('.select-control:has(select[data-sort-property]) .select-trigger').click();
    await page.locator(`${panel} .select-option[data-value="${key}"]`).click();
    await sleep(200);
    await row.locator('.select-control:has(select[data-sort-direction]) .select-trigger').click();
    await page.locator(`${panel} .select-option[data-value="${dir}"]`).click();
  };
}
