// Standalone entry for the Admin plane browser gate (issues #401-#406, prototype parity redo).
//
// The full web-regression suite (`scripts/web-regression.mjs`, spawned by
// `scripts/run-browser-ci.mjs`) also registers this scene, but that suite builds and serves the Web
// fixture Vault and takes minutes. The Admin plane needs neither the Web build nor any credential:
// this runner launches Chromium, gives the scene its own scratch root, and runs only the
// `admin-layout` checks (prototype-parity structure/paint/no-JS + the migrated defect criteria).
//
//   PLAYWRIGHT_MODULE=<path to playwright-core/index.mjs> node scripts/run-admin-layout-checks.mjs
//   WEB_TEST_OUTPUT=<dir>            # optional trace output directory (default: a scratch dir outside the repo)
//
// The default output goes to the OS temp directory on purpose: the trace is a run artefact, not
// repository content (`AGENTS.md`: do not commit live logs / generated evidence into the tree).
// Exit code 0 = every check passed, 1 = at least one check failed, 2 = setup failed.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { results, check, sleep } from './web-regression/recorder.mjs';
import { exportHarnessChromiumExecutable, loadPlaywrightChromium, playwrightRuntimeExecutablePath } from './web-regression/chromium-binary.mjs';

const appRoot = path.resolve(import.meta.dirname, '..');
const outputRoot = path.resolve(process.env.WEB_TEST_OUTPUT || path.join(os.tmpdir(), 'obsidian-admin-layout-evidence'));

// The Admin gate drives no gesture/fling timing, but it uses the same pinned full Chromium build as
// the Web harness so a verdict can never depend on which browser build the machine happened to
// resolve (`chromium-binary.mjs`, issue #380). Resolution is fail-closed with the fix list.
let chromiumBinary;
try {
  const chromium = await loadPlaywrightChromium();
  chromiumBinary = exportHarnessChromiumExecutable({ defaultExecutablePath: playwrightRuntimeExecutablePath(chromium) });
} catch (error) {
  console.error(`SETUP FAILED: ${error.message}`);
  process.exit(2);
}
const { registerAdminLayoutChecks } = await import('./web-regression/admin-layout.mjs');
const playwrightModule = String(process.env.PLAYWRIGHT_MODULE || '').trim();
const { chromium } = await import(playwrightModule ? pathToFileURL(playwrightModule).href : 'playwright');

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-admin-layout-'));
const serverErrors = [];
let browser;
try {
  await fs.mkdir(outputRoot, { recursive: true });
  console.log(`[admin-layout] chromium=${chromiumBinary.executablePath} source=${chromiumBinary.source}`);
  browser = await chromium.launch({ headless: true, executablePath: chromiumBinary.executablePath });
  await registerAdminLayoutChecks({ check, sleep, browser, root, appRoot, outputRoot, serverErrors });
  await fs.writeFile(path.join(outputRoot, 'admin-layout-results.json'), JSON.stringify({ results, serverErrors }, null, 2));
} catch (error) {
  console.error(`SETUP FAILED: ${error?.stack ?? error}`);
  process.exitCode = 2;
} finally {
  await browser?.close().catch(() => {});
  if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('obsidian-admin-layout-')) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
const failed = results.filter((item) => !item.pass);
console.log(`\nadmin-layout checks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0 && process.exitCode === undefined) process.exitCode = 1;
