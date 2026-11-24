import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { QRELS_FIXTURE_DIR, compareToExpected, loadQrelsFixture, runQrelsGate } from "../scripts/search-v2-baseline.mjs";

// Search v2 Task S1 — frozen relevance and hard-filter gate.
//
// This is a *measurement* gate: it adds no ranking change. It grades today's
// production search path against a graded answer key (qrels) and freezes the
// numbers in test/fixtures/search-v2/expected.json. The suite is red when the
// answer key, the corpus, or the ranking drifts, and it is also red when the
// gate itself stops being able to catch drift — each guard below is exercised
// against a deliberately broken copy of the fixture.
//
// The measured path is the production one: a temporary Vault is built from
// corpus.json, `syncRetrievalIndex` builds the real index, `getVaultIndex`
// supplies the real records, and `hybridSearch` + `parseObsidianQuery` run the
// same call `search_notes` makes. No second index, no second scorer.
const expected = JSON.parse(await fs.readFile(path.join(QRELS_FIXTURE_DIR, "expected.json"), "utf8"));

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "search-v2-qrels-gate-"));
after(() => fs.rm(scratch, { recursive: true, force: true }));

let counter = 0;
async function fixtureCopy(mutate) {
  counter += 1;
  const directory = path.join(scratch, `fixture-${counter}`);
  await fs.cp(QRELS_FIXTURE_DIR, directory, { recursive: true });
  await mutate(directory);
  return directory;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

// One shared measurement of the shipped fixture: the guard tests below only need
// to watch the gate reject broken input, not to re-measure the corpus.
const measured = runQrelsGate({ fixtureDir: QRELS_FIXTURE_DIR });

test("the shipped fixture passes its own frozen gate", async () => {
  const report = await measured;
  assert.deepEqual(compareToExpected(report, expected), []);
  assert.equal(report.fixtureHash, expected.fixtureHash);
  assert.ok(report.noteCount >= 15 && report.noteCount <= 25, `corpus size ${report.noteCount} outside 15..25`);
});

test("every declared category carries a graded answer key and measured numbers", async () => {
  const report = await measured;
  const categories = new Set(report.queries.map((entry) => entry.category));
  for (const category of new Set(expected.queries.map((entry) => entry.category))) {
    assert.ok(categories.has(category), `category ${category} is missing from the report`);
  }
  for (const entry of report.queries) {
    assert.ok(entry.graded >= 1, `query ${entry.query} has no graded row`);
    assert.ok(entry.top1Path !== null, `query ${entry.query} returned nothing`);
    assert.ok(typeof entry.ndcg10 === "number");
    assert.ok(entry.latencyMs.p50 >= 0 && entry.latencyMs.p95 >= entry.latencyMs.p50);
  }
  for (const row of report.categories) {
    assert.ok(row.queries >= 1 && typeof row.ndcg10 === "number" && row.p95Ms >= row.p50Ms);
  }
});

test("a missing qrels file fails the gate", async () => {
  const directory = await fixtureCopy((target) => fs.rm(path.join(target, "qrels.json")));
  await assert.rejects(loadQrelsFixture(directory), /qrels\.json is missing/);
});

test("a qrel whose docId has no fixture note fails the gate", async () => {
  const directory = await fixtureCopy(async (target) => {
    const file = path.join(target, "qrels.json");
    const qrels = await readJson(file);
    qrels.rows.push({ query: "retry policy", constraints: {}, docId: "Notes/Not In Corpus.md", relevance: 1 });
    await fs.writeFile(file, `${JSON.stringify(qrels, null, 2)}\n`, "utf8");
  });
  await assert.rejects(loadQrelsFixture(directory), /not in the corpus/);
});

test("a corpus tampered with by one byte fails on the frozen fixture hash", async () => {
  const directory = await fixtureCopy(async (target) => {
    const file = path.join(target, "corpus.json");
    const bytes = await fs.readFile(file, "utf8");
    const tampered = bytes.replace("Keep 14 daily backups", "Keep 15 daily backups");
    assert.notEqual(tampered, bytes, "the tamper edit must really change a byte");
    await fs.writeFile(file, tampered, "utf8");
  });
  await assert.rejects(loadQrelsFixture(directory), /fixture hash mismatch/);
});

test("a wrong frozen expectation turns the gate red (the gate can catch a regression)", async () => {
  const report = await measured;
  const wrong = structuredClone(expected);
  const first = wrong.queries[0];
  const second = wrong.queries.find((entry) => entry.query !== first.query);
  second.ranking = first.ranking;
  second.top1Path = first.top1Path;
  second.ndcg10 = first.ndcg10;
  const failures = compareToExpected(report, wrong);
  assert.ok(failures.length > 0, "a swapped expectation must not pass");
  assert.ok(failures.some((line) => line.includes(second.query)), `failures must name the drifted query: ${failures.join("; ")}`);
});

test("a swapped relevance grade turns the gate red against the frozen numbers", async () => {
  const directory = await fixtureCopy(async (target) => {
    const file = path.join(target, "qrels.json");
    const qrels = await readJson(file);
    const canonical = qrels.rows.find((row) => row.query === "retry policy" && row.relevance === 2);
    const related = qrels.rows.find((row) => row.query === "retry policy" && row.relevance === 1);
    canonical.relevance = 1;
    related.relevance = 2;
    await fs.writeFile(file, `${JSON.stringify(qrels, null, 2)}\n`, "utf8");
  });
  const report = await runQrelsGate({ fixtureDir: directory });
  const failures = compareToExpected(report, expected);
  assert.ok(failures.some((line) => line.includes("retry policy")), `a swapped grade must move the numbers: ${failures.join("; ")}`);
});

test("a cheat fixture that names its answer file in the query is rejected", async () => {
  const directory = await fixtureCopy(async (target) => {
    const file = path.join(target, "qrels.json");
    const qrels = await readJson(file);
    const query = "path:Ops/Deploy Runbook.md";
    qrels.queries.find((entry) => entry.category === "path-constraint").query = query;
    for (const row of qrels.rows.filter((item) => item.query === "path:Ops deploy")) row.query = query;
    await fs.writeFile(file, `${JSON.stringify(qrels, null, 2)}\n`, "utf8");
  });
  await assert.rejects(loadQrelsFixture(directory), /names its answer/);
});
