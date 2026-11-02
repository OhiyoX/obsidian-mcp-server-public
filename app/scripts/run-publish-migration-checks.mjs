// Executable v1 → v2 Publish state migration fixture (issues #277/#278, Wave D, doc §8).
//
// Usage (from `app/`):
//   node scripts/run-publish-migration-checks.mjs
//   node scripts/run-publish-migration-checks.mjs --list
//   node scripts/run-publish-migration-checks.mjs --case=corrupt-not-json
//   node scripts/run-publish-migration-checks.mjs --json --output=DIR
//
// What it does: for every case in `publish-migration-fixtures.mjs` it writes the
// checked-in state-file sample into a throwaway data root, then drives the *real*
// `PublishService` (real file IO, real Vault, no stubs) and asserts the §8.1 outcome —
// including the invariant that matters most for an operator: a refusal must never
// half-write the state file (byte-identical original, no `*.tmp` residue).
//
// Negative control (repo convention, same as `P278_B1_NEGATIVE`):
//   P278_D_MIGRATION_NEGATIVE=<caseId>[,<caseId>…]|all
// runs the listed cases with the *pre-fix* expectation ("the guard is broken"). Each
// targeted guard MUST reject it, so the run is deliberately red; `NEGATIVE-CONTROL OK`
// lines are the proof that the green assertions are real detectors.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  PUBLISH_MIGRATION_CASES,
  PUBLISH_MIGRATION_MISSING_PATH,
  createFixtureVault,
  fixtureBytes,
  fixtureJson,
  idsByPath,
} from "./publish-migration-fixtures.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const NEGATIVE_ENV = "P278_D_MIGRATION_NEGATIVE";
const VAULT = "default";
const STATE_VERSION_V2 = 2;

function parseArgs(argv) {
  const options = { list: false, json: false, output: "", cases: [] };
  for (const arg of argv) {
    if (arg === "--list") options.list = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help") options.help = true;
    else if (arg.startsWith("--case=")) options.cases.push(arg.slice("--case=".length));
    else if (arg.startsWith("--output=")) options.output = arg.slice("--output=".length);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log("usage: node scripts/run-publish-migration-checks.mjs [--list] [--case=ID] [--json] [--output=DIR]");
  process.exit(0);
}
if (options.list) {
  console.log("# v1 → v2 Publish state migration fixture cases");
  for (const entry of PUBLISH_MIGRATION_CASES) console.log(`${entry.id}\t${entry.guard}\t${entry.name}`);
  console.log(`case-count: ${PUBLISH_MIGRATION_CASES.length}`);
  process.exit(0);
}

const requested = new Set(options.cases);
for (const id of requested) {
  if (!PUBLISH_MIGRATION_CASES.some((entry) => entry.id === id)) {
    console.error(`publish-migration-checks: unknown case "${id}" (see --list)`);
    process.exit(2);
  }
}
const selected = PUBLISH_MIGRATION_CASES.filter((entry) => requested.size === 0 || requested.has(entry.id));
const negativeEnv = String(process.env[NEGATIVE_ENV] || "").trim();
const negativeAll = negativeEnv === "all";
const negativeIds = new Set(negativeEnv.split(",").map((value) => value.trim()).filter((value) => value && value !== "all"));
for (const id of negativeIds) {
  if (!PUBLISH_MIGRATION_CASES.some((entry) => entry.id === id)) {
    console.error(`publish-migration-checks: unknown negative-control case "${id}"`);
    process.exit(2);
  }
}
const negativeFor = (id) => negativeAll || negativeIds.has(id);
const inNegativeMode = negativeAll || negativeIds.size > 0;

// ------------------------------------------------------------------ tmp environment

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-publish-migration-"));
const vaultRoot = path.join(root, "vault");
const dataRoot = path.join(root, "data");
const stateDir = path.join(dataRoot, "publish");
await createFixtureVault(vaultRoot);
await fs.mkdir(stateDir, { recursive: true });
process.env.VAULT_PATH = vaultRoot;
process.env.DATA_PATH = dataRoot;
process.env.MAX_READ_BYTES = "2048";
process.env.GIT_ENABLED = "false";
process.env.GIT_AUTO_COMMIT = "false";
process.env.GIT_AUTO_PUSH = "false";
delete process.env.WEB_VAULTS_ROOT;

// Imported only after the environment above, because `src/config.js` snapshots it.
const { PublishService } = await import("../src/publish/service.js");
const { PUBLISH_LIFECYCLE } = await import("../src/publish/lifecycle.js");

// ------------------------------------------------------------------ helpers

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const stateFileFor = (id) => path.join(stateDir, `${id}.json`);

async function attempt(run) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, code: error?.code ?? null, message: error?.message ?? String(error) };
  }
}

async function writeState(file, bytes) {
  await fs.writeFile(file, bytes);
  return file;
}

async function readState(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function assertNoTempResidue(directory, label) {
  const entries = await fs.readdir(directory);
  const strays = entries.filter((entry) => entry.endsWith(".tmp") || entry.includes(".tmp."));
  assert.deepEqual(strays, [], `${label}: no temp file may survive (found ${JSON.stringify(strays)})`);
}

/** §8.2 no half-write: the sample byte sequence must be exactly what is still on disk. */
async function assertOriginalSurvives(file, bytes, label) {
  const after = await fs.readFile(file);
  assert.equal(sha256(after), sha256(bytes), `${label}: the original state file must not be rewritten`);
  await assertNoTempResidue(path.dirname(file), label);
}

const countIssues = (issues, needle) => issues.filter((issue) => issue.includes(needle)).length;
const pathsOf = (records) => records.map((record) => record.path).sort();
const lifecycleById = (state) => Object.fromEntries((state.records || []).map((record) => [record.id, record.lifecycle]));

// ------------------------------------------------------------------ cases

const CASES = {
  async "v1-legacy"(ctx) {
    const file = await writeState(stateFileFor("v1-legacy"), ctx.bytes);
    const ids = idsByPath(ctx.sample);

    if (ctx.negative) {
      // Pre-fix model: load() materialized every v1 record as a live public candidate.
      const service = new PublishService({ file });
      await service.ready;
      assert.equal(
        (await service.list()).length,
        Object.keys(ids).length,
        "pre-fix: every v1 record is already a published candidate on load",
      );
      return;
    }

    const service = new PublishService({ file });
    await service.ready;
    assert.equal(service.migrationIssues.length, 3, `one issue per legacy record, got ${JSON.stringify(service.migrationIssues)}`);
    assert.equal(countIssues(service.migrationIssues, "record_lifecycle_missing"), 3, "an absent lifecycle is reported, not invented");
    // Nothing was guessed and nothing was written: the v1 file is untouched until an
    // explicit observation decides a record.
    await assertOriginalSurvives(file, ctx.bytes, "v1-legacy (load)");
    assert.equal((await readState(file)).version, 1, "load must not rewrite the v1 file");
    // §8.1 is normative about the *loaded model*, not only about the file: a migrated
    // record is `unknown` until an observation says otherwise. Observation would correct
    // an over-eager `active`, so this is the only place that pins the pre-observation value.
    assert.ok(
      service.data.records.every((record) => record.lifecycle === PUBLISH_LIFECYCLE.UNKNOWN),
      `a migrated v1 record must be unknown before observation, got ${JSON.stringify(service.data.records.map((record) => record.lifecycle))}`,
    );

    const visible = await service.list({ includeInactive: true });
    assert.deepEqual(pathsOf(visible), [
      "Notes/Legacy-Markdown.md",
      "Notes/Legacy-Missing.md",
      "Notes/Legacy-NonMarkdown.canvas",
    ]);
    const persisted = await readState(file);
    assert.equal(persisted.version, STATE_VERSION_V2, "the first observation persists the state as v2");
    const lifecycle = lifecycleById(persisted);
    assert.equal(lifecycle[ids["Notes/Legacy-Markdown.md"]], PUBLISH_LIFECYCLE.ACTIVE, "an existing Markdown target becomes active");
    assert.equal(lifecycle[ids[PUBLISH_MIGRATION_MISSING_PATH]], PUBLISH_LIFECYCLE.ORPHANED, "a missing legacy target fails closed to orphaned");
    assert.equal(lifecycle[ids["Notes/Legacy-NonMarkdown.canvas"]], PUBLISH_LIFECYCLE.INVALID, "a non-Markdown legacy target fails closed to invalid");
    for (const record of persisted.records) {
      assert.deepEqual(
        Object.keys(record).sort(),
        ["createdAt", "createdBy", "id", "lifecycle", "path", "updatedAt", "vaultId"],
        "unknown v1 keys (publicUrl / retrievalHint) must not be carried forward",
      );
    }
    // Public surfaces: exactly the active record, and the retired ids stay dead.
    assert.deepEqual(pathsOf(await service.list()), ["Notes/Legacy-Markdown.md"], "only the active record is a published candidate");
    assert.equal(await service.resolve(ids[PUBLISH_MIGRATION_MISSING_PATH]), null, "an orphaned legacy id never resolves");
    assert.equal(await service.resolve(ids["Notes/Legacy-NonMarkdown.canvas"]), null, "an invalid legacy id never resolves");
    const served = await service.resolve(ids["Notes/Legacy-Markdown.md"]);
    assert.ok(served?.note?.content.includes("Legacy markdown"), "the adopted Markdown record serves its current body");
    await assertNoTempResidue(path.dirname(file), "v1-legacy (observed)");

    const restarted = new PublishService({ file });
    await restarted.ready;
    assert.equal(await restarted.resolve(ids[PUBLISH_MIGRATION_MISSING_PATH]), null, "a retired id stays dead across a restart");
    assert.ok(await restarted.resolve(ids["Notes/Legacy-Markdown.md"]), "an active id keeps serving across a restart");
  },

  async "v1-partial-records"(ctx) {
    const file = await writeState(stateFileFor("v1-partial-records"), ctx.bytes);

    if (ctx.negative) {
      const service = new PublishService({ file });
      await service.ready;
      const visible = await service.list({ includeInactive: true });
      assert.ok(
        visible.some((record) => record.path === "Notes/No-Id.md" || record.path.includes("escape")),
        "pre-fix: a malformed or unsafe record survived migration",
      );
      return;
    }

    const service = new PublishService({ file });
    await service.ready; // one bad record must not stop the service (§8.1)
    await assertOriginalSurvives(file, ctx.bytes, "v1-partial-records (load)");
    const issues = service.migrationIssues;
    assert.equal(countIssues(issues, "record_id_missing"), 1, JSON.stringify(issues));
    assert.equal(countIssues(issues, "record_vault_id_missing"), 1, JSON.stringify(issues));
    assert.equal(countIssues(issues, "record_path_missing"), 1, JSON.stringify(issues));
    assert.equal(countIssues(issues, "record_not_an_object"), 2, JSON.stringify(issues));
    assert.equal(countIssues(issues, "record_lifecycle_unrecognized"), 1, JSON.stringify(issues));
    assert.equal(countIssues(issues, "unsafe_record_path"), 2, JSON.stringify(issues));

    const visible = await service.list({ includeInactive: true });
    assert.deepEqual(pathsOf(visible), ["Notes/Dropped-Fields.md", "Notes/Unknown-Lifecycle.md"], "only the recoverable records survive");
    for (const record of visible) {
      assert.ok(!record.path.startsWith("/") && !record.path.includes("\\") && !record.path.includes(".."), `no unsafe path may be listed: ${record.path}`);
    }
    const persisted = await readState(file);
    // Adopting an `unknown` record is a persisted transition, so the migrated state is
    // written as v2 here — and a save must never carry a raw v1 entry forward.
    assert.equal(persisted.version, STATE_VERSION_V2, "observing an unknown record persists the migrated state as v2");
    assert.ok(
      persisted.records.every((record) => record && typeof record.path === "string"),
      `no unmigrated v1 entry may survive a save: ${JSON.stringify(persisted.records)}`,
    );
    const byPath = Object.fromEntries(persisted.records.map((record) => [record.path, record]));
    assert.equal(byPath["Notes/Dropped-Fields.md"].lifecycle, PUBLISH_LIFECYCLE.ACTIVE);
    assert.equal(byPath["Notes/Unknown-Lifecycle.md"].lifecycle, PUBLISH_LIFECYCLE.INVALID, "an unrecognized lifecycle fails closed to invalid");
    assert.deepEqual(pathsOf(await service.list()), ["Notes/Dropped-Fields.md"], "an invalid record is never a published candidate");
    assert.equal(
      await service.resolve(byPath["Notes/Unknown-Lifecycle.md"].id),
      null,
      "an unrecognized-lifecycle record is never served, even though its Markdown target exists",
    );
  },

  async "v1-duplicates"(ctx) {
    const file = await writeState(stateFileFor("v1-duplicates"), ctx.bytes);

    if (ctx.negative) {
      const service = new PublishService({ file });
      await service.ready;
      assert.equal((await service.list({ includeInactive: true })).length, 3, "pre-fix: duplicate v1 identities are both served");
      return;
    }

    const service = new PublishService({ file });
    await service.ready;
    assert.equal(countIssues(service.migrationIssues, "record_id_duplicate"), 1, JSON.stringify(service.migrationIssues));
    assert.equal(countIssues(service.migrationIssues, "record_document_duplicate"), 1, JSON.stringify(service.migrationIssues));
    const visible = await service.list({ includeInactive: true });
    assert.deepEqual(pathsOf(visible), ["Notes/First-Wins.md"], "the first occurrence of a duplicated identity wins");
    await assertNoTempResidue(path.dirname(file), "v1-duplicates");
  },

  async "v2-active-nonmarkdown"(ctx) {
    const sample = await fixtureJson("v2-active-nonmarkdown.json");
    const id = idsByPath(sample)["Notes/Historic.canvas"];
    const file = await writeState(stateFileFor("v2-active-nonmarkdown"), ctx.bytes);
    const service = new PublishService({ file });
    await service.ready;

    if (ctx.negative) {
      assert.ok(await service.resolve(id), "pre-fix: a non-Markdown active record is served anonymously");
      return;
    }

    await assertOriginalSurvives(file, ctx.bytes, "v2-active-nonmarkdown (load)");
    assert.equal(await service.resolve(id), null, "§15 S01: resolve never serves a non-Markdown target");
    const persisted = await readState(file);
    assert.equal(lifecycleById(persisted)[id], PUBLISH_LIFECYCLE.INVALID, "the first read retires the historical invalid record");
    assert.deepEqual(await service.list(), [], "an invalid record is not a published candidate");
    const admin = await service.list({ includeInactive: true });
    assert.deepEqual(pathsOf(admin), ["Notes/Historic.canvas"], "Admin can still see and clean the invalid record");
    await assertNoTempResidue(path.dirname(file), "v2-active-nonmarkdown");
  },

  async "save-atomicity"(ctx) {
    const directory = path.join(stateDir, "atomic");
    const file = path.join(directory, "state.json");
    const service = new PublishService({ file });
    await service.ready;
    await service.publish(VAULT, "Notes/Atomic.md");
    assert.equal((await readState(file)).version, STATE_VERSION_V2, "the published state is persisted as v2");
    await assertNoTempResidue(directory, "save-atomicity (clean save)");

    // Block the directory so the *next* save cannot write: it must reject and leave no
    // partial file behind (temp + rename, §8.2).
    await fs.rm(directory, { recursive: true, force: true });
    await fs.writeFile(directory, "blocker");

    if (ctx.negative) {
      const swallowed = await attempt(() => service.publish(VAULT, "Notes/Atomic2.md"));
      assert.equal(swallowed.ok, true, "pre-fix: a failed save is swallowed and the mutation reports success");
      return;
    }

    const failure = await attempt(() => service.publish(VAULT, "Notes/Atomic2.md"));
    assert.equal(failure.ok, false, "a failed save must surface instead of losing the mutation");
    assert.ok(
      ["EEXIST", "ENOTDIR", "EISDIR", "EPERM"].includes(failure.code),
      `unexpected save failure code ${failure.code}: ${failure.message}`,
    );
    assert.equal(await fs.readFile(file, "utf8").then(() => true, () => false), false, "no half-written state file is left behind");
    assert.equal((await fs.stat(directory)).isFile(), true, "the blocking file is untouched");
    const strays = (await fs.readdir(path.dirname(directory))).filter((entry) => entry.includes(".tmp"));
    assert.deepEqual(strays, [], "no temp residue after a failed save");
  },
};

async function runRejectionCase(ctx, needle) {
  const file = await writeState(stateFileFor(ctx.entry.id), ctx.bytes);
  const service = new PublishService({ file });

  if (ctx.negative) {
    await service.ready; // pre-fix: the broken file loaded and was silently repaired
    const repaired = await readState(file);
    assert.equal(repaired.version, STATE_VERSION_V2, "pre-fix: a broken state file is tolerated and rewritten as an empty v2 state");
    return;
  }

  await assert.rejects(service.ready, /Cannot load publish state/, `${ctx.entry.id}: a broken state file must be fatal`);
  await assert.rejects(service.ready, new RegExp(needle), `${ctx.entry.id}: the refusal must name the actual cause`);
  await assertOriginalSurvives(file, ctx.bytes, `${ctx.entry.id} (refused)`);
  // Deterministic: a second load of the same bytes refuses identically instead of
  // "repairing" the file as a side effect of the first attempt.
  const second = new PublishService({ file });
  await assert.rejects(second.ready, /Cannot load publish state/);
  await assertOriginalSurvives(file, ctx.bytes, `${ctx.entry.id} (refused twice)`);
}

CASES["corrupt-not-json"] = (ctx) => runRejectionCase(ctx, "Cannot load publish state");
CASES["unsupported-version"] = (ctx) => runRejectionCase(ctx, "unsupported state version 7");
CASES["records-not-array"] = (ctx) => runRejectionCase(ctx, "malformed state file");
CASES["top-level-array"] = (ctx) => runRejectionCase(ctx, "malformed state file");

// ------------------------------------------------------------------ run

const results = [];
try {
  for (const entry of selected) {
    const bytes = entry.stateFile ? await fixtureBytes(entry.stateFile) : null;
    const sample = entry.stateFile && !entry.stateFile.startsWith("corrupt") ? JSON.parse(bytes.toString("utf8")) : null;
    const ctx = { entry, bytes, sample, negative: negativeFor(entry.id) };
    const start = Date.now();
    try {
      await CASES[entry.id](ctx);
      results.push({ ...entry, pass: true, negative: ctx.negative, ms: Date.now() - start });
      if (ctx.negative) console.log(`NEGATIVE-CONTROL MISSED ${entry.id}: the guard accepted the pre-fix expectation`);
      else console.log(`PASS ${entry.id}: ${entry.name}`);
    } catch (error) {
      results.push({ ...entry, pass: false, negative: ctx.negative, ms: Date.now() - start, error: error.message });
      if (ctx.negative) console.log(`NEGATIVE-CONTROL OK ${entry.id}: ${entry.guard}`);
      else console.log(`FAIL ${entry.id}: ${error.message}`);
    }
  }
} finally {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

const passed = results.filter((item) => item.pass).length;
const failed = results.length - passed;
const missed = results.filter((item) => item.negative && item.pass).length;
const detected = results.filter((item) => item.negative && !item.pass).length;
console.log(`cases: ${results.length}  passed: ${passed}  failed: ${failed}`);
if (inNegativeMode) {
  console.log(`negative-control: ${detected} guard(s) rejected the pre-fix expectation, ${missed} missed (${negativeEnv})`);
}

if (options.output) {
  const outputRoot = path.resolve(options.output);
  await fs.mkdir(outputRoot, { recursive: true });
  const resultsPath = path.join(outputRoot, "results.json");
  await fs.writeFile(
    resultsPath,
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      mode: inNegativeMode ? "negative-control" : "green",
      negativeControl: inNegativeMode ? negativeEnv : null,
      vaultId: VAULT,
      cases: results,
      passed,
      failed,
      detected,
      missed,
    }, null, 2)}\n`,
    "utf8",
  );
  console.log(`results: ${resultsPath}`);
}
if (options.json) console.log(JSON.stringify({ passed, failed, detected, missed, cases: results }, null, 2));

// A negative-control run is red by design (repo convention): its proof is the
// `NEGATIVE-CONTROL OK` lines, not a zero exit code.
process.exitCode = inNegativeMode ? 1 : failed === 0 ? 0 : 1;
