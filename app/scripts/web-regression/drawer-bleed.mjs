// Issue #418 — the mobile drawer must be an opaque, topmost surface over a Bases document.
//
// Reported from production: on a phone, opening the files drawer over a Base view let the Base
// surface (view title, toolbar, table) show over the drawer. Two independent defects produce
// that symptom, and this module pins both:
//
//   1. paint order — a feature may lift itself inside the document with a z-index, so the
//      document subtree must be a stacking context *below* the shell overlays. Before the fix
//      `.base-surface-header{position:relative;z-index:5}` tied the fixed drawer (5) and won by
//      DOM order, and it also beat the shared scrim (4): the Base toolbar painted over the open
//      drawer *and* received the "tap outside to close" gesture aimed at the scrim.
//   2. surface opacity — the drawer background was the themed chrome token alone. A community
//      theme may hand over a translucent `--background-secondary`, and the drawer then composited
//      to a non-opaque surface no matter how correct the paint order was.
//
// Everything below is a real browser observation at a phone profile (390x844, `pointer: coarse`)
// against a fixture Vault carrying a real Base: computed styles parsed channel by channel,
// `elementFromPoint` hit testing on the points the Base occupies, and the app's own community-theme
// route serving a theme with a translucent chrome token. Measurements land in
// <outputRoot>/drawer-bleed-trace.json.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWebBasesFixtureVault } from '../web-bases-fixtures.mjs';

// The phone profile of the report. Below the frozen `<=720px` drawer breakpoint.
const VIEWPORT = { width: 390, height: 844 };
const DRAWER_SETTLE_MS = 260; // the drawer transform transition is 160 ms
const TRANSLUCENT_THEME = 'V418Translucent';
// A community theme whose chrome token is translucent. It is declared on `:root` because that is
// where the app resolves its own `--app-chrome-bg: var(--background-secondary)` indirection.
const TRANSLUCENT_THEME_CSS = `:root, .theme-light, .theme-dark { --background-secondary: rgb(40 40 40 / 0.8); }\n`;

export async function registerDrawerBleedChecks(ctx) {
  const { check, sleep, browser, root, appRoot, serverErrors, outputRoot } = ctx;

  const trace = { startedAt: Date.now(), viewport: VIEWPORT, breakpointPx: 720, phases: [] };
  const fixtureRoot = path.join(root, 'web-drawer-bleed');
  const fixtures = await createWebBasesFixtureVault(fixtureRoot);
  // The theme is installed the way a real community theme is: a directory under the Vault's
  // `.obsidian/themes` plus the active `cssTheme` in `appearance.json`, so the SSR page links it
  // through `/api/web/v1/theme.css` exactly like production does.
  const themeRoot = path.join(fixtures.vault, '.obsidian', 'themes', TRANSLUCENT_THEME);
  await fs.mkdir(themeRoot, { recursive: true });
  await fs.writeFile(path.join(themeRoot, 'theme.css'), TRANSLUCENT_THEME_CSS);
  await fs.writeFile(path.join(themeRoot, 'manifest.json'), JSON.stringify({ name: TRANSLUCENT_THEME, version: '1.0.0' }));

  const port = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(24).toString('hex');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: appRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), DATA_PATH: path.join(fixtureRoot, 'data'),
      OAUTH_ENABLED: 'true', PUBLIC_BASE_URL: base, OAUTH_INITIAL_USERNAME: 'browser-test', OAUTH_INITIAL_PASSWORD: password,
      OAUTH_ADMIN_PASSWORD: password, API_KEY: '', GIT_ENABLED: 'false', GIT_AUTO_COMMIT: 'false', GIT_AUTO_PUSH: 'false',
      EMBEDDING_PROVIDER: 'disabled', EMBEDDING_EDGE_PROVIDER: 'disabled', EMBEDDING_EDGE_BASE_URL: '', EMBEDDING_EDGE_REGISTRY_URL: '',
      RETRIEVAL_AUTO_EMBED: 'false', WEB_FILE_WATCH_DEBOUNCE_MS: '50', ...fixtures.serverEnv,
    },
  });
  child.stderr.on('data', (data) => serverErrors.push(data.toString()));
  child.stdout.resume();

  const context = await browser.newContext({ viewport: VIEWPORT, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  const page = await context.newPage();
  const pageErrors = [];
  try {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* keep waiting */ }
      if (child.exitCode !== null) throw new Error('Drawer-bleed test server exited');
      await sleep(100);
    }
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));

    const response = await page.request.post(`${base}/auth/login`, { form: { username: 'browser-test', password } });
    assert.equal(response.status(), 200, `drawer-bleed login failed with ${response.status()}`);

    // Opens the Base the way a phone user does — through the files drawer — and leaves that
    // drawer open, which is the reported state. Returns the fixture Base's document path so the
    // assertions can name the surface they are talking about.
    const openBaseWithDrawerOpen = async () => {
      await page.goto(`${base}/app`);
      await page.waitForSelector('.note[title="Readme.md"]', { timeout: 20000 });
      await page.locator('#menu').click();
      await page.waitForFunction(() => document.querySelector('.shell')?.classList.contains('sidebar-open'));
      await sleep(DRAWER_SETTLE_MS);
      await page.locator(`.note.note-base[data-path="${fixtures.files.projectBase}"]`).first().click();
      await page.waitForSelector('#base-host:not([hidden])', { timeout: 20000 });
      await page.waitForSelector('[data-base-table] tbody tr', { timeout: 20000 });
      await sleep(DRAWER_SETTLE_MS);
      assert.equal(await page.locator('.shell').evaluate((element) => element.classList.contains('sidebar-open')), true, 'the files drawer must still be open over the Base');
    };

    // One snapshot of the whole reported state: the drawer's own box and computed surface, the
    // shared scrim, the Base surface box, and the hit stack on the points that matter.
    const snapshot = () => page.evaluate((VIEWPORT) => {
      const alphaOf = (color) => {
        const value = String(color || '').trim();
        if (!value) return null;
        if (value === 'transparent') return 0;
        // `rgb(from C r g b / a)` is serialised as `color(srgb r g b / a)` by Chromium.
        if (value.startsWith('color(')) {
          const inner = value.slice(value.indexOf('(') + 1, value.lastIndexOf(')'));
          const [channels, alpha] = inner.split('/');
          return { channels: channels.trim(), alpha: alpha === undefined ? 1 : Number.parseFloat(alpha) };
        }
        const rgb = value.match(/^rgba?\(([^)]*)\)$/i);
        if (rgb) {
          const slash = rgb[1].split('/');
          if (slash.length > 1) return { channels: slash[0].trim(), alpha: Number.parseFloat(slash[1]) };
          const parts = rgb[1].split(',').map((part) => part.trim());
          if (parts.length === 4) return { channels: parts.slice(0, 3).join(' '), alpha: Number.parseFloat(parts[3]) };
          return { channels: parts.join(' '), alpha: 1 };
        }
        // A named or hex colour carries no alpha channel.
        return { channels: value, alpha: 1 };
      };
      const box = (el) => {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const sidebar = document.querySelector('.sidebar');
      const rail = document.querySelector('#context-sidebar');
      const scrim = document.querySelector('.scrim');
      const header = document.querySelector('.base-surface-header');
      const drawer = box(sidebar);
      const headerBox = box(header);
      const describe = (el) => (el ? { tag: el.tagName.toLowerCase(), className: typeof el.className === 'string' ? el.className : '', baseOwned: Boolean(el.closest('#base-host')) } : null);
      // Every sample sits inside the drawer and on a band the Base really occupies, so a passing
      // hit can only mean the drawer covers it.
      const samples = [
        ['drawer-over-base-toolbar', Math.round(drawer.left + drawer.width / 2), Math.round(headerBox.top + headerBox.height / 2)],
        ['drawer-over-base-table', 60, Math.round((headerBox.bottom + VIEWPORT.height) / 2)],
        ['drawer-over-file-tree', Math.round(drawer.left + drawer.width / 2), VIEWPORT.height - 120],
      ].map(([name, x, y]) => ({ name, x, y, stack: document.elementsFromPoint(x, y).slice(0, 8).map(describe) }));
      // The strip the open drawer does not cover, on the Base toolbar's own row: the shared scrim
      // has to be the topmost surface there, or the "tap outside" affordance is gone.
      const scrimStrip = { x: VIEWPORT.width - 12, y: Math.round(headerBox.top + headerBox.height / 2) };
      scrimStrip.stack = document.elementsFromPoint(scrimStrip.x, scrimStrip.y).slice(0, 8).map(describe);
      return {
        drawerOpen: document.querySelector('.shell').classList.contains('sidebar-open'),
        drawerMode: matchMedia('(max-width:720px)').matches,
        drawerPosition: getComputedStyle(sidebar).position,
        drawerZIndex: getComputedStyle(sidebar).zIndex,
        scrimZIndex: getComputedStyle(scrim).zIndex,
        scrimDisplay: getComputedStyle(scrim).display,
        sidebarSurface: alphaOf(getComputedStyle(sidebar).backgroundColor),
        railSurface: alphaOf(getComputedStyle(rail).backgroundColor),
        scrimSurface: alphaOf(getComputedStyle(scrim).backgroundColor),
        chromeToken: getComputedStyle(document.documentElement).getPropertyValue('--app-chrome-bg').trim(),
        backgroundSecondary: getComputedStyle(document.documentElement).getPropertyValue('--background-secondary').trim(),
        themeLink: document.querySelector('#community-theme')?.getAttribute('href') ?? null,
        themeDisabled: document.querySelector('#community-theme')?.disabled ?? null,
        drawer,
        railBox: box(rail),
        scrimBox: box(scrim),
        baseHeader: headerBox,
        baseHeaderVisible: Boolean(header) && headerBox.height > 0,
        samples,
        scrimStrip,
      };
    }, VIEWPORT);

    await check('mobile drawer: opening a Base under the files drawer keeps every covered point on the drawer', async () => {
      await openBaseWithDrawerOpen();
      const state = await snapshot();
      trace.phases.push({ check: 'default-theme', at: Date.now(), state });
      assert.equal(state.drawerMode, true, '390px must be inside the frozen <=720px drawer policy');
      assert.equal(state.drawerOpen, true, 'the files drawer is open over the Base');
      assert.equal(state.drawerPosition, 'fixed', 'below the breakpoint the files pane is a drawer');
      assert.ok(state.baseHeaderVisible, `the fixture Base must really render its surface header: ${JSON.stringify(state.baseHeader)}`);
      assert.ok(state.baseHeader.right > state.drawer.left, 'the Base surface header overlaps the drawer horizontally, so the probe points are real');
      for (const sample of state.samples) {
        const top = sample.stack[0];
        assert.ok(top, `elementFromPoint(${sample.x}, ${sample.y}) must return something`);
        assert.equal(top.baseOwned, false, `${sample.name}: the drawer must own (${sample.x}, ${sample.y}) but the topmost element is Base content: ${JSON.stringify(sample.stack)}`);
        assert.ok(sample.stack.some((entry) => !entry.baseOwned && /(^|\s)sidebar(\s|$)|sidebar-panel|note-list|note\b|panel-head|sidebar-actions|context-sidebar/.test(entry.className)), `${sample.name}: the drawer itself must be in the hit stack: ${JSON.stringify(sample.stack)}`);
      }
      assert.equal(state.scrimStrip.stack[0].className.split(' ')[0], 'scrim', `the shared scrim must be the topmost surface on the strip the drawer does not cover: ${JSON.stringify(state.scrimStrip)}`);
      assert.ok(state.scrimBox.width >= VIEWPORT.width - state.drawer.width, `the scrim still spans the uncovered content area: ${JSON.stringify(state.scrimBox)}`);
      assert.ok(Number(state.scrimZIndex) < Number(state.drawerZIndex), `the frozen scrim < drawer order is intact: ${state.scrimZIndex} < ${state.drawerZIndex}`);
    });

    await check('mobile drawer: the drawer surface composites opaque, even under a translucent community theme', async () => {
      // Baseline: the app's own fallback theme, where the chrome token is already opaque. The
      // assertion must hold here too — the fix may not regress the default look.
      await openBaseWithDrawerOpen();
      const plain = await snapshot();
      trace.phases.push({ check: 'opacity:default-theme', at: Date.now(), state: plain });
      assert.equal(plain.sidebarSurface.alpha, 1, `the default-theme files drawer must be opaque: ${JSON.stringify(plain.sidebarSurface)}`);
      assert.equal(plain.railSurface.alpha, 1, `the default-theme note-context drawer must be opaque: ${JSON.stringify(plain.railSurface)}`);
      assert.ok(plain.scrimSurface.alpha < 1, `the scrim stays the translucent "tap outside" hint: ${JSON.stringify(plain.scrimSurface)}`);

      // Now the production shape of the bug: a community theme whose chrome token is translucent.
      await fs.writeFile(path.join(fixtures.vault, '.obsidian', 'appearance.json'), JSON.stringify({ cssTheme: TRANSLUCENT_THEME, theme: 'moonstone' }));
      await openBaseWithDrawerOpen();
      const themed = await snapshot();
      trace.phases.push({ check: 'opacity:translucent-theme', at: Date.now(), state: themed });
      assert.match(String(themed.themeLink), /theme\.css\?name=V418Translucent/, `the page must link the community theme through the app's own route: ${themed.themeLink}`);
      assert.equal(themed.themeDisabled, false, 'the community theme link must be enabled');
      assert.equal(themed.backgroundSecondary, 'rgb(40 40 40 / 0.8)', `the fixture theme must really make the chrome token translucent: ${JSON.stringify(themed.backgroundSecondary)}`);
      assert.ok(themed.scrimSurface.alpha < 1, 'the scrim keeps its translucent value under the community theme');
      assert.equal(themed.sidebarSurface.alpha, 1, `a translucent chrome token must not make the drawer translucent: ${JSON.stringify(themed.sidebarSurface)}`);
      assert.equal(themed.railSurface.alpha, 1, `a translucent chrome token must not make the note-context drawer translucent: ${JSON.stringify(themed.railSurface)}`);
      // Belt and braces on the point the report names: with the translucent token in force the
      // drawer still owns the Base toolbar band, both over the drawer and over the scrim strip.
      for (const sample of themed.samples) {
        assert.equal(sample.stack[0].baseOwned, false, `${sample.name} under a translucent theme: ${JSON.stringify(sample.stack)}`);
      }
      assert.equal(themed.scrimStrip.stack[0].className.split(' ')[0], 'scrim', `the scrim still owns the uncovered strip under a translucent theme: ${JSON.stringify(themed.scrimStrip)}`);
      await fs.rm(path.join(fixtures.vault, '.obsidian', 'appearance.json'), { force: true });
    });

    assert.deepEqual(pageErrors, [], `no page error may fire while the drawer is open over a Base: ${JSON.stringify(pageErrors)}`);
  } finally {
    await fs.writeFile(path.join(outputRoot, 'drawer-bleed-trace.json'), JSON.stringify(trace, null, 2));
    await context.close();
    child.kill();
    await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
  }
}
