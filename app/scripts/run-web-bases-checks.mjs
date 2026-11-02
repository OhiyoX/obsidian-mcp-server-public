// Standalone runner for the Web Bases browser contract (Wave A / A5).
//
// It mirrors `web-regression.mjs`'s startup: a synthetic tmp Vault fixture, a real
// `server.js` with OAuth enabled, and a real headless Chromium. It does NOT import
// or modify the shared harness (`web-regression.mjs` / `run-browser-ci.mjs`).
//
// Usage (from app/):
//   node scripts/run-web-bases-checks.mjs --phase=characterization
//   node scripts/run-web-bases-checks.mjs --phase=full
//   node scripts/run-web-bases-checks.mjs --list
//
// Playwright resolution:
//   PLAYWRIGHT_MODULE       absolute path to an external playwright entry module
//   CHROMIUM_EXECUTABLE     absolute path to a Chromium binary
//
// With no Playwright runtime the runner prints "runtime unavailable" and exits 2.
// It never installs packages and never runs `npm ci`.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createWebBasesFixtureVault } from './web-bases-fixtures.mjs';
import { createSortDriver } from './web-bases-panels.mjs';
import {
  listWebBasesScenarios,
  registerWebBasesChecks,
  registerWebBasesParityChecks,
  WEB_BASES_SECTION_ITEMS,
} from './web-bases-checks.mjs';

const appRoot = path.resolve(import.meta.dirname, '..');
const PHASES = ['characterization', 'full'];

function parseArgs(argv) {
  const options = { phase: 'characterization', phaseExplicit: false, list: false, json: false, output: '' };
  for (const arg of argv) {
    if (arg === '--list') options.list = true;
    else if (arg === '--json') options.json = true;
    else if (arg.startsWith('--phase=')) { options.phase = arg.slice('--phase='.length); options.phaseExplicit = true; }
    else if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length);
    else if (arg === '--help') options.help = true;
  }
  return options;
}

function printList(phase) {
  const scenarios = listWebBasesScenarios(phase === 'all' ? undefined : phase);
  console.log(`# Web Bases browser contract scenarios (phase=${phase})`);
  for (const scenario of scenarios) {
    console.log(`${scenario.id}\t${scenario.phase}\t§15.8.${scenario.item}\t${scenario.name}`);
  }
  const items = [...new Set(scenarios.map((scenario) => scenario.item))].sort((a, b) => a - b);
  console.log(`scenario-count: ${scenarios.length}`);
  console.log(`section-item-count: ${items.length}`);
  console.log(`section-items: ${items.join(',')}`);
  return scenarios;
}

function failRuntime(reason) {
  console.error(`web-bases-checks: runtime unavailable: ${reason}`);
  console.error('Set PLAYWRIGHT_MODULE (and CHROMIUM_EXECUTABLE if needed); this runner never installs dependencies.');
  return 2;
}

async function loadChromium() {
  const modulePath = process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : 'playwright';
  try {
    const mod = await import(modulePath);
    if (!mod?.chromium) return { error: new Error(`module ${modulePath} has no chromium export`) };
    return { chromium: mod.chromium };
  } catch (error) {
    return { error };
  }
}

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, child, sleep) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`test server exited early with code ${child.exitCode}`);
    await sleep(100);
  }
  throw new Error('test server did not become healthy');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: node scripts/run-web-bases-checks.mjs [--phase=characterization|full] [--list] [--json] [--output=DIR]');
    return 0;
  }
  if (options.list) {
    printList(options.phaseExplicit ? options.phase : 'all');
    return 0;
  }
  if (!PHASES.includes(options.phase)) {
    console.error(`web-bases-checks: unknown phase "${options.phase}" (expected ${PHASES.join('|')})`);
    return 2;
  }

  const { chromium, error } = await loadChromium();
  if (!chromium) return failRuntime(error?.message || String(error));

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-web-bases-'));
  const fixtures = await createWebBasesFixtureVault(root);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(24).toString('hex');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: appRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_PATH: path.join(root, 'data'),
      OAUTH_ENABLED: 'true',
      PUBLIC_BASE_URL: base,
      OAUTH_INITIAL_USERNAME: 'browser-test',
      OAUTH_INITIAL_PASSWORD: password,
      OAUTH_ADMIN_PASSWORD: password,
      API_KEY: '',
      GIT_ENABLED: 'false',
      GIT_AUTO_COMMIT: 'false',
      GIT_AUTO_PUSH: 'false',
      EMBEDDING_PROVIDER: 'disabled',
      EMBEDDING_EDGE_PROVIDER: 'disabled',
      EMBEDDING_EDGE_BASE_URL: '',
      EMBEDDING_EDGE_REGISTRY_URL: '',
      RETRIEVAL_AUTO_EMBED: 'false',
      WEB_FILE_WATCH_DEBOUNCE_MS: '50',
      ...fixtures.serverEnv,
    },
  });
  const serverErrors = [];
  child.stderr.on('data', (chunk) => serverErrors.push(chunk.toString()));
  child.stdout.resume();

  const results = [];
  let browser;
  let page;
  try {
    await waitForHealth(base, child, sleep);
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const pageErrors = [];
    page.on('pageerror', (pageError) => pageErrors.push(pageError.stack || pageError.message));
    // Same editor-capture hook the shared harness installs: dirty-navigation checks
    // need window.__testEditor to make the note dirty.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'createObsidianEditor', { configurable: true, set(factory) {
        Object.defineProperty(window, 'createObsidianEditor', { configurable: true, writable: true, value(...args) { const editor = factory(...args); window.__testEditor = editor; return editor; } });
      } });
    });

    let loggedIn = false;
    async function login() {
      if (loggedIn) return;
      const response = await page.request.post(`${base}/auth/login`, { form: { username: 'browser-test', password } });
      assert.equal(response.status(), 200, `login failed with ${response.status()}`);
      loggedIn = true;
    }

    async function open(notePath) {
      await login();
      const response = page.waitForResponse((candidate) => {
        if (candidate.request().method() !== 'GET' || !candidate.url().includes('/api/web/v1/note?')) return false;
        return new URL(candidate.url()).searchParams.get('path') === notePath;
      });
      await page.locator(`.note[title="${notePath}"]`).click();
      assert.equal((await response).status(), 200);
      await page.waitForFunction((wanted) => document.querySelector('#current-path')?.textContent === wanted, notePath);
      // U41: the reader/editor bundles are on demand now, so the scripted-edit checks below
      // must wait for the captured editor instance instead of a boot-time global.
      await page.waitForFunction(() => Boolean(window.__testEditor), null, { timeout: 10000 });
    }

    // Best-effort cross-Vault grant for the full phase. Uses the in-memory Admin
    // session and the documented /admin/auth/oauth/user/scopes form endpoint; the
    // characterization phase never calls this.
    async function grantVaultAccess(vaultId) {
      const loginResponse = await page.request.post(`${base}/admin/auth/login`, { form: { password } });
      assert.ok([200, 303].includes(loginResponse.status()), `admin login returned ${loginResponse.status()}`);
      const pageResponse = await page.request.get(`${base}/admin/auth?tab=accounts`);
      const html = await pageResponse.text();
      const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
      const userId = html.match(/name="id" value="([0-9a-f-]{36})"/)?.[1];
      assert.ok(csrf, 'admin CSRF token not found');
      assert.ok(userId, 'OAuth user id not found');
      const body = new URLSearchParams();
      body.append('csrf', csrf);
      body.append('id', userId);
      for (const scope of ['obsidian.read', 'obsidian.write', 'obsidian.files']) body.append('allowedScope', scope);
      for (const vault of [fixtures.vaultId, vaultId]) body.append('allowedVault', vault);
      const update = await page.request.post(`${base}/admin/auth/oauth/user/scopes`, {
        data: body.toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      assert.ok([200, 303].includes(update.status()), `grant update returned ${update.status()}`);
      loggedIn = false;
    }

    await login();
    await registerWebBasesChecks({
      check: async (name, fn) => {
        const start = Date.now();
        try {
          await fn();
          results.push({ name, pass: true, ms: Date.now() - start });
          console.log(`PASS ${name}`);
        } catch (checkError) {
          results.push({ name, pass: false, error: checkError.message, ms: Date.now() - start });
          console.log(`FAIL ${name}: ${checkError.message}`);
        }
      },
      page,
      serverUrl: base,
      phase: options.phase,
      login,
      open,
      sleep,
      fixtures,
      grantVaultAccess,
    });
    // D3 parity extension: full phase only, appended on top of the §15.8 items.
    if (options.phase === 'full') {
      await registerWebBasesParityChecks({
        check: async (name, fn) => {
          const start = Date.now();
          try {
            await fn();
            results.push({ name, pass: true, ms: Date.now() - start });
            console.log(`PASS ${name}`);
          } catch (checkError) {
            results.push({ name, pass: false, error: checkError.message, ms: Date.now() - start });
            console.log(`FAIL ${name}: ${checkError.message}`);
          }
        },
        page,
        serverUrl: base,
        phase: 'full',
        login,
        open,
        sleep,
        fixtures,
        grantVaultAccess,
        applySortViaPopover: createSortDriver(page, sleep),
      });
    }

    await sleep(50);
    if (pageErrors.length) {
      console.log(`page-errors: ${pageErrors.length}`);
      for (const message of pageErrors) console.log(`  ${message.split('\n')[0]}`);
    }

    const outputRoot = path.resolve(options.output || process.env.WEB_BASES_OUTPUT || path.join(appRoot, '.web-bases'));
    await fs.mkdir(outputRoot, { recursive: true });
    const resultsPath = path.join(outputRoot, `results-${options.phase}.json`);
    const passed = results.filter((item) => item.pass).length;
    await fs.writeFile(resultsPath, `${JSON.stringify({
      phase: options.phase,
      generatedAt: new Date().toISOString(),
      vault: fixtures.root,
      results,
      passed,
      failed: results.length - passed,
      pageErrors,
      serverErrors,
    }, null, 2)}\n`, 'utf8');
    console.log(`results: ${resultsPath}`);
    console.log(`summary: ${passed}/${results.length} passed (phase=${options.phase})`);
    return results.some((item) => !item.pass) ? 1 : 0;
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null) child.kill();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

const exitCode = await main();
process.exitCode = exitCode;
