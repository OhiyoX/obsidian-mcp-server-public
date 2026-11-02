// Focused real-Chromium regression for the Explorer flat view (Phase 2).
//
// Additive scenario set, like `web-explorer-sort-regression.mjs`: it runs its own
// isolated temporary Vault against the real HTTP routes and drives the real controls,
// so the flat view is verified as a product behaviour (not only as pure modules):
//
//   1. the mode menu switches Tree <-> Flat, Flat lists every note of the Vault and
//      the `modified desc` order matches the flat API for the same Vault;
//   2. a query survives the mode switch, the Flat list equals the search result set
//      and `name`/`modified`/`score` sorting are all switchable in query context;
//   3. reveal scrolls to and highlights the current note in Flat without leaving the
//      query behind for the Tree behaviour of the same control;
//   4. the mode and flat sort preferences survive a reload, and the narrow layout
//      does not overflow.
//
// Run after `npm run build:web`:
//   CI=true node scripts/web-explorer-flat-regression.mjs
// Env: WEB_FLAT_OUTPUT (artifact dir, screenshots + results.json), WEB_TEST_ONLY
//      (regex, local), PLAYWRIGHT_MODULE, CHROMIUM_EXECUTABLE.
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
const outputRoot = path.resolve(process.env.WEB_FLAT_OUTPUT || path.join(appRoot, '.browser-flat-ci'));
await fs.mkdir(outputRoot, { recursive: true });
const shotsRoot = path.join(outputRoot, 'screenshots');
await fs.mkdir(shotsRoot, { recursive: true });
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-web-flat-browser-'));
const vault = path.join(root, 'vault');
await fs.mkdir(path.join(vault, 'Notes', 'Deep'), { recursive: true });

// Distinct mtimes so `modified` order is deterministic, and a shared text seed whose
// per-note repetition count gives the search path distinct bm25 scores.
const files = [
  ['A.md', '# A\n\nneedle needle needle needle needle\n', '2026-01-01T10:00:00Z'],
  ['B.md', '# B\n\nneedle\n', '2026-01-02T10:00:00Z'],
  ['Notes/C.md', '# C\n\nneedle needle\n', '2026-01-03T10:00:00Z'],
  ['Notes/Deep/D.md', '# D\n\nplain deep note\n', '2026-01-04T10:00:00Z'],
  ['E.md', '# E\n\nplain root note\n', '2026-01-05T10:00:00Z'],
];
for (const [name, body, iso] of files) {
  const target = path.join(vault, name);
  await fs.writeFile(target, body);
  const when = new Date(iso);
  await fs.utimes(target, when, when);
}

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
let scoreSamples = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function check(name, fn) {
  if (process.env.WEB_TEST_ONLY && !new RegExp(process.env.WEB_TEST_ONLY).test(name)) return;
  const start = Date.now();
  try { await fn(); results.push({ name, pass: true, ms: Date.now() - start }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, pass: false, error: error.message, ms: Date.now() - start }); console.log(`FAIL ${name}: ${error.message}`); }
}

const TREE_PATHS = ['A.md', 'B.md', 'E.md', 'Notes/C.md', 'Notes/Deep/D.md'];
const MODIFIED_DESC = ['E.md', 'Notes/Deep/D.md', 'Notes/C.md', 'B.md', 'A.md'];
const QUERY_PATHS = ['A.md', 'B.md', 'Notes/C.md'];
const NAME_ASC = ['A.md', 'B.md', 'Notes/C.md'];

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

  const modeTrigger = page.locator('#explorer-mode-toggle');
  const modeOption = (mode) => page.locator(`#explorer-mode-menu [data-explorer-mode="${mode}"]`);
  const flatSortTrigger = page.locator('#explorer-flat-sort-toggle');
  const flatSortOption = (value) => page.locator(`#explorer-flat-sort-menu [data-flat-sort="${value}"]`);
  const flatPaths = () => page.locator('#note-list .note-flat[data-path]').evaluateAll((nodes) => nodes.map((n) => n.dataset.path));
  const flatSpec = () => page.evaluate(() => {
    const checked = document.querySelector('#explorer-flat-sort-menu [aria-checked="true"]');
    return checked ? checked.dataset.flatSort : null;
  });
  const filePanelMode = () => page.evaluate(() => document.querySelector('[data-panel-head="files"]')?.dataset.explorerMode ?? null);
  const showFilesTab = async () => {
    if (await page.locator('[data-sidebar-tab="files"]').getAttribute('aria-selected') !== 'true') await page.locator('[data-sidebar-tab="files"]').click();
  };
  const showSearchTab = async () => {
    if (await page.locator('[data-sidebar-tab="search"]').getAttribute('aria-selected') !== 'true') await page.locator('[data-sidebar-tab="search"]').click();
  };
  const searchValue = () => page.evaluate(() => document.querySelector('#search')?.value ?? null);
  const setMode = async (mode) => {
    if (await filePanelMode() === mode) return;
    await modeTrigger.click();
    await modeOption(mode).click();
    if (mode === 'flat') await page.waitForSelector('#note-list .note-flat[data-path]');
    else await page.waitForSelector('#note-list .tree-folder-row, #note-list .note[data-path]');
  };
  const setFlatSort = async (value) => {
    if (await flatSpec() === value) return;
    await flatSortTrigger.click();
    await flatSortOption(value).click();
    await page.waitForFunction((expected) => document.querySelector('#explorer-flat-sort-menu [aria-checked="true"]')?.dataset.flatSort === expected, value);
  };
  const shot = (name) => page.screenshot({ path: path.join(shotsRoot, `${name}.png`), fullPage: false });
  const apiJson = async (url) => (await page.request.get(`${base}${url}`)).json();
  const treeSortTrigger = page.locator('#explorer-sort-toggle');
  const treeSortOption = (key, direction) => page.locator(`#explorer-sort-menu [data-sort-key="${key}"][data-sort-direction="${direction}"]`);
  const setTreeSort = async (key, direction) => {
    const response = page.waitForResponse((r) => {
      if (!r.url().includes('/api/web/v2/tree')) return false;
      const u = new URL(r.url());
      return u.searchParams.get('parent') === '' && u.searchParams.get('sort') === key && u.searchParams.get('direction') === direction;
    });
    await treeSortTrigger.click();
    await treeSortOption(key, direction).click();
    await response;
  };

  await check('flat: mode switch lists every note and matches the flat API order', async () => {
    await shot('01-tree-empty-query');
    await setMode('flat');
    assert.deepEqual(await flatPaths(), MODIFIED_DESC, 'flat default (modified desc) matches the expected order');
    const api = await apiJson('/api/web/v2/tree?flat=1&sort=modified&direction=desc&limit=500');
    assert.deepEqual(api.items.map((item) => item.kind), MODIFIED_DESC.map(() => 'note'));
    assert.deepEqual(await flatPaths(), api.items.map((item) => item.path), 'the DOM row order equals the server flat page order');
    assert.equal(api.items.length, TREE_PATHS.length, 'flat lists exactly the Vault note count');
    await shot('02-flat-empty-query');
  });

  await check('flat: query survives the mode switch and every query-context sort is switchable', async () => {
    await setMode('tree');
    await showSearchTab();
    const searched = page.waitForResponse((r) => r.url().includes('/api/web/v2/search?') && new URL(r.url()).searchParams.get('q') === 'needle');
    await page.locator('#search').fill('needle');
    await searched;
    await showFilesTab();
    await shot('03-tree-query');
    await setMode('flat');
    assert.equal(await searchValue(), 'needle', 'the mode switch never clears the query');
    const searchPayload = await apiJson('/api/web/v2/search?q=needle&limit=50&semantic=false&caseSensitive=false');
    const payloadPaths = searchPayload.items.map((item) => item.path);
    assert.equal(payloadPaths.length, QUERY_PATHS.length, 'the fixture query matches the expected notes');
    assert.deepEqual([...(await flatPaths())].sort(), [...payloadPaths].sort(), 'the flat row set equals the search result set');
    assert.equal(await flatSortOption('name:asc').isDisabled(), false, 'name is available while a query is active');
    assert.equal(await flatSortOption('score:desc').isDisabled(), false, 'score is available while a query is active');

    await setFlatSort('name:asc');
    assert.deepEqual(await flatPaths(), NAME_ASC, 'name asc orders by the display title');
    await setFlatSort('modified:desc');
    assert.deepEqual(await flatPaths(), ['Notes/C.md', 'B.md', 'A.md'], 'modified desc orders by the row timestamp');
    await setFlatSort('score:asc');
    assert.deepEqual(await flatPaths(), payloadPaths, 'score asc keeps the best-match-first server order');
    const payloadByPath = new Map(searchPayload.items.map((item) => [item.path, item]));
    const scores = payloadPaths.map((p) => payloadByPath.get(p).score);
    scoreSamples = scores;
    await setFlatSort('score:desc');
    if (new Set(scores).size === scores.length) {
      assert.deepEqual(await flatPaths(), [...payloadPaths].reverse(), 'score desc reverses distinct finite scores');
    } else {
      // bm25 produced ties for this fixture: both directions fall back to the same
      // path tie-break, which is the frozen model's documented behaviour.
      assert.deepEqual(await flatPaths(), payloadPaths, 'equal scores tie-break by path in both directions');
    }
    await shot('04-flat-query');
  });

  await check('flat: reveal scrolls to and highlights the current note and clears the query', async () => {
    await showSearchTab();
    const reloaded = page.waitForResponse((r) => r.url().includes('/api/web/v2/tree') && new URL(r.url()).searchParams.get('flat') === '1' && new URL(r.url()).searchParams.get('cursor') === null);
    await page.locator('#search').fill('');
    await reloaded;
    await showFilesTab();
    // With no query the query-only key is no longer honourable: the flat control drops
    // back to the served default instead of silently ordering by nothing.
    assert.equal(await flatSpec(), 'modified:desc', 'clearing the query narrows the effective flat sort');
    assert.equal(await flatSortOption('score:desc').isDisabled(), true, 'score is unavailable without a query');
    assert.equal(await flatSortOption('name:asc').isDisabled(), true, 'name is unavailable without a query');

    const opened = page.waitForResponse((r) => r.request().method() === 'GET' && r.url().includes('/api/web/v1/note?') && new URL(r.url()).searchParams.get('path') === 'Notes/Deep/D.md');
    await page.locator('#note-list .note-flat[data-path="Notes/Deep/D.md"]').click();
    assert.equal((await opened).status(), 200);
    await page.waitForFunction(() => document.querySelector('#current-path')?.textContent === 'Notes/Deep/D.md');
    const reveal = page.waitForResponse((r) => r.url().includes('/api/web/v2/tree') && new URL(r.url()).searchParams.get('flat') === '1');
    await page.locator('#reveal-active').click();
    await reveal;
    await page.waitForFunction(() => document.querySelector('#note-list .note-flat[aria-current="page"]')?.dataset.path === 'Notes/Deep/D.md');
    assert.equal(await page.locator('#note-list .note-flat[aria-current="page"]').count(), 1, 'exactly one highlighted flat row');
    assert.equal(await filePanelMode(), 'flat', 'reveal does not leave flat mode');
    const visible = await page.locator('#note-list .note-flat[aria-current="page"]').evaluate((el) => {
      const list = el.closest('#note-list');
      const row = el.getBoundingClientRect();
      const box = list.getBoundingClientRect();
      return row.top >= box.top - 1 && row.bottom <= box.bottom + 1;
    });
    assert.equal(visible, true, 'the highlighted row is inside the visible list');
    await shot('05-flat-reveal-current');
  });

  await check('flat: mode and sort preferences survive a reload, isolated from the Tree preference, and the narrow layout does not overflow', async () => {
    await setMode('tree');
    await showFilesTab();
    await setTreeSort('modified', 'asc');
    await setMode('flat');
    await setFlatSort('path:asc');
    await page.reload();
    await page.waitForSelector('#note-list .note-flat[data-path]');
    assert.equal(await filePanelMode(), 'flat', 'the mode preference is restored');
    await showFilesTab();
    assert.equal(await flatSpec(), 'path:asc', 'the flat sort preference is restored');
    assert.deepEqual(await flatPaths(), TREE_PATHS, 'the restored spec is applied to the restored list');
    const stored = await page.evaluate(() => ({
      tree: localStorage.getItem('obsidian-web.explorer-sort.v1'),
      mode: localStorage.getItem('obsidian-web.explorer-mode.v1'),
      flat: localStorage.getItem('obsidian-web.explorer-flat-sort.v1'),
    }));
    assert.equal(stored.tree, '{"version":1,"key":"modified","direction":"asc"}', 'the Tree preference is untouched by the flat changes');
    assert.equal(stored.mode, '{"version":1,"mode":"flat"}');
    assert.equal(stored.flat, '{"version":1,"key":"path","direction":"asc"}');

    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(120);
    const overflow = await page.evaluate(() => {
      const list = document.querySelector('#note-list');
      return {
        document: document.documentElement.scrollWidth - window.innerWidth,
        list: list.scrollWidth - list.clientWidth,
      };
    });
    assert.equal(overflow.document <= 1, true, `no horizontal document overflow: ${JSON.stringify(overflow)}`);
    assert.equal(overflow.list <= 1, true, `no horizontal list overflow: ${JSON.stringify(overflow)}`);
    assert.equal(await page.locator('#note-list .note-flat[data-path="Notes/Deep/D.md"] .note-subtitle').textContent(), 'Notes/Deep/D.md');
    await shot('06-flat-narrow');
    await page.setViewportSize({ width: 1440, height: 1000 });
  });

  await check('flat: no page errors and the flat API never leaves a note out', async () => {
    const api = await apiJson('/api/web/v2/tree?flat=1&sort=path&direction=asc&limit=500');
    assert.deepEqual(api.items.map((item) => item.path), [...TREE_PATHS].sort());
    assert.deepEqual(pageErrors, [], `pageErrors: ${pageErrors.join('\n')}`);
  });
  await fs.writeFile(path.join(outputRoot, 'results.json'), JSON.stringify({ results, pageErrors, scoreSamples, serverErrors: serverErrors.filter((e) => /error|failed/i.test(e)) }, null, 2));
} catch (error) {
  exitCode = 1;
  console.error('flat regression harness error:', error);
} finally {
  await browser?.close();
  child.kill();
  await fs.rm(root, { recursive: true, force: true });
}
if (results.length === 0) exitCode = 1;
if (results.some((r) => !r.pass)) exitCode = 1;
process.exitCode = exitCode;
