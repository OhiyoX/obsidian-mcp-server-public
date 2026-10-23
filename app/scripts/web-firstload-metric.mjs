// Web first-load metric — RECORD ONLY, no threshold (issue #414).
//
// This script answers "how long and how many bytes does the app shell need on a
// real cold load?" with a real Chromium against the real server. It deliberately
// has NO wall-clock gate: contract §6.6 / §14.8 (see the header of
// `test/bases-perf-baseline.test.js`) allows a hard millisecond budget only when
// it comes from repeated stable measurements on one runner, and a browser
// cold-load number on a shared NAS is not that. The deterministic hard gate lives
// in `test/web-firstload-budget.test.js` (headers + bytes).
//
// Output: JSON at `--out <path>`, else $WEB_FIRSTLOAD_OUT, else
// `<worktree>/verify/web-firstload-metric.json` (the lane directory above app/).
//
// Run (same runtime contract as the browser suite):
//   cd app && PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
//     node scripts/web-firstload-metric.mjs --out ../verify/web-firstload-metric.json
//
// The fixture vault, isolated server and Playwright module resolution are the
// shared `scripts/web-regression/` harness, so this records against the same
// environment the regression suite uses.

import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { environment, cleanupEnvironment } from './web-regression/env.mjs';

const { base, password: loginPassword, chromium, appRoot } = environment;
const argIndex = process.argv.indexOf('--out');
const outPath = path.resolve(
  argIndex >= 0 && process.argv[argIndex + 1]
    ? process.argv[argIndex + 1]
    : process.env.WEB_FIRSTLOAD_OUT || path.join(appRoot, '..', 'verify', 'web-firstload-metric.json'),
);

const USERNAME = 'browser-test'; // OAUTH_INITIAL_USERNAME in web-regression/env.mjs
const ASSET_PREFIX = '/app/assets/';

const round = (value) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : null);

let browser = null;
try {
  // env.mjs spawns the server on import but does not wait for readiness (same as
  // the regression harness, which polls /healthz before opening Chromium).
  let ready = false;
  for (let attempt = 0; attempt < 150 && !ready; attempt += 1) {
    try { ready = (await fetch(`${base}/healthz`)).ok; } catch {}
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`server not ready at ${base}/healthz`);

  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  // A fresh context = an empty HTTP cache and no warm connections.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    // Time-to-first-list: the Explorer's first rendered note row. Recorded from
    // the first mutation that makes `.note` exist, so it does not depend on how
    // long the harness itself waits afterwards.
    window.__firstLoadProbe = { firstListMs: null };
    const observer = new MutationObserver(() => {
      if (window.__firstLoadProbe.firstListMs !== null) return;
      if (document.querySelector('.note')) {
        window.__firstLoadProbe.firstListMs = performance.now();
        observer.disconnect();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  const login = await context.request.post(`${base}/auth/login`, { form: { username: USERNAME, password: loginPassword } });
  if (!login.ok()) throw new Error(`login failed: ${login.status()}`);

  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');

  async function measure({ clearCache, navigate }) {
    const responses = new Map();
    const sizes = new Map();
    // Playwright's CDPSession emits the raw params object as the listener argument
    // (`this.emit(event.method, event.params)` in playwright-core), not a wrapper with a
    // `.params` field. Reading `event.params.*` made every CDP callback throw on the first
    // response (`Cannot read properties of undefined`), so no metric was ever written.
    const onResponse = ({ requestId, response }) => {
      if (!response) return;
      responses.set(requestId, {
        url: response.url,
        contentEncoding: response.headers['content-encoding'] || response.headers['Content-Encoding'] || null,
      });
    };
    const onFinished = ({ requestId, encodedDataLength }) => sizes.set(requestId, encodedDataLength);
    cdp.on('Network.responseReceived', onResponse);
    cdp.on('Network.loadingFinished', onFinished);
    if (clearCache) await cdp.send('Network.clearBrowserCache');
    const startedAt = performance.now();
    await navigate();
    const wallMs = performance.now() - startedAt;
    cdp.off('Network.responseReceived', onResponse);
    cdp.off('Network.loadingFinished', onFinished);
    // The list paint is by definition later than the `load` event: the Explorer rows arrive
    // after `vaultController.load()` + `loadNotes()`. Reading the probe here (as the first
    // version did) always recorded `firstListMs: null`. The wait only delays the *read*; the
    // recorded value is still `performance.now()` at the first `.note` mutation, so the
    // number stays independent of how long this harness waits. Bytes stay scoped to the
    // navigate-to-load window above.
    await page.waitForFunction(() => window.__firstLoadProbe?.firstListMs != null, null, { timeout: 15000 }).catch(() => {});

    const navigation = await page.evaluate(() => {
      const entry = performance.getEntriesByType('navigation')[0];
      return entry ? {
        ttfbMs: entry.responseStart,
        domContentLoadedMs: entry.domContentLoadedEventEnd,
        loadMs: entry.loadEventEnd,
        firstListMs: window.__firstLoadProbe?.firstListMs ?? null,
      } : null;
    });
    const assets = [];
    let assetBytes = 0;
    for (const [requestId, meta] of responses) {
      if (!meta.url.includes(ASSET_PREFIX)) continue;
      const encoded = sizes.get(requestId) ?? 0;
      assetBytes += encoded;
      assets.push({
        url: meta.url.replace(base, ''),
        contentEncoding: meta.contentEncoding,
        encodedBytes: encoded,
      });
    }
    assets.sort((a, b) => b.encodedBytes - a.encodedBytes);
    let totalBytes = 0;
    for (const encoded of sizes.values()) totalBytes += encoded;
    return { wallMs: round(wallMs), ...navigation, totalEncodedBytes: totalBytes, assetEncodedBytes: assetBytes, requestCount: sizes.size, assets };
  }

  const cold = await measure({ clearCache: true, navigate: () => page.goto(`${base}/app`, { waitUntil: 'load' }) });
  const warm = await measure({ clearCache: false, navigate: () => page.reload({ waitUntil: 'load' }) });

  const report = {
    generatedAt: new Date().toISOString(),
    note: 'RECORD ONLY — no wall-clock threshold is asserted anywhere. The deterministic gate is app/test/web-firstload-budget.test.js.',
    base,
    node: process.version,
    browserVersion: browser.version(),
    coldLoad: cold,
    warmReload: warm,
  };
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`WEB_FIRSTLOAD_METRIC ${JSON.stringify({ out: outPath, coldLoadMs: cold.loadMs, coldFirstListMs: cold.firstListMs, coldAssetBytes: cold.assetEncodedBytes, warmAssetBytes: warm.assetEncodedBytes })}`);
} finally {
  await browser?.close();
  await cleanupEnvironment();
}
