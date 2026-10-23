// Shared probes for the issue #427 Explorer draft checks (desktop scene + mobile scene).
//
// Everything here observes the *real* app: the create POSTs the page actually issues, the
// fixture Vault on disk, and the DOM. Kept in its own module so both scenes stay well under
// the repository's file budget (`scripts/line-budget.mjs`).
import fs from 'node:fs/promises';
import path from 'node:path';

export const NOTE_PATH = '/api/web/v1/note';
export const FOLDER_PATH = '/api/web/v1/folder';

// Both create routes answer `201 Created` (`app/src/app/routes.js`); a reshaped 200 would
// still be a success, so callers pin "a successful create", not the literal code.
export const isCreated = (status) => status === 200 || status === 201;

// Every create POST a page issues, with its JSON body, in order.
export function watchCreatePosts(page) {
  const entries = [];
  const onRequest = (request) => {
    if (request.method() !== 'POST') return;
    const url = new URL(request.url());
    if (url.pathname !== NOTE_PATH && url.pathname !== FOLDER_PATH) return;
    let body = null;
    try { body = request.postDataJSON(); } catch { body = null; }
    entries.push({ path: url.pathname, body });
  };
  page.on('request', onRequest);
  return {
    entries,
    notes: () => entries.filter((entry) => entry.path === NOTE_PATH),
    folders: () => entries.filter((entry) => entry.path === FOLDER_PATH),
    reset: () => { entries.length = 0; },
    stop: () => page.off('request', onRequest),
  };
}

// A recursive listing of the fixture Vault, so "no new .md / no new directory" is a disk
// fact and not a client claim. `.obsidian` is harness chrome, not user content.
export async function vaultEntries(vault) {
  const out = [];
  const walk = async (dir, prefix) => {
    for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
      if (prefix === '' && dirent.name === '.obsidian') continue;
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      out.push(dirent.isDirectory() ? `${rel}/` : rel);
      if (dirent.isDirectory()) await walk(path.join(dir, dirent.name), rel);
    }
  };
  await walk(vault, '');
  return out.sort();
}

// A pending wait must never crash the whole suite when the check that created it fails
// earlier: attaching a no-op handler keeps the rejection handled, and `await`ing the
// returned promise still surfaces it inside the check.
const swallow = (promise) => {
  promise.catch(() => {});
  return promise;
};

// The draft row's selectors, the create-POST waits and the two settle helpers, bound to one
// page. A root-scope draft row is a direct child of the file list; an in-folder one lives in
// that folder's own children container.
export function draftUi(page) {
  const noteResponse = () => swallow(page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === NOTE_PATH));
  const folderResponse = () => swallow(page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === FOLDER_PATH));
  return {
    rootRow: () => page.locator('#note-list > .note-create-row'),
    rootInput: () => page.locator('#note-list > .note-create-row .note-create-input'),
    folderInput: (folder) => page.locator(`.tree-folder-row[data-folder-path="${folder}"] + .tree-children > .note-create-row .note-create-input`),
    inputClass: () => page.evaluate(() => document.activeElement?.className ?? ''),
    notePost: noteResponse,
    folderPost: folderResponse,
    // A labelled wait, so a timeout names the step instead of a bare Playwright message.
    waitFor: async (label, fn, timeout = 8000) => {
      try { await page.waitForFunction(fn, null, { timeout }); }
      catch (error) { throw new Error(`${label}: ${error.message}`); }
    },
    // The file panel must be in front and the sidebar visible before a panel-head action.
    ensureFilesPanel: async () => {
      if (await page.locator('[data-sidebar-tab="files"]').getAttribute('aria-selected') !== 'true') {
        await page.locator('[data-sidebar-tab="files"]').click();
      }
      if (await page.locator('.shell').evaluate((el) => el.classList.contains('sidebar-hidden'))) {
        await page.locator('#files-toggle').click();
      }
    },
    // Wait until the list stops mutating, so a background repaint cannot be mistaken for a
    // click effect (the same settle rule the explorer checks use).
    settleList: async () => {
      await page.evaluate(() => {
        window.__draftMutationAt = performance.now();
        window.__draftObserver = new MutationObserver(() => { window.__draftMutationAt = performance.now(); });
        window.__draftObserver.observe(document.querySelector('#note-list'), { childList: true, subtree: true });
      });
      await page.waitForFunction(() => performance.now() - window.__draftMutationAt > 250, null, { timeout: 7000 });
      await page.evaluate(() => window.__draftObserver.disconnect());
    },
  };
}
