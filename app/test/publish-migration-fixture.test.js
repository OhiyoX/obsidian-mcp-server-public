// Node gate for the v1 → v2 Publish state migration fixture (Wave D, doc §8/§17).
//
// `app/scripts/run-publish-migration-checks.mjs` is the executable fixture; this file
// wires it into `npm test` and pins the two things a fixture may not silently lose:
//   1. the checked-in v1/v2 state-file samples are the shapes the doc describes, and
//   2. every fail-closed guard is a *real* detector — the env-gated negative control
//      must reject the pre-fix expectation for all nine cases.
// The fixture runs in a throwaway tmp root and must ignore any ambient VAULT_PATH.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PUBLISH_MIGRATION_CASE_IDS,
  PUBLISH_MIGRATION_CASES,
  PUBLISH_MIGRATION_FIXTURE_DIR,
  PUBLISH_MIGRATION_MISSING_PATH,
  PUBLISH_MIGRATION_VAULT_FILES,
} from "../scripts/publish-migration-fixtures.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(appRoot, "scripts", "run-publish-migration-checks.mjs");
const OPAQUE_ID = /^[A-Za-z0-9_-]{43}$/;

function runFixture(args, env = {}) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: appRoot,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
}

function withTmpDir(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-migration-fixture-test-"));
  try {
    return callback(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const read = (name) => fs.readFileSync(path.join(PUBLISH_MIGRATION_FIXTURE_DIR, name), "utf8");

test("the checked-in samples are the v1/v2 shapes the fixture claims", () => {
  assert.deepEqual(fs.readdirSync(PUBLISH_MIGRATION_FIXTURE_DIR).sort(), [
    "corrupt-not-json.json",
    "records-not-array.json",
    "top-level-array.json",
    "unsupported-version.json",
    "v1-duplicates.json",
    "v1-legacy.json",
    "v1-partial-records.json",
    "v2-active-nonmarkdown.json",
  ]);

  const legacy = JSON.parse(read("v1-legacy.json"));
  assert.equal(legacy.version, 1, "a v1 sample must carry version 1");
  assert.equal(legacy.records.length, 3);
  for (const record of legacy.records) {
    assert.equal("lifecycle" in record, false, "§8.1: the v1 sample has no lifecycle to trust");
    assert.match(record.id, OPAQUE_ID, "sample ids keep the real opaque shape");
    assert.equal(record.vaultId, "default");
  }
  assert.deepEqual(
    legacy.records.map((record) => record.path),
    ["Notes/Legacy-Markdown.md", PUBLISH_MIGRATION_MISSING_PATH, "Notes/Legacy-NonMarkdown.canvas"],
    "the sample spans the three §8.1 outcomes: markdown / missing / non-markdown",
  );
  // The unknown keys are the point: they must not be carried into v2.
  assert.ok("publicUrl" in legacy.records[2] && "retrievalHint" in legacy.records[2]);

  const partial = JSON.parse(read("v1-partial-records.json"));
  assert.equal(partial.records.length, 9, "every §8.1 drop reason has a sample record");
  assert.ok(partial.records.includes(null), "a null record must be part of the sample");
  assert.ok(partial.records.some((record) => record && record.path === "../escape.md"), "an unsafe path must be part of the sample");

  assert.equal(JSON.parse(read("unsupported-version.json")).version, 7);
  assert.equal(Array.isArray(JSON.parse(read("records-not-array.json")).records), false);
  assert.deepEqual(JSON.parse(read("top-level-array.json")), []);
  assert.throws(() => JSON.parse(read("corrupt-not-json.json")), SyntaxError, "the corrupt sample must really be unparseable");

  const historic = JSON.parse(read("v2-active-nonmarkdown.json"));
  assert.equal(historic.version, 2);
  assert.equal(historic.records[0].lifecycle, "active");
  assert.ok(historic.records[0].path.endsWith(".canvas"));

  // The temporary Vault is generated, never read from the machine.
  const vaultPaths = Object.values(PUBLISH_MIGRATION_VAULT_FILES).map(([relative]) => relative);
  assert.ok(vaultPaths.includes("Notes/Legacy-Markdown.md"));
  assert.ok(vaultPaths.includes("Notes/Legacy-NonMarkdown.canvas"));
  assert.equal(vaultPaths.includes(PUBLISH_MIGRATION_MISSING_PATH), false, "the missing path must stay missing");
});

test("the migration fixture passes against the wired PublishService (9/9)", () => {
  withTmpDir((output) => {
    const result = runFixture([`--output=${output}`]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /cases: 9 {2}passed: 9 {2}failed: 0/);
    assert.equal(result.stdout.includes("FAIL"), false, `no case may fail:\n${result.stdout}`);
    const summary = JSON.parse(fs.readFileSync(path.join(output, "results.json"), "utf8"));
    assert.equal(summary.mode, "green");
    assert.equal(summary.passed, 9);
    assert.deepEqual(summary.cases.map((entry) => entry.id), [...PUBLISH_MIGRATION_CASE_IDS]);
    for (const entry of PUBLISH_MIGRATION_CASES) {
      assert.ok(typeof entry.guard === "string" && entry.guard.length > 10, `${entry.id} must name its guard`);
    }
  });
});

test("every fail-closed guard is a real detector (negative control rejects the pre-fix expectation)", () => {
  const result = runFixture([], { P278_D_MIGRATION_NEGATIVE: "all" });
  assert.equal(result.status, 1, "the negative-control run is red by design");
  const detected = result.stdout.match(/NEGATIVE-CONTROL OK/g) || [];
  assert.equal(detected.length, PUBLISH_MIGRATION_CASE_IDS.length, `every guard must reject the pre-fix expectation:\n${result.stdout}`);
  assert.equal(result.stdout.includes("NEGATIVE-CONTROL MISSED"), false, `a guard silently accepted the pre-fix expectation:\n${result.stdout}`);
  assert.match(result.stdout, /9 guard\(s\) rejected the pre-fix expectation, 0 missed/);
});

test("the runner ignores an ambient VAULT_PATH/DATA_PATH and never writes to a real data root", () => {
  withTmpDir((dir) => {
    const sentinelVault = path.join(dir, "sentinel-vault");
    const sentinelData = path.join(dir, "sentinel-data");
    const result = runFixture(["--case=v1-legacy"], { VAULT_PATH: sentinelVault, DATA_PATH: sentinelData });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.existsSync(sentinelVault), false, "the fixture must not read the ambient Vault");
    assert.equal(fs.existsSync(sentinelData), false, "the fixture must not write the ambient data root");
  });
});

test("`--list` publishes every case, and an unknown case is refused", () => {
  const listed = runFixture(["--list"]);
  assert.equal(listed.status, 0, listed.stderr);
  for (const id of PUBLISH_MIGRATION_CASE_IDS) assert.ok(listed.stdout.includes(`\n${id}\t`), `--list must cover ${id}`);
  assert.match(listed.stdout, /case-count: 9/);

  const unknown = runFixture(["--case=not-a-case"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown case "not-a-case"/);
});
