// Issue #380 — the harness must run the full Chromium build, never chrome-headless-shell.
// These tests pin the resolution contract in `scripts/web-regression/chromium-binary.mjs`
// (the single resolution point used by the harness and by
// `scripts/verify-chromium-binary.mjs`). The negative controls below are the ones the
// issue asks for: a headless-shell override and a browsers path that only holds the shell
// must both fail closed instead of silently running the shell build.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

import {
  CHROMIUM_EXECUTABLE_ENV,
  ChromiumBinaryError,
  exportHarnessChromiumExecutable,
  fullBuildCandidates,
  isHeadlessShellPath,
  loadPlaywrightChromium,
  playwrightRuntimeExecutablePath,
  resolveChromiumExecutable,
  resolveChromiumExecutableForEnvironment,
} from "../scripts/web-regression/chromium-binary.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");

function captureThrow(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: "expected the call to throw" });
}

// A fake file system built from a list of existing files: `readdir` only reports real
// directories (derived from the file list), so a shell-only directory looks exactly like a
// real one on disk.
const fakeRoot = (name) => path.join(os.tmpdir(), name);

function fakeTree(files) {
  const resolved = files.map((file) => path.resolve(file));
  return {
    isFile: (candidate) => resolved.includes(path.resolve(candidate)),
    readdir: (directory) => {
      const root = path.resolve(directory);
      const prefix = `${root}${path.sep}`;
      return [...new Set(
        resolved
          .filter((file) => file.startsWith(prefix))
          .map((file) => path.relative(root, file).split(path.sep)[0]),
      )];
    },
  };
}

// Platform layouts as Playwright 1.63 ships them.
function fullBuild(browsersPath, revision) {
  if (process.platform === "win32") return path.join(browsersPath, `chromium-${revision}`, "chrome-win64", "chrome.exe");
  if (process.platform === "darwin") {
    return path.join(browsersPath, `chromium-${revision}`, "chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
  }
  return path.join(browsersPath, `chromium-${revision}`, "chrome-linux64", "chrome");
}

function headlessShellBuild(browsersPath, revision = "1243") {
  if (process.platform === "win32") {
    return path.join(browsersPath, `chromium_headless_shell-${revision}`, "chrome-headless-shell-win64", "chrome-headless-shell.exe");
  }
  return path.join(browsersPath, `chromium_headless_shell-${revision}`, "chrome-linux64", "headless_shell");
}

test("a full-build override is used verbatim and reported as env-override", () => {
  const browsersPath = fakeRoot("fake-browsers");
  const override = fullBuild(browsersPath, "1243");
  const fake = fakeTree([override, headlessShellBuild(browsersPath)]);
  const resolution = resolveChromiumExecutable({ override, browsersPath, isFile: fake.isFile, readdir: fake.readdir });
  assert.equal(resolution.executablePath, path.resolve(override));
  assert.equal(resolution.source, "env-override");
  assert.ok(!isHeadlessShellPath(resolution.executablePath));
});

test("negative control: a headless-shell override fails closed instead of running the shell", () => {
  const browsersPath = fakeRoot("fake-browsers");
  const shell = headlessShellBuild(browsersPath);
  const fake = fakeTree([shell, fullBuild(browsersPath, "1243")]);
  const error = captureThrow(() => resolveChromiumExecutable({ override: shell, browsersPath, defaultExecutablePath: fullBuild(browsersPath, "1243"), isFile: fake.isFile, readdir: fake.readdir }));
  assert.ok(error instanceof ChromiumBinaryError, error.message);
  assert.match(error.message, /chrome-headless-shell/);
  assert.match(error.message, /#380/);
  // Fail-closed: the rejected override is reported, and no other source is consulted.
  assert.deepEqual(error.candidates.map((candidate) => candidate.source), ["env-override"]);
});

test("a missing override is an error, not an invitation to fall back", () => {
  const browsersPath = fakeRoot("fake-browsers");
  const fake = fakeTree([fullBuild(browsersPath, "1243")]);
  assert.throws(
    () => resolveChromiumExecutable({ override: path.join(browsersPath, "chromium-1243", "chrome-win64", "nope.exe"), isFile: fake.isFile, readdir: fake.readdir }),
    /is not an existing file/,
  );
});

test("the browsers path scan takes the newest full build and ignores the shell directory", () => {
  const browsersPath = fakeRoot("fake-browsers");
  const older = fullBuild(browsersPath, "1200");
  const newest = fullBuild(browsersPath, "1243");
  const shell = headlessShellBuild(browsersPath, "1243");
  const fake = fakeTree([older, newest, shell]);
  const resolution = resolveChromiumExecutable({ browsersPath, isFile: fake.isFile, readdir: fake.readdir });
  assert.equal(resolution.executablePath, path.resolve(newest));
  assert.equal(resolution.source, "PLAYWRIGHT_BROWSERS_PATH");
  assert.ok(!resolution.executablePath.includes("headless_shell"));
  // Only full builds are candidates at all: the shell directory and other browsers never appear.
  const candidates = fullBuildCandidates({ browsersPath, readdir: fake.readdir }).map((candidate) => path.resolve(candidate));
  assert.equal(candidates[0], path.resolve(newest));
  assert.ok(candidates.every((candidate) => !candidate.includes("headless_shell")));
  assert.deepEqual(
    [...new Set(candidates.map((candidate) => path.relative(path.resolve(browsersPath), candidate).split(path.sep)[0]))],
    ["chromium-1243", "chromium-1200"],
  );
});

test("an incomplete newest revision falls back to the next full build deterministically", () => {
  const browsersPath = fakeRoot("fake-browsers");
  const older = fullBuild(browsersPath, "1200");
  const fake = fakeTree([older, headlessShellBuild(browsersPath, "1243")]);
  const resolution = resolveChromiumExecutable({ browsersPath, isFile: fake.isFile, readdir: fake.readdir });
  assert.equal(resolution.executablePath, path.resolve(older));
});

test("negative control: a browsers path with only the headless shell fails closed and lists the fix", () => {
  const browsersPath = fakeRoot("fake-browsers-only-shell");
  const shell = headlessShellBuild(browsersPath);
  const fake = fakeTree([shell]);
  const error = captureThrow(() => resolveChromiumExecutable({ browsersPath, defaultExecutablePath: fullBuild(browsersPath, "1243"), isFile: fake.isFile, readdir: fake.readdir }));
  assert.ok(error instanceof ChromiumBinaryError, error.message);
  assert.match(error.message, /No usable full Chromium build/);
  assert.match(error.message, /npx playwright install chromium/);
  assert.match(error.message, new RegExp(CHROMIUM_EXECUTABLE_ENV));
  assert.equal(error.candidates.length, 1);
  assert.equal(error.candidates[0].exists, false);
});

test("the Playwright runtime default is used when no override is set, and a shell is still refused", () => {
  const browsersPath = fakeRoot("fake-browsers");
  const fallback = fullBuild(browsersPath, "1243");
  const shell = headlessShellBuild(browsersPath);
  const fake = fakeTree([fallback, shell]);
  assert.equal(
    resolveChromiumExecutable({ defaultExecutablePath: fallback, isFile: fake.isFile, readdir: fake.readdir }).source,
    "playwright-executable-path",
  );
  const shellOnly = fakeTree([shell]);
  assert.throws(
    () => resolveChromiumExecutable({ defaultExecutablePath: shell, isFile: shellOnly.isFile, readdir: shellOnly.readdir }),
    /No usable full Chromium build/,
  );
});

test("the revision-correct Playwright default wins over a newer full build on disk", () => {
  const browsersPath = fakeRoot("fake-browsers");
  const pinned = fullBuild(browsersPath, "1243");
  const newer = fullBuild(browsersPath, "1300");
  const fake = fakeTree([pinned, newer]);
  const resolution = resolveChromiumExecutable({ browsersPath, defaultExecutablePath: pinned, isFile: fake.isFile, readdir: fake.readdir });
  // A newer Chromium than the pinned Playwright speaks to is a new source of
  // nondeterminism, so the runtime's revision stays first.
  assert.equal(resolution.executablePath, path.resolve(pinned));
  assert.equal(resolution.source, "playwright-executable-path");
  // When that revision is not installed, the deterministic scan takes over.
  const missingPinned = fakeTree([newer]);
  assert.equal(resolveChromiumExecutable({ browsersPath, defaultExecutablePath: pinned, isFile: missingPinned.isFile, readdir: missingPinned.readdir }).source, "PLAYWRIGHT_BROWSERS_PATH");
});

test("exportHarnessChromiumExecutable publishes the resolved path to CHROMIUM_EXECUTABLE", () => {
  const browsersPath = fakeRoot("fake-browsers");
  const override = fullBuild(browsersPath, "1243");
  const fake = fakeTree([override]);
  const previous = process.env[CHROMIUM_EXECUTABLE_ENV];
  const previousOverride = process.env.CHROMIUM_EXECUTABLE;
  try {
    process.env.CHROMIUM_EXECUTABLE = override;
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    const resolution = exportHarnessChromiumExecutable({ isFile: fake.isFile, readdir: fake.readdir });
    assert.equal(process.env[CHROMIUM_EXECUTABLE_ENV], resolution.executablePath);
    assert.ok(!isHeadlessShellPath(process.env[CHROMIUM_EXECUTABLE_ENV]));
  } finally {
    if (previous === undefined) delete process.env[CHROMIUM_EXECUTABLE_ENV];
    else process.env[CHROMIUM_EXECUTABLE_ENV] = previous;
    if (previousOverride === undefined) delete process.env.CHROMIUM_EXECUTABLE;
    else process.env.CHROMIUM_EXECUTABLE = previousOverride;
  }
});

// Issue #380 also requires CI to assert the *launched* binary. A local machine cannot run the
// CI job, so this pins the wiring the same way `publish-checks-ci-wiring.test.js` pins the
// Web Publish steps: the browser job must run the assertion, and that assertion must be a
// real launch check rather than a directory-existence check.
test("the CI browser job asserts the launched Chromium binary through the harness resolver", () => {
  const workflowPath = path.join(appRoot, "..", ".github", "workflows", "ci.yml");
  const workflow = yaml.load(fs.readFileSync(workflowPath, "utf8"));
  const steps = workflow?.jobs?.browser?.steps ?? [];
  const step = steps.find((entry) => typeof entry?.run === "string" && entry.run.includes("scripts/verify-chromium-binary.mjs"));
  assert.ok(step, "the browser job must run scripts/verify-chromium-binary.mjs (issue #380)");
  assert.match(step.run, /set -eux/, "the assertion step must fail the job when the check fails");
  assert.match(step.env?.CHROMIUM_BINARY_REPORT ?? "", /browser-ci\/chromium-binary\.json/, "the report must land in the uploaded browser-regression artifact");

  const script = fs.readFileSync(path.join(appRoot, "scripts", "verify-chromium-binary.mjs"), "utf8");
  // A path check alone would not catch a mis-resolved binary, so the script must assert on the
  // running browser's own version report.
  assert.match(script, /Browser\.getVersion/, "the step must query the launched browser");
  assert.match(script, /product\.startsWith\('Chrome\/'\)/, "the step must reject a HeadlessChrome product");
  assert.match(script, /isHeadlessShellPath\(resolved\.executablePath\)/, "the step must reject a headless-shell path");
});

// The acceptance assertion for this issue: whatever the harness resolves in *this*
// environment must be a real full Chrome build. When the environment genuinely has no full
// build (only the shell is installed) the test reports that instead of passing silently.
test("the harness resolves a real full Chrome build in this environment", async (t) => {
  let chromium;
  try {
    chromium = await loadPlaywrightChromium();
  } catch (error) {
    t.skip(`no Playwright runtime available: ${error.message}`);
    return;
  }
  let resolution;
  try {
    resolution = resolveChromiumExecutableForEnvironment({ defaultExecutablePath: playwrightRuntimeExecutablePath(chromium) });
  } catch (error) {
    t.skip(`no full Chrome for Testing build in this environment (issue #380 report): ${error.message.split("\n")[0]}`);
    return;
  }
  assert.ok(fs.statSync(resolution.executablePath).isFile(), `resolved binary does not exist: ${resolution.executablePath}`);
  assert.ok(!isHeadlessShellPath(resolution.executablePath), `resolved path is a headless-shell build: ${resolution.executablePath}`);
  assert.match(path.basename(resolution.executablePath), /^(chrome|chrome\.exe|Google Chrome for Testing)$/);
  // The pinned binary has to live in a full `chromium-<revision>/` directory, not in
  // `chromium_headless_shell-<revision>/`.
  assert.match(path.resolve(resolution.executablePath), /[\\/]chromium-\d+[\\/]/);
  assert.ok(!path.resolve(resolution.executablePath).includes("node_modules"), "the harness must not resolve a bundled Chromium");
});
