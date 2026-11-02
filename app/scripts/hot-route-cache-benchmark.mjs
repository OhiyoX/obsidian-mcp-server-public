#!/usr/bin/env node
// Hot Routes Phase 1-A — hermetic benchmark for the isolated HotRouteCache
// primitive.
//
// This is NOT a production benchmark. It uses an in-memory synthetic fixture,
// the actual `createHotRouteCache` primitive, and one deterministic derived
// function. It never reads the vault, never touches the network, and never
// sleeps. Before any timing is reported, every cached round is deep-equal to
// the uncached baseline for the same input; any mismatch fails the run.
//
// Honesty rules:
//   - CPU and RSS are reported only because they are measured here with
//     `process.cpuUsage()` / `process.memoryUsage().rss`.
//   - Filesystem calls are NOT measured; the primitive imports no filesystem
//     module, so the label stays `measured: false`.
//   - No performance ratio gate, production TTL, capacity, or hit-rate claim is
//     made. The numbers are fixture-local observations only.

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";

import { createHotRouteCache } from "../src/hot-route-cache.js";

const ROUNDS = Number.parseInt(process.env.HOT_ROUTE_BENCH_ROUNDS ?? "200", 10);
const RECORDS = Number.parseInt(process.env.HOT_ROUTE_BENCH_RECORDS ?? "4000", 10);

function parseOutputPath(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out") return path.resolve(process.cwd(), argv[index + 1]);
    if (argv[index].startsWith("--out=")) return path.resolve(process.cwd(), argv[index].slice("--out=".length));
  }
  return null;
}

// Deterministic seeded fixture (mulberry32), no randomness across runs.
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildRecords(count) {
  const random = seeded(0x51f15e);
  const folders = ["Projects", "Areas", "Archive", "Maps", "Skills"];
  const tags = ["alpha", "beta", "gamma", "delta", "epsilon"];
  const records = [];
  for (let index = 0; index < count; index += 1) {
    const folder = folders[index % folders.length];
    const tagCount = Math.floor(random() * 4);
    const recordTags = [];
    for (let t = 0; t < tagCount; t += 1) recordTags.push(tags[(index + t) % tags.length]);
    records.push({
      path: `${folder}/note-${String(index).padStart(5, "0")}.md`,
      name: `note-${index}`,
      tags: recordTags,
    });
  }
  return records;
}

// Deterministic, CPU-bound pure derivation over the synthetic records.
function derive(records, args) {
  const { root, minTags } = args;
  const folderCounts = new Map();
  const tagCounts = new Map();
  const selected = [];
  for (const record of records) {
    if (root && !record.path.startsWith(`${root}/`)) continue;
    const folder = record.path.split("/")[0];
    folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
    for (const tag of record.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    if (record.tags.length >= minTags) selected.push(record.path);
  }
  selected.sort();
  return {
    total: selected.length,
    folders: [...folderCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    tags: [...tagCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    selected,
  };
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const total = times.reduce((sum, value) => sum + value, 0);
  return {
    rounds: times.length,
    totalMs: Number(total.toFixed(3)),
    meanMs: Number((total / times.length).toFixed(6)),
    minMs: Number(sorted[0].toFixed(6)),
    p50Ms: Number(sorted[Math.floor(sorted.length / 2)].toFixed(6)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(6)),
  };
}

const records = buildRecords(RECORDS);
const args = { root: "Projects", minTags: 1 };
const sourceStats = {
  publicationRevision: 42,
  snapshotGeneration: 7,
  includeHidden: false,
  coverage: { includeHidden: false, completeness: "complete", skipped: 0 },
};
const freshness = {
  freshness: "clean",
  vaultGeneration: 7,
  publicationRevision: 42,
  includeHidden: false,
  coverage: { includeHidden: false, completeness: "complete", skipped: 0 },
};

let derivationCount = 0;
const cache = createHotRouteCache({
  namespaces: { "bench-route": { allowedArgKeys: ["root", "minTags"], maxCanonicalBytes: 256 } },
  ttlMs: 60 * 60 * 1000,
  maxEntries: 4,
  now: () => 1000,
  readFreshness: () => freshness,
});

const baselineTimes = [];
const cachedTimes = [];
let mismatches = 0;
const rssBefore = process.memoryUsage().rss;
const cpuBefore = process.cpuUsage();

for (let round = 0; round < ROUNDS; round += 1) {
  const baselineStart = performance.now();
  const baseline = derive(records, args);
  baselineTimes.push(performance.now() - baselineStart);

  const cachedStart = performance.now();
  const result = await cache.getOrCompute({
    namespace: "bench-route",
    canonicalArgs: args,
    sourceStats,
    compute: () => {
      derivationCount += 1;
      return derive(records, args);
    },
  });
  cachedTimes.push(performance.now() - cachedStart);

  if (result.status !== "hit" && result.status !== "computed") {
    mismatches += 1;
    continue;
  }
  if (!isDeepStrictEqual(result.value, baseline)) mismatches += 1;
}

const rssAfter = process.memoryUsage().rss;
const cpuAfter = process.cpuUsage(cpuBefore);

const report = {
  schema: "hot-routes-phase1a-benchmark/v1",
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuCount: os.cpus().length,
  },
  fixture: { records: RECORDS, rounds: ROUNDS, args, sourceStats },
  correctness: {
    baselineMatchesCached: mismatches === 0,
    roundsChecked: ROUNDS,
    mismatches,
  },
  timings: { baseline: stats(baselineTimes), cached: stats(cachedTimes) },
  counts: {
    baselineDerivations: ROUNDS,
    cachedDerivations: derivationCount,
    cache: cache.stats(),
  },
  cpuMicros: { user: cpuAfter.user, system: cpuAfter.system },
  rssBytes: { before: rssBefore, after: rssAfter },
  filesystemCalls: {
    measured: false,
    note: "The primitive imports no filesystem module and this fixture is in-memory; no fs-call count is claimed.",
  },
  claims: {
    performanceRatioGate: null,
    productionTtlOrCapacity: null,
    note: "Fixture-local observations only. No production gain, hit-rate, or timeout claim is made.",
  },
};

const outputPath = parseOutputPath(process.argv.slice(2));
const text = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, text, "utf8");
  console.log(`wrote ${outputPath}`);
} else {
  process.stdout.write(text);
}

if (mismatches !== 0) {
  console.error(`benchmark failed: ${mismatches} cached result(s) differed from the uncached baseline`);
  process.exitCode = 1;
}
