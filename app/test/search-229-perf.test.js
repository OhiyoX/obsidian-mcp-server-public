// Issue #229 follow-up / D1 — §16 performance / I/O observations.
//
// Two observable paths over synthetic record sets (300 / 1k / 10k):
//   1. the bounded zero-result diagnostics builder (contract §7.3);
//   2. exact-positive auto search, which must not touch retrieval.
//
// The measured numbers are *observations written to evidence*, not thresholds:
// the only assertions are the contract bounds (<=8 groups, <=16 cumulative
// clauses), the corpus-independence of the diagnostics groups payload, and the
// retrieval lifecycle fact (retrievalIndexStatusSnapshot() stays null).
//
// Run:
//   cd app
//   node --test test/search-229-perf.test.js

import assert from "node:assert/strict";
import test from "node:test";
import { buildZeroResultDiagnostics } from "../src/search/query-diagnostics.js";
import { parseObsidianQuery } from "../src/search/obsidian-query.js";
import { hybridSearch } from "../src/search/hybrid-search.js";
import { retrievalIndexStatusSnapshot } from "../src/retrieval.js";

const SIZES = [300, 1000, 10000];

// Query with 9 OR groups / 18 clauses over tokens that never appear, so the
// diagnostics payload is dominated by the bounded explainer itself.
const BOUNDED_QUERY = "a1 b1 OR a2 b2 OR a3 b3 OR a4 b4 OR a5 b5 OR a6 b6 OR a7 b7 OR a8 b8 OR a9 b9";

function makeRecord(index) {
  const path = `Synthetic/Note ${index}.md`;
  const content = index % 2 === 0 ? "alpha beta gamma delta" : `epsilon zeta unique-${index}`;
  return {
    path,
    name: `Note ${index}.md`,
    basename: `Note ${index}`,
    aliases: [],
    tags: index % 3 === 0 ? ["x"] : [],
    frontmatter: {},
    content,
    raw: content,
    stat: { size: content.length, created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z" },
    revision: `sha256:${index}`,
  };
}

function makeRecords(size) {
  return Array.from({ length: size }, (_, index) => makeRecord(index));
}

function timed(fn) {
  const cpuStart = process.cpuUsage();
  const wallStart = process.hrtime.bigint();
  const value = fn();
  const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;
  const cpu = process.cpuUsage(cpuStart);
  return { value, wallMs, cpuMs: (cpu.user + cpu.system) / 1000 };
}

const diagnosticsGroups = new Map();

for (const size of SIZES) {
  test(`§16 diagnostics on ${size} records: bounded groups/clauses and corpus-independent payload`, () => {
    const records = makeRecords(size);
    const parsed = parseObsidianQuery(BOUNDED_QUERY);
    const { value: diagnostics, wallMs, cpuMs } = timed(() => buildZeroResultDiagnostics(records, parsed, {}));

    assert.equal(diagnostics.candidateRecords, size);
    assert.equal(diagnostics.groupCount, 9);
    assert.equal(diagnostics.truncated, true);
    assert.ok(diagnostics.groups.length <= 8);
    const totalClauses = diagnostics.groups.reduce((sum, group) => sum + group.clauses.length, 0);
    assert.ok(totalClauses <= 16, `expected <=16 clauses, saw ${totalClauses}`);
    assert.ok(Number.isFinite(wallMs) && wallMs >= 0);
    assert.ok(Number.isFinite(cpuMs) && cpuMs >= 0);

    const bytes = Buffer.byteLength(JSON.stringify(diagnostics), "utf8");
    assert.ok(Number.isFinite(bytes) && bytes > 0);
    diagnosticsGroups.set(size, diagnostics.groups);

    console.log(`# perf diagnostics ${size} records x ${diagnostics.groupCount} groups -> wall ${wallMs.toFixed(2)} ms, cpu ${cpuMs.toFixed(2)} ms, bytes ${bytes}`);
  });
}

test("§16 diagnostics payload carries no per-record data at any size", () => {
  const base = diagnosticsGroups.get(SIZES[0]);
  assert.ok(base, "the diagnostics observation must have run first");
  for (const size of SIZES.slice(1)) {
    assert.deepEqual(
      diagnosticsGroups.get(size),
      base,
      `diagnostics groups must not grow with the corpus (${size} vs ${SIZES[0]})`,
    );
  }
});

for (const size of SIZES) {
  test(`§16 exact-positive auto on ${size} records: no retrieval cold-load`, async () => {
    const records = makeRecords(size);
    const parsed = parseObsidianQuery("alpha");
    const snapshotBefore = retrievalIndexStatusSnapshot();
    assert.equal(snapshotBefore, null, "setup: retrieval must never have been loaded");

    const cpuStart = process.cpuUsage();
    const wallStart = process.hrtime.bigint();
    const search = await hybridSearch(records, parsed, {});
    const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;
    const cpu = process.cpuUsage(cpuStart);
    const cpuMs = (cpu.user + cpu.system) / 1000;

    assert.equal(search.semanticMode, "auto");
    assert.equal(search.fallbackUsed, false);
    assert.equal(search.hybridUsed, false);
    assert.equal(search.semanticUsed, false);
    assert.equal(search.exactMatched, Math.ceil(size / 2));
    assert.equal(retrievalIndexStatusSnapshot(), null, "exact-positive auto must not load or refresh retrieval");
    assert.ok(Number.isFinite(wallMs) && wallMs >= 0);
    assert.ok(Number.isFinite(cpuMs) && cpuMs >= 0);

    console.log(`# perf exact-positive auto ${size} records -> wall ${wallMs.toFixed(2)} ms, cpu ${cpuMs.toFixed(2)} ms, exactMatched ${search.exactMatched}`);
  });
}
