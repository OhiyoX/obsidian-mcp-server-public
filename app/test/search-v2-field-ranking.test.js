import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { projectLexicalFields, lexicalFieldStats, rankLexicalCandidates } from "../src/search/field-ranker.js";
import { parseObsidianQuery } from "../src/search/obsidian-query.js";
import { hybridSearch } from "../src/search/hybrid-search.js";

// The pre-S3 numbers are inlined on purpose: once the gate is frozen to the new ranking, the
// before/after claim can no longer be re-derived from the fixture, and the claim is what this
// test exists to keep honest. Shape: [query, top1Before, ndcgBefore, top1After, ndcgAfter].
const S3_RESULT = [
  ["网络故障", 1, 0.726229, 1, 0.726229],
  ["网络", 1, 1, 1, 1],
  ["OpenWrt 网络故障", 1, 0.726229, 1, 0.726229],
  ["retry policy", 0, 0.683494, 1, 0.983218],
  ["backup retention", 0, 0.796708, 0, 0.796708],
  ["restore_from_trash", 1, 0.878962, 1, 0.878962],
  ["2c1a9f0", 0, 0.63093, 0, 0.63093],
  ["app/src/search.js", 0, 0.796708, 1, 1],
  ["planRestoreVersion", 1, 0.878962, 1, 0.878962],
  ["path:Ops deploy", 1, 1, 1, 1],
  ["path:Code restore", 0, 0.796708, 0, 0.796708],
  ["tag:search/index refresh", 1, 0.826235, 1, 0.826235],
  ["tag:ops/runbook deploy", 1, 1, 1, 1],
  ["[owner:Ada] backup", 1, 1, 1, 1],
  ["retry policy -draft", 1, 1, 1, 1],
  ["retry -backoff", 1, 1, 1, 1],
  ['"delayed retry budget"', 1, 1, 1, 1],
  ["vector cache eviction", 1, 0.826235, 1, 0.826235],
];

test("field weighting gained 2 canonical Top1 answers and cost no per-query metric", () => {
  const before = S3_RESULT.reduce((sum, row) => sum + row[1], 0);
  const after = S3_RESULT.reduce((sum, row) => sum + row[3], 0);
  assert.equal(after - before, 2, "Top1 total must be two better than the pre-S3 frozen numbers");
  for (const [query, top1Before, ndcgBefore, top1After, ndcgAfter] of S3_RESULT) {
    assert.ok(top1After >= top1Before, `${query}: Top1 regressed`);
    assert.ok(ndcgAfter + 0.000001 >= ndcgBefore, `${query}: nDCG regressed`);
  }
  const gained = S3_RESULT.filter((row) => row[3] > row[1]).map((row) => row[0]);
  assert.deepEqual(gained.sort(), ["app/src/search.js", "retry policy"].sort(), "exactly the two recorded gains");
});

test("a live run reproduces the inlined after-numbers", async () => {
  const script = new URL("../scripts/search-v2-baseline.mjs", import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e",
    `import { runQrelsGate } from ${JSON.stringify(script)}; console.log(JSON.stringify(await runQrelsGate({ iterations: 1 })));`], { timeout: 60000 });
  const live = JSON.parse(stdout);
  for (const [query, , , top1After, ndcgAfter] of S3_RESULT) {
    const row = live.queries.find((entry) => entry.query === query);
    assert.ok(row, `missing live row for ${query}`);
    assert.equal(row.top1, top1After, `${query}: live Top1 drifted from the inlined number`);
    assert.ok(Math.abs(row.ndcg10 - ndcgAfter) < 0.000001, `${query}: live nDCG drifted`);
    assert.deepEqual(row.violations, []);
  }
});

function record(path, content = "needle", frontmatter = {}, aliases = []) {
  return { path, basename: path.replace(/.*\//, "").replace(/\.md$/, ""), name: path.split("/").at(-1), content, raw: content,
    frontmatter, aliases, tags: [], stat: { modified: "2026-01-01" }, revision: "test" };
}
function rank(records, query = "needle", weights) {
  return rankLexicalCandidates(parseObsidianQuery(query), records, lexicalFieldStats(records), weights);
}

test("title, alias, path and heading each outweigh a body mention", () => {
  for (const candidate of [record("a.md", "other", { title: "needle" }), record("a.md", "other", {}, ["needle"]),
    record("needle.md", "other"), record("a.md", "## needle\nother")]) {
    const ranked = rank([record("b.md"), candidate]);
    assert.equal(ranked[0].path, candidate.path);
    assert.ok(ranked[0].reasons.some((reason) => reason.startsWith("field:")));
    assert.ok(ranked[0].topSnippetRef.text.includes("needle"));
  }
});

test("frontmatter is not counted again as body; repeated aliases are deduplicated", () => {
  const a = record("a.md", "body", { title: "needle" }, ["needle"]);
  const b = { ...a, raw: "---\ntitle: needle\naliases: [needle, needle]\n---\nbody", aliases: ["needle", "needle"] };
  assert.deepEqual(projectLexicalFields(a), projectLexicalFields(b));
  assert.equal(rank([a])[0].score, rank([b])[0].score);
});

test("length normalization is finite for empty, very short and very long notes", () => {
  const rows = [record("empty.md", ""), record("short.md"), record("long.md", `needle ${"unrelated ".repeat(10000)}`)];
  const ranked = rank(rows);
  assert.ok(ranked.every((row) => Number.isFinite(row.score)));
  assert.ok(ranked.find((row) => row.path === "short.md").score > ranked.find((row) => row.path === "long.md").score);
});

test("equal scores use a stable path order independent of input order", () => {
  const rows = [record("z.md"), record("a.md")];
  assert.deepEqual(rank(rows).map((row) => row.path), ["a.md", "z.md"]);
  assert.deepEqual(rank(rows.reverse()).map((row) => row.path), ["a.md", "z.md"]);
});

test("statistics and scores do not leak across Vaults with identical paths", () => {
  const a = [record("same.md")];
  const before = rank(a);
  rank([record("same.md", "needle ".repeat(5000)), record("other.md", "other")]);
  assert.deepEqual(rank(a), before);
});

test("hard filters, negatives and quoted phrases supply no rank terms", () => {
  const rows = [record("a.md", "needle draft"), record("z.md", "needle")];
  for (const query of ["path:a", "tag:needle", "[owner:needle]", "-draft", '"needle"']) {
    const ranked = rank(rows, query);
    assert.equal(ranked[0].score, ranked[1].score);
    assert.deepEqual(ranked[0].reasons, []);
  }
});

test("scoped content and hidden frontmatter do not produce title or alias evidence", async () => {
  const row = record("a.md", "needle", { title: "needle private title" }, ["needle private alias"]);
  for (const [query, options] of [["content:needle", {}], ["needle", { includeFrontmatter: false }]]) {
    const result = await hybridSearch([row], parseObsidianQuery(query), { ...options, semantic: false });
    assert.ok(!result.results[0].reasons.includes("field:title"));
    assert.ok(!result.results[0].reasons.includes("field:alias"));
    assert.ok(!result.results[0].snippets.some((snippet) => snippet.includes("private")));
  }
});

test("the index heading map keeps fenced hashes in the body", () => {
  const fields = projectLexicalFields({ ...record("a.md", "```\n# needle\n```"), headings: [] });
  assert.equal(fields.heading.text, "");
  assert.ok(fields.body.text.includes("# needle"));
  assert.ok(Number.isFinite(rank([record("?.md", "?")], "?")[0].score));
});

test("the real lexical path ranks an exact file identifier above repeated body mentions", async () => {
  const source = record("Code/app/src/search.js.md", "File notes for app/src/search.js.");
  const design = record("Notes/Search Design.md", "app/src/search.js and app/src/search.js");
  const result = await hybridSearch([design, source], parseObsidianQuery("app/src/search.js"), { semantic: false });
  assert.equal([...result.results].sort((a, b) => b.score - a.score)[0].path, source.path);
  const filtered = await hybridSearch([design, source], parseObsidianQuery("path:Notes app/src/search.js"), { semantic: false });
  assert.deepEqual(filtered.results.map((row) => row.path), [design.path]);
});
