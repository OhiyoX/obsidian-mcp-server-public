// #515 — the two human-facing deploy-time surfaces, locked in the real browser.
//
// Route decided in #523/#528: the server keeps the raw UTC ISO as the source of truth and
// only the *human* faces render Beijing time. Two faces, one implementation:
//
//   * settings footer — client-side: `frontend/…/settings/deploy-time.js` rewrites the line
//                       from the element's `data-deployed-at` at app bootstrap;
//   * Admin badge     — server-side: `src/admin/release-badge.js` renders the same
//                       `formatBeijingDeployLabel` into the CSP-locked Admin shell
//                       (`default-src 'none'`, no script of its own).
//
// `app/test/settings-deploy-time.test.js` and `app/test/admin-release-badge.test.js` pin the
// formatters, but neither can see what the browser actually shows: only a page load proves the
// bundle really runs the rewrite, that the served markup hands it the raw ISO, and that the
// Admin badge reaches the screen already labelled +08:00. This scene is that evidence — the
// gate #515 closes on instead of a manual browser login.
//
// The shared fixture server runs without a deploy manifest (the local-run face), so this scene
// writes one into the DATA_PATH the harness mounts for it and hard-loads the pages.
// `src/release-version.js` keys its manifest cache on mtime+size, so a new file is picked up
// without a restart; the manifest is removed again in `finally`. The scene runs in its own
// browser context, so the shared page is never touched. It deliberately reads everything it
// needs from `ctx` (no `env.mjs` import): that keeps `test/web-deploy-time-browser-contract.test.js`
// able to drive it with a stub recorder, without booting the fixture server.
//
// What the fixed instant proves where: `2026-09-25 04:40:00Z` -> `北京时间 · 2026-09-25
// 12:40:00 +08:00` is asserted verbatim, so the label, the explicit `+08:00` and the wall
// clock are locked on *any* host. The 8-hour shift away from the *process* clock is only
// observable where the process is not already at +08:00 (CI and production run UTC); on a
// +08:00 dev host the two renderings coincide, which is why `admin-release-badge.test.js`
// pins the shift with `process.env.TZ = 'UTC'` as well.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Fixed fixture instant, in the raw form a deploy manifest carries (`Z`-suffixed UTC ISO). */
export const DEPLOYED_AT = '2026-09-25T04:40:00Z';
export const DEPLOY_VERSION = 'v2026.09.25.7';
export const DEPLOY_COMMIT = '0baca750747d2bd8a32dc4ef7bf50e0f09efd9e6';
/** The exact visible line both human faces must render for `DEPLOYED_AT`. */
export const BEIJING_LABEL = '北京时间 · 2026-09-25 12:40:00 +08:00';
/** The line the *server* renders for the same instant: its own process clock. */
export const SERVER_FACE_PREFIX = '服务端时间 · ';

const VIEWPORT = { width: 1440, height: 1000 };

/** The manifest `src/release-version.js` reads; the harness mounts the server's DATA_PATH here. */
export function deployTimeManifestPath(root) {
  return path.join(root, 'data', 'deployed-version.json');
}

/** `formatDeployTime`'s offset suffix (`±HH:MM`) for an instant, computed on the caller's host. */
export function processOffsetSuffix(isoString) {
  const offsetMinutes = -new Date(isoString).getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const hours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offsetMinutes) % 60).padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

export async function registerDeployTimeChecks(ctx) {
  const { check, browser, base, root, password } = ctx;
  const manifest = deployTimeManifestPath(root);
  await fs.mkdir(path.dirname(manifest), { recursive: true });
  await fs.writeFile(manifest, `${JSON.stringify({ version: DEPLOY_VERSION, commit: DEPLOY_COMMIT, deployedAt: DEPLOYED_AT }, null, 2)}\n`);

  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  try {
    // DT-1: the served markup must carry the raw ISO plus the server's own face, and the
    // browser must rewrite the *visible* line to Beijing time.
    await check('DT-1 settings footer line 2 shows Beijing time (+08:00) and keeps the raw UTC ISO', async () => {
      const login = await page.request.post(`${base}/auth/login`, { form: { username: 'browser-test', password } });
      assert.equal(login.status(), 200, `web login must succeed (got ${login.status()})`);
      const served = await page.request.get(`${base}/app`);
      assert.equal(served.status(), 200, `GET /app must succeed (got ${served.status()})`);
      const html = await served.text();
      const start = html.indexOf('class="settings-meta"');
      assert.ok(start > 0, 'the served /app must carry the settings footer');
      const footer = html.slice(start, html.indexOf('</footer>', start));
      assert.ok(footer.includes(`data-deployed-at="${DEPLOYED_AT}"`), `the served footer must hand the raw UTC ISO to the browser: ${footer}`);
      assert.ok(footer.includes(SERVER_FACE_PREFIX), `the served footer must carry the server (process clock) face: ${footer}`);
      assert.equal(footer.includes('北京时间'), false, 'the server must not pre-render the Beijing label into the settings footer; the browser owns that rewrite');

      await page.goto(`${base}/app`);
      await page.waitForFunction(() => document.querySelector('.settings-meta-deploy')?.textContent?.includes('北京时间'), null, { timeout: 10000 });
      const line = page.locator('.settings-meta-deploy');
      assert.equal(await line.textContent(), BEIJING_LABEL, 'the browser rewrite must produce the Beijing label exactly');
      assert.equal(await line.getAttribute('data-deployed-at'), DEPLOYED_AT, 'the raw UTC ISO must stay on the element for later client-side routes');
      await page.locator('#settings-open').click();
      assert.equal(await line.isVisible(), true, 'footer line 2 must be visible in the opened settings dialog');
      assert.equal(await line.textContent(), BEIJING_LABEL, 'the visible line must be the Beijing label');
    });

    // DT-2: the Admin plane's single deploy identity. #515's ruling is that the plane shows the
    // SAME Beijing label and keeps the raw UTC ISO; the greenfield shell moved that row out of a
    // shell strip and into the overview's 部署版本 key/value row (the prototype HAS that row and
    // has no shell strip), so this scene anchors on the row instead of the retired strip. The
    // assertions are the same ones, and one invariant is added: the plane carries exactly ONE
    // deploy identity.
    await check('DT-2 the Admin badge shows the same Beijing label and keeps the raw UTC ISO', async () => {
      const login = await page.request.post(`${base}/admin/auth/login`, { form: { password }, maxRedirects: 0 });
      assert.equal(login.status(), 303, `admin login must succeed (got ${login.status()})`);
      await page.goto(`${base}/admin/auth`);
      const badge = page.locator('[data-deployed-at]');
      assert.equal(await badge.count(), 1, 'the Admin badge must carry exactly one raw-ISO attribute');
      assert.equal(await badge.getAttribute('data-deployed-at'), DEPLOYED_AT, 'the Admin badge must keep the raw UTC ISO');
      const text = await badge.textContent();
      assert.ok(text.includes(BEIJING_LABEL), `the Admin badge must reuse the shared formatter verbatim, got: ${text}`);
      assert.ok(text.includes(`commit ${DEPLOY_COMMIT}`), `the badge must keep the commit identity, got: ${text}`);
      assert.equal(await badge.isVisible(), true, 'the Admin badge must be visible');
      const row = page.locator('.kv > .k', { hasText: '部署版本' }).first();
      assert.equal(await row.count(), 1, 'the deploy identity must sit in the 部署版本 row');
      const strip = await row.evaluate((node) => node.parentElement?.textContent || '');
      assert.ok(strip.includes('部署版本'), `the badge strip must name the release, got: ${strip}`);
    });

    // DT-3: the API face is the other half of the same ruling — it keeps the raw ISO and the
    // *process* clock, never Asia/Shanghai. The expected offset is computed on this host (the
    // server child inherits it), so the assertion is meaningful at any process timezone.
    await check('DT-3 /healthz stays on the raw UTC ISO and the process clock, not Asia/Shanghai', async () => {
      const response = await page.request.get(`${base}/healthz`);
      assert.equal(response.status(), 200, `GET /healthz must succeed (got ${response.status()})`);
      const health = await response.json();
      assert.equal(health.deployedAt, DEPLOYED_AT, 'the API must keep the raw UTC ISO');
      assert.equal(health.deployedAtFormatted?.iso, DEPLOYED_AT, 'deployedAtFormatted.iso must stay the raw UTC ISO');
      const local = String(health.deployedAtFormatted?.local ?? '');
      assert.match(local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/, `the API renders the process clock, got: ${local}`);
      assert.ok(local.endsWith(processOffsetSuffix(DEPLOYED_AT)), `the API must follow the process timezone, got: ${local}`);
    });
  } finally {
    await context.close();
    await fs.rm(manifest, { force: true });
  }
}
