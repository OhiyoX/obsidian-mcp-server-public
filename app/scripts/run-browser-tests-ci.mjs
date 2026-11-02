#!/usr/bin/env node
// CI adapter for the real-Chromium web regression.
//
// Wraps `scripts/run-browser-ci.mjs` with the two CI concerns the harness should
// not own:
//
//   1. Judging the result. The harness already exits 1 when any check fails;
//      this adapter separates failures that are known artefacts of the
//      self-hosted runner (allow-listed, and always reported as warnings) from
//      failures that must block the pipeline.
//
//   2. Optional diagnostic retries. CI runs once: an unknown failure is not
//      evidence of runner load. An operator may explicitly request another
//      attempt; both artifacts and the first failure remain visible.
//
// Env:
//   WEB_BROWSER_OUTPUT           artifact root; each attempt writes into
//                                <root>/attempt-<n> so every attempt is uploaded
//   KNOWN_ENVIRONMENT_FAILURES   newline-separated check names allowed to fail
//   BROWSER_TEST_GATE_ATTEMPTS   default 1; 2 is an explicit diagnostic retry
//   BROWSER_TEST_GATE_HARNESS    override the harness path (used by tests)
//
// Exit code 0 only when the last attempt had no blocking item.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const harness = process.env.BROWSER_TEST_GATE_HARNESS
  ? path.resolve(process.env.BROWSER_TEST_GATE_HARNESS)
  : path.join(appRoot, "scripts", "run-browser-ci.mjs");
const outputRoot = path.resolve(
  process.env.WEB_BROWSER_OUTPUT || path.join(appRoot, ".browser-ci"),
);
const attempts = Math.max(
  1,
  Math.min(2, Number.parseInt(process.env.BROWSER_TEST_GATE_ATTEMPTS || "1", 10) || 1),
);
const allowed = new Set(
  (process.env.KNOWN_ENVIRONMENT_FAILURES || "")
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean),
);

// One line per failing check, plus a generic line carrying the exit code. Any
// other entry in `problems` is a harness-level problem (timeout, Playwright
// version mismatch, unparseable output) and must not be tolerated.
const CHECK_FAILURE = /^\d+ FAIL: /;
const HARNESS_EXIT = /^harness exited with code \d+$/;

function judge(report) {
  if (report === null) {
    return {
      passed: null,
      total: null,
      failedNames: [],
      known: [],
      unexpected: [],
      hard: [`no readable ci-summary.json in ${process.env.WEB_BROWSER_OUTPUT || outputRoot}`],
    };
  }
  const checks = report.checks || {};
  const failedNames = Array.isArray(checks.failedNames) ? checks.failedNames : [];
  const problems = Array.isArray(report.problems) ? report.problems : [];
  return {
    passed: checks.passed ?? null,
    total: checks.total ?? null,
    failedNames,
    known: failedNames.filter((name) => allowed.has(name)),
    unexpected: failedNames.filter((name) => !allowed.has(name)),
    hard: problems.filter(
      (problem) => !CHECK_FAILURE.test(problem) && !HARNESS_EXIT.test(problem),
    ),
  };
}

function readSummary(attemptDir) {
  const summaryPath = path.join(attemptDir, "ci-summary.json");
  if (!fs.existsSync(summaryPath)) {
    console.error(`::warning::no ci-summary.json at ${summaryPath}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  } catch (error) {
    console.error(`::warning::ci-summary.json is not valid JSON: ${error.message}`);
    return null;
  }
}

console.log(`[browser-gate] harness=${harness}`);
console.log(`[browser-gate] attempts=${attempts} allow-list=${allowed.size} entry/entries`);

let firstBlocking = [];
let last = null;

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const attemptDir = path.join(outputRoot, `attempt-${attempt}`);
  fs.rmSync(attemptDir, { recursive: true, force: true });
  fs.mkdirSync(attemptDir, { recursive: true });
  console.log(`[browser-gate] attempt ${attempt}/${attempts} -> ${attemptDir}`);

  const result = spawnSync(process.execPath, [harness], {
    cwd: appRoot,
    stdio: "inherit",
    env: { ...process.env, WEB_BROWSER_OUTPUT: attemptDir },
  });
  if (result.error) {
    console.error(`::warning::could not spawn the harness: ${result.error.message}`);
  }

  const verdict = judge(readSummary(attemptDir));
  last = { attempt, attemptDir, verdict };
  const blocking = [...verdict.unexpected, ...verdict.hard];

  console.log(
    `[browser-gate] attempt ${attempt}: ${verdict.passed ?? "?"}/${verdict.total ?? "?"} passed, `
      + `${verdict.failedNames.length} check failure(s), ${verdict.hard.length} harness problem(s), `
      + `harness exit ${result.status}`,
  );

  if (blocking.length === 0) {
    if (attempt > 1) {
      console.warn(
        `::warning::chromium regression passed on attempt ${attempt} after attempt 1 failed on `
          + `${firstBlocking.join("; ")} -- explicit diagnostic retry, treat the `
          + `first failure as flakiness to investigate, not as a pass`,
      );
    }
    for (const name of verdict.known) {
      console.log(`::warning::known environment-sensitive failure: ${name}`);
    }
    process.exit(0);
  }

  if (attempt === 1) firstBlocking = blocking;

  if (attempt < attempts) {
    console.warn(
      `::warning::attempt ${attempt} has ${blocking.length} blocking item(s): ${blocking.join("; ")} `
        + `-- retrying once`,
    );
    continue;
  }
}

console.error(`::error::chromium regression still failing after ${last.attempt} attempt(s)`);
for (const name of last.verdict.known) {
  console.log(`::warning::known environment-sensitive failure: ${name}`);
}
for (const name of last.verdict.unexpected) {
  console.error(`::error::unexpected failure: ${name}`);
}
for (const problem of last.verdict.hard) {
  console.error(`::error::${problem}`);
}
console.error(`::error::artifacts kept per attempt under ${outputRoot}`);
process.exit(1);
