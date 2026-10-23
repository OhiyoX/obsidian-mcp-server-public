// Standalone entry for the #434 window-presentation browser regression.
//
// The full web-regression suite (`scripts/web-regression.mjs`) registers the `admin-layout` scene,
// which will register this module once PR #443 (#435) is merged. Until then the module can be run
// on its own: it starts its own fixture Vault + data dir + server under the scratch root (with the
// server clock injected through `test/preload-frozen-clock.mjs`), so it needs neither the Web build
// nor any credential.
//
//   PLAYWRIGHT_MODULE=<path to playwright/index.mjs> node scripts/run-admin-window-checks.mjs
//   WEB_TEST_OUTPUT=<dir>   # optional trace output directory
//
// Exit code 0 = every check passed, 1 = at least one check failed, 2 = setup failed. The geometry
// readings (row count, row height, column widths, summary line count) are printed as JSON so the
// handoff can quote them verbatim.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { results, check, sleep } from './web-regression/recorder.mjs';
import { registerAdminWindowPresentationChecks } from './web-regression/admin-window-presentation.mjs';

const appRoot = path.resolve(import.meta.dirname, '..');
const outputRoot = path.resolve(process.env.WEB_TEST_OUTPUT || path.join(appRoot, '..', 'docs', 'review', 'admin-window'));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-admin-window-'));
const serverErrors = [];
let browser;
try {
  await fs.mkdir(outputRoot, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const readings = await registerAdminWindowPresentationChecks({ check, sleep, browser, root, appRoot, outputRoot, serverErrors });
  await fs.writeFile(path.join(outputRoot, 'admin-window-results.json'), JSON.stringify({ results, serverErrors, readings }, null, 2));
  console.log(`WINDOW-READINGS ${JSON.stringify(readings)}`);
} catch (error) {
  console.error(`SETUP FAILED: ${error?.stack ?? error}`);
  process.exitCode = 2;
} finally {
  await browser?.close().catch(() => {});
  if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('obsidian-admin-window-')) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
const failed = results.filter((item) => !item.pass);
console.log(`\nadmin-window checks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0 && process.exitCode === undefined) process.exitCode = 1;
