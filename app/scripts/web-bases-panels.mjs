// UI driver for the frozen Web Bases browser contract (Wave D / D3 parity items).
//
// Since #309 the Base toolbar panels are desktop-shaped floating popovers: the 排序
// menu has no per-direction button any more. It adds a 排序依据 row whose 属性 / 方向
// selects carry the same frozen hooks (an <option> with data-sort-key + data-sort-dir),
// so the frozen parity item 21 drives the popover instead of a per-direction button.
// The driver is a separate module so `web-bases-checks.mjs` keeps one subject (the frozen
// parity items) and this one owns the popover driving.

export function createSortDriver(page, sleep) {
  return async function applySortViaPopover(key, dir) {
    // Each Base surface carries its own toolbar, so a second surface (or a cached panel) puts a
    // second copy of every hook in the DOM. Issue #747: an unscoped selector resolved to both and
    // Playwright refused the click. The driver drives the panel the reader is looking at.
    const panel = '[data-base-panel="sort"]:visible';
    // The parity item wants ONE sort level. A view may arrive with its own default row, and
    // "添加排序" would append a second one (issue #747 measured [priority, file.name]). Keep the
    // first row, drop the rest, and only add when the panel has none.
    let rows = page.locator(`${panel} [data-sort-row]`);
    if (await rows.count() === 0) {
      await page.locator('[data-sort-add]:visible').first().click();
      await sleep(200);
      rows = page.locator(`${panel} [data-sort-row]`);
    }
    for (let index = (await rows.count()) - 1; index >= 1; index -= 1) {
      await rows.nth(index).locator('[data-sort-remove]').click();
      await sleep(150);
    }
    const row = page.locator(`${panel} [data-sort-row]`).first();
    await row.locator('.select-control:has(select[data-sort-property]) .select-trigger').click();
    await page.locator(`${panel} .select-option[data-value="${key}"]`).first().click();
    await sleep(200);
    await row.locator('.select-control:has(select[data-sort-direction]) .select-trigger').click();
    await page.locator(`${panel} .select-option[data-value="${dir}"]`).first().click();
  };
}
