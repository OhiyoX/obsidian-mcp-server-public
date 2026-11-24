// M0 — benchmark harness contract (plan 01 Task 1).
//
// The harness exists so a 383 MiB production-sized index can be measured without
// touching production and without slowing the normal gate: it runs a child
// process on an isolated copy and reports numbers only.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertIsolatedRoot, bytesToMiB, runRetrievalMemoryBenchmark } from "../scripts/retrieval-memory-benchmark.mjs";

async function makeFixture(root) {
  const vault = path.join(root, "vault");
  await fs.mkdir(vault, { recursive: true });
  await fs.writeFile(path.join(vault, "Note.md"), "# Note\n\nalpha needle\n", "utf8");
  await fs.writeFile(path.join(vault, "Other.md"), "# Other\n\n中文内容 beta\n", "utf8");
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  return root;
}

test("production roots are refused", () => {
  for (const forbidden of ["/data", "/data/index", "/srv/x", "/workspace/projects/obsidian-mcp-server/repo", "/app"]) {
    assert.throws(() => assertIsolatedRoot(forbidden), /refusing to benchmark/u);
  }
  assert.throws(() => assertIsolatedRoot(""), /non-empty path/u);
  const previous = process.env.DATA_PATH;
  process.env.DATA_PATH = "/srv/live-data";
  try {
    assert.throws(() => assertIsolatedRoot("/srv/live-data/index"), /configured live Vault\/Data root/u);
  } finally {
    if (previous === undefined) delete process.env.DATA_PATH;
    else process.env.DATA_PATH = previous;
  }
  assert.equal(assertIsolatedRoot("/tmp/isolated-copy"), "/tmp/isolated-copy");
});

test("sizes are MiB, not MB", () => {
  assert.equal(bytesToMiB(1048576), 1);
  assert.equal(bytesToMiB(402027808), 383.4);
  assert.equal(bytesToMiB(null), null);
});

test("a small isolated fixture produces a complete report", { timeout: 120000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-bench-fixture-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await makeFixture(path.join(root, "fixture"));
  const output = path.join(root, "out");

  const report = await runRetrievalMemoryBenchmark({ fixtureRoot: path.join(root, "fixture"), outputDir: output, label: "unit" });
  for (const key of ["label", "generatedAt", "node", "fixture", "index", "cgroup", "stages", "units", "unavailable"]) {
    assert.ok(Object.hasOwn(report, key), `report field ${key}`);
  }
  assert.equal(report.label, "unit");
  assert.equal(report.fixture.vaultNotes, 2);
  assert.ok(report.index.bytes > 0, "the sync must produce an index file in the isolated copy");
  assert.equal(report.units.size, "MiB (1048576 bytes)");
  assert.ok(report.stages.cold, "cold stage");
  assert.ok(report.stages.warm, "warm stage");
  assert.equal(report.stages.latency.samples >= 2, true);
  assert.equal(report.stages.noOpSync.writes, 0, "M1: an unchanged sync writes nothing");
  assert.equal(report.stages.noOpSync.hashUnchanged, true);
  assert.equal(report.stages.singleNoteUpdate.updated, 1);

  const written = JSON.parse(await fs.readFile(path.join(output, "unit.json"), "utf8"));
  assert.deepEqual(written.stages.noOpSync, report.stages.noOpSync);
});

test("the fixture itself is never written", { timeout: 120000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-bench-readonly-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = path.join(root, "fixture");
  await makeFixture(fixture);
  const before = await fs.readFile(path.join(fixture, "vault", "Note.md"), "utf8");
  await runRetrievalMemoryBenchmark({ fixtureRoot: fixture, outputDir: path.join(root, "out") });
  assert.equal(await fs.readFile(path.join(fixture, "vault", "Note.md"), "utf8"), before, "the benchmark appends only inside its temp copy");
  assert.deepEqual(await fs.readdir(path.join(fixture, "data")), [], "nothing is persisted into the fixture data dir");
});
