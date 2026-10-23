// Web Bases browser-contract checks (Wave A / A5).
//
// Exports `registerWebBasesChecks(ctx)`, which registers one Playwright check per
// scenario against the caller's real server + browser (the same shape as
// `web-regression.mjs`'s `check(name, fn)`).
//
// Every scenario carries a phase:
//
//   characterization — passes TODAY against main@670fa03. It asserts the frozen
//                      current reality: `.base` is absent from the Explorer,
//                      `GET /api/web/v1/base` is 404, `/app/base/...` is 404, and
//                      v2 note search never returns a `.base`.
//   full             — asserts the §4/§10/§11 target behavior once Wave B/C wire
//                      the Base surface. These are expected to FAIL until then.
//
// `ctx` contract (superset of the brief):
//
//   {
//     check(name, fn)   // register a check; from web-regression.mjs
//     page              // Playwright Page (authenticated cookie jar)
//     serverUrl         // e.g. http://127.0.0.1:PORT
//     login()           // idempotent: ensures the browser session is logged in
//     open(path)        // navigate to a note path and wait for the note to load
//     mode | phase      // 'characterization' (default) | 'full'
//     fixtures          // return value of createWebBasesFixtureVault()
//     sleep(ms)         // optional; defaults to setTimeout
//     grantVaultAccess(vaultId) // optional; full-phase cross-Vault helper
//   }
//
// `open`/`login` are only *called* by checks; the runner supplies them.
//
// IMPORTANT: full-phase DOM selectors below are the Wave C wiring contract.
// They are declared in `selectors` so Wave C can align the surface markup, and
// the API assertions (frozen in the TODO §4.2/§8/§9) stay authoritative even if
// the DOM hooks are renamed.

import assert from 'node:assert/strict';

export const BASE_API_PATH = '/api/web/v1/base';
export const BASE_ROUTE_PREFIX = '/app/base/';

// The exact integration snippet Wave C should apply to the shared harness.
// Kept as a string so tests can assert the wiring contract without A5 editing
// `web-regression.mjs` (Wave C owns that file).
export const WAVE_C_REGISTRATION_SNIPPET = [
  "import { registerWebBasesChecks } from './web-bases-checks.mjs';",
  "import { createWebBasesFixtureVault } from './web-bases-fixtures.mjs';",
  '',
  '// after the shared fixture Vault and login are ready, before the final results write:',
  'const webBasesFixtures = await createWebBasesFixtureVault(webBasesRoot);',
  'await registerWebBasesChecks({',
  '  check,',
  '  page,',
  '  serverUrl: base,',
  '  login: async () => {},',
  '  open,',
  '  sleep,',
  '  phase: process.env.WEB_BASES_PHASE || \u0027characterization\u0027,',
  '  fixtures: webBasesFixtures,',
  '});',
].join('\n');

// Wave C DOM hooks (documented, not yet implemented). Keep in sync with the
// Base frontend feature; API/route assertions above are the frozen contract.
export const selectors = Object.freeze({
  baseNode: (path) => `[data-path="${path}"]`,
  baseSurface: '[data-document-kind="base"], .base-surface, #base-view',
  viewSelector: '[data-base-view]',
  viewOption: (name) => `[data-base-view-option="${name}"]`,
  linkCell: '[data-cell-kind="link"]',
  loadMore: '[data-base-load-more]',
  table: '[data-base-table], .base-surface table',
});

function sleep(ctx, ms) {
  if (typeof ctx.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function phaseOf(ctx) {
  return ctx.phase || ctx.mode || 'characterization';
}

// Mirror of the frozen document-route codec (app/src/publish/service.js). Kept
// local so a check failure does not depend on production import side effects.
export function encodeDocumentRoute(vaultId, notePath) {
  const payload = JSON.stringify({ v: 1, vaultId, path: notePath });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

async function request(ctx, route, { method = 'GET', form } = {}) {
  const url = new URL(route, ctx.serverUrl).href;
  const response = method === 'GET'
    ? await ctx.page.request.get(url)
    : await ctx.page.request.post(url, form ? { form } : undefined);
  const text = await response.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  return { status: response.status(), body, response };
}

async function getJson(ctx, route) {
  return request(ctx, route, { method: 'GET' });
}

// Waits until the v2 catalog answers 200 (cold reconcile on a fresh tmp Vault).
export async function waitForCatalog(ctx, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await getJson(ctx, '/api/web/v2/tree?parent=');
    if (last.status === 200) return last.body;
    await sleep(ctx, 100);
  }
  throw new Error(`catalog not ready after ${timeoutMs}ms (last status ${last?.status})`);
}

async function treeItems(ctx, parent = '') {
  const res = await getJson(ctx, `/api/web/v2/tree?parent=${encodeURIComponent(parent)}`);
  assert.equal(res.status, 200, `tree(${parent}) status ${res.status}`);
  return Array.isArray(res.body?.items) ? res.body.items : [];
}

async function searchItems(ctx, q) {
  const res = await getJson(ctx, `/api/web/v2/search?q=${encodeURIComponent(q)}`);
  assert.equal(res.status, 200, `search(${q}) status ${res.status}`);
  return Array.isArray(res.body?.items) ? res.body.items : [];
}

function itemPaths(items) {
  return items.map((item) => (typeof item === 'string' ? item : item?.path)).filter(Boolean);
}

function assertNoBaseNodes(items, label) {
  const offenders = itemPaths(items).filter((value) => String(value).toLowerCase().endsWith('.base'));
  assert.deepEqual(offenders, [], `${label}: .base must not be enumerated yet (got ${offenders.join(', ')})`);
}

// The exact "today" reality: no .base document anywhere in the Explorer, no Web
// Base read API, and no /app/base page route.
async function assertWebBasesAbsent(ctx) {
  await waitForCatalog(ctx);
  for (const parent of ['', 'Notes', 'Notes/Deep', 'Mixed']) {
    assertNoBaseNodes(await treeItems(ctx, parent), `tree(${parent})`);
  }
  const api = await getJson(ctx, `${BASE_API_PATH}?path=${encodeURIComponent(ctx.fixtures.files.projectBase)}`);
  assert.equal(api.status, 404, `GET ${BASE_API_PATH} must not exist yet (got ${api.status})`);
  const route = await request(ctx, `${BASE_ROUTE_PREFIX}${encodeDocumentRoute(ctx.fixtures.vaultId, ctx.fixtures.files.projectBase)}`);
  assert.equal(route.status, 404, `${BASE_ROUTE_PREFIX}... must not exist yet (got ${route.status})`);
}

async function gotoApp(ctx) {
  await ctx.login();
  const response = await ctx.page.goto(`${ctx.serverUrl}/app`);
  assert.equal(response?.status(), 200);
  // Earlier scenarios can select another Vault (the secondary deep link). Reset to
  // the shared primary fixture Vault so every scenario starts from the same tree.
  const select = ctx.page.locator('#vault-select');
  if (await select.count()) {
    await ctx.page.waitForFunction(() => {
      const el = document.querySelector('#vault-select');
      return Boolean(el) && [...el.options].some((option) => option.value);
    });
    const current = await select.inputValue().catch(() => null);
    if (current && current !== ctx.fixtures.vaultId) {
      await select.selectOption(ctx.fixtures.vaultId);
      await sleep(ctx, 200);
    }
  }
  await ctx.page.waitForSelector('.note[title="Readme.md"]', { timeout: 15000 });
}

async function openBase(ctx, basePath, { view } = {}) {
  const query = new URLSearchParams({ path: basePath });
  if (view) query.set('view', view);
  return getJson(ctx, `${BASE_API_PATH}?${query.toString()}`);
}

function basePayloadItems(payload) {
  return Array.isArray(payload?.rows) ? payload.rows : [];
}

// --- scenario implementations ------------------------------------------------
//
// Each item exposes `characterization` and `full` descriptors. The characterization
// function must pass on main@670fa03; the full function targets the wired feature.

const ITEMS = [
  {
    item: 1,
    title: 'authenticated browser session reaches the workspace',
    characterization: {
      description: 'login via /auth/login then /app and the v2 tree respond',
      async run(ctx) {
        await gotoApp(ctx);
        const session = await getJson(ctx, '/api/web/v1/session');
        assert.equal(session.status, 200);
        assert.equal(session.body.vaultId, ctx.fixtures.vaultId);
        const tree = await getJson(ctx, '/api/web/v2/tree?parent=');
        assert.equal(tree.status, 200);
      },
    },
    full: {
      description: 'login lands in the workspace with the Base-capable catalog',
      async run(ctx) {
        await gotoApp(ctx);
        await waitForCatalog(ctx);
      },
    },
  },
  {
    item: 2,
    title: 'Explorer expands a directory that contains Project.base',
    characterization: {
      description: 'tree pages never enumerate a .base node yet',
      async run(ctx) { await assertWebBasesAbsent(ctx); },
    },
    full: {
      description: 'Project.base is a file node with the stem title inside its directory',
      async run(ctx) {
        await gotoApp(ctx);
        await waitForCatalog(ctx);
        const root = itemPaths(await treeItems(ctx, ''));
        assert.ok(root.includes(ctx.fixtures.files.projectBase), 'Project.base must be in the root tree page');
        const node = ctx.page.locator(selectors.baseNode(ctx.fixtures.files.projectBase));
        await node.first().waitFor({ state: 'attached', timeout: 10000 });
        assert.equal((await node.first().locator('.note-title').textContent())?.trim(), 'Project');
        const notes = itemPaths(await treeItems(ctx, 'Notes'));
        assert.ok(notes.includes(ctx.fixtures.files.alphaNote));
      },
    },
  },
  {
    item: 3,
    title: 'clicking Project.base opens a Base document',
    characterization: {
      description: 'no .base node exists to click and the API is absent',
      async run(ctx) {
        await assertWebBasesAbsent(ctx);
        assert.equal(await ctx.page.locator(selectors.baseNode(ctx.fixtures.files.projectBase)).count(), 0);
      },
    },
    full: {
      description: 'clicking the .base node calls the Base loader (not /note)',
      async run(ctx) {
        await gotoApp(ctx);
        await waitForCatalog(ctx);
        const baseResponse = ctx.page.waitForResponse((r) => r.url().includes(BASE_API_PATH) && r.request().method() === 'GET').catch(() => null);
        await ctx.page.locator(selectors.baseNode(ctx.fixtures.files.projectBase)).first().click({ timeout: 5000 });
        const response = await baseResponse;
        assert.ok(response, 'clicking Project.base must issue a GET /api/web/v1/base request');
        assert.equal(response.status(), 200);
        await ctx.page.locator(selectors.baseSurface).first().waitFor({ state: 'visible', timeout: 10000 });
      },
    },
  },
  {
    item: 4,
    title: 'the Base route is /app/base/<encoded-document-route>',
    characterization: {
      description: 'GET /app/base/... is 404 today',
      async run(ctx) { await assertWebBasesAbsent(ctx); },
    },
    full: {
      description: 'deep link /app/base/... renders the Base surface at that URL',
      async run(ctx) {
        await ctx.login();
        const route = `${BASE_ROUTE_PREFIX}${encodeDocumentRoute(ctx.fixtures.vaultId, ctx.fixtures.files.projectBase)}`;
        const response = await ctx.page.goto(`${ctx.serverUrl}${route}`);
        assert.equal(response?.status(), 200);
        assert.ok(new URL(ctx.page.url()).pathname.startsWith(BASE_ROUTE_PREFIX));
        await ctx.page.locator(selectors.baseSurface).first().waitFor({ state: 'visible', timeout: 10000 });
      },
    },
  },
  {
    item: 5,
    title: 'switching the Base view re-queries the current view only',
    characterization: {
      description: 'no view selector is rendered while the surface is absent',
      async run(ctx) {
        await assertWebBasesAbsent(ctx);
        assert.equal(await ctx.page.locator(selectors.viewSelector).count(), 0);
      },
    },
    full: {
      description: 'both declared views are listed and switching changes the rows',
      async run(ctx) {
        await gotoApp(ctx);
        await waitForCatalog(ctx);
        await ctx.page.locator(selectors.baseNode(ctx.fixtures.files.projectBase)).first().click();
        await ctx.page.locator(selectors.baseSurface).first().waitFor({ state: 'visible', timeout: 10000 });
        const selector = ctx.page.locator(selectors.viewSelector).first();
        await selector.waitFor({ state: 'visible', timeout: 10000 });
        await ctx.page.waitForFunction(() => document.querySelector('[data-base-view]')?.options?.length > 0, { timeout: 10000 });
        const options = await selector.locator('option').allTextContents();
        assert.ok(options.some((value) => value.includes('All project notes')), `view options must list the declared views, saw ${JSON.stringify(options)}`);
        assert.ok(options.some((value) => value.includes('Active only')), `view options must list the declared views, saw ${JSON.stringify(options)}`);
        await selector.selectOption({ label: 'Active only' });
        await sleep(ctx, 150);
        const all = await openBase(ctx, ctx.fixtures.files.projectBase, { view: 'All project notes' });
        const active = await openBase(ctx, ctx.fixtures.files.projectBase, { view: 'Active only' });
        assert.equal(active.status, 200);
        assert.ok(active.body.rows.length <= all.body.rows.length);
      },
    },
  },
  {
    item: 6,
    title: 'column order, row order and structured asLink cells are stable',
    characterization: {
      description: 'GET /api/web/v1/base is 404 today',
      async run(ctx) { await assertWebBasesAbsent(ctx); },
    },
    full: {
      description: 'API returns declared columns, deterministic row order and link cells',
      async run(ctx) {
        await ctx.login();
        const res = await openBase(ctx, ctx.fixtures.files.projectBase);
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.body.columns), 'columns must be declared');
        assert.deepEqual(res.body.columns.slice(0, 2).map((column) => column.key), ['file.name', 'status']);
        assert.ok(
          res.body.columns.every((column) => typeof column.key === 'string' && typeof column.label === 'string' && typeof column.kind === 'string'),
          'the frozen §8 column DTO carries {key,label,kind}',
        );
        const rows = basePayloadItems(res.body);
        const paths = rows.map((row) => row.path);
        assert.equal(new Set(paths).size, paths.length, 'no duplicate rows');
        // Project.base declares `sort: priority DESC`; equal priorities keep the
        // canonical final path ASC tie-break (workflows.sortBaseRecords).
        let previousPriority = Infinity;
        for (const row of rows) {
          const priority = row.values?.priority;
          assert.ok(Number.isFinite(priority), `priority must be projected for ordering, saw ${JSON.stringify(priority)}`);
          assert.ok(priority <= previousPriority, `priority must be non-increasing (DESC), saw ${priority} after ${previousPriority}`);
          previousPriority = priority;
        }
        for (let index = 1; index < rows.length; index += 1) {
          const previous = rows[index - 1];
          const current = rows[index];
          if (previous.values?.priority === current.values?.priority) {
            assert.ok(
              previous.path.localeCompare(current.path) <= 0,
              `equal-priority rows keep path ASC: ${previous.path} before ${current.path}`,
            );
          }
        }
        const link = basePayloadItems(res.body).flatMap((row) => Object.values(row.values || {}))
          .find((value) => value && typeof value === 'object' && value.kind === 'asLink');
        assert.ok(link, 'a structured asLink cell must be present');
        assert.ok(typeof link.path === 'string' && link.path.endsWith('.md'));
      },
    },
  },
  {
    item: 7,
    title: 'clicking a structured link cell opens the target Markdown note',
    characterization: {
      description: 'no Base cells and no Base API exist yet',
      async run(ctx) { await assertWebBasesAbsent(ctx); },
    },
    full: {
      description: 'a link cell opens /api/web/v1/note and the Markdown reader',
      async run(ctx) {
        await gotoApp(ctx);
        await waitForCatalog(ctx);
        await ctx.page.locator(selectors.baseNode(ctx.fixtures.files.projectBase)).first().click();
        await ctx.page.locator(selectors.baseSurface).first().waitFor({ state: 'visible', timeout: 10000 });
        const noteResponse = ctx.page.waitForResponse((r) => r.url().includes('/api/web/v1/note?') && r.request().method() === 'GET').catch(() => null);
        await ctx.page.locator(selectors.linkCell).first().click({ timeout: 5000 });
        const response = await noteResponse;
        assert.ok(response, 'a link cell must issue a GET /api/web/v1/note request');
        assert.equal(response.status(), 200);
        await ctx.page.waitForFunction(() => document.querySelector('#current-path')?.textContent?.endsWith('.md'));
      },
    },
  },
  {
    item: 8,
    title: 'Back returns from the note to the Base document',
    characterization: {
      description: '/app/base/... has no history entry today',
      async run(ctx) { await assertWebBasesAbsent(ctx); },
    },
    full: {
      description: 'history Back restores the Base route and surface',
      async run(ctx) {
        await gotoApp(ctx);
        await waitForCatalog(ctx);
        const route = `${BASE_ROUTE_PREFIX}${encodeDocumentRoute(ctx.fixtures.vaultId, ctx.fixtures.files.projectBase)}`;
        await ctx.page.goto(`${ctx.serverUrl}${route}`);
        await ctx.page.locator(selectors.baseSurface).first().waitFor({ state: 'visible', timeout: 10000 });
        const baseUrl = ctx.page.url();
        await ctx.page.locator(selectors.linkCell).first().click();
        await ctx.page.waitForURL((url) => url.pathname.startsWith('/app/note/'), { timeout: 10000 });
        await ctx.page.goBack();
        assert.equal(ctx.page.url(), baseUrl);
        await ctx.page.locator(selectors.baseSurface).first().waitFor({ state: 'visible', timeout: 10000 });
      },
    },
  },
  {
    item: 9,
    title: 'load more appends the next bounded page',
    characterization: {
      description: 'the Base pagination API is absent',
      async run(ctx) { await assertWebBasesAbsent(ctx); },
    },
    full: {
      description: 'default limit 100 and a load-more control appends rows',
      async run(ctx) {
        await ctx.login();
        const first = await openBase(ctx, ctx.fixtures.files.projectBase);
        assert.equal(first.status, 200);
        assert.ok(first.body.nextCursor === null || typeof first.body.nextCursor === 'string');
        assert.ok(basePayloadItems(first.body).length <= 100, 'default limit is 100');
        await gotoApp(ctx);
        await waitForCatalog(ctx);
        await ctx.page.locator(selectors.baseNode(ctx.fixtures.files.projectBase)).first().click();
        await ctx.page.locator(selectors.baseSurface).first().waitFor({ state: 'visible', timeout: 10000 });
        const before = await ctx.page.locator(selectors.table).first().locator('tbody tr').count();
        const more = ctx.page.locator(selectors.loadMore);
        if (await more.count()) {
          await more.first().click();
          await ctx.page.waitForTimeout(200);
          const after = await ctx.page.locator(selectors.table).first().locator('tbody tr').count();
          assert.ok(after >= before);
        }
      },
    },
  },
  {
    item: 10,
    title: 'external Base changes are visible after reload',
    characterization: {
      description: 'writing a new .base still does not add a tree node',
      async run(ctx) {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const extra = path.join(ctx.fixtures.vault, 'Added.base');
        await fs.writeFile(extra, ctx.fixtures.supportedDocuments['Files.base'], 'utf8');
        try {
          await sleep(ctx, 300);
          assertNoBaseNodes(await treeItems(ctx, ''), 'tree after external .base write');
        } finally {
          await fs.rm(extra, { force: true });
        }
      },
    },
    full: {
      description: 'a changed Base revision is read again on reopen',
      async run(ctx) {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const target = path.join(ctx.fixtures.vault, ...ctx.fixtures.files.projectBase.split('/'));
        const original = await fs.readFile(target, 'utf8');
        const changed = original.replace('All project notes', 'All project notes (edited)');
        try {
          await fs.writeFile(target, changed, 'utf8');
          await sleep(ctx, 400);
          await ctx.login();
          const res = await openBase(ctx, ctx.fixtures.files.projectBase);
          assert.equal(res.status, 200);
          const views = (res.body.views || []).map((view) => view.name);
          assert.ok(views.includes('All project notes (edited)'), 'the edited Base revision must be read');
        } finally {
          await fs.writeFile(target, original, 'utf8');
        }
      },
    },
  },
  {
    item: 11,
    title: 'a same-named Base in a secondary Vault stays isolated',
    characterization: {
      description: 'the secondary Vault (and its .base) is not in the session allowlist',
      async run(ctx) {
        await waitForCatalog(ctx);
        const vaults = await getJson(ctx, '/api/web/v1/vaults');
        assert.equal(vaults.status, 200);
        const ids = (vaults.body.vaults || []).map((vault) => vault.id);
        assert.ok(!ids.includes(ctx.fixtures.secondaryVaultId), 'secondary Vault must not be authorized yet');
        assertNoBaseNodes(await treeItems(ctx, ''), 'primary tree');
      },
    },
    full: {
      description: 'with access granted, the secondary Vault serves its own Project.base',
      async run(ctx) {
        assert.equal(typeof ctx.grantVaultAccess, 'function', 'runner must provide grantVaultAccess for the cross-Vault check');
        await ctx.grantVaultAccess(ctx.fixtures.secondaryVaultId);
        await ctx.login();
        const vaults = await getJson(ctx, '/api/web/v1/vaults');
        assert.equal(vaults.status, 200);
        assert.ok(vaults.body.vaults.some((vault) => vault.id === ctx.fixtures.secondaryVaultId), 'granted secondary Vault must be listed');
        // The document route encodes the Vault id, so isolation is checked through
        // the frozen deep-link shape rather than a session-scoped API assumption.
        const route = `${BASE_ROUTE_PREFIX}${encodeDocumentRoute(ctx.fixtures.secondaryVaultId, ctx.fixtures.files.secondaryBase)}`;
        const response = await request(ctx, route);
        assert.equal(response.status, 200, `secondary Base route returned ${response.status}`);
        // Serving the page selects the secondary Vault in the session; its Catalog is
        // cold, so wait for it to reconcile before the Base surface can load.
        await waitForCatalog(ctx);
        await ctx.page.goto(`${ctx.serverUrl}${route}`);
        await ctx.page.locator(selectors.baseSurface).first().waitFor({ state: 'visible', timeout: 10000 });
        await ctx.page.waitForFunction(() => {
          const surface = document.querySelector('.base-surface');
          return Boolean(surface) && Boolean(surface.querySelector('tbody tr'));
        }, { timeout: 10000 });
        const bodyText = await ctx.page.locator(selectors.baseSurface).first().innerText();
        // The secondary row shows its own note name / alias, never a primary row.
        assert.ok(bodyText.includes('Secondary'), 'secondary rows must come from the secondary Vault');
        assert.ok(!bodyText.includes('Alpha'), 'primary rows must never leak into the secondary Vault');
        // Cross-check isolation through the session-scoped API as well.
        const secondaryApi = await openBase(ctx, ctx.fixtures.files.secondaryBase);
        assert.equal(secondaryApi.status, 200);
        const secondaryPaths = basePayloadItems(secondaryApi.body).map((row) => row.path);
        assert.ok(secondaryPaths.some((rowPath) => rowPath.endsWith('Secondary.md')), 'secondary API rows come from the secondary Vault');
        assert.ok(!secondaryPaths.some((rowPath) => rowPath.includes('Alpha')), 'primary rows must never leak into the secondary Vault');
      },
    },
  },
  {
    item: 12,
    title: 'an unauthorized Vault is invisible and not directly reachable',
    characterization: {
      description: 'the denied Vault is absent from /vaults and 404 on the direct route',
      async run(ctx) {
        await waitForCatalog(ctx);
        const vaults = await getJson(ctx, '/api/web/v1/vaults');
        assert.equal(vaults.status, 200);
        const ids = (vaults.body.vaults || []).map((vault) => vault.id);
        assert.ok(!ids.includes(ctx.fixtures.deniedVaultId));
        const route = await request(ctx, `${BASE_ROUTE_PREFIX}${encodeDocumentRoute(ctx.fixtures.deniedVaultId, ctx.fixtures.files.deniedBase)}`);
        assert.equal(route.status, 404);
      },
    },
    full: {
      description: 'the denied Vault Base stays 404 even after the feature is wired',
      async run(ctx) {
        await ctx.login();
        const route = await request(ctx, `${BASE_ROUTE_PREFIX}${encodeDocumentRoute(ctx.fixtures.deniedVaultId, ctx.fixtures.files.deniedBase)}`);
        assert.equal(route.status, 404);
        const listed = await request(ctx, `${BASE_API_PATH}?path=${encodeURIComponent(ctx.fixtures.files.deniedBase)}`);
        assert.ok(listed.status === 404 || listed.status === 403, `denied Vault must fail closed (got ${listed.status})`);
      },
    },
  },
  {
    item: 13,
    title: 'dirty Markdown -> Base: cancel keeps the dirty document',
    characterization: {
      description: 'a dirty note is preserved when a Base route cannot be reached',
      async run(ctx) {
        await gotoApp(ctx);
        await ctx.open(ctx.fixtures.files.readmeNote);
        const before = await ctx.page.evaluate(() => document.querySelector('#current-path')?.textContent);
        const route = await request(ctx, `${BASE_ROUTE_PREFIX}${encodeDocumentRoute(ctx.fixtures.vaultId, ctx.fixtures.files.projectBase)}`);
        assert.equal(route.status, 404);
        const after = await ctx.page.evaluate(() => document.querySelector('#current-path')?.textContent);
        assert.equal(after, before, 'the open Markdown document must not change on an unreachable Base route');
      },
    },
    full: {
      description: 'cancelling the confirm dialog leaves the dirty Markdown untouched',
      async run(ctx) {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const target = path.join(ctx.fixtures.vault, ...ctx.fixtures.files.readmeNote.split('/'));
        const original = await fs.readFile(target, 'utf8');
        try {
          await gotoApp(ctx);
          await ctx.open(ctx.fixtures.files.readmeNote);
          // Make the note dirty through the editor API used by web-regression.mjs.
          await ctx.page.evaluate(() => window.__testEditor?.setValue?.('# dirty change\n'));
          const dialog = ctx.page.waitForEvent('dialog').catch(() => null);
          await ctx.page.locator(selectors.baseNode(ctx.fixtures.files.projectBase)).first().click({ timeout: 5000 }).catch(() => {});
          const prompt = await dialog;
          assert.ok(prompt, 'a dirty note must prompt before navigating to a Base');
          await prompt.dismiss().catch(() => {});
          assert.equal(await fs.readFile(target, 'utf8'), original, 'cancel must not write the note');
          assert.ok((await ctx.page.evaluate(() => document.querySelector('#current-path')?.textContent))?.endsWith('Readme.md'));
        } finally {
          await fs.writeFile(target, original, 'utf8');
        }
      },
    },
  },
  {
    item: 14,
    title: 'dirty Markdown -> Base: confirm switches to the Base document',
    characterization: {
      description: 'a dirty note can still be re-read from disk without colliding with a Base',
      async run(ctx) {
        await gotoApp(ctx);
        await ctx.open(ctx.fixtures.files.readmeNote);
        const content = await getJson(ctx, `/api/web/v1/note?path=${encodeURIComponent(ctx.fixtures.files.readmeNote)}`);
        assert.equal(content.status, 200);
        assert.ok(typeof content.body.content === 'string' || typeof content.body.raw === 'string');
      },
    },
    full: {
      description: 'confirming navigates to Base and never writes the dirty Markdown',
      async run(ctx) {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const target = path.join(ctx.fixtures.vault, ...ctx.fixtures.files.readmeNote.split('/'));
        const original = await fs.readFile(target, 'utf8');
        try {
          await gotoApp(ctx);
          await ctx.open(ctx.fixtures.files.readmeNote);
          await ctx.page.evaluate(() => window.__testEditor?.setValue?.('# dirty change\n'));
          const dialog = ctx.page.waitForEvent('dialog').catch(() => null);
          await ctx.page.locator(selectors.baseNode(ctx.fixtures.files.projectBase)).first().click({ timeout: 5000 }).catch(() => {});
          const prompt = await dialog;
          assert.ok(prompt, 'a dirty note must prompt before navigating to a Base');
          await prompt.accept().catch(() => {});
          await ctx.page.locator(selectors.baseSurface).first().waitFor({ state: 'visible', timeout: 10000 });
          assert.equal(await fs.readFile(target, 'utf8'), original);
        } finally {
          await fs.writeFile(target, original, 'utf8');
        }
      },
    },
  },
  {
    item: 15,
    title: 'light and dark themes render the same document',
    characterization: {
      description: 'the theme toggle works and no Base surface is painted',
      async run(ctx) {
        await gotoApp(ctx);
        const initial = await ctx.page.evaluate(() => document.documentElement.dataset.theme || document.documentElement.getAttribute('data-color-mode'));
        const toggle = ctx.page.locator('[data-theme-toggle], #theme-toggle, .theme-toggle').first();
        if (await toggle.count()) {
          await toggle.click();
          await sleep(ctx, 100);
        }
        const after = await ctx.page.evaluate(() => document.documentElement.dataset.theme || document.documentElement.getAttribute('data-color-mode'));
        assert.ok(initial !== undefined && after !== undefined);
        assert.equal(await ctx.page.locator(selectors.baseSurface).count(), 0);
      },
    },
    full: {
      description: 'the Base surface paints under both themes',
      async run(ctx) {
        await gotoApp(ctx);
        await waitForCatalog(ctx);
        await ctx.page.locator(selectors.baseNode(ctx.fixtures.files.projectBase)).first().click();
        await ctx.page.locator(selectors.baseSurface).first().waitFor({ state: 'visible', timeout: 10000 });
        const toggle = ctx.page.locator('[data-theme-toggle], #theme-toggle, .theme-toggle').first();
        for (let i = 0; i < 2 && await toggle.count(); i += 1) {
          await toggle.click();
          await sleep(ctx, 150);
          assert.ok(await ctx.page.locator(selectors.baseSurface).first().isVisible());
        }
      },
    },
  },
  {
    item: 16,
    title: 'desktop and narrow layouts keep the Base usable',
    characterization: {
      description: 'viewport changes work while the Base surface is absent',
      async run(ctx) {
        await gotoApp(ctx);
        await ctx.page.setViewportSize({ width: 420, height: 800 });
        await sleep(ctx, 100);
        const narrow = await ctx.page.evaluate(() => document.documentElement.clientWidth);
        assert.ok(narrow <= 460);
        await ctx.page.setViewportSize({ width: 1440, height: 1000 });
        assert.equal(await ctx.page.locator(selectors.baseSurface).count(), 0);
      },
    },
    full: {
      description: 'the narrow Base table scrolls horizontally instead of clipping',
      async run(ctx) {
        await gotoApp(ctx);
        await waitForCatalog(ctx);
        await ctx.page.locator(selectors.baseNode(ctx.fixtures.files.projectBase)).first().click();
        await ctx.page.locator(selectors.baseSurface).first().waitFor({ state: 'visible', timeout: 10000 });
        await ctx.page.setViewportSize({ width: 420, height: 800 });
        await sleep(ctx, 150);
        const scrollable = await ctx.page.evaluate(() => {
          const table = document.querySelector('[data-base-table], .base-surface table');
          const scroller = table?.closest('.base-table-wrap, .base-scroll, .table-scroll') || table?.closest('.base-surface') || table?.parentElement;
          return Boolean(scroller) && scroller.scrollWidth > scroller.clientWidth;
        });
        assert.ok(scrollable);
        await ctx.page.setViewportSize({ width: 1440, height: 1000 });
      },
    },
  },
  {
    item: 17,
    title: 'hostile YAML/frontmatter text never executes a script',
    characterization: {
      description: 'hostile Base/note text stays inert (marker unset, no page error)',
      async run(ctx) {
        const errors = [];
        const onError = (error) => errors.push(error.message);
        ctx.page.on('pageerror', onError);
        try {
          await gotoApp(ctx);
          await waitForCatalog(ctx);
          const hostile = await openBase(ctx, ctx.fixtures.files.xssBase);
          assert.equal(hostile.status, 404, 'hostile .base must not be served by a Web API yet');
          await request(ctx, `${BASE_ROUTE_PREFIX}${encodeDocumentRoute(ctx.fixtures.vaultId, ctx.fixtures.files.xssBase)}`);
          await ctx.open(ctx.fixtures.files.payloadNote);
          await sleep(ctx, 150);
          const marker = await ctx.page.evaluate((name) => window[name], ctx.fixtures.xss.marker);
          assert.equal(marker, undefined, 'hostile text must never execute');
          assert.deepEqual(errors, []);
        } finally {
          ctx.page.off('pageerror', onError);
        }
      },
    },
    full: {
      description: 'the Base surface renders hostile view/cell text as inert text',
      async run(ctx) {
        const errors = [];
        const onError = (error) => errors.push(error.message);
        ctx.page.on('pageerror', onError);
        try {
          await gotoApp(ctx);
          await waitForCatalog(ctx);
          await ctx.page.locator(selectors.baseNode(ctx.fixtures.files.xssBase)).first().click();
          // hostile .base 404s (characterization below) so the surface is hidden again right after it mounts: wait for the mount, not the transient visible window (#315).
          await ctx.page.locator(selectors.baseSurface).first().waitFor({ state: 'attached', timeout: 10000 });
          await sleep(ctx, 150);
          const marker = await ctx.page.evaluate((name) => window[name], ctx.fixtures.xss.marker);
          assert.equal(marker, undefined);
          assert.deepEqual(errors, []);
        } finally { ctx.page.off('pageerror', onError); }
      },
    },
  },
];

const PHASES = ['characterization', 'full'];

export const WEB_BASES_SCENARIOS = Object.freeze(ITEMS.flatMap((definition) => PHASES.map((phase) => {
  const descriptor = definition[phase];
  return Object.freeze({
    id: `WBE2E-${String(definition.item).padStart(2, '0')}-${phase === 'characterization' ? 'C' : 'F'}`,
    item: definition.item,
    title: definition.title,
    phase,
    name: `bases/${String(definition.item).padStart(2, '0')} ${definition.title} [${phase}]`,
    description: descriptor.description,
  });
})));

export function listWebBasesScenarios(phase) {
  const wanted = phase ? String(phase) : null;
  return WEB_BASES_SCENARIOS
    .filter((scenario) => !wanted || scenario.phase === wanted)
    .map(({ id, item, title, phase: scenarioPhase, name, description }) => ({ id, item, title, phase: scenarioPhase, name, description }));
}

export const WEB_BASES_SECTION_ITEMS = ITEMS.map((definition) => definition.item);

// Registers the checks for the requested phase. Returns the ids that were
// registered so a runner can report coverage. Async because the harness `check`
// runs each scenario to completion; awaiting keeps the scenarios sequential on
// the single shared page.
export async function registerWebBasesChecks(ctx) {
  assert.equal(typeof ctx?.check, 'function', 'ctx.check must be the browser harness check(name, fn) function');
  assert.ok(ctx?.page, 'ctx.page is required');
  assert.ok(ctx?.serverUrl, 'ctx.serverUrl is required');
  assert.ok(ctx?.fixtures, 'ctx.fixtures is required');
  const phase = phaseOf(ctx);
  assert.ok(PHASES.includes(phase), `unknown phase "${phase}"`);
  const registered = [];
  for (const definition of ITEMS) {
    const descriptor = definition[phase];
    const scenario = WEB_BASES_SCENARIOS.find((entry) => entry.item === definition.item && entry.phase === phase);
    await ctx.check(scenario.name, () => descriptor.run({ ...ctx, phase }));
    registered.push(scenario.id);
  }
  return registered;
}

// =============================================================================
// D3 parity extension — full phase only (P1 desktop-parity interactions)
// =============================================================================
//
// Appended ON TOP of the frozen §15.8 items 1-17 above, which stay unchanged.
// The item list, `WEB_BASES_SCENARIOS`, `WEB_BASES_SECTION_ITEMS` and
// `registerWebBasesChecks` keep their pinned meaning (17 items x 2 phases); the
// interactions below register through `registerWebBasesParityChecks`, which both
// the standalone A5 runner (full phase) and the shared `web-regression.mjs`
// harness call. They only exist in the full phase because the desktop-parity
// surface itself only exists once P1 is merged.

const PARITY = Object.freeze({
  baseRow: (path) => `.note.note-base[data-path="${path}"]`,
  badge: '.note-badge',
  viewNative: '.base-view-control select.base-view-select',
  viewTrigger: '.base-view-control .select-trigger',
  viewMenu: '.base-view-control .select-menu',
  action: (id) => `[data-base-action="${id}"]`,
  panel: (id) => `[data-base-panel="${id}"]`,
  table: '[data-base-table]',
  rows: '[data-base-table] tbody tr',
  col: (key) => `col[data-column="${key}"]`,
  resize: (key) => `.base-col-resize[data-column="${key}"]`,
});

async function firstColumnTexts(ctx) {
  return ctx.page.locator(PARITY.rows).evaluateAll((rows) => rows
    .map((row) => (row.querySelector('td')?.textContent ?? '').trim()));
}

async function columnKeys(ctx) {
  return ctx.page.locator(`${PARITY.table} thead th`).evaluateAll((headers) => headers
    .map((header) => header.getAttribute('data-column')));
}

async function waitForRows(ctx) {
  await ctx.page.locator(PARITY.rows).first().waitFor({ state: 'visible', timeout: 10000 });
  await sleep(ctx, 120);
}

async function waitForFirstRow(ctx, expected) {
  await ctx.page.waitForFunction((text) => {
    const row = document.querySelector('[data-base-table] tbody tr');
    return (row?.querySelector('td')?.textContent ?? '').trim() === text;
  }, expected, { timeout: 10000 });
}

// Deterministic start for every parity scenario: desktop viewport, the primary
// fixture Vault, the Base document opened from the Explorer at a clean URL.
async function openParityBase(ctx) {
  await ctx.page.setViewportSize({ width: 1440, height: 1000 });
  await gotoApp(ctx);
  await waitForCatalog(ctx);
  const row = ctx.page.locator(PARITY.baseRow(ctx.fixtures.files.projectBase)).first();
  await row.waitFor({ state: 'visible', timeout: 10000 });
  await row.click({ timeout: 5000 });
  await ctx.page.locator(selectors.baseSurface).first().waitFor({ state: 'visible', timeout: 10000 });
  await waitForRows(ctx);
}

const PARITY_ITEMS = [
  {
    item: 18,
    title: 'the Explorer renders a .base row with a BASE badge',
    description: 'Project.base is a file row whose trailing tag reads BASE',
    async run(ctx) {
      await gotoApp(ctx);
      await waitForCatalog(ctx);
      const row = ctx.page.locator(PARITY.baseRow(ctx.fixtures.files.projectBase)).first();
      await row.waitFor({ state: 'visible', timeout: 10000 });
      assert.equal(await row.getAttribute('data-kind'), 'base');
      assert.equal((await row.locator('.note-title').textContent()).trim(), 'Project');
      const badge = row.locator(PARITY.badge);
      await badge.waitFor({ state: 'visible', timeout: 5000 });
      assert.equal((await badge.textContent()).trim(), 'BASE');
      assert.equal(await badge.isVisible(), true);
    },
  },
  {
    item: 19,
    title: 'the view dropdown is the custom component, never a native select',
    description: 'the trigger opens a .select-menu panel and switching views re-queries',
    async run(ctx) {
      await openParityBase(ctx);
      assert.equal(await ctx.page.locator(PARITY.viewNative).count(), 1);
      // The native select stays the canonical value source but is visually removed:
      // clipped (clip-path inset) with a <=1px box, aria-hidden and out of the tab
      // order. Playwright's `isVisible()`/box test treats a clipped 1px box as
      // visible, so assert the paintable surface directly: the native node must not
      // be what `elementFromPoint` hits inside its own box.
      const natives = await ctx.page.evaluate(() => [...document.querySelectorAll('[data-base-document-kind="base"] select')]
        .map((node) => {
          const style = getComputedStyle(node);
          const box = node.getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          const hit = (box.width > 0 && box.height > 0 && x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight)
            ? document.elementFromPoint(x, y)
            : null;
          return {
            hiddenClass: node.classList.contains('select-native'),
            ariaHidden: node.getAttribute('aria-hidden'),
            tabIndex: node.tabIndex,
            clipPath: style.clipPath,
            painted: hit === node || node.contains(hit),
          };
        }));
      assert.ok(natives.length > 0, 'the Base surface must keep its canonical native selects');
      for (const native of natives) {
        assert.equal(native.hiddenClass, true, 'every Base native select must be .select-native');
        assert.equal(native.ariaHidden, 'true');
        assert.equal(native.tabIndex, -1);
        assert.notEqual(native.clipPath, 'none');
        assert.equal(native.painted, false, 'a native select must never be the painted element');
      }
      const trigger = ctx.page.locator(PARITY.viewTrigger).first();
      await trigger.waitFor({ state: 'visible', timeout: 5000 });
      await trigger.click();
      const menu = ctx.page.locator(PARITY.viewMenu).first();
      await menu.waitFor({ state: 'visible', timeout: 5000 });
      const options = await menu.locator('.select-option').allTextContents();
      assert.ok(options.some((value) => value.includes('All project notes')), `view options: ${JSON.stringify(options)}`);
      assert.ok(options.some((value) => value.includes('Active only')), `view options: ${JSON.stringify(options)}`);
      await menu.locator('.select-option[data-value="Active only"]').click();
      await ctx.page.waitForFunction(() => new URL(location.href).searchParams.get('view') === 'Active only', { timeout: 10000 });
      await waitForRows(ctx);
      const statuses = await ctx.page.locator(PARITY.rows).evaluateAll((rows) => rows
        .map((row) => (row.querySelectorAll('td')[1]?.textContent ?? '').trim().toLowerCase()));
      assert.ok(statuses.length > 0, 'Active only must still return rows');
      assert.ok(statuses.every((value) => value === 'active'), `switching the view must re-query Active only, saw ${JSON.stringify(statuses)}`);
    },
  },
  {
    item: 20,
    title: 'the tool row exposes the five labelled actions',
    description: '排序/筛选/属性/搜索/新建 are visible, labelled and open their panel',
    async run(ctx) {
      await openParityBase(ctx);
      const expected = [['sort', '排序'], ['filter', '筛选'], ['properties', '属性'], ['search', '搜索'], ['new', '新建']];
      for (const [id, label] of expected) {
        const button = ctx.page.locator(PARITY.action(id)).first();
        await button.waitFor({ state: 'visible', timeout: 5000 });
        assert.equal((await button.locator('.base-action-label').textContent()).trim(), label);
        assert.equal(await button.isEnabled(), true);
      }
      for (const [id] of expected) {
        await ctx.page.locator(PARITY.action(id)).first().click();
        await ctx.page.locator(PARITY.panel(id)).first().waitFor({ state: 'visible', timeout: 5000 });
        await ctx.page.locator(PARITY.action(id)).first().click();
        await ctx.page.locator(PARITY.panel(id)).first().waitFor({ state: 'detached', timeout: 5000 });
        await sleep(ctx, 60);
      }
    },
  },
  {
    item: 21,
    title: 'sorting by priority changes the row order and the document URL',
    description: 'priority ASC re-orders the rows, writes ?sort= and survives a reload',
    async run(ctx) {
      await openParityBase(ctx);
      const before = await firstColumnTexts(ctx);
      assert.ok(before.length >= 2, `need rows to sort, saw ${JSON.stringify(before)}`);
      assert.notEqual(before[0], 'Alpha', `default view sorts priority DESC, saw ${JSON.stringify(before)}`);

      await ctx.page.locator(PARITY.action('sort')).click();
      await ctx.page.locator(PARITY.panel('sort')).first().waitFor({ state: 'visible', timeout: 5000 });
      await ctx.applySortViaPopover('priority', 'asc'); // desktop-shaped 排序 menu, no per-direction buttons (scripts/web-bases-panels.mjs)
      await waitForFirstRow(ctx, 'Alpha');
      const after = await firstColumnTexts(ctx);
      assert.equal(after[0], 'Alpha', `priority ASC must start at Alpha, saw ${JSON.stringify(after)}`);
      assert.notEqual(after[0], before[0]);
      assert.notEqual(after[after.length - 1], before[before.length - 1]);
      const sortParam = new URL(ctx.page.url()).searchParams.get('sort');
      assert.ok(sortParam, 'the document URL must carry the sort override');
      assert.deepEqual(JSON.parse(sortParam), [{ key: 'priority', dir: 'asc' }]);

      await ctx.page.reload();
      await waitForRows(ctx);
      await waitForFirstRow(ctx, 'Alpha');
      assert.equal((await firstColumnTexts(ctx))[0], 'Alpha', 'the sort override must survive a reload');
    },
  },
  {
    item: 22,
    title: 'a status filter shrinks the row set and writes ?filter=',
    description: 'status is active hides the archived row; clearing the condition restores it',
    async run(ctx) {
      await openParityBase(ctx);
      const before = await firstColumnTexts(ctx);
      assert.ok(before.includes('Beta'), `the archived row must start visible, saw ${JSON.stringify(before)}`);

      await ctx.page.locator(PARITY.action('filter')).click();
      await ctx.page.locator(PARITY.panel('filter')).first().waitFor({ state: 'visible', timeout: 5000 });
      await ctx.page.locator('[data-filter-add]').click();
      await sleep(ctx, 150);
      // Pick the key through the custom dropdown, then commit the value with Enter.
      await ctx.page.locator('[data-filter-row="0"] .select-control').first().locator('.select-trigger').click();
      await ctx.page.locator('[data-filter-row="0"] .select-option[data-value="status"]').click();
      await sleep(ctx, 150);
      const value = ctx.page.locator('[data-filter-value]').first();
      await value.waitFor({ state: 'visible', timeout: 5000 });
      await value.fill('active');
      await value.press('Enter');
      await sleep(ctx, 250);

      const filtered = await firstColumnTexts(ctx);
      assert.ok(!filtered.includes('Beta'), `the archived row must be filtered out, saw ${JSON.stringify(filtered)}`);
      assert.ok(filtered.length < before.length, `filter must shrink the row set (${before.length} -> ${filtered.length})`);
      const filterParam = new URL(ctx.page.url()).searchParams.get('filter');
      assert.ok(filterParam, 'the document URL must carry the filter override');
      assert.deepEqual(JSON.parse(filterParam), [{ key: 'status', op: 'is', value: 'active' }]);

      if (!(await ctx.page.locator(PARITY.panel('filter')).first().isVisible().catch(() => false))) {
        await ctx.page.locator(PARITY.action('filter')).click();
        await ctx.page.locator(PARITY.panel('filter')).first().waitFor({ state: 'visible', timeout: 5000 });
      }
      await ctx.page.locator('[data-filter-clear]').click();
      await sleep(ctx, 250);
      const restored = await firstColumnTexts(ctx);
      assert.ok(restored.includes('Beta'), `clearing the filter must restore the row, saw ${JSON.stringify(restored)}`);
      assert.equal(new URL(ctx.page.url()).searchParams.get('filter'), null);
    },
  },
  {
    item: 23,
    title: 'hiding a column removes it from the header and the cells',
    description: 'the properties panel toggles the updated column off, then back on',
    async run(ctx) {
      await openParityBase(ctx);
      assert.ok((await columnKeys(ctx)).includes('updated'), 'updated must be a visible column by default');
      const cellsBefore = await ctx.page.locator(PARITY.rows).first().locator('td').count();

      await ctx.page.locator(PARITY.action('properties')).click();
      await ctx.page.locator(PARITY.panel('properties')).first().waitFor({ state: 'visible', timeout: 5000 });
      const toggle = ctx.page.locator('[data-prop-toggle="updated"]').first();
      await toggle.waitFor({ state: 'visible', timeout: 5000 });
      // The re-render replaces this checkbox, so click (not `uncheck()`, which
      // waits for the detached node to report the new state).
      await toggle.click();
      await ctx.page.waitForFunction(() => !document.querySelector('[data-base-table] thead th[data-column="updated"]'), { timeout: 5000 });
      await sleep(ctx, 150);

      assert.ok(!(await columnKeys(ctx)).includes('updated'), 'the updated header must disappear');
      const cellsAfter = await ctx.page.locator(PARITY.rows).first().locator('td').count();
      assert.equal(cellsAfter, cellsBefore - 1, 'the updated cell must disappear too');
      const hiddenPersisted = await ctx.page.evaluate(() => Object.keys(localStorage)
        .filter((key) => key.startsWith('obsidian-web.base-view-config:v1'))
        .some((key) => {
          try { return (JSON.parse(localStorage.getItem(key)).hidden ?? []).includes('updated'); } catch { return false; }
        }));
      assert.equal(hiddenPersisted, true, 'the hidden column must persist in localStorage');

      if (!(await ctx.page.locator(PARITY.panel('properties')).first().isVisible().catch(() => false))) {
        await ctx.page.locator(PARITY.action('properties')).click();
        await ctx.page.locator(PARITY.panel('properties')).first().waitFor({ state: 'visible', timeout: 5000 });
      }
      await ctx.page.locator('[data-prop-toggle="updated"]').first().click();
      await ctx.page.waitForFunction(() => Boolean(document.querySelector('[data-base-table] thead th[data-column="updated"]')), { timeout: 5000 });
      await sleep(ctx, 150);
      assert.ok((await columnKeys(ctx)).includes('updated'), 'restoring the column must bring the header back');
      assert.equal(await ctx.page.locator(PARITY.rows).first().locator('td').count(), cellsBefore);
    },
  },
  {
    item: 24,
    title: 'searching narrows the row set to the matching rows',
    description: 'a term matching one row shrinks the table and writes ?q=',
    async run(ctx) {
      await openParityBase(ctx);
      const before = await firstColumnTexts(ctx);
      assert.ok(before.length >= 2, `need rows to search, saw ${JSON.stringify(before)}`);

      await ctx.page.locator(PARITY.action('search')).click();
      const input = ctx.page.locator('[data-search-input]').first();
      await input.waitFor({ state: 'visible', timeout: 5000 });
      await input.fill('Gamma');
      await input.press('Enter');
      await waitForFirstRow(ctx, 'Gamma');

      const after = await firstColumnTexts(ctx);
      assert.ok(after.length < before.length, `search must shrink the row set (${before.length} -> ${after.length})`);
      assert.ok(after.every((text) => text.includes('Gamma')), `only the matching row may remain, saw ${JSON.stringify(after)}`);
      assert.equal(new URL(ctx.page.url()).searchParams.get('q'), 'Gamma');
    },
  },
  {
    item: 25,
    title: 'dragging a column boundary resizes it and the width persists',
    description: 'the dragged width is applied and survives a reload through localStorage',
    async run(ctx) {
      await openParityBase(ctx);
      const before = await ctx.page.locator(PARITY.col('file.name')).first().evaluate((col) => col.style.width);
      const handle = ctx.page.locator(PARITY.resize('file.name')).first();
      const box = await handle.boundingBox();
      assert.ok(box, 'the file.name resize handle must be present');
      await ctx.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await ctx.page.mouse.down();
      await ctx.page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 12 });
      await ctx.page.mouse.up();
      await sleep(ctx, 250);

      const after = await ctx.page.locator(PARITY.col('file.name')).first().evaluate((col) => col.style.width);
      assert.notEqual(after, before, 'dragging must change the column width');
      assert.ok(Number.parseInt(after, 10) > Number.parseInt(before, 10), `${after} must be wider than ${before}`);
      const persisted = await ctx.page.evaluate(() => Object.keys(localStorage)
        .filter((key) => key.startsWith('obsidian-web.base-view-config:v1'))
        .map((key) => { try { return JSON.parse(localStorage.getItem(key)).widths?.['file.name'] ?? null; } catch { return null; } })
        .find((value) => Number.isFinite(value)) ?? null);
      assert.equal(persisted, Number.parseInt(after, 10), 'the width must persist in localStorage');

      await ctx.page.reload();
      await waitForRows(ctx);
      const reloaded = await ctx.page.locator(PARITY.col('file.name')).first().evaluate((col) => col.style.width);
      assert.equal(reloaded, after, 'the width must survive a reload');
    },
  },
  {
    item: 26,
    title: 'the table box scrolls vertically while the header stays pinned',
    description: 'scrollHeight > clientHeight, the sticky header stays put and the page does not scroll',
    async run(ctx) {
      await openParityBase(ctx);
      await ctx.page.setViewportSize({ width: 1440, height: 420 });
      await sleep(ctx, 200);
      const metrics = await ctx.page.evaluate(() => {
        const wrap = document.querySelector('.base-table-wrap');
        const header = document.querySelector('[data-base-table] thead th');
        return {
          overflowY: getComputedStyle(wrap).overflowY,
          clientHeight: wrap.clientHeight,
          scrollHeight: wrap.scrollHeight,
          headerTop: Math.round(header.getBoundingClientRect().top),
          wrapTop: Math.round(wrap.getBoundingClientRect().top),
        };
      });
      assert.ok(['auto', 'scroll'].includes(metrics.overflowY), `the table box must own the vertical scroll, saw ${metrics.overflowY}`);
      assert.ok(metrics.scrollHeight > metrics.clientHeight + 1, `the table box must overflow: ${JSON.stringify(metrics)}`);

      await ctx.page.evaluate(() => { document.querySelector('.base-table-wrap').scrollTop = 120; });
      await sleep(ctx, 150);
      const after = await ctx.page.evaluate(() => {
        const wrap = document.querySelector('.base-table-wrap');
        const header = document.querySelector('[data-base-table] thead th');
        const scroller = document.scrollingElement || document.documentElement;
        return {
          scrollTop: wrap.scrollTop,
          headerTop: Math.round(header.getBoundingClientRect().top),
          wrapTop: Math.round(wrap.getBoundingClientRect().top),
          pageScrollTop: scroller.scrollTop,
          windowScrollY: window.scrollY,
          pageOverflow: scroller.scrollHeight > window.innerHeight + 1,
        };
      });
      assert.ok(after.scrollTop > 0, 'the table box must actually scroll');
      assert.ok(Math.abs(after.headerTop - after.wrapTop) <= 2, `the sticky header must stay pinned: ${JSON.stringify(after)}`);
      assert.equal(after.pageScrollTop, 0);
      assert.equal(after.windowScrollY, 0);
      assert.equal(after.pageOverflow, false, 'the Base document must not grow the page');
      await ctx.page.setViewportSize({ width: 1440, height: 1000 });
    },
  },
  {
    item: 27,
    title: 'opening a Base from a note clears the outline to its empty state',
    description: 'no note heading survives the note -> Base switch',
    async run(ctx) {
      await ctx.page.setViewportSize({ width: 1440, height: 1000 });
      await gotoApp(ctx);
      if (await ctx.page.locator('.shell').evaluate((shell) => shell.classList.contains('context-hidden'))) {
        await ctx.page.locator('#sidebar-toggle').click();
        await sleep(ctx, 150);
      }
      await ctx.open(ctx.fixtures.files.readmeNote);
      await ctx.page.locator('#outline-list .outline-item').first().waitFor({ state: 'visible', timeout: 10000 });
      const headingCount = await ctx.page.locator('#outline-list .outline-item').count();
      assert.ok(headingCount > 0, 'the note outline must have content before switching');

      await ctx.page.locator(PARITY.baseRow(ctx.fixtures.files.projectBase)).first().click({ timeout: 5000 });
      await ctx.page.locator(selectors.baseSurface).first().waitFor({ state: 'visible', timeout: 10000 });
      await waitForRows(ctx);
      await sleep(ctx, 200);
      const outline = await ctx.page.evaluate(() => ({
        items: document.querySelectorAll('#outline-list .outline-item').length,
        empty: document.querySelector('#outline-list .context-empty')?.textContent ?? null,
      }));
      assert.equal(outline.items, 0, `the note headings must not survive into the Base, saw ${outline.items}`);
      assert.ok(typeof outline.empty === 'string' && outline.empty.length > 0, 'the outline must show its empty state text');
    },
  },
];

export const WEB_BASES_PARITY_SCENARIOS = Object.freeze(PARITY_ITEMS.map((definition) => Object.freeze({
  id: `WBPAR-${String(definition.item).padStart(2, '0')}-F`,
  item: definition.item,
  title: definition.title,
  phase: 'full',
  name: `bases/parity/${String(definition.item).padStart(2, '0')} ${definition.title} [full]`,
  description: definition.description,
})));

export function listWebBasesParityScenarios() {
  return WEB_BASES_PARITY_SCENARIOS.map(({ id, item, title, phase, name, description }) => ({ id, item, title, phase, name, description }));
}

// Registers the parity scenarios in the full phase only. Mirrors
// `registerWebBasesChecks`: sequential on the single shared page, returns the ids.
export async function registerWebBasesParityChecks(ctx) {
  assert.equal(typeof ctx?.check, 'function', 'ctx.check must be the browser harness check(name, fn) function');
  assert.ok(ctx?.page, 'ctx.page is required');
  assert.ok(ctx?.serverUrl, 'ctx.serverUrl is required');
  assert.ok(ctx?.fixtures, 'ctx.fixtures is required');
  const registered = [];
  for (const definition of PARITY_ITEMS) {
    const scenario = WEB_BASES_PARITY_SCENARIOS.find((entry) => entry.item === definition.item);
    await ctx.check(scenario.name, () => definition.run({ ...ctx, phase: 'full' }));
    registered.push(scenario.id);
  }
  return registered;
}
