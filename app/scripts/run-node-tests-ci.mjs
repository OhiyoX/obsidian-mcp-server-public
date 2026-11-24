#!/usr/bin/env node
// Fail-closed CI adapter for the repository's Node test suite.
//
// The normal CI path always runs the full `node --test` discovery. Test-only
// harness overrides exist solely so this adapter's negative contracts can be
// exercised without recursively spawning the full repository suite.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
// The 15-minute default is the CI budget. A local run on a slow mount may need more: this container
// cancels ~360 tests at 900 s while reporting zero failures, because a module import costs seconds
// there (measured 2026-11-13). An explicit override may raise the cap to one hour — never shorten it,
// so nobody can make the gate cheaper by accident.
const MAX_OVERRIDE_MS = 60 * 60 * 1000;
const timeoutMs = !Number.isFinite(configuredTimeout) || configuredTimeout <= 0
  ? DEFAULT_TIMEOUT_MS
  // In test mode the number may go down as well, so a negative contract can make a hung child time out.
  : testing
    ? Math.max(50, Math.min(configuredTimeout, DEFAULT_TIMEOUT_MS))
    : Math.max(DEFAULT_TIMEOUT_MS, Math.min(configuredTimeout, MAX_OVERRIDE_MS));

// #732: a full run at the host's default concurrency (`availableParallelism()`) fails 1–3 tests per
// run on a loaded machine, and the failing SET changes between runs (health-check waits against a
// spinning CPU, wall-clock deadline assertions). That made the release gate unreproducible, which is
// worse than slow: a red gate nobody can re-run is a gate people route around. The gate therefore
// pins a concurrency instead of inheriting the core count; `NODE_TEST_GATE_CONCURRENCY` overrides it
// for diagnosis. A value that is not a small positive integer fails closed rather than silently
// falling back — a typo must not change what the gate proves.
// #795/#732: several suites (`authorization-*`, the Web catalog routes) refuse to run without
// `DATA_PATH` — their first assertion is "DATA_PATH must point at the isolated test root", because
// they write a real state file. This adapter inherited no such isolation, so any local run of the
// release gate was red for a reason that had nothing to do with the code under test (measured
// 2026-11-20: 54 failures, all from that guard). The adapter now creates its own temp root exactly
// like `run-node-tests-local.mjs`: an explicit `DATA_PATH` is respected and never deleted.
const CONCURRENCY_DEFAULT = 4;
const CONCURRENCY_MAX = 32;
function resolveConcurrency(raw) {
  if (raw === undefined || raw === "") return CONCURRENCY_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > CONCURRENCY_MAX || String(parsed) !== String(raw).trim()) return null;
  return parsed;
}

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
  // The pinned concurrency travels on the child's own command line (execArgv), so the negative
  // contracts can read it back instead of trusting the source text.
  const concurrency = resolveConcurrency(process.env.NODE_TEST_GATE_CONCURRENCY);
  if (concurrency === null) fail(`NODE_TEST_GATE_CONCURRENCY must be an integer 1..${CONCURRENCY_MAX}`);
  const concurrencyFlag = `--test-concurrency=${concurrency ?? CONCURRENCY_DEFAULT}`;
  const args = harnessOverride ? [concurrencyFlag, harnessOverride] : [PRELOAD, PRELOAD_SPECIFIER, "--test", concurrencyFlag];
  // A harness run executes one stub file and touches no state, so it keeps the caller's environment.
  const ownDataPath = !harnessOverride && (process.env.DATA_PATH === undefined || process.env.DATA_PATH === "");
  const dataPath = ownDataPath ? fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-ci-tests-")) : process.env.DATA_PATH;
  const releaseDataPath = () => {
    if (ownDataPath) fs.rmSync(dataPath, { recursive: true, force: true });
  };
  await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: APP_ROOT,
      env: { ...process.env, NODE_TEST_GATE_HARNESS: "", NODE_TEST_GATE_TESTING: "", ...(ownDataPath ? { DATA_PATH: dataPath } : {}) },
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

  releaseDataPath();
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
