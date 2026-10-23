import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const ADAPTER = path.join(APP_ROOT, "scripts", "run-browser-tests-ci.mjs");
const ALLOWED = "Table Surface v2.11 primes final geometry before the first observable table frame";

// The stub stands in for scripts/run-browser-ci.mjs: it reads the attempt
// directory the adapter hands it and writes the summary that attempt should
// produce. No Playwright, no browser.
function writeStub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-test-gate-"));
  const file = path.join(dir, "stub-harness.mjs");
  fs.writeFileSync(file, `
    import fs from "node:fs";
    import path from "node:path";
    const plan = JSON.parse(process.env.STUB_PLAN);
    const dir = process.env.WEB_BROWSER_OUTPUT;
    const attempt = Number(path.basename(dir).replace("attempt-", ""));
    const step = plan[attempt] ?? plan.default ?? {};
    if (step.writeSummary !== false) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "ci-summary.json"),
        step.raw ?? JSON.stringify(step.report ?? {}),
      );
    }
    process.exitCode = step.exit ?? 0;
  `);
  return { dir, file };
}

function summary({ failed = [], hard = [], passed = 73 } = {}) {
  const problems = ["harness exited with code 1"];
  if (failed.length > 0) problems.push(`${failed.length} FAIL: ${failed.join("; ")}`);
  return {
    status: failed.length > 0 || hard.length > 0 ? "failed" : "passed",
    checks: { total: passed + failed.length, passed, failed: failed.length, failedNames: failed },
    problems: [...problems, ...hard],
  };
}

function run(plan, extraEnv = {}) {
  const stub = writeStub();
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "browser-test-out-"));
  try {
    const result = spawnSync(process.execPath, [ADAPTER], {
      cwd: APP_ROOT,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        CI: "",
        GITHUB_ACTIONS: "",
        BROWSER_TEST_GATE_HARNESS: stub.file,
        BROWSER_TEST_GATE_ATTEMPTS: "2",
        WEB_BROWSER_OUTPUT: outputRoot,
        KNOWN_ENVIRONMENT_FAILURES: ALLOWED,
        STUB_PLAN: JSON.stringify(plan),
        ...extraEnv,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      outputRoot,
      attemptDir: (n) => path.join(outputRoot, `attempt-${n}`),
    };
  } finally {
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
}

test("a clean pass is accepted and never retried", () => {
  const result = run({ 1: { report: summary(), exit: 0 } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(result.attemptDir(1)));
  assert.equal(fs.existsSync(result.attemptDir(2)), false, "must not retry a clean pass");
});

test("default CI attempt does not rerun the entire suite for an unknown failure", () => {
  const result = run({
    1: { report: summary({ failed: ["unknown product failure"] }), exit: 1 },
    2: { report: summary(), exit: 0 },
  }, { BROWSER_TEST_GATE_ATTEMPTS: "" });
  assert.equal(result.status, 1, result.stdout);
  assert.equal(fs.existsSync(result.attemptDir(2)), false);
  assert.match(result.stderr, /unexpected failure: unknown product failure/);
});

test("allow-listed failures do not block and do not trigger a retry", () => {
  const result = run({ 1: { report: summary({ failed: [ALLOWED] }), exit: 1 } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /known environment-sensitive failure/);
  assert.equal(fs.existsSync(result.attemptDir(2)), false, "an allow-listed failure is expected, not flaky");
});

test("an unexpected failure passes on retry, loudly", () => {
  const flaky = "LP-12 10k-line editing stays viewport-bounded, not document-bounded";
  const result = run({
    1: { report: summary({ failed: [flaky] }), exit: 1 },
    2: { report: summary(), exit: 0 },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout + result.stderr, /passed on attempt 2 after attempt 1 failed/);
  assert.match(result.stdout + result.stderr, /LP-12/);
  assert.ok(fs.existsSync(result.attemptDir(1)), "the failing attempt must stay on disk as an artifact");
  assert.ok(fs.existsSync(result.attemptDir(2)));
});

test("an unexpected failure that repeats still blocks", () => {
  const flaky = "LP-12 10k-line editing stays viewport-bounded, not document-bounded";
  const result = run({
    1: { report: summary({ failed: [flaky] }), exit: 1 },
    2: { report: summary({ failed: [flaky] }), exit: 1 },
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /unexpected failure: LP-12/);
  assert.match(result.stderr, /still failing after 2 attempt/);
  assert.equal(fs.existsSync(result.attemptDir(3)), false, "must not retry more than once");
});

test("a missing summary blocks even when no check reports a failure", () => {
  const result = run({ default: { writeSummary: false, exit: 1 } });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /no ci-summary\.json/);
});

test("harness-level problems block even with zero check failures", () => {
  const result = run({
    default: { report: { ...summary(), problems: ["Playwright version mismatch: expected 1.63.0, resolved 1.62.0"] }, exit: 1 },
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Playwright version mismatch/);
});

test("malformed summary JSON blocks instead of being treated as a pass", () => {
  const result = run({ default: { raw: "{not json", exit: 1 } });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /not valid JSON|no readable ci-summary/);
});
