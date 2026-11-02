#!/usr/bin/env node
// Search v2 Phase 1A — offline analyzer benchmark (correctness-first).
//
// This script measures ONLY the real Phase 1A analyzer over an offline
// synthetic corpus built from the frozen behavior fixture. It imports no
// production retrieval/ranking code. There is no pass/fail performance
// threshold, no "faster search" claim, and no relevance/accuracy claim: the
// wall/CPU/RSS numbers are observations for this corpus on this Node runtime.
//
// Usage:
//   node app/scripts/search-analyzer-benchmark.mjs
//   node app/scripts/search-analyzer-benchmark.mjs --iterations=5000
//
// The optional legacy-tokenizer reference is intentionally omitted: this lane
// does not import a production retrieval environment, so an exact frozen
// baseline cannot be proven here.
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { analyzeText, analyzePositiveClauses } from "../src/search/analyzer.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(scriptDirectory, "..", "test", "fixtures", "search-analyzer-v1.json");
const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));

// 1. Correctness assertions run first. Any contract failure exits non-zero and
//    emits no performance comparison.
const failures = [];
for (const testCase of fixture.textCases) {
  if (!isDeepStrictEqual(analyzeText(testCase.input, testCase.options), testCase.expected)) failures.push(`text:${testCase.name}`);
}
for (const testCase of fixture.clauseCases) {
  if (!isDeepStrictEqual(analyzePositiveClauses(testCase.input, testCase.options), testCase.expected)) failures.push(`clauses:${testCase.name}`);
}
if (failures.length > 0) {
  console.error("analyzer benchmark: fixture contract failed; no performance numbers emitted");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const iterationArgument = process.argv.find((argument) => argument.startsWith("--iterations="));
const iterations = iterationArgument ? Number.parseInt(iterationArgument.slice("--iterations=".length), 10) : 1000;
if (!Number.isSafeInteger(iterations) || iterations <= 0) {
  console.error("analyzer benchmark: --iterations must be a positive safe integer");
  process.exit(1);
}

const textCorpus = fixture.textCases.map((testCase) => testCase.input);
const clauseCorpus = fixture.clauseCases.map((testCase) => testCase.input);
const textInputCodeUnits = textCorpus.reduce((total, input) => total + input.length, 0);
const clauseInputCodeUnits = clauseCorpus.reduce((total, clauses) => total + clauses.reduce((sum, clause) => sum + clause.text.length, 0), 0);

function runText() {
  let generatedTokens = 0;
  for (const input of textCorpus) generatedTokens += analyzeText(input).tokens.length;
  return generatedTokens;
}

function runClauses() {
  let generatedTokens = 0;
  for (const clauses of clauseCorpus) {
    for (const clause of analyzePositiveClauses(clauses).clauses) generatedTokens += clause.tokens.length;
  }
  return generatedTokens;
}

function measure(strategy, cases, inputCodeUnits, run) {
  for (let index = 0; index < Math.min(iterations, 50); index += 1) run();
  const rssStartBytes = process.memoryUsage().rss;
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  let generatedTokens = 0;
  for (let index = 0; index < iterations; index += 1) generatedTokens = run();
  const wallMs = performance.now() - wallStart;
  const cpu = process.cpuUsage(cpuStart);
  return {
    strategy,
    cases,
    iterations,
    inputCodeUnits,
    generatedTokens,
    wallMs,
    cpuUserMs: cpu.user / 1000,
    cpuSystemMs: cpu.system / 1000,
    rssStartBytes,
    rssEndBytes: process.memoryUsage().rss,
    maxRssKiB: process.resourceUsage().maxRSS,
  };
}

const report = {
  fixture: "app/test/fixtures/search-analyzer-v1.json",
  correctness: "passed",
  corpus: "offline synthetic inputs from the frozen behavior fixture",
  legacyReference: "omitted (no exact frozen baseline proven in this lane)",
  note: "observations only; no performance threshold and no relevance/accuracy claim",
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  results: [
    measure("phase1a-analyzer-text", textCorpus.length, textInputCodeUnits, runText),
    measure("phase1a-analyzer-clauses", clauseCorpus.length, clauseInputCodeUnits, runClauses),
  ],
};

console.log(JSON.stringify(report, null, 2));
