#!/usr/bin/env node
// Fail-closed CI adapter for the repository's Node test suite.
//
// The normal CI path always runs the full `node --test` discovery. Test-only
// harness overrides exist solely so this adapter's negative contracts can be
// exercised without recursively spawning the full repository suite.

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const testing = process.env.NODE_TEST_GATE_TESTING === "1";
const harnessOverride = testing && process.env.NODE_TEST_GATE_HARNESS
  ? path.resolve(process.env.NODE_TEST_GATE_HARNESS)
  : "";
const configuredTimeout = Number.parseInt(process.env.NODE_TEST_GATE_TIMEOUT_MS || "", 10);
const timeoutMs = testing && Number.isFinite(configuredTimeout)
  ? Math.max(50, Math.min(configuredTimeout, DEFAULT_TIMEOUT_MS))
  : DEFAULT_TIMEOUT_MS;

const problems = [];

function fail(message) {
  problems.push(message);
}

function summaryValue(output, key) {
  const pattern = new RegExp(`^(?:#|ℹ) ${key} (\\d+)\\s*$`, "gm");
  const matches = [...output.matchAll(pattern)];
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    fail(`duplicate Node test summary field: ${key} (${matches.length} occurrences)`);
    return null;
  }
  return Number.parseInt(matches[0][1], 10);
}

function evaluateSummary(output) {
  const summary = {};
  for (const key of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    summary[key] = summaryValue(output, key);
    if (summary[key] === null) fail(`missing Node test summary field: ${key}`);
  }
  if (Object.values(summary).some((value) => value === null)) return summary;
  if (summary.tests === 0) fail("Node test suite reported zero tests");
  if (summary.fail !== 0) fail(`Node test suite reported ${summary.fail} failure(s)`);
  if (summary.cancelled !== 0) fail(`Node test suite reported ${summary.cancelled} cancelled test(s)`);
  if (summary.todo !== 0) fail(`Node test suite reported ${summary.todo} todo test(s)`);
  // The arithmetic has to count EVERY outcome, not just pass+skipped: Node counts a failure in
  // `tests` and not in `pass`, so a suite with one real failure produced a SECOND, misleading
  // "summary is inconsistent" problem (observed as `pass=4769 + skipped=37 ≠ tests=4807` on a run
  // whose only real problem was 1 failure). Counting all five keeps fail-closed (the run still
  // exits non-zero because of the failure itself) without inventing a phantom problem.
  const accounted = summary.pass + summary.fail + summary.cancelled + summary.skipped + summary.todo;
  if (accounted !== summary.tests) {
    fail(`Node test summary is inconsistent: pass=${summary.pass} + fail=${summary.fail} + cancelled=${summary.cancelled} + skipped=${summary.skipped} + todo=${summary.todo} = ${accounted} ≠ tests=${summary.tests}`);
  }
  return summary;
}

if (process.argv.length > 2) {
  fail("Node test filtering/extra CLI arguments are disabled in CI");
}
const inCi = process.env.GITHUB_ACTIONS === "true" || process.env.CI === "true";
if (inCi && (testing || process.env.NODE_TEST_GATE_HARNESS)) {
  fail("Node test harness overrides are disabled in CI; the gate requires the real repository suite");
} else if (!testing && process.env.NODE_TEST_GATE_HARNESS) {
  fail("NODE_TEST_GATE_HARNESS is test-only and cannot replace the real CI suite");
}

let stdout = "";
let stderr = "";
let exitCode = null;
let signal = null;
let timedOut = false;

if (problems.length === 0) {
  // The real suite runs **with `test/preload-fetch-safe-listen.mjs`**. This host's dynamic port range
  // starts at 1024 (Windows: `1024 + 13977`), which overlaps undici's hard-coded "bad port" set, so an
  // OS-assigned `listen(0)` port can make an unrelated `fetch()` fail with `bad port` and turn this
  // adapter red on a machine-specific coin flip. The preload only changes WHICH free port a fixture
  // binds (issue #344, `scripts/fetch-safe-listen.mjs`); it touches no assertion. The document that
  // describes the local serial command already passed `--import` — the CI adapter had not been wired
  // to it, so CI kept the flake (Wave R).
  const PRELOAD = "--import";
  const PRELOAD_PATH = path.join(APP_ROOT, "test", "preload-fetch-safe-listen.mjs");
  // `--import` needs a resolvable ESM specifier. A bare Windows drive path (`D:\…`) is parsed as a
  // URL with scheme `d:` and every test file dies with ERR_UNSUPPORTED_ESM_URL_SCHEME — so pass a
  // `file://` URL (`pathToFileURL`), which works on both platforms.
  const PRELOAD_SPECIFIER = pathToFileURL(PRELOAD_PATH).href;
  const args = harnessOverride ? [harnessOverride] : [PRELOAD, PRELOAD_SPECIFIER, "--test"];
  await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: APP_ROOT,
      env: { ...process.env, NODE_TEST_GATE_HARNESS: "", NODE_TEST_GATE_TESTING: "" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let forceKill = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKill.unref?.();
    }, timeoutMs);
    timeout.unref?.();

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      fail(`could not start Node tests: ${error.message}`);
      resolve();
    });
    child.once("exit", (code, childSignal) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      exitCode = code;
      signal = childSignal;
      resolve();
    });
  });

  if (timedOut) fail(`Node test suite timed out after ${timeoutMs}ms`);
  if (signal) fail(`Node test suite terminated by signal ${signal}`);
  if (exitCode !== 0) fail(`Node test suite exited with code ${exitCode}`);
  evaluateSummary(`${stdout}\n${stderr}`);
}

if (problems.length > 0) {
  console.error("\nNode CI test gate: failed");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log("\nNode CI test gate: passed (nonzero tests; 0 fail/cancelled/todo)");
  process.exitCode = 0;
}
