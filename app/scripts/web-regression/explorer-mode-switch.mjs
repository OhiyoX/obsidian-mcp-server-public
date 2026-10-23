// Issue #335 (real Chromium): switching the Explorer browse mode must repaint the files
// list on the same click.
//
// The Tree renderer reuses its DOM while `treeRenderSignature(model)` is unchanged, and
// the flat list paints the SAME `#note-list` host. A flat paint therefore has to
// invalidate that cache; otherwise the switch back to Tree matches an unchanged
// signature, returns early, and leaves flat rows in the list while the mode control
// already reads "树状视图" — the reported #335 failure (state changed, view did not).
//
// Both data paths are asserted because they take different branches: with no query the
// flat list is a server keyset page (`flat=1`), with an active query it is a client-side
// projection of the loaded search rows. The Tree direction samples the DOM at t+0 (as
// soon as the click resolves) and again at t+300 ms, so a repaint that only happens on
// some later event cannot pass.
//
// The flat direction is sampled the same way but honestly: a query-less flat page is a
// network round trip, so the assertion there is "the Tree rows are gone at t+0 and the
// control already reports flat" plus "flat rows are present once the page lands". The
// existing loading placeholder semantics stay untouched.
//
// The mode control lives in the files panel head, and any *new* query identity pulls the
// search panel to the front, so `showPanel('files')` is repeated wherever a click needs
// the mode trigger to be on screen. The same panel head carries the Publishes shortcut
// (`#publishes-open`), whose #421 contract is asserted here too: one click sets
// `published:true`, lands on the Search panel, and never reports a pressed state.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const TREE_FIRST = 'tree-folder-row';
const PUBLISHED_NOTE = 'ExplorerModeSwitch/Published.md';

function listShape(page) {
  return page.evaluate(() => {
    const list = document.querySelector('#note-list');
    return {
      mode: document.querySelector('[data-panel-head="files"]')?.dataset.explorerMode ?? null,
      title: document.querySelector('#explorer-mode-toggle')?.getAttribute('title') ?? null,
      folders: list ? list.querySelectorAll('.tree-folder-row').length : -1,
      notes: list ? list.querySelectorAll('.note').length : -1,
      flat: list ? list.querySelectorAll('.note-flat').length : -1,
      currentRows: list ? list.querySelectorAll('.note[aria-current="page"]').length : -1,
      first: list?.firstElementChild?.className ?? null,
    };
  });
}

const currentPath = (page) => page.evaluate(() => document.querySelector('#current-path')?.textContent ?? null);
const searchValue = (page) => page.evaluate(() => document.querySelector('#search')?.value ?? null);

async function showPanel(page, name) {
  const tab = page.locator(`[data-sidebar-tab="${name}"]`);
  if (await tab.getAttribute('aria-selected') !== 'true') await tab.click();
}

// The same route the document menu uses, with the page's CSRF token (a mutation route
// without it answers 403), so the Publish registry changes exactly as it does for a user.
async function publishAction(page, base, action) {
  const csrf = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  return page.request.post(`${base}/api/web/v1/publish`, {
    headers: { 'X-CSRF-Token': csrf },
    data: { action, path: PUBLISHED_NOTE },
  });
}

// A real click on the menu option: the acceptance is about what the click itself paints,
// so this is never an idempotent setter.
async function clickMode(page, mode) {
  await showPanel(page, 'files');
  await page.locator('#explorer-mode-toggle').click();
  await page.locator(`#explorer-mode-menu [data-explorer-mode="${mode}"]`).click();
}

function assertTreeShape(shape, label) {
  assert.equal(shape.mode, 'tree', `${label}: the control must report Tree mode: ${JSON.stringify(shape)}`);
  assert.ok(shape.folders > 0, `${label}: the Tree must render folder rows: ${JSON.stringify(shape)}`);
  assert.equal(shape.flat, 0, `${label}: no flat row may survive inside the Tree: ${JSON.stringify(shape)}`);
  assert.equal(shape.first, TREE_FIRST, `${label}: the first row must be a folder row: ${JSON.stringify(shape)}`);
}

// Tree → Flat: the Tree rows must be gone at t+0 and the flat rows present once loaded.
async function assertFlatAfterClick(page, { label, sleep }) {
  const t0 = await listShape(page);
  assert.equal(t0.mode, 'flat', `${label} t+0: the control must report flat mode: ${JSON.stringify(t0)}`);
  assert.equal(t0.folders, 0, `${label} t+0: no Tree row may survive in the flat list: ${JSON.stringify(t0)}`);
  await page.waitForSelector('#note-list .note-flat[data-path]', { timeout: 7000 });
  await sleep(300);
  const t300 = await listShape(page);
  assert.equal(t300.mode, 'flat', `${label} t+300ms: ${JSON.stringify(t300)}`);
  assert.ok(t300.flat > 0, `${label} t+300ms: the flat list must render rows: ${JSON.stringify(t300)}`);
  assert.equal(t300.folders, 0, `${label} t+300ms: no Tree row may survive: ${JSON.stringify(t300)}`);
  assert.match(t300.first ?? '', /^note/, `${label} t+300ms: the first row must be a flat note row: ${JSON.stringify(t300)}`);
  return { t0, t300 };
}

async function assertTreeAfterClick(page, label, sleep) {
  const t0 = await listShape(page);
  assertTreeShape(t0, `${label} t+0`);
  await sleep(300);
  const t300 = await listShape(page);
  assertTreeShape(t300, `${label} t+300ms`);
  return { t0, t300 };
}

export async function registerExplorerModeSwitchChecks({ check, sleep, page, vault, base, outputRoot, errors }) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await showPanel(page, 'files');
  await page.waitForSelector('#note-list', { timeout: 7000 });

  // Fixture warming (not part of what the checks measure): the fixture Vault's root has
  // directories, so a folder row is the observable "the Tree is materialized" precondition.
  // On a cold server the very first root page can land while the catalog is still
  // reconciling — a `WEB_TEST_ONLY` run skips every warming check — and a page reload is
  // the user-equivalent way back to a complete level.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await page.waitForSelector('#note-list .tree-folder-row', { timeout: 5000 });
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
      await page.reload();
      await page.waitForSelector('#note-list', { timeout: 7000 });
    }
  }

  // The Publish-filter round trip needs its own fixture: `env.mjs` ships no published
  // note, and without one `published:true` legitimately matches nothing. Written through
  // the real filesystem so the catalog indexes it; published later through the real API.
  await fs.mkdir(path.join(vault, 'ExplorerModeSwitch'), { recursive: true });
  await fs.writeFile(path.join(vault, PUBLISHED_NOTE), '# Published probe\n\nissue 335 mode-switch fixture\n');
  let indexed = false;
  for (let attempt = 0; attempt < 300 && !indexed; attempt += 1) {
    const response = await page.request.get(`${base}/api/web/v2/tree?parent=ExplorerModeSwitch`);
    if (response.ok()) {
      const body = await response.json();
      indexed = (body.items ?? []).some((item) => item.path === PUBLISHED_NOTE);
    }
    if (!indexed) await sleep(100);
  }
  assert.equal(indexed, true, 'the mode-switch fixture note must be indexed before the probe');

  await check('explorer mode switch: flat → tree repaints the files list on the same click (no query)', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Start from a query-less files panel: a query left by an earlier check would make
    // the flat list a search projection instead of the server page this check asserts.
    await showPanel(page, 'search');
    if ((await searchValue(page))?.trim()) {
      // #421: `#publishes-open` is a one-shot shortcut now, so it can no longer clear the
      // query; the search panel's own clear control is what empties it.
      await page.locator('#search-clear').click();
      await page.waitForFunction(() => document.querySelector('#search')?.value === '');
    }
    for (const round of [1, 2]) {
      await clickMode(page, 'flat');
      await assertFlatAfterClick(page, { label: `no-query round ${round} flat`, sleep });
      const opened = await currentPath(page);
      await clickMode(page, 'tree');
      await assertTreeAfterClick(page, `no-query round ${round} tree`, sleep);
      assert.equal(await currentPath(page), opened, `no-query round ${round}: the mode switch must not close or clear the open note`);
      await page.screenshot({ path: path.join(outputRoot, `explorer-mode-switch-tree-round-${round}.png`) });
    }
  });

  await check('explorer mode switch: flat → tree repaints with an active query and keeps query, Publish filter and note', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await showPanel(page, 'search');
    // `path:Folder` is a deterministic hard filter: it matches exactly `Folder/Nested.md`
    // in the fixture Vault, so the flat projection has a known row to assert on.
    await page.locator('#search').fill('path:Folder');
    await page.waitForSelector('#search-list .note[data-path="Folder/Nested.md"]', { timeout: 7000 });
    const opened = await currentPath(page);

    await clickMode(page, 'flat');
    await assertFlatAfterClick(page, { label: 'query flat', sleep });
    assert.equal(
      await page.evaluate(() => document.querySelector('#note-list .note-flat[data-path]')?.dataset.path ?? null),
      'Folder/Nested.md',
      'the flat list must project the loaded search rows (not the server flat page)',
    );
    await clickMode(page, 'tree');
    await assertTreeAfterClick(page, 'query tree', sleep);
    assert.equal(await searchValue(page), 'path:Folder', 'the mode switch must not clear the query');
    assert.equal(await currentPath(page), opened, 'the mode switch must not close or clear the open note');
    await page.screenshot({ path: path.join(outputRoot, 'explorer-mode-switch-query-round.png') });

    // The Publish filter is the same query channel with its own control state. `published:`
    // is a hard filter over the Publish registry (frontmatter plays no part), so the fixture
    // note has to be published for real — through the same route the document menu uses.
    const published = await publishAction(page, base, 'publish');
    assert.equal(published.status(), 200, `publishing the fixture note must succeed: ${await published.text()}`);
    let visible = false;
    for (let attempt = 0; attempt < 100 && !visible; attempt += 1) {
      const response = await page.request.get(`${base}/api/web/v2/search?q=${encodeURIComponent('published:true')}&limit=50`);
      if (response.ok()) {
        const body = await response.json();
        visible = (body.items ?? []).some((item) => item.path === PUBLISHED_NOTE);
      }
      if (!visible) await sleep(100);
    }
    assert.equal(visible, true, 'the published note must be visible to the Publish filter');
    await showPanel(page, 'files');
    await page.locator('#publishes-open').click();
    // #421: the entry is a shortcut, not a toggle. One click must set the preset query,
    // bring the Search panel to the front, and leave no pressed state behind.
    assert.equal(
      await page.locator('#publishes-open').getAttribute('aria-pressed'),
      null,
      'the Publishes shortcut must not report a pressed state',
    );
    assert.equal(
      await page.locator('[data-sidebar-tab="search"]').getAttribute('aria-selected'),
      'true',
      'the Publishes shortcut must land on the Search panel it filters',
    );
    await page.waitForFunction(() => document.querySelector('#search')?.value === 'published:true');
    await page.waitForSelector(`#search-list .note[data-path="${PUBLISHED_NOTE}"]`, { timeout: 7000 });
    await clickMode(page, 'flat');
    await assertFlatAfterClick(page, { label: 'publish flat', sleep });
    assert.equal(
      await page.evaluate(() => document.querySelector('#note-list .note-flat[data-path]')?.dataset.path ?? null),
      PUBLISHED_NOTE,
      'the Publish filter projection must carry the published note',
    );
    await clickMode(page, 'tree');
    await assertTreeAfterClick(page, 'publish tree', sleep);
    assert.equal(await searchValue(page), 'published:true', 'the mode switch must not clear the Publish filter');
    assert.equal(
      await page.locator('#publishes-open').getAttribute('aria-pressed'),
      null,
      'the Publishes shortcut stays a shortcut (no pressed state) across the mode switch',
    );
    assert.equal(await currentPath(page), opened, 'the Publish filter round trip must not close the open note');

    // Leave the shared page in a query-less Tree for any check registered after this one,
    // and hand the Publish registry back exactly as it was found. The shortcut cannot clear
    // the query any more (#421), so the panel's own clear control does it.
    await showPanel(page, 'search');
    await page.locator('#search-clear').click();
    await page.waitForFunction(() => document.querySelector('#search')?.value === '');
    await showPanel(page, 'files');
    const revoked = await publishAction(page, base, 'revoke');
    assert.equal(revoked.status(), 200, `revoking the fixture note must succeed: ${await revoked.text()}`);
    await page.waitForSelector('#note-list .tree-folder-row', { timeout: 7000 });
    assert.equal(errors.length, 0, `no uncaught page error: ${JSON.stringify(errors)}`);
  });

  // #421 second writer (U49-FIX): the Explorer's own create path
  // (`features/explorer/create-note.js`) used to clear the old Publishes toggle state right
  // after a successful create, so the "no pressed state" invariant survived every other
  // interaction and then broke on the new-note path. This drives the real inline create the
  // way a user does -- hover a folder row, `+`, type a name, Enter -- and reads the shortcut
  // off the live DOM afterwards. The static/unit halves of the same contract live in
  // `test/web-publish-shortcut-semantics.test.js`.
  await check('explorer create note never writes a pressed state onto the Publishes shortcut (#421)', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await showPanel(page, 'files');
    await page.waitForSelector('#note-list .tree-folder-row', { timeout: 7000 });
    assert.equal(
      await page.locator('#publishes-open').getAttribute('aria-pressed'),
      null,
      'precondition: the shortcut starts a shortcut',
    );

    const createdPath = 'Folder/PublishesProbe.md';
    const folder = page.locator('.tree-folder-row[data-folder-path="Folder"]');
    await folder.hover();
    const add = folder.locator('.tree-folder-add');
    await add.waitFor();
    await add.click();
    const input = page.locator('.tree-folder-row[data-folder-path="Folder"] + .tree-children > .note-create-row .note-create-input');
    await input.waitFor();
    await input.fill('PublishesProbe');
    const created = page.waitForResponse(async (response) => {
      if (!response.url().endsWith('/api/web/v1/note') || response.request().method() !== 'POST') return false;
      try { return (await response.request().postDataJSON()).path === createdPath; } catch { return false; }
    });
    await input.press('Enter');
    assert.equal((await created).status(), 200, 'the probe note must really be created');
    // The create path opens the new note, so this waits for the real post-create state, not
    // for the click to resolve.
    await page.waitForFunction((target) => document.querySelector('#current-path')?.textContent === target, createdPath);

    assert.equal(
      await page.locator('#publishes-open').getAttribute('aria-pressed'),
      null,
      'creating a note must not write a pressed state back onto the Publishes shortcut',
    );
    assert.equal(
      await page.locator('#publishes-open').evaluate((element) => element.classList.contains('active')),
      false,
      'nor its latched paint',
    );

    // Hand the fixture Vault back the way the other checks do, and leave the panel query-less
    // in Tree mode for any check registered after this one.
    await fs.rm(path.join(vault, 'Folder', 'PublishesProbe.md'), { force: true });
    // Best-effort catalog re-convergence: the removal is fixture hygiene, not part of what
    // this check measures, so it must never turn into a product failure of its own.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await page.request.get(`${base}/api/web/v2/tree?parent=Folder`);
      if (!response.ok()) break;
      const body = await response.json();
      if (!(body.items ?? []).some((item) => item.path === createdPath)) break;
      await sleep(100);
    }
    await showPanel(page, 'files');
    assert.equal(await searchValue(page), '', 'the create path leaves no query behind');
    await page.waitForSelector('#note-list .tree-folder-row', { timeout: 7000 });
    assert.equal(errors.length, 0, `no uncaught page error: ${JSON.stringify(errors)}`);
  });
}
