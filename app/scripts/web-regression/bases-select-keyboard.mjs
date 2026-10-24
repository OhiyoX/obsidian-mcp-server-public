// Issue #409 review (batch 5): the two real-Chromium regressions the review probe found on the
// shipped Base surface. Registered from `web-regression/bases.mjs` inside the Web Bases fixture
// block, so it drives the same fixture Vault, the same real server and the same real page as the
// rest of the Base contract.
//
//   A. keyboard-only commit: focus the trigger -> ArrowDown (open) -> ArrowDown (move) -> Enter.
//      The view really changes, but the consumer (`features/bases/view.js`) replaces the whole
//      surface from inside its synchronous `change` handler, so the trigger that committed is
//      detached while the control is still running. The shipped defect focused that detached node
//      and left `document.activeElement === BODY`.
//   B. in-app Back: reach the Base by clicking its Explorer row (a pushState navigation), open
//      the listbox, then go Back. popstate re-renders the note in place; the Base host stays in
//      the DOM, hidden, and the still-"open" listbox used to keep its document listener and
//      preventDefault every ArrowDown/Enter on the note.
import assert from 'node:assert/strict';
import { encodeDocumentRoute } from '../web-bases-checks.mjs';

const TRIGGER = '.base-view-control .select-trigger';
const MENU = '.base-view-control .select-menu';

// The readings the two defects are judged on: which node owns the focus, and whether the listbox
// still announces itself as open.
async function readControl(page) {
  return page.evaluate(([triggerSelector, menuSelector]) => {
    const active = document.activeElement;
    const trigger = document.querySelector(triggerSelector);
    const menu = document.querySelector(menuSelector);
    const native = document.querySelector('.base-view-control select.base-view-select');
    return {
      activeTag: active?.tagName ?? null,
      activeIsTrigger: Boolean(active && trigger && active === trigger),
      activeInsideControl: Boolean(active?.closest?.('.select-control')),
      expanded: trigger?.getAttribute('aria-expanded') ?? null,
      menuHidden: menu ? menu.hidden : null,
      triggerVisible: Boolean(trigger && (trigger.offsetWidth || trigger.offsetHeight || trigger.getClientRects().length)),
      view: native ? native.value : null,
    };
  }, [TRIGGER, MENU]);
}

// Deterministic start: a full load on the note, then the Base opened from its Explorer row (an
// in-app pushState navigation), so history Back returns to the note without a page reload.
async function openBaseFromExplorer(ctx, notePath) {
  const { page, serverUrl, fixtures, login, sleep } = ctx;
  await login();
  await page.goto(`${serverUrl}/app/note/${encodeDocumentRoute(fixtures.vaultId, notePath)}`);
  await page.waitForFunction((wanted) => document.querySelector('#current-path')?.textContent === wanted, notePath, { timeout: 20000 });
  const row = page.locator(`.note.note-base[data-path="${fixtures.files.projectBase}"]`).first();
  await row.waitFor({ state: 'visible', timeout: 15000 });
  await row.click({ timeout: 5000 });
  await page.locator('.base-surface').first().waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-base-table] tbody tr').first().waitFor({ state: 'visible', timeout: 15000 });
  await sleep(200);
}

export async function registerBaseSelectKeyboardChecks(ctx) {
  const { check, page, fixtures, sleep } = ctx;

  await check('bases/select: a keyboard commit keeps the focus on the live view trigger', async () => {
    await openBaseFromExplorer(ctx, fixtures.files.readmeNote);
    const trigger = page.locator(TRIGGER).first();
    await trigger.focus();
    const before = await readControl(page);
    assert.equal(before.expanded, 'false', 'the listbox must start closed');

    await page.keyboard.press('ArrowDown');
    await sleep(150);
    const opened = await readControl(page);
    assert.equal(opened.expanded, 'true', 'ArrowDown opens the listbox');
    assert.equal(opened.menuHidden, false, 'and the menu is rendered');

    await page.keyboard.press('ArrowDown');
    await sleep(120);
    await page.keyboard.press('Enter');
    await sleep(600);
    const after = await readControl(page);
    assert.notEqual(after.view, before.view, `the commit must switch the view (${before.view} -> ${after.view})`);
    assert.equal(after.expanded, 'false', 'the listbox closed');
    assert.equal(after.activeIsTrigger, true, `the focus must land on the live trigger, saw ${JSON.stringify(after)}`);
  });

  await check('bases/select: leaving the Base by Back does not leave the listbox owning the document keys', async () => {
    await openBaseFromExplorer(ctx, fixtures.files.readmeNote);
    await page.locator(TRIGGER).first().focus();
    await page.keyboard.press('ArrowDown');
    await sleep(150);
    const open = await readControl(page);
    assert.equal(open.expanded, 'true', 'the listbox is open before the surface is left');
    assert.equal(open.menuHidden, false);

    await page.goBack();
    await page.waitForFunction((wanted) => document.querySelector('#current-path')?.textContent === wanted, fixtures.files.readmeNote, { timeout: 20000 });
    await sleep(300);
    const gone = await readControl(page);
    assert.equal(gone.triggerVisible, false, 'the Base surface must be out of sight after Back');

    // Real keystrokes with the note on screen. The recorder listens on the document in the
    // bubble phase, so it reads the flag a document-level capture handler set (and it survives
    // the Explorer search field not being focusable in every shell state).
    await page.bringToFront();
    const setup = await page.evaluate(() => {
      window.__baseSelectKeyTrace = [];
      document.addEventListener('keydown', (event) => {
        window.__baseSelectKeyTrace.push({ key: event.key, prevented: event.defaultPrevented, target: event.target?.id || event.target?.tagName || null });
      }, false);
      const search = document.querySelector('#search');
      if (search) search.focus();
      return {
        active: document.activeElement?.id || document.activeElement?.tagName || null,
        hasSearch: Boolean(search),
        searchVisible: Boolean(search && (search.offsetWidth || search.offsetHeight)),
      };
    });
    await page.keyboard.press('ArrowDown');
    await sleep(120);
    await page.keyboard.press('Enter');
    await sleep(200);
    const events = await page.evaluate(() => window.__baseSelectKeyTrace);
    assert.equal(events.length, 2, `both keystrokes must reach the note page, saw ${JSON.stringify({ events, setup })}`);
    for (const event of events) {
      assert.equal(event.prevented, false, `${event.key} must not be swallowed after leaving the Base (${JSON.stringify(events)})`);
    }

    // The same synthetic reading the review probe took, kept for comparability with its log.
    const synthetic = await page.evaluate(() => {
      const node = document.querySelector('#search') || document.body;
      node.focus();
      const arrow = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
      node.dispatchEvent(arrow);
      const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      node.dispatchEvent(enter);
      return { arrowDefaultPrevented: arrow.defaultPrevented, enterDefaultPrevented: enter.defaultPrevented };
    });
    assert.deepEqual(synthetic, { arrowDefaultPrevented: false, enterDefaultPrevented: false });
  });
}
