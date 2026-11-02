// CI adapter for the real-Chromium Web regression harness.
//
// `scripts/web-regression.mjs` remains the single source of truth for scenarios
// and assertions. This wrapper only adds what a CI gate needs around it:
//
//   1. fail fast with an actionable message when the Playwright runtime is missing;
//   2. run the harness against an isolated artifact directory;
//   3. mirror stdout/stderr into `browser-regression.log` and write `ci-summary.json`
//      so a red job still uploads a readable log (the harness only writes
//      `results.json` when it reaches the end of the suite);
//   4. block on a non-zero exit, any FAIL check, a missing/empty result file, or any
//      uncaught page error.
//
// Environment:
//   WEB_BROWSER_OUTPUT      artifact directory (default: app/.browser-ci)
//   WEB_BROWSER_REGRESSION  alternative harness path; tests only, also disables the
//                           built-in Playwright requirement (the caller supplies a runtime)
//   WEB_TEST_ONLY           forwarded to the harness to narrow scenarios (local use)
//   WEB_BROWSER_TIMEOUT_MS  wall-clock budget for the harness process tree in ms
//                           (default 600000, clamped to HARNESS_TIMEOUT_MAX_MS = 600000)
//   PLAYWRIGHT_MODULE       absolute path to an external Playwright entry module
//   CHROMIUM_EXECUTABLE     absolute path to a Chromium binary

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const appRoot = path.resolve(import.meta.dirname, '..');
const harnessOverride = process.env.WEB_BROWSER_REGRESSION
  ? path.resolve(process.env.WEB_BROWSER_REGRESSION)
  : '';
const harnessPath = harnessOverride || path.join(appRoot, 'scripts', 'web-regression.mjs');
const outputRoot = path.resolve(process.env.WEB_BROWSER_OUTPUT || path.join(appRoot, '.browser-ci'));
const logPath = path.join(outputRoot, 'browser-regression.log');
const resultsPath = path.join(outputRoot, 'results.json');
const summaryPath = path.join(outputRoot, 'ci-summary.json');
// The budget is a hang detector, not an assertion: it only decides when a stuck
// harness process tree is killed, and it never changes a check's own timeout. The
// suite outgrew the original 180s ceiling (issue #375: a healthy 133-check run was
// SIGTERMed at 180s with 0/0 checks).
//
// U54 raised it from 420s to the documented maximum. Evidence, both first hand:
//   * wsl-obsidian-ci completed the full 213-check suite in 339.6s (run 37907247393,
//     job 113743566556), so 420s left only ~24% headroom for a suite that keeps growing;
//   * tx-obsidian-ci was killed at 420s in all six attempts of run 37914910852 while
//     still inside the last scenario (attempt 2 had reached the final badge module), and
//     a killed harness uploads no `results.json`, so the job reported 0/0 checks.
//
// The maximum deliberately stays at 600s rather than growing with the default: the CI job
// allows 25 minutes, a `timeout-minutes` kill by GitHub produces no artifact, and two
// attempts at 600s (plus this job's setup) stay inside it. A suite that cannot finish a
// full run in 600s on a runner that carries the `browser` label must be split, not given a
// longer hang detector -- raising this ceiling without raising `timeout-minutes` in
// .github/workflows/ci.yml would trade a legible failure for a truncated one.
const DEFAULT_HARNESS_TIMEOUT_MS = 600_000;
const HARNESS_TIMEOUT_MAX_MS = 600_000;
const requestedHarnessTimeoutMs = Number.parseInt(process.env.WEB_BROWSER_TIMEOUT_MS || '', 10);
const harnessTimeoutClamped =
  Number.isFinite(requestedHarnessTimeoutMs) && requestedHarnessTimeoutMs > HARNESS_TIMEOUT_MAX_MS;
// Applies with or without a harness override, and may raise the default; only the
// documented maximum clamps it.
const harnessTimeoutMs = Number.isFinite(requestedHarnessTimeoutMs)
  ? Math.max(50, Math.min(requestedHarnessTimeoutMs, HARNESS_TIMEOUT_MAX_MS))
  : DEFAULT_HARNESS_TIMEOUT_MS;

const summary = {
  status: 'failed',
  problems: [],
  harness: path.relative(appRoot, harnessPath) || harnessPath,
  exitCode: null,
  signal: null,
  durationMs: 0,
  checks: { total: 0, passed: 0, failed: 0, failedNames: [] },
  pageErrors: [],
  serverErrors: [],
  environment: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    playwrightModule: process.env.PLAYWRIGHT_MODULE || null,
    playwrightVersion: null,
    chromiumExecutable: process.env.CHROMIUM_EXECUTABLE || null,
    webTestOnly: process.env.WEB_TEST_ONLY || null,
    harnessTimeoutMs,
    outputRoot,
  },
  artifacts: { log: logPath, results: resultsPath, summary: summaryPath },
};

await fs.mkdir(outputRoot, { recursive: true });
await fs.rm(resultsPath, { force: true });
const log = createWriteStream(logPath);
const writeLog = (chunk) => log.write(chunk);
const stamp = () => new Date().toISOString();
writeLog(`[run-browser-ci] ${stamp()}\n`);
writeLog(`[run-browser-ci] node=${process.version} platform=${process.platform} ${process.arch}\n`);
writeLog(`[run-browser-ci] harness=${harnessPath}\n`);
writeLog(`[run-browser-ci] output=${outputRoot}\n`);
writeLog(`[run-browser-ci] playwright=${process.env.PLAYWRIGHT_MODULE || '(package resolution)'}\n`);
writeLog(`[run-browser-ci] chromium=${process.env.CHROMIUM_EXECUTABLE || '(playwright default)'}\n`);
writeLog(`[run-browser-ci] harnessTimeoutMs=${harnessTimeoutMs}\n`);
if (harnessTimeoutClamped) {
  const notice = `[run-browser-ci] WEB_BROWSER_TIMEOUT_MS=${requestedHarnessTimeoutMs} exceeds the ${HARNESS_TIMEOUT_MAX_MS}ms maximum; clamped to ${harnessTimeoutMs}ms`;
  writeLog(`${notice}\n`);
  console.warn(notice);
}
if (process.env.WEB_TEST_ONLY) writeLog(`[run-browser-ci] WEB_TEST_ONLY=${process.env.WEB_TEST_ONLY}\n`);
writeLog('[run-browser-ci] ---- harness output ----\n');

function fail(message) {
  summary.problems.push(message);
}

const inCi = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true';
if (inCi && process.env.WEB_TEST_ONLY) {
  fail('WEB_TEST_ONLY filtering is disabled in CI; the gate requires the full browser suite');
}
if (inCi && process.env.WEB_BROWSER_REGRESSION) {
  fail('WEB_BROWSER_REGRESSION harness override is disabled in CI; the gate requires the repository browser harness');
}
if (inCi && process.env.PLAYWRIGHT_MODULE) {
  fail('PLAYWRIGHT_MODULE override is disabled in CI; the gate requires the pinned Playwright package');
}
if (inCi && process.env.CHROMIUM_EXECUTABLE) {
  fail('CHROMIUM_EXECUTABLE override is disabled in CI; the gate requires the pinned Playwright Chromium build');
}

// Resolve the Playwright runtime up front so a missing dependency reports as one clear
// line instead of an unresolved-module stack trace inside the harness.
function resolvePlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) {
    if (existsSync(process.env.PLAYWRIGHT_MODULE)) return process.env.PLAYWRIGHT_MODULE;
    fail(`PLAYWRIGHT_MODULE does not exist: ${process.env.PLAYWRIGHT_MODULE}`);
    return null;
  }
  try {
    return createRequire(path.join(appRoot, 'package.json')).resolve('playwright');
  } catch {
    if (harnessOverride) return null;
    fail('Playwright is not installed. Run `npm install --no-save playwright@<pinned-version>` in app/ and `npx playwright install --with-deps chromium`.');
    return null;
  }
}

// Never mutate the caller's environment beyond the artifact wiring the harness documents.
const childEnv = { ...process.env, WEB_TEST_OUTPUT: outputRoot };

const playwrightModule = resolvePlaywright();
if (playwrightModule) {
  summary.environment.playwrightModule = playwrightModule;
  try {
    summary.environment.playwrightVersion = createRequire(path.join(appRoot, 'package.json'))('playwright/package.json').version;
  } catch {
    // External PLAYWRIGHT_MODULE entries may not expose package metadata.
  }
}
writeLog(`[run-browser-ci] playwright resolved=${playwrightModule || '(missing)'} version=${summary.environment.playwrightVersion || 'unknown'}\n`);
if (inCi && !harnessOverride) {
  const expectedPlaywrightVersion = String(process.env.PLAYWRIGHT_VERSION || '').trim();
  if (!expectedPlaywrightVersion) {
    fail('PLAYWRIGHT_VERSION must be set in CI to pin the browser test runtime');
  } else if (summary.environment.playwrightVersion !== expectedPlaywrightVersion) {
    fail(`Playwright version mismatch: expected ${expectedPlaywrightVersion}, resolved ${summary.environment.playwrightVersion || 'unknown'}`);
  }
}
if (process.env.CHROMIUM_EXECUTABLE && !existsSync(process.env.CHROMIUM_EXECUTABLE)) {
  fail(`CHROMIUM_EXECUTABLE does not exist: ${process.env.CHROMIUM_EXECUTABLE}`);
}

async function runHarness() {
  const startedAt = Date.now();
  try {
    const { code, signal, timedOut } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [harnessPath], {
        cwd: appRoot,
        env: childEnv,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let timedOut = false;
      let forceKill = null;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        forceKill = setTimeout(() => child.kill('SIGKILL'), 1_000);
        forceKill.unref?.();
      }, harnessTimeoutMs);
      timeout.unref?.();
      child.stdout.on('data', (chunk) => { writeLog(chunk); process.stdout.write(chunk); });
      child.stderr.on('data', (chunk) => { writeLog(chunk); process.stderr.write(chunk); });
      child.once('error', (error) => {
        clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        resolve({ code, signal, timedOut });
      });
    });
    summary.exitCode = code;
    summary.signal = signal;
    if (timedOut) fail(`harness timed out after ${harnessTimeoutMs}ms`);
    if (signal) fail(`harness terminated by signal ${signal}`);
    if (code !== 0) fail(`harness exited with code ${code}`);
  } catch (error) {
    fail(`could not start harness: ${error.message}`);
  } finally {
    summary.durationMs = Date.now() - startedAt;
  }
}

async function readResults() {
  const raw = await fs.readFile(resultsPath, 'utf8').catch(() => null);
  if (raw === null) {
    fail(`missing ${path.relative(appRoot, resultsPath)}; the harness did not reach the end of the suite`);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`unreadable ${path.relative(appRoot, resultsPath)}: ${error.message}`);
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('results.json root must be an object');
    return;
  }
  if (!Array.isArray(parsed.results)) {
    fail('results.json results must be an array');
    return;
  }

  const checks = parsed.results;
  const failedNames = [];
  const validNames = [];
  let passed = 0;
  for (let index = 0; index < checks.length; index += 1) {
    const check = checks[index];
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      failedNames.push(`#${index + 1} malformed`);
      continue;
    }
    const name = typeof check.name === 'string' ? check.name.trim() : '';
    if (!name || typeof check.pass !== 'boolean') {
      failedNames.push(name || `#${index + 1} malformed`);
      continue;
    }
    validNames.push(name);
    const explicitlySkipped =
      check.skip === true ||
      check.skipped === true ||
      check.todo === true ||
      String(check.status || '').toLowerCase() === 'skipped';
    if (explicitlySkipped || check.pass !== true) failedNames.push(name);
    else passed += 1;
  }

  summary.checks = { total: checks.length, passed, failed: checks.length - passed, failedNames };
  if (!Array.isArray(parsed.errors)) fail('results.json errors must be an array');
  if (!Array.isArray(parsed.serverErrors)) fail('results.json serverErrors must be an array');
  summary.pageErrors = Array.isArray(parsed.errors) ? parsed.errors : [];
  summary.serverErrors = Array.isArray(parsed.serverErrors) ? parsed.serverErrors : [];
  if (checks.length === 0) fail('harness reported zero checks');
  const duplicateNames = [...new Set(validNames.filter((name, index) => validNames.indexOf(name) !== index))];
  if (duplicateNames.length > 0) fail(`duplicate check name(s): ${duplicateNames.join('; ')}`);
  if (failedNames.length > 0) fail(`${failedNames.length} FAIL: ${failedNames.join('; ')}`);
  if (summary.serverErrors.length > 0) {
    fail(`${summary.serverErrors.length} server error(s): ${String(summary.serverErrors[0]).split('\n')[0]}`);
  }
  // The harness asserts page errors once, mid-suite; re-check the recorded list so an
  // error raised by a later scenario also blocks the job.
  if (summary.pageErrors.length > 0) fail(`${summary.pageErrors.length} uncaught page error(s): ${String(summary.pageErrors[0]).split('\n')[0]}`);
}

if (summary.problems.length === 0) {
  await runHarness();
  await readResults();
} else {
  fail('harness was not started because the runtime check above failed');
}

summary.status = summary.problems.length === 0 ? 'passed' : 'failed';
writeLog(`[run-browser-ci] status=${summary.status} checks=${summary.checks.passed}/${summary.checks.total} duration=${summary.durationMs}ms\n`);
writeLog(`[run-browser-ci] ---- end ${stamp()} ----\n`);
await new Promise((resolve) => log.end(resolve));
await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

console.log('');
console.log('Chromium web regression summary');
console.log(`  status   : ${summary.status}`);
console.log(`  checks   : ${summary.checks.passed} passed / ${summary.checks.failed} failed / ${summary.checks.total} total`);
console.log(`  duration : ${(summary.durationMs / 1000).toFixed(1)}s`);
console.log(`  log      : ${logPath}`);
console.log(`  results  : ${resultsPath}`);
console.log(`  summary  : ${summaryPath}`);
if (summary.problems.length > 0) {
  console.log('  problems :');
  for (const problem of summary.problems) console.log(`    - ${problem}`);
}
process.exitCode = summary.status === 'passed' ? 0 : 1;
