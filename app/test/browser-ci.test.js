import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const appRoot = path.resolve(import.meta.dirname, "..");
const adapter = path.join(appRoot, "scripts", "run-browser-ci.mjs");
const harness = path.join(appRoot, "scripts", "web-regression.mjs");

const passCheck = (name) => ({ name, pass: true, ms: 1 });
const failCheck = (name, message) => ({ name, pass: false, error: message, ms: 1 });

// The adapter only orchestrates `web-regression.mjs`; these stubs prove the gate
// decisions (exit code, FAIL, page error, missing/empty results) without Chromium.
function writeStubHarness(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-ci-test-"));
  const stub = path.join(dir, "stub-harness.mjs");
  const lines = [
    `import fs from "node:fs";`,
    `import path from "node:path";`,
    options.stdout ? `process.stdout.write(${JSON.stringify(options.stdout)});` : "",
    options.stderr ? `process.stderr.write(${JSON.stringify(options.stderr)});` : "",
    options.hangMs ? `await new Promise((resolve) => setTimeout(resolve, ${Number(options.hangMs)}));` : "",
    options.results === undefined ? "" : `fs.writeFileSync(path.join(process.env.WEB_TEST_OUTPUT, "results.json"), ${JSON.stringify(JSON.stringify(options.results))});`,
    `process.exitCode = ${options.exitCode ?? 0};`,
  ].filter(Boolean);
  fs.writeFileSync(stub, `${lines.join("\n")}\n`);
  return { stub, outputRoot: path.join(dir, "artifacts") };
}

function runAdapter({ stub, outputRoot }, extraEnv = {}) {
  const result = spawnSync(process.execPath, [adapter], {
    cwd: appRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "",
      GITHUB_ACTIONS: "",
      PLAYWRIGHT_MODULE: "",
      CHROMIUM_EXECUTABLE: "",
      WEB_BROWSER_REGRESSION: stub,
      WEB_BROWSER_OUTPUT: outputRoot,
      ...extraEnv,
    },
  });
  const summaryPath = path.join(outputRoot, "ci-summary.json");
  const logPath = path.join(outputRoot, "browser-regression.log");
  return {
    result,
    summary: JSON.parse(fs.readFileSync(summaryPath, "utf8")),
    log: fs.readFileSync(logPath, "utf8"),
  };
}

test("browser CI adapter passes and logs a passing harness", () => {
  const target = writeStubHarness({
    stdout: "PASS alpha\nPASS beta\n",
    results: { results: [passCheck("alpha"), passCheck("beta")], errors: [], serverErrors: [] },
  });
  const { result, summary, log } = runAdapter(target);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(summary.status, "passed");
  assert.deepEqual(summary.problems, []);
  assert.deepEqual(summary.checks, { total: 2, passed: 2, failed: 0, failedNames: [] });
  assert.match(log, /PASS alpha/);
  assert.match(log, /status=passed/);
});

test("browser CI adapter blocks on a FAIL check and keeps a readable log", () => {
  const target = writeStubHarness({
    stdout: "FAIL gamma: expected 1 got 2\n",
    results: { results: [passCheck("alpha"), failCheck("gamma", "expected 1 got 2")], errors: [], serverErrors: [] },
    exitCode: 1,
  });
  const { result, summary, log } = runAdapter(target);
  assert.equal(result.status, 1);
  assert.equal(summary.status, "failed");
  assert.equal(summary.checks.failed, 1);
  assert.deepEqual(summary.checks.failedNames, ["gamma"]);
  assert.ok(summary.problems.some((problem) => problem.includes("gamma")));
  assert.match(log, /FAIL gamma: expected 1 got 2/);
});

test("browser CI adapter blocks on an uncaught page error even when the harness exits 0", () => {
  const target = writeStubHarness({
    results: { results: [passCheck("alpha")], errors: ["TypeError: boom\n    at x"], serverErrors: [] },
  });
  const { result, summary } = runAdapter(target);
  assert.equal(result.status, 1);
  assert.equal(summary.status, "failed");
  assert.equal(summary.pageErrors.length, 1);
  assert.ok(summary.problems.some((problem) => problem.includes("uncaught page error")));
});

test("browser CI adapter blocks on a recorded server error even when checks pass", () => {
  const target = writeStubHarness({
    results: { results: [passCheck("alpha")], errors: [], serverErrors: ["Error: backend boom"] },
  });
  const { result, summary } = runAdapter(target);
  assert.equal(result.status, 1);
  assert.equal(summary.status, "failed");
  assert.equal(summary.serverErrors.length, 1);
  assert.ok(summary.problems.some((problem) => problem.includes("server error")));
});

test("browser CI adapter never allowlists a known expected-4xx server error string", () => {
  const target = writeStubHarness({
    results: {
      results: [passCheck("alpha")],
      errors: [],
      serverErrors: ["Obsidian Web error: Error: Search operator requires a value at position 6"],
    },
  });
  const { result, summary } = runAdapter(target);
  assert.equal(result.status, 1);
  assert.equal(summary.status, "failed");
  assert.equal(summary.serverErrors.length, 1);
  assert.ok(summary.problems.some((problem) => problem.includes("server error")));
});

test("browser CI adapter rejects null or malformed result payloads", () => {
  const nullPayload = runAdapter(writeStubHarness({ results: null }));
  assert.equal(nullPayload.result.status, 1);
  assert.ok(nullPayload.summary.problems.some((problem) => problem.includes("root must be an object")));

  const malformedCheck = runAdapter(writeStubHarness({
    results: { results: [null], errors: [], serverErrors: [] },
  }));
  assert.equal(malformedCheck.result.status, 1);
  assert.equal(malformedCheck.summary.checks.failed, 1);
  assert.ok(malformedCheck.summary.problems.some((problem) => problem.includes("malformed")));
});

test("browser CI adapter requires pass to be the boolean true", () => {
  const target = writeStubHarness({
    results: { results: [{ name: "alpha", pass: "true", ms: 1 }], errors: [], serverErrors: [] },
  });
  const { result, summary } = runAdapter(target);
  assert.equal(result.status, 1);
  assert.equal(summary.checks.passed, 0);
  assert.equal(summary.checks.failed, 1);
  assert.deepEqual(summary.checks.failedNames, ["alpha"]);
});

test("browser CI adapter rejects duplicate and explicitly skipped checks", () => {
  const duplicate = runAdapter(writeStubHarness({
    results: { results: [passCheck("alpha"), passCheck("alpha")], errors: [], serverErrors: [] },
  }));
  assert.equal(duplicate.result.status, 1);
  assert.ok(duplicate.summary.problems.some((problem) => problem.includes("duplicate check name")));

  const skipped = runAdapter(writeStubHarness({
    results: { results: [{ ...passCheck("alpha"), skipped: true }], errors: [], serverErrors: [] },
  }));
  assert.equal(skipped.result.status, 1);
  assert.equal(skipped.summary.checks.passed, 0);
  assert.deepEqual(skipped.summary.checks.failedNames, ["alpha"]);
});

test("browser CI adapter rejects WEB_TEST_ONLY filtering under CI", () => {
  const target = writeStubHarness({
    results: { results: [passCheck("alpha")], errors: [], serverErrors: [] },
  });
  const { result, summary } = runAdapter(target, { CI: "true", WEB_TEST_ONLY: "alpha" });
  assert.equal(result.status, 1);
  assert.ok(summary.problems.some((problem) => problem.includes("WEB_TEST_ONLY filtering is disabled in CI")));
});

test("browser CI adapter rejects a replacement harness under CI", () => {
  const target = writeStubHarness({
    stdout: "SHOULD_NOT_RUN\n",
    results: { results: [passCheck("alpha")], errors: [], serverErrors: [] },
  });
  for (const env of [
    { CI: "true" },
    { CI: "", GITHUB_ACTIONS: "true" },
  ]) {
    const { result, summary, log } = runAdapter(target, env);
    assert.equal(result.status, 1);
    assert.ok(summary.problems.some((problem) => problem.includes("harness override is disabled in CI")));
    assert.match(summary.problems.join("\n"), /harness was not started/);
    assert.doesNotMatch(log, /SHOULD_NOT_RUN/);
  }
});

test("browser CI adapter does not treat CI=false as CI", () => {
  const target = writeStubHarness({
    results: { results: [passCheck("alpha")], errors: [], serverErrors: [] },
  });
  const { result, summary } = runAdapter(target, { CI: "false", GITHUB_ACTIONS: "" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(summary.status, "passed");
});

test("browser CI adapter rejects browser runtime overrides under CI", () => {
  const target = writeStubHarness({
    results: { results: [passCheck("alpha")], errors: [], serverErrors: [] },
  });
  const { result, summary } = runAdapter(target, {
    CI: "",
    GITHUB_ACTIONS: "true",
    PLAYWRIGHT_MODULE: path.join(target.outputRoot, "fake-playwright.mjs"),
    CHROMIUM_EXECUTABLE: path.join(target.outputRoot, "fake-chromium"),
  });
  assert.equal(result.status, 1);
  assert.ok(summary.problems.some((problem) => problem.includes("PLAYWRIGHT_MODULE override is disabled in CI")));
  assert.ok(summary.problems.some((problem) => problem.includes("CHROMIUM_EXECUTABLE override is disabled in CI")));
});

test("browser CI adapter times out a hung harness", () => {
  const target = writeStubHarness({ hangMs: 10_000 });
  const { result, summary } = runAdapter(target, { WEB_BROWSER_TIMEOUT_MS: "100" });
  assert.equal(result.status, 1);
  assert.ok(summary.problems.some((problem) => problem.includes("timed out after 100ms")));
});

// U54: the hang detector is the only wall-clock budget the adapter owns, and the CI job's
// 25-minute `timeout-minutes` must stay above two attempts of it -- otherwise GitHub kills the
// job and the uploaded artifacts that make a red run readable are lost. Pinned here because the
// value is a CI contract, not an implementation detail.
test("browser CI adapter ships a 600s hang detector by default", () => {
  const { result, summary } = runAdapter(writeStubHarness({
    results: { results: [passCheck("alpha")], errors: [], serverErrors: [] },
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(summary.environment.harnessTimeoutMs, 600_000);
});

test("browser CI adapter clamps a longer hang detector to the documented maximum", () => {
  const { result, summary, log } = runAdapter(writeStubHarness({
    results: { results: [passCheck("alpha")], errors: [], serverErrors: [] },
  }), { WEB_BROWSER_TIMEOUT_MS: "1800000" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(summary.environment.harnessTimeoutMs, 600_000);
  assert.match(log, /exceeds the 600000ms maximum; clamped to 600000ms/);
});

test("browser CI adapter reports a harness that never writes results.json", () => {
  const target = writeStubHarness({ stdout: "starting\n", exitCode: 1 });
  const { result, summary, log } = runAdapter(target);
  assert.equal(result.status, 1);
  assert.equal(summary.status, "failed");
  assert.ok(summary.problems.some((problem) => problem.includes("missing")));
  assert.match(log, /starting/);
});

test("browser CI adapter treats zero reported checks as a failure", () => {
  const target = writeStubHarness({ results: { results: [], errors: [], serverErrors: [] } });
  const { result, summary } = runAdapter(target);
  assert.equal(result.status, 1);
  assert.ok(summary.problems.some((problem) => problem.includes("zero checks")));
});

test("browser CI adapter fails fast on a missing Playwright module", () => {
  const target = writeStubHarness({ results: { results: [passCheck("alpha")], errors: [] } });
  const { result, summary, log } = runAdapter(target, { PLAYWRIGHT_MODULE: path.join(target.outputRoot, "does-not-exist.mjs") });
  assert.equal(result.status, 1);
  assert.ok(summary.problems.some((problem) => problem.includes("PLAYWRIGHT_MODULE does not exist")));
  assert.match(log, /run-browser-ci/);
});

test("web regression harness normalizes the CRLF fixture as executable code", () => {
  // The harness was split into scripts/web-regression/*.mjs; the fixture setup now lives in
  // env.mjs, so scan the entry point plus that module to keep covering the same guard.
  const source = [harness, path.join(appRoot, "scripts", "web-regression", "env.mjs")]
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  const line = source.split(/\r?\n/).find((candidate) => candidate.includes("const fixture ="));
  assert.ok(line, "harness must declare the fixture once");
  // A previous merge glued this statement onto the preceding comment, leaving `fixture`
  // undefined and the whole suite unable to start.
  assert.ok(
    line.trimStart().startsWith("const fixture ="),
    `fixture declaration must be executable code, got: ${line}`,
  );
  assert.match(line, /\.replace\(\/\\r\\n\/g,'\\n'\)/, "harness must normalize CRLF fixture newlines");
  assert.match(source, /await fs\.writeFile\(path\.join\(vault,'A\.md'\), fixture\)/, "the normalized fixture must be the file under test");
});
