// Focused real-Chromium regression for the lazy Explorer Tree sorting adaptation.
//
// The main `scripts/web-regression.mjs` suite stays the product-wide harness. This
// file is an additive, reviewable scenario set for the four required lazy-sort
// behaviours, each in an isolated temporary Vault against the real HTTP routes:
//
//   1. a >1-page parent keeps the whole-parent server ordering across load-more and
//      the retired cursor never crosses a sort switch;
//   2. nested expanded levels + the current-note focus survive a sort switch with
//      bounded lazy materialization (no eager Vault walk, no duplicate rows);
//   3. a query-active sort is zero search/tree/per-note IO and preserves the
//      server-authoritative search order; a later Reveal locates under the adopted spec;
//   4. an active inline-create draft keeps focus/value across deferred sorts and an
//      SSE refresh, and both cancel and commit settle to the last requested spec.
//
// Run after `npm run build:web`:
//   CI=true node scripts/web-explorer-sort-regression.mjs
// Env: WEB_SORT_OUTPUT (artifact dir), WEB_TEST_ONLY (regex, local), PLAYWRIGHT_MODULE,
//      CHROMIUM_EXECUTABLE.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const appRoot = path.resolve(import.meta.dirname, '..');
const outputRoot = path.resolve(process.env.WEB_SORT_OUTPUT || path.join(appRoot, '.browser-sort-ci'));
await fs.mkdir(outputRoot, { recursive: true });
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-web-sort-browser-'));
const vault = path.join(root, 'vault');
await fs.mkdir(vault);

await fs.writeFile(path.join(vault, 'A.md'), '# A heading\n\nA unique content.\n');
await fs.writeFile(path.join(vault, 'B.md'), '# B heading\n\nB unique content.\n');
await fs.mkdir(path.join(vault, 'Folder'));
await fs.writeFile(path.join(vault, 'Folder', 'Nested.md'), '# Nested heading\n\nserver search marker\n');
// A >1-page directory: the API page size is 100, so 130 forces one load-more.
await fs.mkdir(path.join(vault, 'Bulk'));
for (let n = 0; n < 130; n += 1) await fs.writeFile(path.join(vault, 'Bulk', `note-${String(n).padStart(3, '0')}.md`), `# bulk ${n}\n`);
// A nested chain for the expansion/focus scenario.
await fs.mkdir(path.join(vault, 'Deep', 'Inner'), { recursive: true });
await fs.writeFile(path.join(vault, 'Deep', 'Inner', 'Target.md'), '# deep target\n');

const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const password = randomBytes(24).toString('hex');
const child = spawn(process.execPath, ['server.js'], {
  cwd: appRoot,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    HOST: '127.0.0.1', PORT: String(port), VAULT_PATH: vault, WEB_VAULTS_ROOT: '', WEB_DEFAULT_VAULT: '', DATA_PATH: path.join(root, 'data'),
    OAUTH_ENABLED: 'true', PUBLIC_BASE_URL: base, OAUTH_INITIAL_USERNAME: 'browser-test', OAUTH_INITIAL_PASSWORD: password,
    OAUTH_ADMIN_PASSWORD: password, API_KEY: '', GIT_ENABLED: 'false', GIT_AUTO_COMMIT: 'false', GIT_AUTO_PUSH: 'false',
    EMBEDDING_PROVIDER: 'disabled', EMBEDDING_EDGE_PROVIDER: 'disabled', EMBEDDING_EDGE_BASE_URL: '', EMBEDDING_EDGE_REGISTRY_URL: '', RETRIEVAL_AUTO_EMBED: 'false', WEB_FILE_WATCH_DEBOUNCE_MS: '50',
  },
});
const serverErrors = [];
child.stderr.on('data', (d) => serverErrors.push(d.toString()));
child.stdout.resume();

const results = [];
let browser;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function check(name, fn) {
  if (process.env.WEB_TEST_ONLY && !new RegExp(process.env.WEB_TEST_ONLY).test(name)) return;
  const start = Date.now();
  try { await fn(); results.push({ name, pass: true, ms: Date.now() - start }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, pass: false, error: error.message, ms: Date.now() - start }); console.log(`FAIL ${name}: ${error.message}`); }
}

let exitCode = 0;
try {
  for (let n = 0; n < 150; n += 1) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* retry */ } if (child.exitCode !== null) throw Error('Test server exited'); await sleep(100); }
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(8000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
  const login = await page.request.post(`${base}/auth/login`, { form: { username: 'browser-test', password } });
  assert.equal(login.status(), 200);
  await page.goto(`${base}/app`);
  await page.waitForSelector('.note[title="A.md"]');

  // The sort control is a toolbar trigger plus an option menu (the desktop
  // file-explorer shape): one option per key×direction, the live one carrying
  // aria-checked="true". Every helper below drives that real UI.
  const sortTrigger = page.locator('#explorer-sort-toggle');
  const sortOption = (key, direction) => page.locator(`#explorer-sort-menu [data-sort-key="${key}"][data-sort-direction="${direction}"]`);
  const currentSpec = () => page.evaluate(() => {
    const checked = document.querySelector('#explorer-sort-menu [aria-checked="true"]');
    return checked ? { key: checked.dataset.sortKey, direction: checked.dataset.sortDirection } : null;
  });
  const currentDirection = async () => (await currentSpec())?.direction;
  const rootRequestFor = (sort, direction) => page.waitForResponse((r) => {
    if (!r.url().includes('/api/web/v2/tree')) return false;
    const u = new URL(r.url());
    return u.searchParams.get('parent') === '' && u.searchParams.get('sort') === sort && u.searchParams.get('direction') === direction;
  });
  // Pick a spec through the menu without waiting for tree IO: query-active sorts and
  // draft-deferred sorts issue no root request at all.
  async function clickSort(key, direction) {
    await sortTrigger.click();
    await sortOption(key, direction).click();
  }
  // Drive the control to a spec and wait for the tree re-materialization to land.
  async function setSort(key, direction) {
    const spec = await currentSpec();
    if (spec && spec.key === key && spec.direction === direction) return;
    const response = rootRequestFor(key, direction);
    await clickSort(key, direction);
    await response;
    await page.waitForFunction(([k, d]) => document.querySelector(`#explorer-sort-menu [data-sort-key="${k}"][data-sort-direction="${d}"]`)?.getAttribute('aria-checked') === 'true', [key, direction]);
  }
  const notePaths = () => page.locator('.note[data-path]').evaluateAll((nodes) => nodes.map((n) => n.dataset.path));
  const domPaths = (prefix) => page.locator(`.note[title^="${prefix}"]`).evaluateAll((nodes) => nodes.map((n) => n.dataset.path));

  await check('sort scenario 1: >1-page parent is server-ordered across load-more and the old cursor retires', async () => {
    await page.locator('#search').fill('');
    await page.waitForSelector('.note[title="A.md"]');
    await setSort('name', 'asc');
    await setSort('modified', 'desc');
    const tree = [];
    const onRequest = (r) => { if (r.url().includes('/api/web/v2/tree')) tree.push(new URL(r.url())); };
    page.on('request', onRequest);
    try {
      const firstBulk = page.waitForResponse((r) => r.url().includes('/api/web/v2/tree') && new URL(r.url()).searchParams.get('parent') === 'Bulk');
      await page.locator('.tree-folder-row[data-folder-path="Bulk"] .tree-folder').click();
      const firstBody = await (await firstBulk).json();
      assert.equal(firstBody.items.length, 100, 'a full page is returned');
      assert.ok(firstBody.nextCursor, 'a >1-page directory must return a nextCursor');
      await page.waitForSelector(`.note[title="${firstBody.items[0].path}"]`);

      const authoritative = await (await page.request.get(`${base}/api/web/v2/tree?parent=Bulk&sort=modified&direction=desc&limit=300`)).json();
      assert.equal(authoritative.items.length, 130, 'the whole parent is visible to the authority fetch');
      assert.deepEqual(await domPaths('Bulk/note-'), authoritative.items.slice(0, 100).map((item) => item.path), 'the first page must be the server-order prefix, never a client re-sort');

      tree.length = 0;
      const nextBulk = page.waitForResponse((r) => { if (!r.url().includes('/api/web/v2/tree')) return false; const u = new URL(r.url()); return u.searchParams.get('parent') === 'Bulk' && u.searchParams.get('cursor'); });
      await page.locator('.tree-load-more').first().click();
      const nextResponse = await nextBulk;
      assert.equal(new URL(nextResponse.request().url()).searchParams.get('cursor'), firstBody.nextCursor, 'load-more must pass the returned cursor verbatim');
      await page.waitForFunction(() => document.querySelectorAll('.note[title^="Bulk/note-"]').length >= 130, undefined, { timeout: 6000 });
      await sleep(120);
      assert.deepEqual(await domPaths('Bulk/note-'), authoritative.items.map((item) => item.path), 'concatenated pages must equal the whole-parent server order with no duplicate/missing/re-sort');
      assert.ok(tree.every((u) => u.searchParams.get('sort') === 'modified' && u.searchParams.get('direction') === 'desc'), `every page stays on the frozen spec: ${tree.map((u) => u.search)}`);

      tree.length = 0;
      await setSort('name', 'asc');
      await page.waitForFunction(() => document.querySelectorAll('.note[title^="Bulk/note-"]').length === 100, undefined, { timeout: 6000 });
      await sleep(150);
      assert.ok(tree.some((u) => u.searchParams.get('parent') === 'Bulk'), 'the expanded parent must reload under the new spec');
      assert.ok(tree.every((u) => u.searchParams.get('sort') === 'name'), `every request after the switch is under name: ${tree.map((u) => u.search)}`);
      assert.ok(tree.every((u) => u.searchParams.get('cursor') !== firstBody.nextCursor), 'the retired modified cursor must never be replayed under name');
      assert.equal((await currentSpec())?.key, 'name');
      assert.equal((await currentSpec())?.direction, 'asc');
      // Leave Bulk collapsed so the next scenario materializes only its own chain.
      await page.locator('.tree-folder-row[data-folder-path="Bulk"] .tree-folder').click();
      await sleep(100);
    } finally { page.off('request', onRequest); }
  });

  await check('sort scenario 2: nested expansion + current-note focus survive the switch with bounded lazy materialization', async () => {
    await page.locator('#search').fill('');
    await setSort('name', 'asc');
    const bulkToggle = page.locator('.tree-folder-row[data-folder-path="Bulk"] .tree-folder');
    if ((await bulkToggle.getAttribute('aria-expanded')) === 'true') { await bulkToggle.click(); await sleep(80); }
    await page.locator('.tree-folder-row[data-folder-path="Deep"] .tree-folder').click();
    await page.waitForSelector('.tree-folder-row[data-folder-path="Deep/Inner"]');
    await page.locator('.tree-folder-row[data-folder-path="Deep/Inner"] .tree-folder').click();
    await page.waitForSelector('.note[title="Deep/Inner/Target.md"]');
    const opened = page.waitForResponse((r) => r.request().method() === 'GET' && r.url().includes('/api/web/v1/note?') && new URL(r.url()).searchParams.get('path') === 'Deep/Inner/Target.md');
    await page.locator('.note[title="Deep/Inner/Target.md"]').click();
    assert.equal((await opened).status(), 200);
    await page.waitForFunction(() => document.querySelector('#current-path')?.textContent === 'Deep/Inner/Target.md');

    const tree = [];
    const onRequest = (r) => { if (r.url().includes('/api/web/v2/tree')) tree.push(new URL(r.url())); };
    page.on('request', onRequest);
    try {
      tree.length = 0;
      await setSort('modified', 'desc');
      await page.waitForSelector('.note[title="Deep/Inner/Target.md"]');
      await sleep(150);
      const parents = [...new Set(tree.map((u) => u.searchParams.get('parent')))].sort();
      assert.ok(parents.every((p) => p === '' || p === 'Deep' || p === 'Deep/Inner'), `only the materialized chain reloads: ${parents}`);
      assert.ok(tree.length <= 8, `bounded lazy materialization, not an eager Vault walk: ${tree.map((u) => u.search)}`);
      assert.equal(await page.locator('.tree-folder-row[data-folder-path="Deep"] .tree-folder').getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('.tree-folder-row[data-folder-path="Deep/Inner"] .tree-folder').getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('.note[aria-current="page"]').count(), 1, 'exactly one current row');
      assert.equal(await page.locator('.note[title="Deep/Inner/Target.md"][aria-current="page"]').count(), 1, 'the current note focus is restored');
      const paths = await notePaths();
      assert.equal(new Set(paths).size, paths.length, `no duplicate rows from a transient mix: ${paths.length} vs ${new Set(paths).size}`);
    } finally { page.off('request', onRequest); }
  });

  await check('sort scenario 3: query-local sort preserves server order and Reveal uses the adopted Tree spec', async () => {
    await page.locator('#search').fill('');
    await setSort('name', 'asc');
    const bulkFolder = page.locator('.tree-folder-row[data-folder-path="Bulk"] .tree-folder');
    if ((await bulkFolder.getAttribute('aria-expanded')) !== 'true') {
      const load = page.waitForResponse((r) => r.url().includes('/api/web/v2/tree') && new URL(r.url()).searchParams.get('parent') === 'Bulk');
      await bulkFolder.click();
      await load;
    }
    await page.waitForSelector('.note[title="Bulk/note-000.md"]');
    const findFar = page.waitForResponse((r) => r.url().includes('/api/web/v2/search?') && new URL(r.url()).searchParams.get('q') === 'file:note-125');
    await page.locator('#search').fill('file:note-125');
    await findFar;
    await page.waitForSelector('.note[title="Bulk/note-125.md"]');
    const opened = page.waitForResponse((r) => r.request().method() === 'GET' && r.url().includes('/api/web/v1/note?') && new URL(r.url()).searchParams.get('path') === 'Bulk/note-125.md');
    await page.locator('.note[title="Bulk/note-125.md"]').click();
    assert.equal((await opened).status(), 200);
    await page.waitForFunction(() => document.querySelector('#current-path')?.textContent === 'Bulk/note-125.md');

    const network = [];
    const onRequest = (r) => {
      const u = r.url();
      if (u.includes('/api/web/v2/tree')) network.push(`tree ${u}`);
      else if (u.includes('/api/web/v2/search')) network.push(`search ${u}`);
      else if (u.includes('/api/web/v1/notes')) network.push(`v1notes ${u}`);
      else if (/\/api\/web\/v1\/note(\?|$)/.test(u)) network.push(`note ${u}`);
    };
    page.on('request', onRequest);
    try {
      const results2 = page.waitForResponse((r) => r.url().includes('/api/web/v2/search?') && new URL(r.url()).searchParams.get('q') === 'file:note-1');
      await page.locator('#search').fill('file:note-1');
      await results2;
      await page.waitForSelector('.note[data-path]');
      const before = await notePaths();
      network.length = 0;
      await clickSort('modified', await currentDirection());
      await sleep(250);
      assert.equal(network.filter((entry) => entry.startsWith('tree ')).length, 0, `query sort must not touch tree IO: ${network}`);
      assert.equal(network.filter((entry) => entry.startsWith('search ')).length, 0, `query sort must not re-query search: ${network}`);
      assert.equal(network.filter((entry) => entry.startsWith('note ')).length, 0, `query sort must not touch per-note IO: ${network}`);
      assert.equal(network.filter((entry) => entry.startsWith('v1notes ')).length, 0, `query sort must never use v1 notes: ${network}`);
      const after = await notePaths();
      assert.deepEqual(after, before, 'Explorer sort must preserve the server-authoritative search order');
      assert.equal(new Set(after).size, after.length, 'no duplicate rows after the query sort');
      assert.equal((await currentSpec())?.key, 'modified');

      network.length = 0;
      const locate = page.waitForResponse((r) => { if (!r.url().includes('/api/web/v2/tree')) return false; return new URL(r.url()).searchParams.get('anchorPath') === 'Bulk/note-125.md'; });
      await page.locator('#reveal-active').click();
      const located = await locate;
      assert.match(located.request().url(), /sort=modified/, `Reveal must locate under the adopted spec: ${located.request().url()}`);
      await page.waitForSelector('.note[title="Bulk/note-125.md"][aria-current="page"]');
      assert.equal(await page.locator('#search').inputValue(), '');
    } finally {
      page.off('request', onRequest);
      await page.locator('#search').fill('').catch(() => {});
    }
  });

  await check('sort scenario 4: inline-create keeps draft/focus and last-spec-wins on cancel and commit with SSE', async () => {
    await page.locator('#search').fill('');
    await setSort('name', 'asc');
    const folderRow = page.locator('.tree-folder-row[data-folder-path="Folder"]');
    if ((await folderRow.locator('.tree-folder').getAttribute('aria-expanded')) !== 'true') await folderRow.locator('.tree-folder').click();
    await page.waitForSelector('.note[title="Folder/Nested.md"]');
    const inputLocator = page.locator('.tree-folder-row[data-folder-path="Folder"] + .tree-children > .note-create-row .note-create-input');
    async function openDraft(value) {
      await folderRow.hover();
      await folderRow.locator('.tree-folder-add').click();
      await inputLocator.waitFor();
      await inputLocator.fill(value);
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('note-create-input')), true, 'draft input owns focus');
      return inputLocator;
    }

    // CANCEL path: two deferred sort requests, then an SSE refresh, then Escape.
    const draftInput = await openDraft('Sort draft cancel');
    await clickSort('modified', await currentDirection());
    await clickSort('name', await currentDirection());
    assert.equal(await draftInput.inputValue(), 'Sort draft cancel', 'a deferred sort must not drop the draft value');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('note-create-input')), true, 'a deferred sort must not steal focus');
    await fs.writeFile(path.join(vault, 'Folder', 'SortLive.md'), '# sort live\n');
    await page.waitForSelector('.note[title="Folder/SortLive.md"]', { timeout: 8000 });
    assert.equal(await draftInput.inputValue(), 'Sort draft cancel', 'an SSE refresh must restore the draft value');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('note-create-input')), true, 'an SSE refresh must restore focus');
    await draftInput.press('Escape');
    await page.waitForFunction(() => document.querySelectorAll('.note-create-row').length === 0);
    await sleep(300);
    assert.equal((await currentSpec())?.key, 'name', 'cancel settles on the last requested spec (name)');
    assert.equal((await currentSpec())?.direction, 'asc');
    await fs.rm(path.join(vault, 'Folder', 'SortLive.md'), { force: true });

    // COMMIT path: one deferred sort (modified) plus an SSE refresh, then Enter.
    const commitInput = await openDraft('Sort draft commit');
    const tree = [];
    const onRequest = (r) => { if (r.url().includes('/api/web/v2/tree')) tree.push(new URL(r.url())); };
    page.on('request', onRequest);
    try {
      await clickSort('modified', await currentDirection());
      await fs.writeFile(path.join(vault, 'Folder', 'SortLive2.md'), '# sort live 2\n');
      await page.waitForSelector('.note[title="Folder/SortLive2.md"]', { timeout: 8000 });
      assert.equal(await commitInput.inputValue(), 'Sort draft commit', 'the SSE refresh keeps the committed draft');
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('note-create-input')), true);
      const created = page.waitForResponse(async (r) => {
        if (!r.url().endsWith('/api/web/v1/note') || r.request().method() !== 'POST') return false;
        try { return (await r.request().postDataJSON()).path === 'Folder/Sort draft commit.md'; } catch { return false; }
      });
      await commitInput.press('Enter');
      assert.equal((await created).status(), 200);
      await page.waitForFunction(() => document.querySelector('#current-path')?.textContent === 'Folder/Sort draft commit.md');
      await sleep(300);
      assert.equal((await currentSpec())?.key, 'modified', 'commit settles on the last requested spec (modified)');
      assert.ok(tree.some((u) => u.searchParams.get('sort') === 'modified'), `the deferred spec re-materializes the tree: ${tree.map((u) => u.search)}`);
    } finally {
      page.off('request', onRequest);
      await fs.rm(path.join(vault, 'Folder', 'Sort draft commit.md'), { force: true });
      await fs.rm(path.join(vault, 'Folder', 'SortLive2.md'), { force: true });
    }
    await setSort('name', 'asc');
  });

  await check('sort scenario 5: root and expanded 500/503 failures surface the retry row and recover on retry', async () => {
    // Fully independent page/context: the injected failures must not depend on the
    // state left by the sorting scenarios, and must not disturb them.
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const errorPage = await context.newPage();
    errorPage.setDefaultTimeout(8000);
    try {
      const relogin = await errorPage.request.post(`${base}/auth/login`, { form: { username: 'browser-test', password } });
      assert.equal(relogin.status(), 200);

      // Root: keep failing every root page until we deliberately allow recovery, so
      // the explicit retry row replaces the loading placeholder and is stable. The
      // render signature must see the error to rebuild the DOM.
      let rootFailing = true;
      const rootHandler = async (route) => {
        const u = new URL(route.request().url());
        if (u.pathname.endsWith('/api/web/v2/tree') && u.searchParams.get('parent') === '' && rootFailing) {
          await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
          return;
        }
        await route.continue();
      };
      await errorPage.route('**/api/web/v2/tree**', rootHandler);
      await errorPage.goto(`${base}/app`);
      const rootError = errorPage.locator('.tree-load-error[data-parent-path=""]');
      await rootError.waitFor({ state: 'visible' });
      // The SSE connect issues a bounded resync that may re-materialize the root once;
      // let it settle so the error row (which every failing reload reaches) is stable.
      await sleep(800);
      assert.equal(await rootError.count(), 1, 'the failed root shows exactly one retry row');
      assert.equal(await rootError.locator('.tree-retry').count(), 1, 'the retry control renders');
      rootFailing = false;
      await rootError.locator('.tree-retry').click();
      await errorPage.waitForSelector('.note[title="A.md"]');
      await errorPage.waitForFunction(() => document.querySelectorAll('.tree-load-error[data-parent-path=""]').length === 0);
      await errorPage.unroute('**/api/web/v2/tree**', rootHandler);

      // Expanded parent: fail every Folder children request until we allow recovery,
      // so the level settles into the error row and recovers via the rendered retry.
      let folderFailing = true;
      const folderHandler = async (route) => {
        const u = new URL(route.request().url());
        if (u.pathname.endsWith('/api/web/v2/tree') && u.searchParams.get('parent') === 'Folder' && folderFailing) {
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'catalog-unavailable' }) });
          return;
        }
        await route.continue();
      };
      await errorPage.route('**/api/web/v2/tree**', folderHandler);
      await errorPage.locator('.tree-folder-row[data-folder-path="Folder"] .tree-folder').click();
      const folderError = errorPage.locator('.tree-load-error[data-parent-path="Folder"]');
      await folderError.waitFor({ state: 'visible' });
      assert.equal(await folderError.count(), 1, 'the failed expanded level shows exactly one retry row');
      folderFailing = false;
      await folderError.locator('.tree-retry').click();
      await errorPage.waitForSelector('.note[title="Folder/Nested.md"]');
      await errorPage.waitForFunction(() => document.querySelectorAll('.tree-load-error[data-parent-path="Folder"]').length === 0);
      await errorPage.unroute('**/api/web/v2/tree**', folderHandler);
    } finally {
      await context.close();
    }
  });

  assert.deepEqual(pageErrors, [], `no page errors: ${pageErrors.join('\n')}`);
  exitCode = results.some((r) => !r.pass) ? 1 : 0;
} catch (error) {
  results.push({ name: 'harness', pass: false, error: error.stack || error.message });
  console.log(`HARNESS ERROR: ${error.stack || error.message}`);
  exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill('SIGTERM');
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

const passed = results.filter((r) => r.pass).length;
const summary = {
  status: exitCode === 0 ? 'passed' : 'failed',
  checks: { total: results.length, passed, failed: results.length - passed, failedNames: results.filter((r) => !r.pass).map((r) => r.name) },
  results,
  serverErrors,
};
await fs.writeFile(path.join(outputRoot, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
await fs.writeFile(path.join(outputRoot, 'ci-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\nFocused sort regression: ${passed}/${results.length} passed`);
process.exit(exitCode);
