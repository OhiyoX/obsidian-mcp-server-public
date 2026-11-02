// Issue #427 (U50, review HOLD): the three *interleavings* around the draft commit's
// `await`, against the real application HTTP routes in real Chromium. The base lifecycle
// scene lives in `explorer-draft.mjs`; this module holds the create POST open on purpose so
// the sequence "commit in flight -> a repaint, or a new draft -> the old answer arrives" is
// a deterministic browser fact:
//
//   1. a late SUCCESS of a replaced draft must not remove the newer draft (and the created
//      resource must stay);
//   2. a late FAILURE of a replaced draft must not render a second row;
//   3. a FAILURE after a mid-flight SSE repaint must restore the in-folder row inside the
//      container that is live now (not the detached pre-request children) and stay
//      directly retryable.
//
// The matching deterministic Node tests live in
// `app/test/explorer-create-draft-interleave.test.js`. Registered right after the #427 draft
// scene; it leaves the shared page on a clean Tree with no draft and no stray toast.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NOTE_PATH, FOLDER_PATH, isCreated, draftUi, watchCreatePosts } from './explorer-draft-fixture.mjs';

// One held create POST: the route handler waits on `gate.promise` until `gate.open()`.
function heldGate() {
  let open = null;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open: () => open?.() };
}

export async function registerExplorerDraftInterleaveChecks(ctx) {
  const { check, sleep, page, vault, outputRoot } = ctx;
  const posts = watchCreatePosts(page);
  const evidence = { startedAt: Date.now(), checks: [] };
  const record = (name, value) => { evidence.checks.push({ name, ...value }); };
  const { rootRow, rootInput, folderInput, inputClass, notePost, folderPost, waitFor, ensureFilesPanel, settleList } = draftUi(page);
  const folderRowOf = (name) => page.locator(`.tree-folder-row[data-folder-path="${name}"]`);
  const inFolderRow = (name) => page.locator(`.tree-folder-row[data-folder-path="${name}"] + .tree-children > .note-create-row`);
  const clearToasts = () => page.evaluate(() => document.querySelectorAll('.toast').forEach((node) => node.remove()));

  try {
    await check('explorer draft interleave: a late folder success never removes the note draft opened after it', async () => {
      await ensureFilesPanel();
      await settleList();
      posts.reset();
      const gate = heldGate();
      const holdFolder = async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        await gate.promise;
        return route.continue();
      };
      await page.route(`**${FOLDER_PATH}`, holdFolder);
      try {
        // The folder commit is opened and its response withheld.
        await page.locator('#new-folder').click();
        await rootInput().fill('Interleave folder');
        const folderResponse = folderPost();
        await rootInput().press('Enter');
        await waitFor('the held folder commit takes its row off screen', () => document.querySelectorAll('#note-list > .note-create-row').length === 0);

        // A fresh note draft opens while the folder request is still in flight.
        await page.locator('#new-note').click();
        await rootInput().fill('Fresh note');
        assert.equal(await rootRow().count(), 1, 'the fresh note draft is open');
        assert.equal(await inputClass(), 'note-create-input', 'the fresh note draft holds the focus');

        gate.open(); // the OLD folder request succeeds now
        assert.ok(isCreated((await folderResponse).status()), 'the held folder POST succeeded');
        await waitFor('the created folder appears in the tree', () => [...document.querySelectorAll('.tree-folder-row')].some((row) => row.dataset.folderPath === 'Interleave folder'));
        await sleep(300);

        assert.equal(await rootRow().count(), 1, 'the older success must not remove the newer draft');
        assert.equal(await rootInput().inputValue(), 'Fresh note', 'the newer draft keeps its typed value');
        assert.equal(await inputClass(), 'note-create-input', 'the newer draft keeps the focus');
        assert.deepEqual(posts.folders().map((entry) => entry.body.path), ['Interleave folder'], 'exactly one folder create left the client');
        assert.equal(await folderExists(vault, 'Interleave folder'), true, 'the confirmed resource is kept');
        record('lateSuccess', { folders: posts.folders().length });
        await rootInput().press('Escape');
        assert.equal(await rootRow().count(), 0, 'the newer draft cancels normally afterwards');
      } finally {
        gate.open();
        await page.unroute(`**${FOLDER_PATH}`, holdFolder);
      }
    });

    await check('explorer draft interleave: a late failure never re-renders the folder draft opened after it', async () => {
      await ensureFilesPanel();
      await settleList();
      posts.reset();
      const gate = heldGate();
      const holdNote = async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        await gate.promise;
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'note-exists' }) });
      };
      await page.route(`**${NOTE_PATH}`, holdNote);
      try {
        await page.locator('#new-note').click();
        await rootInput().fill('Interleave old note');
        await rootInput().press('Enter');
        await waitFor('the held note commit paints no row', () => document.querySelectorAll('#note-list > .note-create-row').length === 0);

        // A fresh folder draft replaces the in-flight draft.
        await page.locator('#new-folder').click();
        await rootInput().fill('Fresh folder');
        assert.equal(await rootRow().count(), 1, 'the fresh folder draft is the single row');

        gate.open(); // the OLD note request fails now
        await page.waitForFunction(() => document.querySelectorAll('.toast.error').length > 0, null, { timeout: 5000 });
        await sleep(200);
        assert.equal(await rootRow().count(), 1, 'the older failure must not render a duplicate row');
        assert.equal(await rootInput().inputValue(), 'Fresh folder', 'the newer draft keeps its typed value');
        assert.equal(await inputClass(), 'note-create-input folder-create-input', 'the focus stays on the newer folder draft');
        assert.deepEqual(posts.notes().map((entry) => entry.body.path), ['/Interleave old note.md'], 'the rejected attempt is the only note POST');
        assert.equal(await page.locator('.note[title="Interleave old note.md"]').count(), 0, 'nothing was created by the rejected attempt');
        record('lateFailure', { notes: posts.notes().length });
        await rootInput().press('Escape');
        await clearToasts();
      } finally {
        gate.open();
        await page.unroute(`**${NOTE_PATH}`, holdNote);
      }
    });

    await check('explorer draft interleave: a failure after a mid-flight repaint restores the in-folder row and stays retryable', async () => {
      await ensureFilesPanel();
      await settleList();
      posts.reset();
      const gate = heldGate();
      let holding = true;
      const holdNested = async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        await gate.promise;
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'note-exists' }) });
      };
      await page.route(`**${NOTE_PATH}`, holdNested);
      try {
        // The in-folder commit is opened and its response withheld.
        await folderRowOf('Folder').hover();
        await folderRowOf('Folder').locator('.tree-folder-add').click();
        await folderInput('Folder').fill('Nested retry');
        await folderInput('Folder').press('Enter');
        await waitFor('the held in-folder commit paints no row', () => document.querySelectorAll('.note-create-row').length === 0);

        // A foreign write repaints the whole tree while the POST is still open.
        await fs.writeFile(path.join(vault, 'Interleave sse fixture.md'), '# fixture\n');
        await page.waitForSelector('.note[title="Interleave sse fixture.md"]', { timeout: 8000 });
        await sleep(250);
        assert.equal(await page.locator('.note-create-row').count(), 0, 'the repaint paints no row for the in-flight commit');

        gate.open(); // the held request fails now
        await page.waitForFunction(() => document.querySelectorAll('.toast.error').length > 0, null, { timeout: 5000 });
        await sleep(200);
        assert.equal(await inFolderRow('Folder').count(), 1, 'the failed commit restores the row in the folder\'s live children');
        const restored = inFolderRow('Folder').locator('.note-create-input');
        assert.equal(await restored.inputValue(), 'Nested retry', 'the typed name survives the repaint');
        assert.equal(await inputClass(), 'note-create-input', 'the restored row takes the focus back');
        await fs.rm(path.join(vault, 'Interleave sse fixture.md'), { force: true });
        await waitFor('the repaint fixture row is gone again', () => ![...document.querySelectorAll('.note')].some((node) => node.title === 'Interleave sse fixture.md'));
        record('repaintFailure', { notes: posts.notes().length });

        // Directly retryable: the same row commits against the real server and creates one file.
        holding = false;
        await page.unroute(`**${NOTE_PATH}`, holdNested);
        const retry = notePost();
        await restored.press('Enter');
        assert.ok(isCreated((await retry).status()), 'the retry POST succeeded');
        await waitFor('the retried in-folder note opens', () => document.querySelector('#current-path')?.textContent === 'Folder/Nested retry.md');
        await sleep(200);
        assert.deepEqual(posts.notes().map((entry) => entry.body.path), ['Folder/Nested retry.md', 'Folder/Nested retry.md'], 'one rejected attempt + one explicit retry, never more');
        assert.equal(await fs.readFile(path.join(vault, 'Folder', 'Nested retry.md'), 'utf8'), '', 'the retried note is the empty Markdown the user asked for');
        await fs.rm(path.join(vault, 'Folder', 'Nested retry.md'), { force: true });
        await clearToasts();
      } finally {
        gate.open();
        if (holding) await page.unroute(`**${NOTE_PATH}`, holdNested).catch(() => {});
        await clearToasts();
      }
    });
  } finally {
    posts.stop();
    await fs.writeFile(path.join(outputRoot, 'explorer-draft-interleave.json'), JSON.stringify(evidence, null, 2));
  }
}

async function folderExists(vault, name) {
  return fs.stat(path.join(vault, name)).then((stat) => stat.isDirectory()).catch(() => false);
}
