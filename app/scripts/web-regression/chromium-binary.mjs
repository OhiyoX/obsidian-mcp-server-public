// Issue #380 — pin the Chromium binary the Web regression harness actually launches.
//
// Playwright >= 1.49 launches the `chromium_headless_shell-<revision>` build for
// `chromium.launch({ headless: true })` when no `executablePath` is given. The headless
// shell has a different gesture/compositor pipeline: after a pan its fling stop can keep
// swallowing the first synthesized tap well past the 3 s budget the Bases table-touch
// check allows, so the *same tree* produced `clicks: []` (deterministic FAIL) or PASS
// depending on which binary the machine/CI happened to pick. Every verdict produced by
// the suite was therefore machine-dependent, including merge decisions.
//
// This module is the single resolution point. Both the harness (`web-regression/env.mjs`)
// and the CI assertion (`scripts/verify-chromium-binary.mjs`) call
// `exportHarnessChromiumExecutable()`, so the binary CI asserts is exactly the binary the
// harness launches.
//
// Resolution order (first usable candidate wins; a candidate is usable only when it is a
// real file and is not a headless-shell build):
//
//   1. `CHROMIUM_EXECUTABLE` — explicit operator override. A headless-shell path is
//      rejected outright: that build is the root cause of #380, not a valid choice.
//   2. The resolved Playwright runtime's own `chromium.executablePath()` — the installed
//      `chromium` registry entry, which is the full Chrome for Testing build (never the
//      `chromium-headless-shell` entry) at exactly the revision the pinned Playwright
//      version speaks to, and which itself honors `PLAYWRIGHT_BROWSERS_PATH`. Preferring
//      the revision-correct build keeps this change from introducing a *new* source of
//      nondeterminism.
//   3. `PLAYWRIGHT_BROWSERS_PATH` — scan for `chromium-<revision>/` directories (the
//      pattern cannot match `chromium_headless_shell-<revision>/`), newest revision first,
//      then the platform layout inside it (`EXECUTABLE_LAYOUTS` below). This is the
//      fallback for a browsers path whose wanted revision is not the one the resolved
//      runtime reports; it is what makes a shell-only browsers path fail closed.
//
// If none of the three yields a file the harness exits fail-closed with the candidates it
// tried and the exact commands that fix it. It never silently falls back to the shell
// build — that silent fallback is the bug, so the harness must fail loudly instead.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const CHROMIUM_EXECUTABLE_ENV = 'CHROMIUM_EXECUTABLE';
export const BROWSERS_PATH_ENV = 'PLAYWRIGHT_BROWSERS_PATH';

// Only the full browser directory matches; `chromium_headless_shell-1234` does not.
const FULL_BUILD_DIR = /^chromium-(\d+)$/;
const HEADLESS_SHELL = /headless[-_]shell/i;

// Executable layout inside a browser directory, mirroring playwright-core 1.63
// `EXECUTABLE_PATHS.chromium` (the first entry per platform is the current layout, the
// lowercase variants are the older `chrome-linux`/`chrome-mac`/`chrome-win` layouts).
const MACOS_APP = ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'];
const EXECUTABLE_LAYOUTS = {
  'win32-x64': [['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe']],
  'win32-arm64': [['chrome-win64', 'chrome.exe']],
  'linux-x64': [['chrome-linux64', 'chrome'], ['chrome-linux', 'chrome']],
  'linux-arm64': [['chrome-linux-arm64', 'chrome'], ['chrome-linux', 'chrome']],
  'darwin-x64': [['chrome-mac-x64', ...MACOS_APP], ['chrome-mac', ...MACOS_APP]],
  'darwin-arm64': [['chrome-mac-arm64', ...MACOS_APP], ['chrome-mac', ...MACOS_APP]],
};

export class ChromiumBinaryError extends Error {
  constructor(message, candidates = []) {
    super(message);
    this.name = 'ChromiumBinaryError';
    this.candidates = candidates;
  }
}

export function isHeadlessShellPath(value) {
  return HEADLESS_SHELL.test(String(value ?? ''));
}

function defaultIsFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function defaultReaddir(directory) {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

// Every full-build executable under `browsersPath`, newest revision first. Deterministic:
// numeric revision descending, then directory name, then the documented layout order.
// Paths stay relative to the caller's `browsersPath`; the resolver resolves them.
export function fullBuildCandidates({ browsersPath, platform = process.platform, arch = process.arch, readdir = defaultReaddir } = {}) {
  if (!browsersPath) return [];
  const layouts = EXECUTABLE_LAYOUTS[`${platform}-${arch}`] || EXECUTABLE_LAYOUTS[`${platform}-x64`] || [];
  const revisions = readdir(browsersPath)
    .filter((name) => FULL_BUILD_DIR.test(name))
    .sort((a, b) => Number(FULL_BUILD_DIR.exec(a)[1]) - Number(FULL_BUILD_DIR.exec(b)[1]) || a.localeCompare(b))
    .reverse();
  const candidates = [];
  for (const directory of revisions) {
    for (const layout of layouts) candidates.push(path.join(browsersPath, directory, ...layout));
  }
  return candidates;
}

// `chromium.executablePath()` from any Playwright-compatible runtime object; '' when the
// runtime cannot answer (missing browser, older module) so the caller can fail closed.
export function playwrightRuntimeExecutablePath(chromiumType) {
  try {
    if (!chromiumType || typeof chromiumType.executablePath !== 'function') return '';
    return String(chromiumType.executablePath() || '');
  } catch {
    return '';
  }
}

// The Playwright module the harness runs on: an explicit `PLAYWRIGHT_MODULE` (local
// external runtime) or the package resolved next to `app/`.
export async function loadPlaywrightChromium() {
  const modulePath = String(process.env.PLAYWRIGHT_MODULE || '').trim();
  const module = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
  return module.chromium;
}

function failureMessage({ candidates, override, browsersPath, fallback }) {
  const describe = (value) => (String(value || '').trim() ? String(value).trim() : '(not set)');
  const tried = candidates.length
    ? candidates.map((candidate) => `    - ${candidate.path} [${candidate.source}] ${candidate.exists ? 'exists' : 'missing'}`).join('\n')
    : '    - (no candidate path could be derived)';
  const line = (label, value) => `  ${label.padEnd(30)}: ${describe(value)}`;
  return [
    'No usable full Chromium build found for the Web regression harness (issue #380).',
    'Refusing to fall back to chrome-headless-shell: its gesture/fling timing makes the',
    'tap-selection checks non-deterministic, which is exactly what #380 removes.',
    '',
    line(CHROMIUM_EXECUTABLE_ENV, override),
    line(BROWSERS_PATH_ENV, browsersPath),
    line('Playwright executablePath()', fallback),
    '  candidates:',
    tried,
    '',
    'Fix one of these, then re-run:',
    '  - install the full browser build:  npx playwright install chromium',
    `  - point ${BROWSERS_PATH_ENV} at the directory containing a chromium-<revision>/ build`,
    `  - or pin the binary: ${CHROMIUM_EXECUTABLE_ENV}=<absolute path to chrome.exe|chrome>`,
  ].join('\n');
}

export function resolveChromiumExecutable({
  override = '',
  browsersPath = '',
  defaultExecutablePath = '',
  platform = process.platform,
  arch = process.arch,
  isFile = defaultIsFile,
  readdir = defaultReaddir,
} = {}) {
  const candidates = [];
  const overrideValue = String(override ?? '').trim();
  if (overrideValue) {
    const resolved = path.resolve(overrideValue);
    if (isHeadlessShellPath(overrideValue)) {
      throw new ChromiumBinaryError(
        [
          `${CHROMIUM_EXECUTABLE_ENV} points at a chrome-headless-shell build: ${overrideValue}`,
          'That build is the root cause of issue #380 (a headless-shell fling swallows the first',
          'synthesized tap), so the harness refuses to run it. Point the variable at the full',
          'Chrome for Testing build instead, e.g. <browsers path>/chromium-<revision>/chrome-win64/chrome.exe',
          'on Windows or .../chromium-<revision>/chrome-linux64/chrome on Linux.',
        ].join('\n'),
        [{ path: resolved, source: 'env-override', exists: isFile(resolved) }],
      );
    }
    if (!isFile(resolved)) {
      throw new ChromiumBinaryError(
        `${CHROMIUM_EXECUTABLE_ENV} is not an existing file: ${overrideValue}`,
        [{ path: resolved, source: 'env-override', exists: false }],
      );
    }
    return { executablePath: resolved, source: 'env-override', candidates: [{ path: resolved, source: 'env-override', exists: true }] };
  }

  const browsersDir = String(browsersPath ?? '').trim();
  const fallback = String(defaultExecutablePath ?? '').trim();
  if (fallback) {
    const usable = !isHeadlessShellPath(fallback) && isFile(fallback);
    candidates.push({ path: path.resolve(fallback), source: 'playwright-executable-path', exists: usable });
    if (usable) return { executablePath: path.resolve(fallback), source: 'playwright-executable-path', candidates };
  }

  // Playwright treats '0' as "keep browsers inside node_modules"; then the scan below has
  // no directory to enumerate and the runtime default above is the only usable source.
  if (browsersDir && browsersDir !== '0') {
    for (const candidate of fullBuildCandidates({ browsersPath: browsersDir, platform, arch, readdir })) {
      const absolute = path.resolve(candidate);
      const exists = isFile(absolute);
      candidates.push({ path: absolute, source: BROWSERS_PATH_ENV, exists });
      if (exists) return { executablePath: absolute, source: BROWSERS_PATH_ENV, candidates };
    }
  }

  throw new ChromiumBinaryError(failureMessage({ candidates, override: overrideValue, browsersPath: browsersDir, fallback }), candidates);
}

export function resolveChromiumExecutableForEnvironment(options = {}) {
  return resolveChromiumExecutable({
    override: process.env[CHROMIUM_EXECUTABLE_ENV] || '',
    browsersPath: process.env[BROWSERS_PATH_ENV] || '',
    defaultExecutablePath: options.defaultExecutablePath || '',
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.arch ? { arch: options.arch } : {}),
    ...(options.isFile ? { isFile: options.isFile } : {}),
    ...(options.readdir ? { readdir: options.readdir } : {}),
  });
}

// Resolve *and* publish the choice, exactly once, before any browser is launched. The
// harness (`env.mjs`) calls this at import time, so every launcher in the process — the
// shared session, `web-firstload-metric.mjs` — sees the same pinned binary.
export function exportHarnessChromiumExecutable(options = {}) {
  const resolved = resolveChromiumExecutableForEnvironment(options);
  process.env[CHROMIUM_EXECUTABLE_ENV] = resolved.executablePath;
  return resolved;
}
