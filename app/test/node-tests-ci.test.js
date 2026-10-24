import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const ADAPTER = path.join(APP_ROOT, "scripts", "run-node-tests-ci.mjs");

function writeHarness({ summary = "", exitCode = 0, hangMs = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-test-gate-"));
  const file = path.join(dir, "stub.mjs");
  fs.writeFileSync(file, [
    hangMs ? `await new Promise((resolve) => setTimeout(resolve, ${hangMs}));` : "",
    summary ? `process.stdout.write(${JSON.stringify(summary)});` : "",
    `process.exitCode = ${exitCode};`,
    "",
  ].filter(Boolean).join("\n"));
  return { dir, file };
}

function summary(values = {}) {
  const merged = {
    tests: 2,
    pass: 2,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    ...values,
  };
  return Object.entries(merged).map(([key, value]) => `# ${key} ${value}`).join("\n") + "\n";
}

function runHarness(options, extraArgs = [], extraEnv = {}) {
  const target = writeHarness(options);
  try {
    return spawnSync(process.execPath, [ADAPTER, ...extraArgs], {
      cwd: APP_ROOT,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        CI: "",
        GITHUB_ACTIONS: "",
        NODE_TEST_GATE_TESTING: "1",
        NODE_TEST_GATE_HARNESS: target.file,
        NODE_TEST_GATE_TIMEOUT_MS: "5000",
        ...extraEnv,
      },
    });
  } finally {
    fs.rmSync(target.dir, { recursive: true, force: true });
  }
}

test("Node CI gate accepts a complete nonzero clean summary", () => {
  const result = runHarness({ summary: summary() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Node CI test gate: passed/);
});

test("Node CI gate rejects zero tests", () => {
  const result = runHarness({ summary: summary({ tests: 0, pass: 0 }) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /zero tests/);
});

test("Node CI gate rejects todo and cancelled tests", () => {
  for (const field of ["todo", "cancelled"]) {
    const result = runHarness({ summary: summary({ [field]: 1, pass: 1 }) });
    assert.equal(result.status, 1, `${field}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(field));
  }
});

test("Node CI gate accepts platform-skipped tests when pass + skipped equals tests", () => {
  const result = runHarness({ summary: summary({ tests: 5, pass: 3, skipped: 2 }) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Node CI test gate: passed/);
});

test("Node CI gate parses the Node v24 info-prefix summary format", () => {
  const infoSummary = ["tests 4", "pass 3", "fail 0", "cancelled 0", "skipped 1", "todo 0"]
    .map((line) => `ℹ ${line}`)
    .join("\n") + "\n";
  const result = runHarness({ summary: infoSummary });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Node CI test gate: passed/);
});

test("Node CI gate rejects a nonzero child exit even with a passing summary", () => {
  const result = runHarness({ summary: summary(), exitCode: 7 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exited with code 7/);
});

test("Node CI gate rejects duplicate summary fields instead of trusting the last one", () => {
  const doubled = [
    summary({ tests: 2, pass: 1, skipped: 1 }),
    summary({ tests: 2, pass: 2, skipped: 0 }),
  ].join("");
  const result = runHarness({ summary: doubled });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /duplicate Node test summary field/);
});

test("Node CI gate rejects missing or inconsistent summaries", () => {
  const missing = runHarness({ summary: "stub finished\n" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing Node test summary field/);

  const inconsistent = runHarness({ summary: summary({ tests: 3, pass: 2 }) });
  assert.equal(inconsistent.status, 1);
  assert.match(inconsistent.stderr, /summary is inconsistent/);
});

test("Node CI gate counts a real failure instead of inventing a second problem", () => {
  // Negative control #1 (the phantom account): a suite with ONE real failure used to produce a
  // second, misleading "summary is inconsistent" problem, because the arithmetic ignored `fail`.
  // The summary below is exactly what such a run prints: tests=3, pass=2, fail=1.
  const withFailure = runHarness({ summary: summary({ tests: 3, pass: 2, fail: 1 }), exitCode: 1 });
  assert.equal(withFailure.status, 1, "a failing suite must still exit non-zero");
  assert.match(withFailure.stderr, /reported 1 failure/);
  assert.doesNotMatch(withFailure.stderr, /summary is inconsistent/,
    "one real failure must not also be reported as an inconsistent summary");

  // Negative control #2 (fail-closed survives the fix): an actually inconsistent summary
  // (nothing accounts for the missing test) is still rejected.
  const trulyInconsistent = runHarness({ summary: summary({ tests: 4, pass: 2, fail: 1 }), exitCode: 1 });
  assert.equal(trulyInconsistent.status, 1);
  assert.match(trulyInconsistent.stderr, /summary is inconsistent/);

  // And a clean suite stays green.
  const clean = runHarness({ summary: summary({ tests: 3, pass: 2, skipped: 1 }) });
  assert.equal(clean.status, 0, clean.stderr);
});

test("Node CI gate times out a hung child", () => {
  const result = runHarness({ hangMs: 10_000 }, [], { NODE_TEST_GATE_TIMEOUT_MS: "100" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /timed out after 100ms/);
});

test("Node CI gate rejects filter or extra CLI arguments", () => {
  const result = runHarness({ summary: summary() }, ["--test-name-pattern=only-one"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /filtering\/extra CLI arguments are disabled/);
});

test("Node CI gate rejects a test-only harness override under CI", () => {
  for (const env of [
    { CI: "true" },
    { CI: "", GITHUB_ACTIONS: "true" },
  ]) {
    const result = runHarness({ summary: summary() }, [], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /harness overrides are disabled in CI/);
    assert.doesNotMatch(result.stdout, /Node CI test gate: passed/);
  }
});

test("Node CI gate does not treat CI=false as CI", () => {
  const result = runHarness({ summary: summary() }, [], { CI: "false", GITHUB_ACTIONS: "" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Node CI test gate: passed/);
});

test("the CI adapter passes the port preload as a file:// specifier, not a raw drive path", () => {
  // Wave R: `--import D:\…` is parsed as a URL with scheme `d:` and every test file dies with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME — the adapter then reports hundreds of failures on Windows while
  // Linux CI stays green, so only this assertion (and the mechanism check below) can catch it.
  const source = fs.readFileSync(path.join(APP_ROOT, "scripts", "run-node-tests-ci.mjs"), "utf8");
  assert.match(source, /pathToFileURL\(PRELOAD_PATH\)\.href/, "the adapter must build a file:// URL");
  assert.equal(/\[PRELOAD,\s*PRELOAD_PATH/.test(source), false, "a raw path must never be passed to --import");

  const preload = path.join(APP_ROOT, "test", "preload-fetch-safe-listen.mjs");
  const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ci-preload-")), "probe.test.js");
  fs.writeFileSync(probe, 'import test from "node:test";\ntest("ok", () => {});\n');
  const viaUrl = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, "--test", probe], { encoding: "utf8", cwd: APP_ROOT });
  assert.equal(viaUrl.status, 0, `a file:// specifier must load: ${viaUrl.stderr}`);
  // (No negative assertion on a raw path here: whether `--import D:\…` throws depends on how the
  // process received the backslashes, so the source assertion above is the reliable guard.)
});
