// #471 (P1) — install metadata for the Web app shell, in the real-Chromium harness.
//
// The Node gate (`test/web-pwa-install-metadata.test.js`) already proves the head, the MIME
// types, the byte-level PNG sizes and the maskable safe zone. This module proves the parts
// only a browser can answer:
//
//   * Chromium really fetches and *parses* the manifest under the page's own CSP
//     (`Page.getAppManifest`, which is empty/errored when `manifest-src` forbids it);
//   * the declared icons are decoded by the engine at the declared pixel size and are not
//     blocked by `img-src 'self'`;
//   * the maskable icon, decoded by the engine, fills its canvas and keeps every ink pixel
//     inside the maskable safe circle;
//   * `black-translucent` is not a claim on its own: the chain meta -> `viewport-fit=cover`
//     -> `env(safe-area-inset-top)` -> `--app-inset-top` -> the single topbar owner is
//     measured with an injected non-zero inset (the same published channel #371 exposes),
//     so the standalone status bar cannot eat the top chrome band.
//
// It runs in its own 390x844 mobile context with the harness cookies and never touches the
// shared page. Registered last in `web-regression.mjs`. Observations land in
// `<outputRoot>/pwa-install-trace.json`.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const INJECTED_INSET = '24px';
const SAFE_RADIUS_RATIO = 0.4;

export async function registerPwaInstallChecks(ctx) {
  const { check, sleep, page: sharedPage, browser, base, outputRoot } = ctx;

  const trace = { startedAt: Date.now(), base, viewport: MOBILE_VIEWPORT, checks: [] };
  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  const page = await context.newPage();
  const pageErrors = [];
  page.setDefaultTimeout(7000);
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));

  const record = async (tag, state) => {
    trace.checks.push({ check: tag, at: Date.now(), state });
    return state;
  };

  try {
    await context.addCookies(await sharedPage.context().cookies());
    const response = await page.goto(`${base}/app`);
    assert.equal(response.status(), 200, 'the app shell must load for an authenticated session');
    await page.waitForSelector('.topbar', { state: 'visible' });

    // ---- 1. head metadata ------------------------------------------------------------
    await check('pwa: the app shell head carries the install metadata and one theme-color writer', async () => {
      const state = await page.evaluate(() => ({
        manifestHref: document.querySelector('link[rel="manifest"]')?.href ?? null,
        manifestCount: document.querySelectorAll('link[rel="manifest"]').length,
        appleHref: document.querySelector('link[rel="apple-touch-icon"]')?.href ?? null,
        appleSizes: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('sizes') ?? null,
        appleTitle: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.content ?? null,
        appleCapable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content ?? null,
        appleStatusBar: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content ?? null,
        themeColorCount: document.querySelectorAll('meta[name="theme-color"]').length,
        viewport: document.querySelector('meta[name="viewport"]')?.content ?? null,
        url: location.pathname,
      }));
      await record('head', state);
      assert.equal(state.manifestCount, 1, 'exactly one manifest link');
      assert.match(state.manifestHref, /\/app\/assets\/manifest\.webmanifest\?v=[0-9a-f]{16}$/, `manifest link must be content-addressed (${state.manifestHref})`);
      assert.match(state.appleHref, /\/app\/assets\/apple-touch-icon-180\.png\?v=[0-9a-f]{16}$/, `apple-touch-icon must be content-addressed (${state.appleHref})`);
      assert.equal(state.appleSizes, '180x180');
      assert.equal(state.appleCapable, 'yes');
      assert.equal(state.appleStatusBar, 'black-translucent');
      assert.equal(state.appleTitle, 'Obsidian Web');
      // #471 R5: reuse the existing writer, never add a competing one.
      assert.equal(state.themeColorCount, 1, 'exactly one theme-color meta');
      assert.match(state.viewport, /viewport-fit=cover/, 'the shell keeps the #369 full-canvas viewport');
    });

    // ---- 2. Chromium parses the manifest under the page CSP --------------------------
    await check('pwa: Chromium fetches and parses the manifest under the page CSP', async () => {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Page.enable');
      const manifest = await cdp.send('Page.getAppManifest');
      // Chromium returns the raw manifest text in `data`; `parsed` only carries the subset the
      // renderer's WebAppManifest parser publishes (in this build: the resolved `scope`).
      const parsed = manifest.data ? JSON.parse(manifest.data) : manifest.parsed;
      // Spec scope matching is a prefix test on the resolved URLs. `start_url`/`id` must be
      // inside it (otherwise the browser falls back to the document URL); the slash-less
      // `/app` is recorded as *outside* the scope because the repo still navigates there
      // (`features/vault/controller.js` `location.replace("/app")` and the login `next`
      // default) — a P1-vs-existing-navigation boundary the HANDOFF reports for a ruling
      // instead of silently widening the scope. Recorded, not asserted.
      const resolvedScope = manifest.parsed?.scope ?? null;
      const origin = await page.evaluate(() => location.origin);
      const inScope = (absolute) => (resolvedScope ? absolute.startsWith(resolvedScope) : null);
      const scopeChecks = {
        resolvedScope,
        startUrl: inScope(new URL(parsed.start_url, origin).href),
        id: inScope(new URL(parsed.id, origin).href),
        slashlessApp: inScope(`${origin}/app`),
        notePath: inScope(`${origin}/app/note/x`),
      };
      await record('manifest', { url: manifest.url, errors: manifest.errors, rendererParsed: manifest.parsed, parsed, scopeChecks });
      assert.equal(manifest.url, await page.evaluate(() => document.querySelector('link[rel="manifest"]').href), 'Chromium must read the linked manifest');
      assert.deepEqual(manifest.errors, [], `the browser must report no manifest error (${JSON.stringify(manifest.errors)})`);
      assert.ok(parsed, 'Chromium must return parsed manifest data');
      assert.equal(parsed.name, 'Obsidian Web');
      assert.equal(parsed.short_name, 'Obsidian Web');
      assert.equal(parsed.lang, 'zh-CN');
      assert.equal(parsed.display, 'standalone');
      assert.equal(parsed.id, '/app/');
      assert.equal(parsed.start_url, '/app/');
      assert.equal(parsed.scope, '/app/');
      assert.ok((parsed.icons ?? []).length >= 3, 'the parsed manifest keeps its icon list');
      assert.equal(scopeChecks.startUrl, true, `start_url must be inside the resolved scope (${JSON.stringify(scopeChecks)})`);
      assert.equal(scopeChecks.id, true, `id must be inside the resolved scope (${JSON.stringify(scopeChecks)})`);
      assert.equal(scopeChecks.notePath, true, 'note paths stay inside the scope');
      await cdp.detach();
    });

    // ---- 3. the engine decodes every declared icon at its declared size --------------
    await check('pwa: the engine decodes every declared icon at the declared pixel size under img-src self', async () => {
      const state = await page.evaluate(async () => {
        const manifest = await (await fetch(document.querySelector('link[rel="manifest"]').href)).json();
        const apple = document.querySelector('link[rel="apple-touch-icon"]').href;
        const entries = [...manifest.icons.map((icon) => ({ src: icon.src, declared: icon.sizes, purpose: icon.purpose })), { src: apple, declared: '180x180', purpose: 'apple-touch-icon' }];
        const results = [];
        for (const entry of entries) {
          const url = new URL(entry.src, location.origin).href;
          const response = await fetch(url);
          const image = new Image();
          image.src = url;
          await image.decode();
          results.push({
            src: entry.src,
            purpose: entry.purpose,
            declared: entry.declared,
            status: response.status,
            contentType: response.headers.get('content-type'),
            cacheControl: response.headers.get('cache-control'),
            natural: `${image.naturalWidth}x${image.naturalHeight}`,
          });
        }
        return results;
      });
      await record('icons', state);
      assert.equal(state.length, 4, 'two any-icons, one maskable icon and the Apple icon');
      for (const icon of state) {
        assert.equal(icon.status, 200, `${icon.src} must be served`);
        assert.equal(icon.contentType, 'image/png', `${icon.src} must be image/png (got ${icon.contentType})`);
        assert.match(String(icon.cacheControl), /immutable/, `${icon.src} must keep the immutable asset policy`);
        assert.equal(icon.natural, icon.declared, `${icon.src} must decode at its declared size`);
      }
      const maskable = state.filter((icon) => icon.purpose === 'maskable');
      assert.equal(maskable.length, 1, 'exactly one maskable icon is declared');
      assert.equal(maskable[0].natural, '512x512');
    });

    // ---- 4. maskable safe zone, decoded by the engine --------------------------------
    await check('pwa: the maskable icon fills its canvas and keeps its art inside the safe circle', async () => {
      const state = await page.evaluate(async ({ ratio }) => {
        const manifest = await (await fetch(document.querySelector('link[rel="manifest"]').href)).json();
        const src = manifest.icons.find((icon) => icon.purpose === 'maskable').src;
        const bitmap = await createImageBitmap(await (await fetch(new URL(src, location.origin).href)).blob());
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
        const size = bitmap.width;
        const box = { minX: size, minY: size, maxX: -1, maxY: -1, pixels: 0, maxRadius: 0, transparent: 0 };
        for (let y = 0; y < size; y += 1) {
          for (let x = 0; x < size; x += 1) {
            const index = (y * size + x) * 4;
            if (data[index + 3] <= 8) { box.transparent += 1; continue; }
            if (data[index] > 247 && data[index + 1] > 247 && data[index + 2] > 247) continue;
            box.pixels += 1;
            box.minX = Math.min(box.minX, x);
            box.maxX = Math.max(box.maxX, x);
            box.minY = Math.min(box.minY, y);
            box.maxY = Math.max(box.maxY, y);
            box.maxRadius = Math.max(box.maxRadius, Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2));
          }
        }
        const corner = (x, y) => data[(y * size + x) * 4 + 3];
        return {
          src,
          size,
          box,
          safeRadius: ratio * size,
          corners: [corner(0, 0), corner(size - 1, 0), corner(0, size - 1), corner(size - 1, size - 1)],
          edges: [corner(size >> 1, 0), corner(0, size >> 1)],
        };
      }, { ratio: SAFE_RADIUS_RATIO });
      await record('maskable', state);
      assert.equal(state.size, 512);
      assert.equal(state.box.transparent, 0, 'a maskable icon must paint the whole canvas');
      assert.deepEqual(state.corners, [255, 255, 255, 255], `the maskable canvas must be opaque at the corners (${JSON.stringify(state.corners)})`);
      assert.ok(state.box.pixels > 0, 'the maskable icon must contain artwork');
      assert.ok(
        state.box.maxRadius <= state.safeRadius,
        `every ink pixel must stay inside the safe circle: maxRadius=${state.box.maxRadius.toFixed(2)} > ${state.safeRadius}`,
      );
      assert.ok(state.box.maxRadius > state.safeRadius * 0.9, `the art must use the safe zone it was scaled for (maxRadius=${state.box.maxRadius.toFixed(2)})`);
    });

    // ---- 5. black-translucent is backed by a consumed, single-owner inset ------------
    await check('pwa: black-translucent is backed by a single top-inset owner that reacts to a non-zero inset', async () => {
      const snapshot = () => page.evaluate(() => {
        const shell = document.querySelector('.shell');
        const visible = (el) => Boolean(el) && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
        const padTop = (el) => (el ? Number.parseFloat(getComputedStyle(el).paddingTop) || 0 : 0);
        const topbar = document.querySelector('.topbar');
        const row = document.querySelector('.document-tab-row');
        return {
          declared: getComputedStyle(shell).getPropertyValue('--app-inset-top').trim(),
          topbarHeight: topbar ? topbar.getBoundingClientRect().height : 0,
          topbarPad: padTop(topbar),
          rowPad: padTop(row),
          owners: [['topbar', topbar], ['document-tab-row', row]].filter(([, el]) => visible(el) && padTop(el) > 0).map(([name]) => name),
        };
      });
      // The declaration itself: the published channel must be the real `env()` value, which is
      // what makes `viewport-fit=cover` (meta) and `black-translucent` (meta) safe together.
      const css = await page.evaluate(async () => (await fetch(document.querySelector('link[rel="stylesheet"][href*="app.css"]').href)).text());
      assert.match(css, /--app-inset-top:\s*env\(safe-area-inset-top, 0px\)/, 'app.css must derive the inset from env(safe-area-inset-top)');

      const natural = await snapshot();
      await page.evaluate((inset) => document.querySelector('.shell').style.setProperty('--app-inset-top', inset), INJECTED_INSET);
      await sleep(50);
      const injected = await snapshot();
      await page.evaluate(() => document.querySelector('.shell').style.removeProperty('--app-inset-top'));
      await record('inset', { natural, injected });
      assert.equal(natural.declared, '0px', `a headless viewport has no notch, so the natural inset is 0 (got ${natural.declared})`);
      assert.equal(injected.declared, INJECTED_INSET, 'the probe really overrides the published inset channel');
      assert.deepEqual(injected.owners, ['topbar'], `exactly the topmost band owns the inset (${JSON.stringify(injected.owners)})`);
      assert.equal(injected.topbarPad, 24, 'the topbar consumes the inset exactly once');
      assert.ok(
        Math.abs(injected.topbarHeight - natural.topbarHeight - 24) <= 1,
        `the topbar band grows by exactly the inset (${natural.topbarHeight} -> ${injected.topbarHeight})`,
      );
      assert.equal(injected.rowPad, 0, 'the tab row never adds the same inset again');
      assert.deepEqual(pageErrors, [], `no uncaught page error: ${pageErrors.join('; ')}`);
    });
  } finally {
    await context.close();
    await fs.mkdir(outputRoot, { recursive: true });
    await fs.writeFile(path.join(outputRoot, 'pwa-install-trace.json'), `${JSON.stringify(trace, null, 2)}\n`);
  }
}
