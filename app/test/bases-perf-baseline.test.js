// BASES P1 Wave 0 / W0-C — performance & scale baseline for the canonical Base
// domain layer (app/src/base-query.js + app/src/workflows.js).
//
// Measured, at 10k and 50k deterministic synthetic records, each timed
// independently and repeated (min / median / max):
//   1. parseAndValidateBase + compileBaseView          (compile path)
//   2. evaluateBaseView                                (pure filter)
//   3. sortBaseRecords                                 (pure sort, date/number/string tie-break)
//   4. evaluateBaseView                                (formula projection, file.asLink subset)
//   5. queryBaseSnapshot                               (full pipeline: filter+sort+formula+limit)
//
// Assertions are INVARIANTS ONLY: row/totalMatched counts, same-input-same-output
// determinism, stable tie-break across repeats, no exceptions, supportedSubset.
// There is deliberately NO wall-clock threshold anywhere. Contract §6.6 / §14.8:
// a hard millisecond budget may only be derived from repeated stable measurements
// on one runner, never guessed. Timings are recorded, not gated.
//
// Output: one `BASES_PERF_BASELINE_JSON {...}` console line plus a JSON file
// (env BASES_PERF_OUT, default: the lane directory above this worktree).
//
// Run: cd app && node --test test/bases-perf-baseline.test.js

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  compileBaseView,
  evaluateBaseView,
  parseAndValidateBase,
  queryBaseSnapshot,
} from "../src/base-query.js";
import { sortBaseRecords } from "../src/workflows.js";

const REPS = 5;
const MEASUREMENT_COUNT = 5;
const FILTER_ARCHIVED_EVERY = 7;
const FULL_LIMIT = 5000;

// One Base document with purpose-built views so each measurement isolates one
// stage. `filters` live on the views (not the root) so the projection and sort
// measurements run without a filter. All formula syntax stays inside the frozen
// P0 subset (file.asLink + nested if + file.name + bare property).
const BASE_RAW = `formulas:
  label: 'file.asLink(if(title, title, file.name))'
views:
  - type: table
    name: FilterOnly
    filters: 'status != "archived"'
    order: [file.path]
    limit: 1
  - type: table
    name: Projection
    order: [file.path, title, rank, due, done, labels, status, ref, formula.label]
  - type: table
    name: Overview
    filters: 'status != "archived"'
    order: [file.path, title, rank, due, done, labels, status, ref, formula.label]
    sort:
      - { property: due, direction: ASC }
      - { property: rank, direction: DESC }
    limit: ${FULL_LIMIT}
`;

const PROJECTION_ORDER = Object.freeze([
  "file.path", "title", "rank", "due", "done", "labels", "status", "ref", "formula.label",
]);

// Date -> number -> string tie-break chain (the third column exists only here:
// the string fallback is the expensive comparator branch).
const SORT_KEYS = Object.freeze([
  { property: "due", direction: "ASC" },
  { property: "rank", direction: "DESC" },
  { property: "title", direction: "ASC" },
]);

const pad2 = (value) => String(value).padStart(2, "0");

// Deterministic, pure-function synthetic record generator. No RNG, no clock:
// the same `count` always yields the same array, so determinism assertions are
// meaningful and the generated set is reproducible from this file alone.
// Field coverage: string (title/status/note), number (rank), date-string (due),
// boolean (done), list (labels/tags/links), missing (title/ref), null (note) and
// a structured `asLink` column (ref frontmatter + formula.label projection).
function makeRecords(count) {
  const records = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const id = String(i).padStart(6, "0");
    const frontmatter = {
      rank: i % 997,
      due: `2026-${pad2((i % 12) + 1)}-${pad2((i % 28) + 1)}`,
      done: i % 2 === 0,
      labels: [`l${i % 5}`, `l${i % 7}`, `l${i % 11}`],
      status: i % FILTER_ARCHIVED_EVERY === 0 ? "archived" : i % 3 === 0 ? "active" : "paused",
      note: i % 11 === 0 ? null : `note ${i}`,
    };
    if (i % 17 !== 0) frontmatter.title = `Title ${i}`; // missing => file.name branch
    if (i % 13 !== 0) {
      frontmatter.ref = { path: `Target/${id}.md`, displayName: `Target ${id}`, kind: "asLink" };
    }
    records[i] = {
      path: `Folder${i % 8}/Note ${id}.md`,
      basename: `Note ${id}`,
      frontmatter,
      tags: [`t${i % 4}`, `t${i % 6}`],
      links: [{ target: `Target/${id}` }, { target: "Hub" }],
      stat: { size: 100 + (i % 500), created: "2026-01-01T00:00:00.000Z", modified: "2026-06-01T00:00:00.000Z" },
    };
  }
  return records;
}

function expectedMatched(count) {
  return count - Math.ceil(count / FILTER_ARCHIVED_EVERY);
}

function memorySample() {
  const usage = process.memoryUsage();
  return { heapUsed: usage.heapUsed, rss: usage.rss };
}

function summarizeTimes(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { min: sorted[0], median, max: sorted[sorted.length - 1] };
}

const round = (value) => Number(value.toFixed(3));

// Runs `run` `reps` times, timing each rep and taking the peak heap/rss growth
// across reps (no forced GC under `node --test`, so heap deltas are an upper
// bound that includes uncollected garbage). Never throws away failures: a throw
// propagates and fails the test.
function measure(label, run, { reps = REPS, retain = true } = {}) {
  const times = [];
  let heapUsedDeltaBytesMax = 0;
  let rssDeltaBytesMax = 0;
  let retained;
  for (let rep = 0; rep < reps; rep += 1) {
    const before = memorySample();
    const started = performance.now();
    const value = run();
    times.push(performance.now() - started);
    const after = memorySample();
    heapUsedDeltaBytesMax = Math.max(heapUsedDeltaBytesMax, after.heapUsed - before.heapUsed);
    rssDeltaBytesMax = Math.max(rssDeltaBytesMax, after.rss - before.rss);
    if (retain) retained = value;
  }
  const ms = summarizeTimes(times);
  return {
    label,
    reps,
    samples: times.map(round),
    ms: { min: round(ms.min), median: round(ms.median), max: round(ms.max) },
    heapUsedDeltaBytesMax,
    rssDeltaBytesMax,
    retained,
  };
}

const FIELD = "\u0000";
const ROW = "\u0001";

function rowsSignature(rows) {
  return rows.map((row) => `${row.path}${FIELD}${JSON.stringify(row.values)}`).join(ROW);
}

function snapshotSignature(snapshot) {
  return [snapshot.view, snapshot.totalMatched, snapshot.truncated, snapshot.viewLimit, rowsSignature(snapshot.rows)].join(ROW);
}

// Invariant checks (never timings). Anything violated throws and fails the tier.
function verifyTier({ count, records, base, views, formulas }) {
  const wanted = expectedMatched(count);

  // 1. compile path: stable order / compiled formulas.
  const compiledA = compileBaseView(base, "Overview");
  const compiledB = compileBaseView(base, "Overview");
  assert.deepEqual(compiledA.order, PROJECTION_ORDER);
  assert.ok(Object.hasOwn(compiledA.formulas, "label"));
  assert.equal(JSON.stringify(compiledA.formulas), JSON.stringify(compiledB.formulas));

  // 2. pure filter: full match set (the timed measurement pins projection to one
  // row; this untimed pass projects every match so the predicate can be checked).
  const filteredA = evaluateBaseView({ base, view: views.FilterOnly, order: ["file.path"], formulas, records, limit: count });
  const filteredB = evaluateBaseView({ base, view: views.FilterOnly, order: ["file.path"], formulas, records, limit: count });
  assert.equal(filteredA.totalMatched, wanted);
  assert.equal(filteredA.supportedSubset, true);
  assert.equal(filteredA.rows.length, wanted);
  assert.ok(filteredA.rows.every((row) => row.values.status !== "archived"));
  assert.equal(rowsSignature(filteredA.rows), rowsSignature(filteredB.rows));

  // 3. pure sort: permutation + deterministic order + non-decreasing primary key.
  const dueOf = new Map(records.map((record) => [record.path, record.frontmatter.due]));
  const sortedA = sortBaseRecords(records, SORT_KEYS);
  const sortedB = sortBaseRecords(records, SORT_KEYS);
  const pathsA = sortedA.map((record) => record.path);
  const pathsB = sortedB.map((record) => record.path);
  assert.equal(pathsA.length, count);
  assert.deepEqual(pathsA, pathsB); // stable tie-break across repeats
  assert.deepEqual([...pathsA].sort(), records.map((record) => record.path).sort()); // permutation
  for (let index = 1; index < pathsA.length; index += 1) {
    assert.ok(dueOf.get(pathsA[index - 1]) <= dueOf.get(pathsA[index]), `due order broken at ${index}`);
  }

  // 4. formula projection: same input -> same output, structured asLink cells.
  let projection = evaluateBaseView({ base, view: views.Projection, order: PROJECTION_ORDER, formulas, records });
  const projectionSignature = rowsSignature(projection.rows);
  assert.equal(projection.rows.length, count);
  assert.equal(projection.supportedSubset, true);
  for (const row of projection.rows.slice(0, 200)) {
    const cell = row.values["formula.label"];
    assert.equal(cell.kind, "asLink");
    assert.equal(cell.path, row.path);
    assert.equal(typeof cell.displayName, "string");
    assert.ok(cell.displayName.length > 0);
  }
  const missingTitleRow = projection.rows.find((row) => row.values.title === undefined);
  assert.ok(missingTitleRow && missingTitleRow.values["formula.label"].displayName.length > 0);
  projection = null;
  const projectionSignatureB = rowsSignature(
    evaluateBaseView({ base, view: views.Projection, order: PROJECTION_ORDER, formulas, records }).rows,
  );
  assert.equal(projectionSignature, projectionSignatureB);

  // 5. full pipeline: counts, subset flag, qualifying rows, determinism.
  let full = queryBaseSnapshot({ raw: BASE_RAW, viewName: "Overview", records });
  const fullSignature = snapshotSignature(full);
  assert.equal(full.view, "Overview");
  assert.equal(full.totalMatched, wanted);
  assert.equal(full.supportedSubset, true);
  assert.equal(full.rows.length, Math.min(FULL_LIMIT, wanted));
  assert.equal(full.truncated, wanted > FULL_LIMIT);
  assert.ok(full.rows.every((row) => row.values.status !== "archived"));
  full = null;
  const replay = queryBaseSnapshot({ raw: BASE_RAW, viewName: "Overview", records });
  assert.equal(snapshotSignature(replay), fullSignature);

  return {
    expectedMatched: wanted,
    compileOrderMatchesProjectionOrder: true,
    compiledFormulaNames: Object.keys(compiledA.formulas),
    filterMatchedRows: filteredA.rows.length,
    sortPermutation: true,
    sortStableAcrossRepeats: true,
    sortPrimaryKeyNonDecreasing: true,
    projectionRows: count,
    projectionDeterministic: true,
    fullRows: Math.min(FULL_LIMIT, wanted),
    fullTotalMatched: wanted,
    fullTruncated: wanted > FULL_LIMIT,
    fullDeterministic: true,
  };
}

function runTier(tier, count) {
  const records = makeRecords(count);
  const { base } = parseAndValidateBase(BASE_RAW);
  const views = Object.fromEntries(base.views.map((view) => [view.name, view]));
  const formulas = compileBaseView(base, "Overview").formulas;

  const measurements = [
    measure("parseAndValidateBase+compileBaseView (compile)", () => {
      const parsed = parseAndValidateBase(BASE_RAW);
      return compileBaseView(parsed.base, "Overview");
    }),
    measure("evaluateBaseView (pure filter)", () =>
      evaluateBaseView({ base, view: views.FilterOnly, order: ["file.path"], formulas, records })),
    measure("sortBaseRecords (pure sort, date/number/string tie-break)", () =>
      sortBaseRecords(records, SORT_KEYS), { retain: false }),
    measure("evaluateBaseView (formula projection, file.asLink, all rows)", () =>
      evaluateBaseView({ base, view: views.Projection, order: PROJECTION_ORDER, formulas, records }), { retain: false }),
    measure("queryBaseSnapshot (full pipeline: filter+sort+formula+limit)", () =>
      queryBaseSnapshot({ raw: BASE_RAW, viewName: "Overview", records }), { retain: false }),
  ];

  const verification = verifyTier({ count, records, base, views, formulas });
  return {
    tier,
    recordCount: count,
    measurements: measurements.map(({ retained, ...rest }) => rest),
    verification,
  };
}

const tierResults = new Map();

function recordTier(tier, count) {
  const result = runTier(tier, count);
  tierResults.set(tier, result);
  return result;
}

test("10k synthetic records: baseline timings + invariants", () => {
  const result = recordTier("10k", 10000);
  assert.equal(result.recordCount, 10000);
  assert.equal(result.measurements.length, MEASUREMENT_COUNT);
  assert.ok(result.measurements.every((entry) => entry.reps === REPS && entry.samples.length === REPS));
});

test("50k synthetic records: baseline timings + invariants", () => {
  const result = recordTier("50k", 50000);
  assert.equal(result.recordCount, 50000);
  assert.equal(result.measurements.length, MEASUREMENT_COUNT);
  assert.ok(result.measurements.every((entry) => entry.reps === REPS && entry.samples.length === REPS));
});

test("both tiers: supportedSubset stays true and no wall-clock assertion exists", () => {
  for (const result of tierResults.values()) {
    assert.equal(result.verification.fullRows, Math.min(FULL_LIMIT, result.verification.expectedMatched));
  }
  assert.equal(tierResults.size, 2);
});

function buildSummary() {
  const cpus = os.cpus();
  return {
    kind: "bases-perf-baseline",
    generatedAt: new Date().toISOString(),
    contract: "Bases P1 Wave 0 / W0-C",
    thresholds: "none — timings are recorded, never asserted (contract §6.6 / §14.8)",
    reps: REPS,
    gcForced: typeof globalThis.gc === "function",
    machine: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpuModel: cpus[0]?.model ?? "unknown",
      cpuCount: cpus.length,
      totalMemBytes: os.totalmem(),
      freeMemBytes: os.freemem(),
      loadAvg: os.loadavg(),
    },
    loadDeclaration:
      "Declared: this host runs the bases-p1 W0-A/W0-B/W0-C lanes and other agent harnesses concurrently; " +
      "free memory/CPU are shared and timings are NOT load-controlled. Treat all numbers as one local baseline sample only.",
    tiers: [...tierResults.values()].sort((a, b) => a.recordCount - b.recordCount),
  };
}

async function writeSummary(summary) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const laneRoot = path.resolve(here, "..", "..", "..");
  const outPath = process.env.BASES_PERF_OUT || path.join(laneRoot, "perf-raw.json");
  try {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.log(`BASES_PERF_BASELINE_FILE ${outPath}`);
  } catch (error) {
    console.log(`BASES_PERF_BASELINE_FILE_WRITE_FAILED ${error.message}`);
  }
}

after(async () => {
  const summary = buildSummary();
  console.log(`BASES_PERF_BASELINE_JSON ${JSON.stringify(summary)}`);
  await writeSummary(summary);
});
