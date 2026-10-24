// Issue #380 — assert the browser the Web regression harness launches, not just that a
// directory exists.
//
// Run in the CI `browser` job (after the pinned Playwright runtime is installed) and
// locally in the same way as the harness:
//
//   node scripts/verify-chromium-binary.mjs
//
// Environment:
//   PLAYWRIGHT_MODULE         external Playwright entry module (local runs)
//   CHROMIUM_EXECUTABLE       explicit binary override; a headless-shell path is rejected
//   PLAYWRIGHT_BROWSERS_PATH  directory scanned for `chromium-<revision>/` full builds
//   CHROMIUM_BINARY_REPORT    optional path for the JSON evidence file
//
// The resolver is the same module the harness uses (`web-regression/chromium-binary.mjs`),
// so this step fails exactly when the harness would run the wrong binary. The check is
// taken from the *running* browser: Chromium's `Browser.getVersion` reports
// `Chrome/<version>` for the full Chrome for Testing build and `HeadlessChrome/<version>`
// for `chrome-headless-shell`. A path that merely looks right therefore cannot pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  CHROMIUM_EXECUTABLE_ENV,
  exportHarnessChromiumExecutable,
  isHeadlessShellPath,
  loadPlaywrightChromium,
  playwrightRuntimeExecutablePath,
} from './web-regression/chromium-binary.mjs';

const report = {
  status: 'failed',
  resolved: null,
  environment: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    playwrightModule: process.env.PLAYWRIGHT_MODULE || null,
    browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || null,
    override: process.env[CHROMIUM_EXECUTABLE_ENV] || null,
  },
  launched: null,
  problems: [],
};

function note(message) {
  report.problems.push(message);
  console.error(`verify-chromium-binary: ${message}`);
}

function writeReport() {
  const target = String(process.env.CHROMIUM_BINARY_REPORT || '').trim();
  if (!target) return;
  try {
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    note(`could not write ${target}: ${error.message}`);
  }
}

let browser;
try {
  const chromium = await loadPlaywrightChromium();
  const resolved = exportHarnessChromiumExecutable({
    defaultExecutablePath: playwrightRuntimeExecutablePath(chromium),
  });
  report.resolved = resolved;

  console.log(`verify-chromium-binary: resolved    ${resolved.executablePath}`);
  console.log(`verify-chromium-binary: source      ${resolved.source}`);
  console.log(`verify-chromium-binary: ${CHROMIUM_EXECUTABLE_ENV} ${process.env[CHROMIUM_EXECUTABLE_ENV]}`);
  for (const candidate of resolved.candidates) {
    console.log(`verify-chromium-binary: candidate   ${candidate.exists ? 'exists ' : 'missing'} [${candidate.source}] ${candidate.path}`);
  }

  // Machine-checkable shape assertions first: the resolved path must be a real file, must
  // be the full build, and must be the value the harness exported for its own launch.
  assert.ok(fs.statSync(resolved.executablePath).isFile(), `not a file: ${resolved.executablePath}`);
  assert.ok(!isHeadlessShellPath(resolved.executablePath), `resolved path is a headless-shell build: ${resolved.executablePath}`);
  assert.equal(process.env[CHROMIUM_EXECUTABLE_ENV], resolved.executablePath);

  browser = await chromium.launch({ headless: true, executablePath: resolved.executablePath });
  const page = await browser.newPage();
  const session = await page.context().newCDPSession(page);
  const version = await session.send('Browser.getVersion');
  report.launched = {
    product: version.product,
    revision: version.revision,
    jsVersion: version.jsVersion,
    browserVersion: browser.version(),
    userAgent: version.userAgent,
  };
  console.log(`verify-chromium-binary: launched    product=${version.product} playwrightVersion=${browser.version()}`);
  console.log(`verify-chromium-binary: userAgent   ${version.userAgent}`);

  assert.ok(
    version.product.startsWith('Chrome/'),
    `the launched browser is not the full build: Browser.getVersion product=${version.product}`,
  );
  assert.equal(browser.version(), version.product.slice('Chrome/'.length), 'Playwright and Chromium disagree about the launched version');

  report.status = 'passed';
} catch (error) {
  note(error.message);
} finally {
  await browser?.close().catch(() => {});
  writeReport();
}

console.log(`verify-chromium-binary: status=${report.status}`);
if (report.status !== 'passed') process.exitCode = 1;
