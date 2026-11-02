// Issue #471 (I471-NAV narrow slice): the internal app root is the slash-bearing `/app/`.
//
// #487 (P1) ships a manifest whose `id` = `start_url` = `scope` = `/app/`. Scope membership is a
// same-origin prefix test on the resolved URL, so the slash-less `/app` is outside the scope the
// engine resolves. This slice normalises the internal navigation targets (the login default
// return, the vault switch/create navigation, the history-carried welcome route, the
// session-expiry 303 target) instead of widening `scope`.
//
// What this scene measures on the real engine, right after the addresses are produced:
//   * the login round trip entered at the slash-less `/app` (the pre-fix entry): the login form's
//     `next`, the post-login address, and whether that address is inside the scope the engine
//     resolves from the shipped manifest;
//   * a canonical note deep link carrying a fragment, so the regression face (note/Base deep
//     links with query/hash) is measured rather than assumed;
//   * Back / Forward across two note entries plus the committed welcome entry, with a window
//     marker as the witness for "a document load did or did not happen".
//
// The scope source is recorded in every assertion message: with P1 merged the scene reads the
// manifest the engine itself would parse; on a base without P1 the app-root contract `/app/` is
// the same string, so the verdict does not depend on which base the scene runs on.
import assert from 'node:assert/strict';
import { environment } from './env.mjs';

const APP_ROOT = '/app/';
// The prefix test `scripts/web-regression/pwa-install.mjs` applies to the resolved absolute URLs.
const inScope = (scope, target) => String(target).split(/[?#]/, 1)[0].startsWith(scope);

export async function registerNavRootScopeChecks(ctx) {
  const { check, sleep, page, base, open } = ctx;
  const context = page.context();
  const readAddress = () => page.evaluate(() => ({ pathname: location.pathname, search: location.search, hash: location.hash }));
  // Every check owns its session state: a previous check may have drained it (the login round trip
  // deliberately does), so a check re-authenticates through the fixture API instead of inheriting.
  const ensureSession = async () => {
    const probe = await page.request.get(`${base}/api/web/v1/session`);
    if (probe.ok()) return;
    const login = await page.request.post(`${base}/auth/login`, { form: { username: 'browser-test', password: environment.password } });
    assert.equal(login.status(), 200, 'the fixture login must succeed before an authenticated scene');
  };
  const readResolvedScope = async () => {
    const manifest = await page.evaluate(async () => {
      const href = document.querySelector('link[rel="manifest"]')?.href ?? null;
      if (!href) return null;
      const body = await (await fetch(href)).json();
      return {
        href,
        id: new URL(body.id, href).pathname,
        startUrl: new URL(body.start_url, href).pathname,
        scope: new URL(body.scope, href).pathname,
      };
    });
    return manifest
      ? { ...manifest, scopePath: manifest.scope, source: `manifest ${manifest.href}` }
      : { scopePath: APP_ROOT, source: 'app-root contract (the P1 manifest is not in this base)' };
  };

  await check('#471 nav root: the login round trip returns to the slash-bearing app root, inside the resolved scope', async () => {
    await ensureSession();
    await page.goto(`${base}${APP_ROOT}`);
    await page.waitForSelector('.topbar', { state: 'visible' });
    const scope = await readResolvedScope();
    assert.equal(scope.scopePath, APP_ROOT, `the engine resolves the app root as the scope (source: ${scope.source})`);
    if (scope.id !== undefined) {
      assert.equal(scope.id, APP_ROOT, `the manifest id is the app root (source: ${scope.source})`);
      assert.equal(scope.startUrl, APP_ROOT, `the manifest start_url is the app root (source: ${scope.source})`);
    }
    // The condition this slice removes: the address the repo used to navigate to is outside it.
    assert.equal(inScope(scope.scopePath, '/app'), false, `the slash-less app root is outside the scope (source: ${scope.source})`);
    assert.equal(inScope(scope.scopePath, APP_ROOT), true);

    // Enter at the slash-less root with no session — the old bookmark / old-link case. The blank
    // page first: the app shell's own session probing must not race the navigation under test.
    await page.goto('about:blank');
    await context.clearCookies();
    const login = await page.goto(`${base}/app`);
    assert.equal(login.status(), 200, 'the slash-less entry is served the login page');
    const nextValue = await page.locator('form[action="/auth/login"] input[name="next"]').inputValue();
    assert.equal(nextValue, APP_ROOT, `the login form offers the slash-bearing return (${nextValue})`);
    await page.fill('form[action="/auth/login"] input[name="username"]', 'browser-test');
    await page.fill('form[action="/auth/login"] input[name="password"]', environment.password);
    await page.click('form[action="/auth/login"] button[type="submit"]');
    await page.waitForURL((url) => url.pathname === APP_ROOT, { timeout: 15000 });
    await page.waitForSelector('.topbar', { state: 'visible' });
    const landed = await readAddress();
    assert.equal(landed.pathname, APP_ROOT, `the post-login landing is the slash form (${JSON.stringify(landed)})`);
    assert.equal(inScope(scope.scopePath, landed.pathname), true, `the landing is inside the resolved scope (source: ${scope.source})`);
  });

  await check('#471 nav root: a canonical note deep link keeps its fragment and stays inside the scope', async () => {
    await ensureSession();
    await page.goto(`${base}/app/note/A.md`);
    await page.waitForFunction(() => location.pathname.startsWith('/app/note/') && document.querySelector('#current-path')?.textContent === 'A.md', null, { timeout: 15000 });
    const canonical = new URL(page.url()).pathname;
    await page.goto(`${base}${canonical}#Actual%20heading`);
    await page.waitForFunction(() => document.querySelector('#current-path')?.textContent === 'A.md', null, { timeout: 15000 });
    const address = await readAddress();
    assert.equal(address.pathname, canonical, `the deep link keeps its canonical route (${JSON.stringify(address)})`);
    assert.equal(address.hash, '#Actual%20heading', `the fragment survives the document load (${JSON.stringify(address)})`);
    assert.equal(inScope(APP_ROOT, address.pathname), true, `the deep link stays inside the app root (${JSON.stringify(address)})`);
  });

  await check('#471 nav root: Back, Forward and the committed welcome entry keep every address inside the scope', async () => {
    await ensureSession();
    await page.goto(`${base}${APP_ROOT}`);
    await page.waitForSelector('.welcome', { state: 'visible' });
    await page.waitForSelector('.note[title="A.md"]');
    const addresses = [];
    const record = async (label) => { const address = await readAddress(); addresses.push({ label, ...address }); return address; };
    await open('A.md');
    const noteA = await record('note A');
    await open('B.md');
    const noteB = await record('note B');
    assert.notEqual(noteA.pathname, noteB.pathname, 'the two note entries are distinct addresses');

    await page.goBack();
    await page.waitForFunction((previous) => location.pathname !== previous, noteB.pathname, { timeout: 15000 });
    await record('Back to note A');

    await page.goForward();
    await page.waitForFunction((previous) => location.pathname !== previous, noteA.pathname, { timeout: 15000 });
    await record('Forward to note B');

    // Close every tab: the last close commits the welcome entry through the history API, so the
    // address becomes the app root without a document load (the #410 contract).
    for (const path of ['B.md', 'A.md']) {
      const close = page.locator(`#document-tabs .document-tab[data-tab-path=${JSON.stringify(path)}] .document-tab-close`);
      assert.equal(await close.count(), 1, `${path} still owns a tab before the close`);
      await close.click();
      await sleep(150);
    }
    await page.waitForSelector('.welcome', { state: 'visible' });
    const welcome = await record('welcome committed');
    assert.equal(welcome.pathname, APP_ROOT, `the accepted last close lands on the slash form (${JSON.stringify(welcome)})`);

    // Back onto an earlier note entry is an in-app replay (no document load), Forward onto the
    // committed welcome entry reloads the slash-bearing root. The window marker is the witness.
    await page.evaluate(() => { window.__u47NavMarker = 'same-document'; });
    await page.goBack();
    await page.waitForFunction(() => location.pathname.startsWith('/app/note/'), null, { timeout: 15000 });
    const replayed = await record('Back to a note');
    assert.equal(await page.evaluate(() => window.__u47NavMarker), 'same-document', `Back is an in-app replay, not a load (${JSON.stringify(replayed)})`);

    await page.goForward();
    await page.waitForFunction(() => window.__u47NavMarker === undefined, null, { timeout: 15000 });
    await page.waitForSelector('.welcome', { state: 'visible' });
    const reloaded = await record('Forward onto the welcome entry');
    assert.equal(reloaded.pathname, APP_ROOT, `Forward relocates the welcome entry without leaving the scope (${JSON.stringify(reloaded)})`);

    for (const { label, pathname } of addresses) {
      assert.equal(pathname === APP_ROOT || pathname.startsWith(APP_ROOT), true, `${label} produced ${pathname}, outside ${APP_ROOT}`);
      assert.notEqual(pathname, '/app', `${label} produced the slash-less app root`);
    }
  });
}
