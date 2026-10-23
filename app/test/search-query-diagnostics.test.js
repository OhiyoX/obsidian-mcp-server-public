import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildZeroResultDiagnostics } from "../src/search/query-diagnostics.js";
import { parseObsidianQuery } from "../src/search/obsidian-query.js";

// Synthetic records mirror the shape produced by src/vault-index.js. Diagnostics
// tests must never touch a real Vault, so every fixture is hand-written here.
function makeRecord(path, content, extra = {}) {
  const name = path.split("/").pop();
  return {
    path,
    name,
    basename: name.replace(/\.md$/, ""),
    aliases: [],
    tags: [],
    frontmatter: {},
    content,
    raw: content,
    stat: { size: content.length, mtimeMs: 0 },
    ...extra,
  };
}

function diagnosticsOf(records, query, options) {
  return buildZeroResultDiagnostics(records, parseObsidianQuery(query), options);
}

function clauseSummary(group) {
  return group.clauses.map((clause) => ({
    raw: clause.raw,
    type: clause.type,
    negated: clause.negated,
    matchedRecords: clause.matchedRecords,
  }));
}

test("empty candidate set reports zeroed groups without crashing", () => {
  const diagnostics = diagnosticsOf([], "alpha beta");
  assert.equal(diagnostics.candidateRecords, 0);
  assert.equal(diagnostics.exactMatched, 0);
  assert.equal(diagnostics.groupCount, 1);
  assert.equal(diagnostics.implicitAnd, true);
  assert.equal(diagnostics.truncated, false);
  assert.equal(diagnostics.groups.length, 1);
  assert.equal(diagnostics.groups[0].groupIndex, 0);
  assert.equal(diagnostics.groups[0].matchedRecords, 0);
  assert.deepEqual(diagnostics.groups[0].clauses.map((clause) => clause.matchedRecords), [0, 0]);
});

test("a single absent clause reports zero coverage", () => {
  const records = [makeRecord("A.md", "alpha", { tags: ["status/active"] })];
  const diagnostics = diagnosticsOf(records, "tag:missing");
  assert.equal(diagnostics.groupCount, 1);
  assert.equal(diagnostics.implicitAnd, false);
  assert.equal(diagnostics.groups[0].matchedRecords, 0);
  assert.deepEqual(clauseSummary(diagnostics.groups[0]), [
    { raw: "tag:missing", type: "tag", negated: false, matchedRecords: 0 },
  ]);
});

test("non-co-occurring clauses each have coverage but the group does not", () => {
  const records = [makeRecord("Alpha.md", "alpha only"), makeRecord("Beta.md", "beta only")];
  const diagnostics = diagnosticsOf(records, "alpha beta");
  const group = diagnostics.groups[0];
  assert.equal(group.matchedRecords, 0);
  assert.deepEqual(group.clauses.map((clause) => clause.matchedRecords), [1, 1]);
});

test("co-occurring clauses count a single group match", () => {
  const records = [makeRecord("Alpha.md", "alpha only"), makeRecord("Both.md", "alpha beta")];
  const diagnostics = diagnosticsOf(records, "alpha beta");
  const group = diagnostics.groups[0];
  assert.equal(group.matchedRecords, 1);
  assert.deepEqual(group.clauses.map((clause) => clause.matchedRecords), [2, 1]);
  assert.ok(group.clauses.every((clause) => clause.matchedRecords >= 1));
});

test("OR groups are counted independently and implicitAnd is false", () => {
  const records = [makeRecord("Alpha.md", "alpha only")];
  const diagnostics = diagnosticsOf(records, "alpha OR gamma");
  assert.equal(diagnostics.implicitAnd, false);
  assert.equal(diagnostics.groupCount, 2);
  assert.equal(diagnostics.groups.length, 2);
  assert.equal(diagnostics.groups[0].matchedRecords, 1);
  assert.equal(diagnostics.groups[1].matchedRecords, 0);
  assert.equal(diagnostics.groups[0].groupIndex, 0);
  assert.equal(diagnostics.groups[1].groupIndex, 1);
});

test("negative clauses report records that survive the negation", () => {
  const records = [makeRecord("Alpha.md", "alpha only"), makeRecord("Both.md", "alpha beta")];
  const diagnostics = diagnosticsOf(records, "alpha -beta");
  const group = diagnostics.groups[0];
  assert.equal(group.matchedRecords, 1);
  assert.deepEqual(clauseSummary(group), [
    { raw: "alpha", type: "text", negated: false, matchedRecords: 1 },
    { raw: "-beta", type: "text", negated: true, matchedRecords: 1 },
  ]);
  // Same counting rule as the positive clause: both pass exactly one record here.
  assert.equal(group.clauses[1].matchedRecords, group.clauses[0].matchedRecords);
  assert.equal(group.clauses[1].matchedRecords, group.matchedRecords);
});

test("structural filters constrain text clause coverage", () => {
  const records = [
    makeRecord("One.md", "alpha", { tags: ["x"] }),
    makeRecord("Two.md", "alpha", { tags: ["y"] }),
    makeRecord("Three.md", "gamma", { tags: ["x"] }),
    makeRecord("Four.md", "alpha", { tags: ["x"], frontmatter: { owner: "Ada" } }),
  ];
  const tagDiagnostics = diagnosticsOf(records, "tag:x alpha");
  assert.equal(tagDiagnostics.groups[0].matchedRecords, 2);
  assert.deepEqual(clauseSummary(tagDiagnostics.groups[0]), [
    { raw: "tag:x", type: "tag", negated: false, matchedRecords: 3 },
    { raw: "alpha", type: "text", negated: false, matchedRecords: 2 },
  ]);

  const propertyDiagnostics = diagnosticsOf(records, "[owner:Ada] alpha");
  assert.equal(propertyDiagnostics.groups[0].matchedRecords, 1);
  assert.deepEqual(propertyDiagnostics.groups[0].clauses.map((clause) => clause.matchedRecords), [1, 1]);
});

test("diagnostics are bounded by 8 groups and 16 cumulative clauses", () => {
  const records = [makeRecord("A.md", "a")];

  const nineGroups = diagnosticsOf(records, "a OR b OR c OR d OR e OR f OR g OR h OR i");
  assert.equal(nineGroups.groupCount, 9);
  assert.equal(nineGroups.truncated, true);
  assert.equal(nineGroups.groups.length, 8);
  assert.deepEqual(nineGroups.groups.map((group) => group.groupIndex), [0, 1, 2, 3, 4, 5, 6, 7]);

  const oversized = "a b c OR d e f OR g h i OR j k l OR m n o OR p q r OR s t u OR v w x";
  const clauses = diagnosticsOf(records, oversized);
  assert.equal(clauses.groupCount, 8);
  assert.equal(clauses.truncated, true);
  assert.ok(clauses.groups.length < 8);
  assert.ok(clauses.groups.every((group) => group.clauses.length === 3));
  const totalClauses = clauses.groups.reduce((sum, group) => sum + group.clauses.length, 0);
  assert.ok(totalClauses <= 16);
  assert.deepEqual(clauses.groups.map((group) => group.groupIndex), [0, 1, 2, 3, 4]);

  const boundary = diagnosticsOf(records, "a b OR c d OR e f OR g h OR i j OR k l OR m n OR o p");
  assert.equal(boundary.groupCount, 8);
  assert.equal(boundary.truncated, false);
  assert.equal(boundary.groups.length, 8);
  assert.equal(boundary.groups.reduce((sum, group) => sum + group.clauses.length, 0), 16);
});

test("Unicode and CJK clause raw text is preserved verbatim", () => {
  const records = [makeRecord("中文笔记.md", "禁止自动合并 PR")];
  const diagnostics = diagnosticsOf(records, "禁止自动合并 beta tag:中文");
  assert.equal(diagnostics.groups[0].clauses[0].raw, "禁止自动合并");
  assert.equal(diagnostics.groups[0].clauses[1].raw, "beta");
  assert.equal(diagnostics.groups[0].clauses[2].raw, "tag:中文");
  assert.equal(diagnostics.groups[0].clauses[0].type, "text");
  assert.equal(diagnostics.groups[0].clauses[2].type, "tag");
});

test("diagnostics never leak note bodies or snippets", () => {
  const marker = "UNIQUE_BODY_MARKER_9f3a7c";
  const records = [makeRecord("Secret.md", `alpha ${marker}`)];
  const diagnostics = diagnosticsOf(records, "alpha");
  const serialized = JSON.stringify(diagnostics);
  assert.equal(diagnostics.groups[0].matchedRecords, 1);
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.toLowerCase().includes("snippet"), false);
  assert.equal("snippets" in diagnostics, false);
});

test("diagnostics module keeps the pure architecture boundary", () => {
  const url = new URL("../src/search/query-diagnostics.js", import.meta.url);
  const source = readFileSync(url, "utf8");
  const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual(specifiers, ["./evaluator.js"]);
  assert.equal(specifiers.some((specifier) => /(?:^|\/)fs$|retrieval|vault/.test(specifier)), false);
  assert.doesNotMatch(source, /\brequire\s*\(/);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.match(source, /export function buildZeroResultDiagnostics\b/);
  assert.equal(typeof buildZeroResultDiagnostics, "function");
});

test("diagnostics stay bounded on 200 records and 12 clauses", () => {
  const records = Array.from({ length: 200 }, (_, index) => makeRecord(
    `Notes/Note ${index}.md`,
    index % 2 ? "alpha beta gamma delta" : "epsilon zeta eta theta",
    { tags: [index % 3 ? "x" : "y"] },
  ));
  const started = process.hrtime.bigint();
  const diagnostics = diagnosticsOf(records, "alpha beta gamma delta OR epsilon zeta eta theta OR tag:x alpha beta gamma");
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(diagnostics.groups.length, 3);
  assert.equal(diagnostics.truncated, false);
  assert.equal(diagnostics.groups.reduce((sum, group) => sum + group.clauses.length, 0), 12);
  assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0);
  console.log(`# query-diagnostics 200 records x 12 clauses: ${elapsedMs.toFixed(2)} ms`);
});
