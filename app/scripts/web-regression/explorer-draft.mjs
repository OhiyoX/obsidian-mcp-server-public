// Issue #427: the Explorer "new note / new folder" draft lifecycle, against the real
// application HTTP routes in the isolated fixture Vault.
//
// Every check drives the real UI in real Chromium and counts the *actual* POSTs the app
// issues (`/api/web/v1/note`, `/api/web/v1/folder`) plus a disk snapshot of the Vault:
// a cancel must leave both untouched, a commit must leave exactly one resource. Failure
// modes (409 / 403 / network / delay) are injected on the route so the honest-error path
// is exercised without a second server.
//
// Registered from `scripts/web-regression.mjs` right after the Explorer mode-switch scene;
// it leaves the shared page on a clean Tree with an empty search.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NOTE_PATH, draftUi, isCreated, vaultEntries, watchCreatePosts } from './explorer-draft-fixture.mjs';

export async function registerExplorerDraftChecks(ctx) {
  const { check, sleep, page, base, vault, browser, outputRoot } = ctx;
  const posts = watchCreatePosts(page);
  const evidence = { startedAt: Date.now(), base, checks: [] };
  const record = (name, value) => { evidence.checks.push({ name, ...value }); };
  const { rootRow, rootInput, folderInput, inputClass, notePost, folderPost, waitFor, ensureFilesPanel, settleList } = draftUi(page);

  try {
    await check('explorer draft: the panel-head new-note click only opens a draft; Escape, blur and sidebar close never write', async () => {
      await ensureFilesPanel();
      await settleList();
      const before = await vaultEntries(vault);
      // Another scene may still have a toast on screen (an error toast lives 8 s, TOAST_ERROR_MS);
      // the invariant is that the cancel paths below never ADD a message of their own.
      const toastsBefore = await page.locator('.toast').allTextContents();
      posts.reset();

      await page.locator('#new-note').click();
      await sleep(150);
      // The core #427 invariant comes first, so a regression here fails on the POST count
      // and not on a later UI detail.
      assert.deepEqual(posts.entries, [], 'the click alone must never POST');
      assert.deepEqual(await vaultEntries(vault), before, 'the click alone must never create a file');
      await rootInput().waitFor();
      assert.equal(await rootInput().inputValue(), '未命名笔记', 'the draft starts on the product default name');
      assert.equal(await rootRow().count(), 1, 'exactly one draft row is open');
      assert.equal(await inputClass(), 'note-create-input', 'the draft takes the focus');
      record('clickOpensDraft', { posts: posts.entries.length });

      // Escape cancels: no row, no POST, no new file.
      await rootInput().press('Escape');
      assert.equal(await rootRow().count(), 0);
      // An uncommitted blur cancels too (a rename is not a commit).
      await page.locator('#new-note').click();
      await rootInput().fill('草稿未提交');
      await page.locator('#files-toggle').focus();
      await sleep(120);
      assert.equal(await rootRow().count(), 0, 'an uncommitted blur drops the draft row');
      // Closing the pane cancels as well; the sidebar is re-opened for the next check.
      await page.locator('#new-note').click();
      await rootInput().fill('关闭侧栏');
      await page.locator('#panel-close').click();
      await sleep(120);
      assert.equal(await page.locator('#note-list > .note-create-row').count(), 0);
      await page.locator('#files-toggle').click();
      await sleep(120);

      await sleep(250);
      assert.deepEqual(posts.entries, [], 'no cancel path may POST');
      assert.deepEqual(await vaultEntries(vault), before, 'no cancel path may create a file');
      assert.deepEqual(await page.locator('.toast').allTextContents(), toastsBefore, 'a cancel must not add a success message');
      record('cancelPaths', { posts: posts.entries.length, vault: (await vaultEntries(vault)).length });
    });

    await check('explorer draft: the default name never creates from any of the three entries', async () => {
      await ensureFilesPanel();
      const before = await vaultEntries(vault);
      posts.reset();

      // 1. panel-head new note.
      await page.locator('#new-note').click();
      await rootInput().waitFor();
      await rootInput().press('Enter');
      await sleep(120);
      assert.equal(await rootRow().count(), 0, 'the default note name is abandoned, not created');
      // 2. panel-head new folder: Escape and blur cancel it too (rows 2/3 of the issue matrix).
      await page.locator('#new-folder').click();
      await rootInput().waitFor();
      assert.equal(await rootInput().inputValue(), '新建文件夹');
      await rootInput().press('Escape');
      assert.equal(await rootRow().count(), 0, 'Escape drops the root folder draft');
      await page.locator('#new-folder').click();
      await rootInput().blur();
      await sleep(150);
      assert.equal(await rootRow().count(), 0, 'an uncommitted blur drops the root folder draft');
      // The default folder name is not a create intent either.
      await page.locator('#new-folder').click();
      await rootInput().waitFor();
      await rootInput().press('Enter');
      await sleep(120);
      assert.equal(await rootRow().count(), 0, 'the default folder name is abandoned, not created');
      // 3. the folder row's `+`: Escape and blur cancel an unedited in-folder draft.
      const folderRow = page.locator('.tree-folder-row[data-folder-path="Folder"]');
      await folderRow.hover();
      await folderRow.locator('.tree-folder-add').click();
      await folderInput('Folder').waitFor();
      await folderInput('Folder').press('Escape');
      assert.equal(await page.locator('.note-create-row').count(), 0, 'Escape drops the in-folder draft');
      await folderRow.hover();
      await folderRow.locator('.tree-folder-add').click();
      await folderInput('Folder').fill('临时名字');
      await folderInput('Folder').blur();
      await sleep(150);
      assert.equal(await page.locator('.note-create-row').count(), 0, 'an uncommitted in-folder blur drops the draft');
      // ... and the default name is not a create intent there either.
      await folderRow.hover();
      await folderRow.locator('.tree-folder-add').click();
      await folderInput('Folder').waitFor();
      await folderInput('Folder').press('Enter');
      await sleep(120);
      assert.equal(await page.locator('.note-create-row').count(), 0, 'the default in-folder note name is abandoned');

      // A name typed and then set back to the default is not a final change either.
      await page.locator('#new-note').click();
      await rootInput().fill('改过的名字');
      await rootInput().fill('未命名笔记');
      await rootInput().press('Enter');
      await sleep(150);
      assert.equal(await rootRow().count(), 0, 'the default name typed back is not a create intent');

      assert.deepEqual(posts.entries, [], 'the default name must never POST');
      assert.deepEqual(await vaultEntries(vault), before, 'the default name must never create a resource');
      record('defaultName', { posts: posts.entries.length });
    });

    await check('explorer draft: a rename commits exactly one POST and opens / expands the real resource', async () => {
      await ensureFilesPanel();
      const before = await vaultEntries(vault);
      posts.reset();

      // Root note: exactly one note POST, the empty-body file exists and opens.
      await page.locator('#new-note').click();
      await rootInput().fill('Draft root note');
      const noteResponse = notePost();
      await rootInput().press('Enter');
      assert.ok(isCreated((await noteResponse).status()), 'the create POST succeeded');
      await waitFor('the committed root note opens', () => document.querySelector('#current-path')?.textContent === 'Draft root note.md');
      assert.deepEqual(posts.notes().map((entry) => entry.body.path), ['/Draft root note.md'], 'exactly one note POST with the typed path');
      assert.equal(await fs.readFile(path.join(vault, 'Draft root note.md'), 'utf8'), '', 'the committed note is the empty Markdown the user asked for');
      const debugRows = await page.evaluate(() => [...document.querySelectorAll('#note-list > .note-create-row')].map((row) => ({ value: row.querySelector('input')?.value, disabled: row.querySelector('input')?.disabled })));
      const debugToasts = await page.locator('.toast').allTextContents();
      assert.equal(await rootRow().count(), 0, `the committed draft row is gone ${JSON.stringify({ debugRows, debugToasts })}`);

      // Root folder: exactly one folder POST and the new folder is expanded in the tree.
      await page.locator('#new-folder').click();
      await rootInput().fill('Draft folder');
      const folderResponse = folderPost();
      await rootInput().press('Enter');
      assert.ok(isCreated((await folderResponse).status()), 'the folder create POST succeeded');
      await waitFor('the committed folder appears in the tree', () => [...document.querySelectorAll('.tree-folder-row')].some((row) => row.dataset.folderPath === 'Draft folder'));
      assert.deepEqual(posts.folders().map((entry) => entry.body.path), ['Draft folder']);
      assert.equal(await fs.stat(path.join(vault, 'Draft folder')).then((stat) => stat.isDirectory()), true);

      // In-folder note through the row `+`.
      const folderRow = page.locator('.tree-folder-row[data-folder-path="Folder"]');
      await folderRow.hover();
      await folderRow.locator('.tree-folder-add').click();
      await folderInput('Folder').fill('Draft nested');
      const nestedResponse = notePost();
      await folderInput('Folder').press('Enter');
      assert.ok(isCreated((await nestedResponse).status()), 'the in-folder create POST succeeded');
      await waitFor('the committed in-folder note opens', () => document.querySelector('#current-path')?.textContent === 'Folder/Draft nested.md');
      assert.deepEqual(posts.notes().map((entry) => entry.body.path), ['/Draft root note.md', 'Folder/Draft nested.md']);
      assert.equal(await fs.readFile(path.join(vault, 'Folder', 'Draft nested.md'), 'utf8'), '');

      const after = await vaultEntries(vault);
      assert.deepEqual(after.filter((entry) => !before.includes(entry)), ['Draft folder/', 'Draft root note.md', 'Folder/Draft nested.md']);
      record('commit', { posts: posts.entries.map((entry) => entry.body?.path) });

      // Cleanup: the two notes are removed (the watcher does handle `unlink`). The created
      // folder is deliberately LEFT in place: an externally deleted directory is not
      // propagated (`app/src/app/live-events.js` wires add/change/unlink but no
      // `unlinkDir`, and the catalog keeps serving it — evidence:
      // U50/diag/diag-dir-delete.mjs, out of scope for this issue), so deleting it would
      // leave a stale row in the shared page for the rest of the suite.
      await fs.rm(path.join(vault, 'Draft root note.md'), { force: true });
      await fs.rm(path.join(vault, 'Folder', 'Draft nested.md'), { force: true });
    });

    await check('explorer draft: repeated Enter, Enter+blur and a cancelled row decide at most one POST', async () => {
      await ensureFilesPanel();
      posts.reset();

      // Enter burst dispatched in ONE task, on the live row: one create. This is the
      // strongest form of the repeated-Enter case — the row itself is removed the moment
      // the commit starts, so a second physical press cannot even reach it.
      await page.locator('#new-note').click();
      await rootInput().fill('Draft enter burst');
      const burst = notePost();
      await page.evaluate(() => {
        const input = document.querySelector('#note-list > .note-create-row .note-create-input');
        const send = () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        send();
        send();
      });
      assert.ok(isCreated((await burst).status()));
      await page.waitForFunction(() => document.querySelector('#current-path')?.textContent === 'Draft enter burst.md');
      await sleep(250);
      assert.deepEqual(posts.notes().map((entry) => entry.body.path), ['/Draft enter burst.md'], 'an Enter burst is a single create');
      await fs.rm(path.join(vault, 'Draft enter burst.md'), { force: true });
      await sleep(150);

      // Enter immediately followed by a blur (same task): still one create.
      await page.locator('#new-note').click();
      await rootInput().fill('Draft enter blur');
      const blur = notePost();
      await page.evaluate(() => {
        const input = document.querySelector('#note-list > .note-create-row .note-create-input');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        input.dispatchEvent(new FocusEvent('blur'));
      });
      assert.ok(isCreated((await blur).status()));
      await page.waitForFunction(() => document.querySelector('#current-path')?.textContent === 'Draft enter blur.md');
      await sleep(250);
      assert.deepEqual(posts.notes().map((entry) => entry.body.path), ['/Draft enter burst.md', '/Draft enter blur.md'], 'Enter + blur does not create twice');
      await fs.rm(path.join(vault, 'Draft enter blur.md'), { force: true });
      await sleep(150);

      // Cancelled draft, then the row's deferred blur + a late Enter on the dead row: inert.
      const beforeCancel = (await vaultEntries(vault)).length;
      await page.locator('#new-note').click();
      await rootInput().fill('Draft cancelled');
      await page.evaluate(() => {
        const input = document.querySelector('#note-list > .note-create-row .note-create-input');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        input.dispatchEvent(new FocusEvent('blur'));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      });
      await sleep(400);
      assert.equal(await rootRow().count(), 0, 'the cancelled draft keeps no row');
      assert.equal(posts.notes().length, 2, 'a cancelled draft can never add a POST');
      assert.equal((await vaultEntries(vault)).length, beforeCancel, 'a cancelled draft leaves no file');
      record('decisionOnce', { posts: posts.notes().length });
    });

    await check('explorer draft: an SSE repaint keeps the draft, its typed value and the focus', async () => {
      await ensureFilesPanel();
      posts.reset();
      await page.locator('#new-note').click();
      await rootInput().fill('Draft survives sse');
      assert.equal(await inputClass(), 'note-create-input', 'the draft holds the focus before the repaint');

      // A foreign write lands in the Vault: the watcher repaints the tree underneath.
      await fs.writeFile(path.join(vault, 'Draft sse fixture.md'), '# fixture\n');
      await page.waitForSelector('.note[title="Draft sse fixture.md"]', { timeout: 8000 });
      await sleep(200);
      assert.equal(await rootInput().inputValue(), 'Draft survives sse', 'the repaint restores the typed value');
      assert.equal(await inputClass(), 'note-create-input', 'the repaint restores the focus into the draft row');
      assert.deepEqual(posts.entries, [], 'a background repaint must not create anything');

      await page.locator('#new-note').click(); // single owner: re-opening replaces the old draft
      assert.equal(await rootRow().count(), 1, 'replacing a draft leaves exactly one row');
      assert.equal(await rootInput().inputValue(), '未命名笔记');
      await rootInput().press('Escape');
      await fs.rm(path.join(vault, 'Draft sse fixture.md'), { force: true });
      record('sseRepaint', { posts: posts.entries.length });
    });

    await check('explorer draft: 409, 403 and network failures are honest and keep the input for a retry', async () => {
      await ensureFilesPanel();
      await settleList();
      posts.reset();
      let currentPath = await page.locator('#current-path').textContent();
      const failures = [
        { label: '409', status: 409, body: { error: 'note-exists' } },
        { label: '403', status: 403, body: { error: 'read-only' } },
      ];
      for (const failure of failures) {
        await page.route(`**${NOTE_PATH}`, async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          await route.fulfill({ status: failure.status, contentType: 'application/json', body: JSON.stringify(failure.body) });
        });
        try {
          await page.locator('#new-note').click();
          await rootInput().fill(`Draft ${failure.label}`);
          await rootInput().press('Enter');
          await page.waitForFunction(() => document.querySelectorAll('.toast.error').length > 0, null, { timeout: 5000 });
          assert.equal(await rootInput().inputValue(), `Draft ${failure.label}`, `${failure.label}: the typed name is preserved`);
          assert.equal(await rootRow().count(), 1, `${failure.label}: the draft row stays for a retry`);
          assert.equal(await inputClass(), 'note-create-input', `${failure.label}: the focus returns to the row`);
          assert.equal(await page.locator('#current-path').textContent(), currentPath, `${failure.label}: no fake success`);
          assert.equal(await page.locator('.note[title="' + `Draft ${failure.label}.md` + '"]').count(), 0, `${failure.label}: nothing was created`);
          // The toast is NOT clicked: clicking it would move the focus and a blurred draft is
          // cancelled by design (the next iteration would start a fresh draft and the retry
          // below would find no row). The toasts are cleared without touching the focus at
          // the end of this check.
        } finally {
          await page.unroute(`**${NOTE_PATH}`);
        }
      }

      // Network failure: reported, no creation, input kept.
      await page.route(`**${NOTE_PATH}`, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        await route.abort('failed');
      });
      try {
        await page.locator('#new-note').click();
        await rootInput().fill('Draft network');
        await rootInput().press('Enter');
        await page.waitForFunction(() => document.querySelectorAll('.toast.error').length > 0, null, { timeout: 5000 });
        assert.equal(await rootInput().inputValue(), 'Draft network');
        assert.equal(await inputClass(), 'note-create-input', 'the network failure keeps the focus in the row');
      } finally {
        await page.unroute(`**${NOTE_PATH}`);
      }

      // Retry against the real server succeeds and creates exactly one file.
      const retry = notePost();
      await rootInput().press('Enter');
      assert.ok(isCreated((await retry).status()), 'the retry POST succeeded');
      await waitFor('the retried note opens', () => document.querySelector('#current-path')?.textContent === 'Draft network.md');
      assert.equal(await fs.readFile(path.join(vault, 'Draft network.md'), 'utf8'), '');
      assert.equal(posts.notes().length, 4, 'three rejected attempts + one retry, never more');
      currentPath = 'Draft network.md';
      await fs.rm(path.join(vault, 'Draft network.md'), { force: true });
      await sleep(150);
      // Clear this check's error toasts without touching the focus (a later scene must not
      // inherit an 8 s error banner; the toasts are hand-closable in the product).
      await page.evaluate(() => document.querySelectorAll('.toast').forEach((node) => node.remove()));
      record('failures', { posts: posts.notes().length });
    });

    await check('explorer draft: a delayed create stays single-flight, and view switches cancel the draft', async () => {
      await ensureFilesPanel();
      posts.reset();

      // A delayed response must not open a second window for a second POST.
      await page.route(`**${NOTE_PATH}`, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        await sleep(600);
        await route.continue();
      });
      try {
        await page.locator('#new-note').click();
        await rootInput().fill('Draft single flight');
        await page.evaluate(() => { window.__draftInput = document.querySelector('#note-list > .note-create-row .note-create-input'); });
        const delayed = notePost();
        await rootInput().press('Enter');
        await sleep(150);
        // A second Enter while the first request is still in flight (dispatched on the row
        // the commit already removed) must be refused by the single-flight rule.
        await page.evaluate(() => window.__draftInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
        assert.ok(isCreated((await delayed).status()));
        await page.waitForFunction(() => document.querySelector('#current-path')?.textContent === 'Draft single flight.md');
        await sleep(200);
        assert.equal(posts.notes().length, 1, 'an in-flight commit is never duplicated');
      } finally {
        await page.unroute(`**${NOTE_PATH}`);
      }
      await fs.rm(path.join(vault, 'Draft single flight.md'), { force: true });
      await sleep(150);

      // Browse-mode switch: an uncommitted draft is cancelled, not committed.
      posts.reset();
      await page.locator('#new-note').click();
      await rootInput().fill('Draft mode switch');
      await page.locator('#explorer-mode-toggle').click();
      await page.locator('#explorer-mode-menu [data-explorer-mode="flat"]').click();
      await page.waitForFunction(() => document.querySelector('.panel-head')?.dataset.explorerMode === 'flat');
      await sleep(150);
      assert.equal(await page.locator('#note-list .note-create-row').count(), 0, 'flat mode hosts no draft row');
      await page.locator('#explorer-mode-toggle').click();
      await page.locator('#explorer-mode-menu [data-explorer-mode="tree"]').click();
      await page.waitForFunction(() => document.querySelector('.panel-head')?.dataset.explorerMode === 'tree');
      await sleep(200);

      // Search switch: clicking the search tab blurs (and cancels) the open draft. The query
      // is cleared while its own panel is in front (the input is hidden in the file panel).
      await page.locator('#new-note').click();
      await rootInput().fill('Draft search switch');
      await page.locator('[data-sidebar-tab="search"]').click();
      await page.locator('#search').fill('file:A.md');
      await sleep(300);
      assert.equal(await page.locator('.note-create-row').count(), 0, 'a search cancels the draft');
      await page.locator('#search').fill('');
      await page.locator('[data-sidebar-tab="files"]').click();
      await sleep(200);
      assert.deepEqual(posts.entries, [], 'no view switch may commit a draft');
      record('singleFlightAndSwitches', { posts: posts.entries.length });
    });

    await check('explorer draft: a committed empty note survives navigation and existing resources are untouched', async () => {
      await ensureFilesPanel();
      await settleList();
      posts.reset();
      const existingNote = path.join(vault, 'Existing empty.md');
      const existingFolder = path.join(vault, 'Existing empty folder');
      await fs.writeFile(existingNote, '');
      await fs.mkdir(existingFolder, { recursive: true });
      await sleep(300);

      await page.locator('#new-note').click();
      await rootInput().fill('Draft kept');
      const created = notePost();
      await rootInput().press('Enter');
      assert.equal((await created).status(), 200);
      await page.waitForFunction(() => document.querySelector('#current-path')?.textContent === 'Draft kept.md');
      assert.equal(await fs.readFile(path.join(vault, 'Draft kept.md'), 'utf8'), '');

      // Navigation + a new search + a mode switch after the commit: the file stays.
      await page.locator('.note[title="B.md"]').click();
      await page.waitForFunction(() => document.querySelector('#current-path')?.textContent === 'B.md');
      await page.locator('#new-note').click();
      await rootInput().fill('Draft abandoned later');
      await page.locator('[data-sidebar-tab="search"]').click();
      await page.locator('#search').fill('file:A.md');
      await sleep(250);
      await page.locator('#search').fill('');
      await page.locator('[data-sidebar-tab="files"]').click();
      await sleep(250);
      assert.equal(await fs.readFile(path.join(vault, 'Draft kept.md'), 'utf8'), '', 'a committed note is never auto-deleted');
      assert.equal(await fs.readFile(existingNote, 'utf8'), '', 'an existing empty note is never cleaned');
      assert.equal(await fs.stat(existingFolder).then((stat) => stat.isDirectory()), true, 'an existing empty folder is never cleaned');
      assert.equal(await fs.readFile(path.join(vault, 'Folder', 'Nested.md'), 'utf8'), '# Nested heading\n\nserver search marker\n', 'an existing note is never overwritten');
      assert.deepEqual(posts.folders(), [], 'no cancel path deletes or re-creates anything');
      record('keepCommitted', { posts: posts.notes().length });

      await fs.rm(path.join(vault, 'Draft kept.md'), { force: true });
      await fs.rm(existingNote, { force: true });
      await fs.rm(existingFolder, { recursive: true, force: true });
      await sleep(200);
      await page.locator('.note[title="B.md"]').click();
      await page.waitForFunction(() => document.querySelector('#current-path')?.textContent === 'B.md');
    });

    await check('explorer draft: the mobile drawer hosts the draft and closing it cancels', async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
      try {
        await context.addCookies(await page.context().cookies());
        const mobilePage = await context.newPage();
        mobilePage.setDefaultTimeout(7000);
        const mobilePosts = watchCreatePosts(mobilePage);
        const mobileUi = draftUi(mobilePage);
        await mobilePage.goto(`${base}/app`);
        await mobilePage.waitForSelector('.note[title="A.md"]');
        // The file drawer must be open before a panel-head action (the hamburger).
        await mobilePage.locator('#menu').click();
        await mobilePage.locator('#new-note').click();
        const mobileInput = mobileUi.rootInput();
        await mobileInput.waitFor();
        await mobileInput.fill('Draft mobile');
        assert.deepEqual(mobilePosts.entries, [], 'opening the mobile draft writes nothing');

        // Closing the drawer through the scrim cancels the draft: no POST, no file. The
        // click point is the scrim strip the drawer does not cover, proven with
        // elementFromPoint before the click (same technique as the mobile-shell scene).
        const point = { x: 370, y: 620 };
        const hit = await mobilePage.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className ?? '', point);
        assert.match(hit, /scrim/, `the shared scrim must be the topmost element at ${JSON.stringify(point)} (hit: ${hit})`);
        await mobilePage.mouse.click(point.x, point.y);
        await sleep(250);
        assert.equal(await mobileUi.rootRow().count(), 0, 'the closed drawer dropped the draft row');
        assert.deepEqual(mobilePosts.entries, [], 'a closed mobile drawer never commits');
        assert.equal(await mobilePage.locator('.note[title="Draft mobile.md"]').count(), 0, 'the cancelled mobile draft created no note row');
        assert.equal(await fs.stat(path.join(vault, 'Draft mobile.md')).then(() => true).catch(() => false), false, 'no mobile file was created');

        // The mobile commit path still works: one POST and the note opens.
        await mobilePage.locator('#menu').click();
        await mobilePage.locator('#new-note').click();
        await mobileInput.waitFor();
        await mobileInput.fill('Draft mobile ok');
        const created = mobileUi.notePost();
        await mobileInput.press('Enter');
        assert.ok(isCreated((await created).status()), 'the mobile create POST succeeded');
        await mobileUi.waitFor('the mobile note opens', () => document.querySelector('#current-path')?.textContent === 'Draft mobile ok.md');
        assert.equal(await fs.readFile(path.join(vault, 'Draft mobile ok.md'), 'utf8'), '');
        assert.equal(mobilePosts.notes().length, 1, 'the mobile commit is a single POST');
        mobilePosts.stop();
        await fs.rm(path.join(vault, 'Draft mobile ok.md'), { force: true });
        record('mobileDrawer', { posts: mobilePosts.notes().length });
      } finally {
        await context.close();
      }
    });
  } finally {
    posts.stop();
    await fs.writeFile(path.join(outputRoot, 'explorer-draft.json'), JSON.stringify(evidence, null, 2));
  }
}
