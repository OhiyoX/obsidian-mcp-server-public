#!/usr/bin/env node
// Search v2 Phase 0 baseline characterization + Task S1 frozen relevance gate.
//
// Read-only against production source: this script imports the current
// tokenizer / evaluator / hybrid-search modules, builds a temporary Vault from
// app/test/fixtures/search-v2-corpus.json, and projects deterministic
// observations. It never edits src/ and never changes online weights.
//
// Task S1 adds the measurement gate (`runQrelsGate`): a second, frozen synthetic
// corpus (test/fixtures/search-v2/) with graded judgments, scored through the
// same production path `search_notes` uses — `syncRetrievalIndex` builds the one
// real index, `getVaultIndex` supplies the real records, and
// `parseObsidianQuery` + `hybridSearch` rank them. No second index, no second
// scorer, no ranking change: the frozen numbers are whatever today's code
// produces.
//
// Usage:
//   node scripts/search-v2-baseline.mjs            # check golden + qrels gate, write the S1 report
//   node scripts/search-v2-baseline.mjs --write    # regenerate search-v2-golden.json
//   node scripts/search-v2-baseline.mjs --freeze   # re-freeze expected.json (a deliberate ranking change)
//   node scripts/search-v2-baseline.mjs --out=DIR  # report directory (default: <workspace>/scratch/s1-qrels)
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { computeObservations, loadCorpus, projectRecords, writeCorpusVault } from "../test/fixtures/search-v2-harness.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const goldenPath = path.join(scriptDirectory, "..", "test", "fixtures", "search-v2-golden.json");

// The frozen gate fixture. corpus.json is hashed; qrels.json carries the graded
// answer key plus that hash; expected.json carries the frozen numbers.
export const QRELS_FIXTURE_DIR = path.join(scriptDirectory, "..", "test", "fixtures", "search-v2");
const DEFAULT_REPORT_DIR = path.join(scriptDirectory, "..", "..", "..", "scratch", "s1-qrels");
const QRELS_GATE_INVALID = "QRELS_GATE_INVALID";
const TOP_K = 10;

// The production search path, imported once per process (its config is read at
// import time, so the temporary Vault environment is set first). One index is
// built per fixture through `syncRetrievalIndex`; each gate run rewrites that
// single Vault instead of creating a second one.
let searchPathPromise = null;
function searchPath() {
  searchPathPromise ??= (async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "search-v2-qrels-"));
    const vault = path.join(root, "vault");
    const data = path.join(root, "data");
    process.env.VAULT_PATH = vault;
    process.env.DATA_PATH = data;
    process.env.HISTORY_PATH = path.join(data, "history");
    process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
    process.env.RETRIEVAL_AUTO_EMBED = "false";
    process.env.EMBEDDING_PROVIDER = "disabled";
    process.env.GIT_ENABLED = "false";
    const { recall, syncRetrievalIndex, tokenize } = await import("../src/retrieval.js");
    const { getVaultIndex } = await import("../src/vault-index.js");
    const { parseObsidianQuery } = await import("../src/search/obsidian-query.js");
    const { evaluateObsidianQuery } = await import("../src/search/evaluator.js");
    const { hybridSearch } = await import("../src/search/hybrid-search.js");
    return { root, vault, recall, syncRetrievalIndex, tokenize, getVaultIndex, parseObsidianQuery, evaluateObsidianQuery, hybridSearch };
  })();
  return searchPathPromise;
}

function gateError(detail) {
  return Object.assign(new Error(`[${QRELS_GATE_INVALID}] ${detail}`), { code: QRELS_GATE_INVALID });
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

export function fixtureHashOf(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

// A qrel row is `{ query, constraints, docId, relevance }`; constraints are the
// search options shared by every row of one query, so the key is query+options.
export function qrelsKey(query, constraints) {
  return `${query}\u0000${JSON.stringify(constraints ?? {})}`;
}

function searchOptions(constraints) {
  return { limit: TOP_K, ...(constraints ?? {}) };
}

async function readRequired(file, label) {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (error?.code === "ENOENT") throw gateError(`${label} is missing: ${file}`);
    throw error;
  }
}

// Load + validate the frozen fixture. Every guard here is a reason the gate must
// refuse to grade: a missing file, a corpus edited without a judgment review, a
// judgment pointing at a note that does not exist, a query with no canonical
// answer, and a query that already names its answer file (a name lookup, which
// would measure nothing).
export async function loadQrelsFixture(fixtureDir = QRELS_FIXTURE_DIR) {
  const corpusBytes = await readRequired(path.join(fixtureDir, "corpus.json"), "corpus.json");
  const qrelsBytes = await readRequired(path.join(fixtureDir, "qrels.json"), "qrels.json");
  const corpus = JSON.parse(corpusBytes.toString("utf8"));
  const qrels = JSON.parse(qrelsBytes.toString("utf8"));
  const fixtureHash = fixtureHashOf(corpusBytes);
  if (qrels.fixtureHash !== fixtureHash) {
    throw gateError(`fixture hash mismatch: qrels.json declares ${qrels.fixtureHash}, corpus.json is ${fixtureHash} (a corpus edit needs a judgment review, then --freeze)`);
  }
  if (!Array.isArray(corpus.notes) || corpus.notes.length === 0) throw gateError("corpus.json declares no notes");
  if (!Array.isArray(qrels.queries) || !Array.isArray(qrels.rows)) throw gateError("qrels.json must declare queries[] and rows[]");

  const knownPaths = new Set(corpus.notes.map((note) => note.path));
  const declared = new Map(qrels.queries.map((entry) => [qrelsKey(entry.query, entry.constraints), entry]));
  const judgments = new Map();
  for (const row of qrels.rows) {
    const key = qrelsKey(row.query, row.constraints);
    if (!declared.has(key)) throw gateError(`qrels row is not declared in queries[]: ${row.query}`);
    if (!knownPaths.has(row.docId)) throw gateError(`qrels row names a docId that is not in the corpus: ${row.docId} (${row.query})`);
    if (![0, 1, 2].includes(row.relevance)) throw gateError(`relevance must be 0, 1 or 2, got ${row.relevance} (${row.query} -> ${row.docId})`);
    const bucket = judgments.get(key) ?? new Map();
    bucket.set(row.docId, row.relevance);
    judgments.set(key, bucket);
  }
  const queries = [];
  for (const [key, entry] of declared) {
    const bucket = judgments.get(key) ?? new Map();
    const canonical = [...bucket.entries()].filter(([, relevance]) => relevance === 2).map(([docId]) => docId);
    if (canonical.length === 0) throw gateError(`query has no canonical answer (relevance 2): ${entry.query}`);
    const asked = String(entry.query).toLowerCase();
    for (const docId of canonical) {
      const lowered = docId.toLowerCase();
      if (asked.includes(lowered) || asked.includes(lowered.replace(/\.md$/, ""))) {
        throw gateError(`query names its answer file (a name lookup, not a ranking test): ${entry.query} -> ${docId}`);
      }
    }
    if (typeof entry.category !== "string" || entry.category === "") throw gateError(`query declares no category: ${entry.query}`);
    queries.push({ query: entry.query, constraints: entry.constraints ?? {}, category: entry.category, judgments: bucket, canonical });
  }
  return { corpus, qrels, fixtureHash, noteCount: corpus.notes.length, queries };
}

// Write one fixture corpus into the single temporary Vault and rebuild the one
// real index over it. File times are pinned so the relevance sort's last
// tie-break (`stat.modified`) is deterministic across runs.
async function indexFixture(paths, notes) {
  await fs.rm(paths.vault, { recursive: true, force: true });
  await fs.mkdir(paths.vault, { recursive: true });
  const base = Date.UTC(2026, 0, 1);
  for (const [index, note] of notes.entries()) {
    const absolute = path.join(paths.vault, ...note.path.split("/"));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, note.raw, "utf8");
    const stamp = new Date(base + index * 60_000);
    await fs.utimes(absolute, stamp, stamp);
  }
  await paths.syncRetrievalIndex({ force: true });
  const index = await paths.getVaultIndex({ force: true });
  return { index, recordsByPath: new Map(index.records.map((record) => [record.path, record])) };
}

// Exactly the relevance sort `search_notes` applies before its limit.
function rank(results) {
  return [...results]
    .sort((a, b) => (b.score || 0) - (a.score || 0) || b.matchCount - a.matchCount || b.stat.modified.localeCompare(a.stat.modified))
    .slice(0, TOP_K);
}

function ndcg(ranking, judgments) {
  const gain = (docId) => 2 ** (judgments.get(docId) ?? 0) - 1;
  const dcg = ranking.reduce((total, docId, index) => total + gain(docId) / Math.log2(index + 2), 0);
  const ideal = [...judgments.values()].sort((a, b) => b - a).slice(0, TOP_K)
    .reduce((total, relevance, index) => total + (2 ** relevance - 1) / Math.log2(index + 2), 0);
  return ideal === 0 ? 0 : round(dcg / ideal);
}

export function percentile(values, percent) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((percent / 100) * sorted.length)));
  return round(sorted[rank - 1], 3);
}

// Hard-filter violation: a returned note in the top-K that the query's OWN
// structural filter rejects. `semanticCandidate` makes the evaluator skip positive
// text clauses, so only the mandatory filters (path/file/tag/property/negation)
// are enforced.
export async function runQrelsGate({ fixtureDir = QRELS_FIXTURE_DIR, iterations = 3 } = {}) {
  const fixture = await loadQrelsFixture(fixtureDir);
  const paths = await searchPath();
  const { index, recordsByPath } = await indexFixture(paths, fixture.corpus.notes);

  const queries = [];
  for (const entry of fixture.queries) {
    const parsed = paths.parseObsidianQuery(entry.query);
    const options = searchOptions(entry.constraints);
    const samples = [];
    let ranking = [];
    let search = null;
    for (let attempt = 0; attempt < Math.max(1, iterations); attempt += 1) {
      const startedAt = performance.now();
      search = await paths.hybridSearch(index.records, parsed, options, paths.recall);
      ranking = rank(search.results).map((result) => result.path);
      samples.push(performance.now() - startedAt);
    }
    const violations = ranking.filter((docId) => recordsByPath.has(docId)
      && paths.evaluateObsidianQuery(recordsByPath.get(docId), parsed, { ...options, semanticCandidate: true }).matched === false);
    queries.push({
      query: entry.query,
      constraints: entry.constraints,
      category: entry.category,
      graded: entry.judgments.size,
      ranking,
      grades: ranking.map((docId) => entry.judgments.get(docId) ?? 0),
      canonicalRank: ranking.includes(entry.canonical[0]) ? ranking.indexOf(entry.canonical[0]) + 1 : null,
      top1Path: ranking[0] ?? null,
      top1: entry.judgments.get(ranking[0]) === 2 ? 1 : 0,
      ndcg10: ndcg(ranking, entry.judgments),
      violations,
      semanticUsed: search.semanticUsed,
      semanticError: search.semanticError,
      latencyMs: { p50: percentile(samples, 50), p95: percentile(samples, 95), samples },
    });
  }

  const categories = [...new Set(queries.map((entry) => entry.category))].map((category) => {
    const rows = queries.filter((entry) => entry.category === category);
    const latency = rows.map((entry) => entry.latencyMs.p50);
    return {
      category,
      queries: rows.length,
      top1: round(rows.reduce((total, entry) => total + entry.top1, 0) / rows.length),
      ndcg10: round(rows.reduce((total, entry) => total + entry.ndcg10, 0) / rows.length),
      violations: rows.reduce((total, entry) => total + entry.violations.length, 0),
      p50Ms: percentile(latency, 50),
      p95Ms: percentile(latency, 95),
    };
  });

  return {
    fixture: { directory: path.relative(path.join(scriptDirectory, ".."), fixtureDir).split(path.sep).join("/"), fixtureHash: fixture.fixtureHash, notes: fixture.noteCount, queries: queries.length },
    fixtureHash: fixture.fixtureHash,
    noteCount: fixture.noteCount,
    node: process.version,
    queries,
    categories,
  };
}

// The frozen projection: everything the gate re-checks, nothing machine-dependent
// (latency stays observation-only).
export function frozenProjection(report) {
  return {
    fixtureHash: report.fixtureHash,
    queries: report.queries.map(({ query, constraints, category, ranking, top1Path, top1, ndcg10, violations }) => ({ query, constraints, category, ranking, top1Path, top1, ndcg10, violations })),
  };
}

export function compareToExpected(report, expected) {
  const failures = [];
  if (expected.fixtureHash !== report.fixtureHash) failures.push(`fixture hash drift: expected ${expected.fixtureHash}, measured ${report.fixtureHash}`);
  const frozen = new Map(expected.queries.map((entry) => [qrelsKey(entry.query, entry.constraints), entry]));
  for (const entry of report.queries) {
    const key = qrelsKey(entry.query, entry.constraints);
    const want = frozen.get(key);
    if (!want) {
      failures.push(`query ${entry.query}: no frozen expectation`);
      continue;
    }
    frozen.delete(key);
    if (want.top1Path !== entry.top1Path) failures.push(`query ${entry.query}: top1 drifted to ${JSON.stringify(entry.top1Path)}, frozen ${JSON.stringify(want.top1Path)}`);
    if (Math.abs(want.ndcg10 - entry.ndcg10) > 1e-6) failures.push(`query ${entry.query}: nDCG@10 drifted to ${entry.ndcg10}, frozen ${want.ndcg10}`);
    if (JSON.stringify(want.violations) !== JSON.stringify(entry.violations)) failures.push(`query ${entry.query}: hard-filter violations ${JSON.stringify(entry.violations)}, frozen ${JSON.stringify(want.violations)}`);
    if (JSON.stringify(want.ranking) !== JSON.stringify(entry.ranking)) failures.push(`query ${entry.query}: ranking drifted to ${JSON.stringify(entry.ranking)}, frozen ${JSON.stringify(want.ranking)}`);
  }
  for (const extra of frozen.values()) failures.push(`frozen query is gone from the qrels: ${extra.query}`);
  return failures;
}

function markdownReport(report) {
  const lines = [
    "# Search v2 S1 — frozen relevance baseline",
    "",
    `Fixture: \`${report.fixture.directory}\` · ${report.noteCount} notes · ${report.queries.length} queries · hash \`${report.fixtureHash}\` · Node ${report.node}`,
    "",
    "Measured on today's code. A number here is an observation, not a target.",
    "",
    "Latency: each query runs 3 times and reports its median; a category reports the p50/p95 of its own query medians.",
    "",
    "| category | queries | Top1 | nDCG@10 | hard-filter violations | p50 ms | p95 ms |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.categories.map((row) => `| ${row.category} | ${row.queries} | ${row.top1.toFixed(2)} | ${row.ndcg10.toFixed(3)} | ${row.violations} | ${row.p50Ms} | ${row.p95Ms} |`),
    "",
    "## Per query",
    "",
    "| query | category | Top1 | canonical rank | nDCG@10 | violations |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.queries.map((entry) => `| \`${entry.query}\` | ${entry.category} | ${entry.top1} | ${entry.canonicalRank ?? "-"} | ${entry.ndcg10.toFixed(3)} | ${entry.violations.length === 0 ? 0 : entry.violations.join(", ")} |`),
    "",
    "## Rankings that do not put the canonical answer first",
    "",
  ];
  const wrong = report.queries.filter((entry) => entry.top1 !== 1);
  if (wrong.length === 0) lines.push("None.");
  for (const entry of wrong) {
    const noise = entry.ranking.filter((docId, index) => (entry.grades[index] === 0) && (entry.canonicalRank === null || index + 1 < entry.canonicalRank));
    lines.push(`- \`${entry.query}\`: top1 is \`${entry.top1Path}\`, canonical at rank ${entry.canonicalRank ?? "absent"}${noise.length ? `; relevance-0 notes above the answer: ${noise.map((docId) => `\`${docId}\``).join(", ")}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

async function writeReports(report, outDirectory) {
  await fs.mkdir(outDirectory, { recursive: true });
  const jsonPath = path.join(outDirectory, "search-v2-qrels-report.json");
  const markdownPath = path.join(outDirectory, "search-v2-qrels-report.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, markdownReport(report), "utf8");
  return { jsonPath, markdownPath };
}

async function freeze(fixtureDir, report) {
  const expectedPath = path.join(fixtureDir, "expected.json");
  await fs.writeFile(expectedPath, `${JSON.stringify(frozenProjection(report), null, 2)}\n`, "utf8");
  // Only the hash line is patched, so the human-formatted judgment rows stay read as written.
  const qrelsPath = path.join(fixtureDir, "qrels.json");
  const qrels = await fs.readFile(qrelsPath, "utf8");
  await fs.writeFile(qrelsPath, qrels.replace(/"fixtureHash": "sha256:[0-9a-f]+"/, `"fixtureHash": "${report.fixtureHash}"`), "utf8");
  return expectedPath;
}

async function characterize(paths) {
  const corpus = await loadCorpus();
  await indexFixture(paths, corpus.notes.map((note) => ({ path: note.path, raw: note.raw })));
  return computeObservations({
    tokenize: paths.tokenize,
    recall: paths.recall,
    parseObsidianQuery: paths.parseObsidianQuery,
    evaluateObsidianQuery: paths.evaluateObsidianQuery,
    hybridSearch: paths.hybridSearch,
    records: projectRecords(corpus),
  });
}

async function main() {
  const args = process.argv.slice(2);
  const outArgument = args.find((argument) => argument.startsWith("--out="));
  const outDirectory = outArgument ? path.resolve(outArgument.slice("--out=".length)) : DEFAULT_REPORT_DIR;
  const paths = await searchPath();

  if (args.includes("--write")) {
    const observations = await characterize(paths);
    await fs.writeFile(goldenPath, `${JSON.stringify(observations, null, 2)}\n`, "utf8");
    console.log(`Wrote baseline: ${goldenPath}`);
    return;
  }

  const report = await runQrelsGate({ fixtureDir: QRELS_FIXTURE_DIR });
  let exitCode = 0;

  if (args.includes("--freeze")) {
    console.log(`Re-froze the gate projection: ${await freeze(QRELS_FIXTURE_DIR, report)}`);
  } else {
    const expected = JSON.parse(await fs.readFile(path.join(QRELS_FIXTURE_DIR, "expected.json"), "utf8"));
    const failures = compareToExpected(report, expected);
    if (failures.length > 0) {
      console.error("Qrels gate drift detected (review the ranking change, then --freeze):");
      for (const failure of failures) console.error(`- ${failure}`);
      exitCode = 1;
    } else {
      console.log("Qrels gate matches the frozen numbers.");
    }
    const observations = await characterize(paths);
    const serialized = `${JSON.stringify(observations, null, 2)}\n`;
    const existing = await fs.readFile(goldenPath, "utf8").catch(() => null);
    if (existing === serialized) console.log("Baseline matches search-v2-golden.json");
    else {
      console.log("Baseline drift detected (run with --write to regenerate)");
      exitCode = 1;
    }
  }

  const written = await writeReports(report, outDirectory);
  console.log(`Report: ${written.jsonPath}`);
  console.log(`Report: ${written.markdownPath}`);
  console.log(markdownReport(report));
  process.exitCode = exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(describeError(error));
    process.exitCode = 1;
  });
}
