import test, { after } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { parseObsidianQuery } from "../src/search/obsidian-query.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "search-fusion-test-"));
Object.assign(process.env, { VAULT_PATH: path.join(root, "vault"), DATA_PATH: path.join(root, "data"), EMBEDDING_PROVIDER: "disabled", GIT_ENABLED: "false" });
after(() => fs.rm(root, { recursive: true, force: true }));
const { hybridSearch } = await import("../src/search/hybrid-search.js");
const module = await import("../src/search/fusion.js").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});
const fuse = (input) => {
  assert.equal(typeof module.fuseRankedResults, "function", "rank fusion must exist");
  return module.fuseRankedResults(input);
};
const record = (path, content, extra = {}) => ({ path, name: path.split("/").at(-1), basename: path.split("/").at(-1).replace(/\.md$/, ""), raw: content, content, tags: [], frontmatter: {}, ...extra });
const config = { enabled: true, k: 60, lexicalWeight: 1, semanticWeight: 1, candidateCap: 50 };
const constraints = (records, query = "needle") => ({ records, parsed: parseObsidianQuery(query) });
const semantic = (results, extra = {}) => ({ results, semanticUsed: true, semanticError: null, ...extra });

test("exact results precede semantic-only results regardless of raw score", () => {
  const a = record("A.md", "needle"), b = record("B.md", "related");
  for (const enabled of [false, true]) {
    const result = fuse({ exact: [{ ...a, score: 0.001 }], lexical: [a], semantic: semantic([{ ...b, score: 1e9 }, a]), constraints: constraints([a, b]), config: { ...config, enabled } });
    assert.deepEqual(result.results.map((item) => item.path), ["A.md", "B.md"]);
    if (enabled) assert.ok(result.results.every((item) => item.reasons.some((reason) => reason.startsWith("rrf:"))));
    assert.ok(result.results[0].score > result.results[1].score);
  }
});

for (const query of ['"required phrase"', 'content:"required phrase"', 'needle -banned', 'tag:keep needle', 'path:Keep needle', 'file:Keep needle', '[owner:Ada] needle']) {
  test(`all channels must retain hard constraint ${query}`, () => {
    const good = record("Keep/Keep.md", "needle required phrase", { tags: ["keep"], frontmatter: { owner: "Ada" } });
    const bad = record("Other/Bad.md", "related banned", { tags: ["other"], frontmatter: { owner: "Bob" } });
    const result = fuse({ exact: [good, bad], lexical: [bad, good], semantic: semantic([bad, good]), constraints: constraints([good, bad], query), config });
    assert.deepEqual(result.results.map((item) => item.path), [good.path]);
  });
}

test("provider error, disabled, and successful empty response expose distinct facts", () => {
  const a = record("A.md", "needle");
  const run = (provider) => fuse({ exact: [a], lexical: [a], semantic: provider, constraints: constraints([a]), config });
  const facts = ({ semanticUsed, fallbackUsed, semanticError }) => ({ semanticUsed, fallbackUsed, semanticError });
  assert.deepEqual(facts(run(semantic([], { semanticUsed: false, semanticError: "provider timeout" }))), { semanticUsed: false, fallbackUsed: true, semanticError: "provider timeout" });
  assert.deepEqual(facts(run(semantic([], { semanticUsed: false, enabled: false }))), { semanticUsed: false, fallbackUsed: true, semanticError: "Embedding provider is not configured; lexical hybrid ranking was used" });
  assert.deepEqual(facts(run(semantic([]))), { semanticUsed: true, fallbackUsed: false, semanticError: null });
});

test("a failed or disabled semantic provider cannot contribute stale candidates", () => {
  const a = record("A.md", "needle"), b = record("B.md", "related");
  for (const state of [{ semanticError: "provider timeout" }, { enabled: false, semanticUsed: false }]) {
    const result = fuse({ exact: [a], lexical: [a], semantic: semantic([b], state), constraints: constraints([a, b]), config });
    assert.deepEqual(result.results.map((item) => item.path), ["A.md"]);
  }
});

test("fusion uses ranks, deduplicates channel entries, caps candidates and resolves ties deterministically", () => {
  const records = Array.from({ length: 120 }, (_, i) => record(`${String(i).padStart(3, "0")}.md`, "needle"));
  const input = { exact: [], lexical: records, semantic: semantic([...records].reverse()), constraints: constraints(records), config };
  const first = fuse(input);
  assert.equal(first.results.length, 50);
  assert.deepEqual(fuse(input), first);
  const two = [records[1], records[0]];
  const tied = fuse({ ...input, lexical: two, semantic: semantic([...two].reverse()) });
  assert.equal(tied.results[0].path, records[0].path);
  const duplicate = fuse({ ...input, lexical: [records[0], records[0]], semantic: semantic([]) });
  assert.equal(duplicate.results.length, 1);
  assert.equal(duplicate.results[0].fusionScore, 1 / 61);
  const rescaled = fuse({ ...input, lexical: records.map((item) => ({ ...item, score: 1e99 })) });
  assert.deepEqual(rescaled.results.map((item) => item.path), first.results.map((item) => item.path));
});

test("same paths from separate Vaults never merge or borrow content", () => {
  const a = record("Same.md", "needle", { vaultId: "a" });
  const b = record("Same.md", "banned", { vaultId: "b" });
  const input = { exact: [a], lexical: [a], semantic: semantic([b]), constraints: constraints([a, b], "needle -banned"), config };
  assert.deepEqual(fuse(input).results.map((item) => item.vaultId), ["a"]);
  const both = fuse({ ...input, constraints: constraints([a, b]) });
  assert.deepEqual(both.results.map((item) => item.vaultId), ["a", "b"]);
  const selected = fuse({ ...input, constraints: { ...constraints([a, b]), vaultId: "a" } });
  assert.deepEqual(selected.results.map((item) => item.vaultId), ["a"]);
});

test("hybrid integration rechecks phrases even with fusion disabled", async () => {
  const good = record("Good.md", "required phrase"), bad = record("Bad.md", "related");
  const recalled = async () => semantic([bad, good]);
  for (const enabled of [false, true]) {
    const result = await hybridSearch([good, bad], parseObsidianQuery('"required phrase"'), { semantic: true, fusion: { ...config, enabled } }, recalled);
    assert.deepEqual(result.results.map((item) => item.path), ["Good.md"]);
    if (enabled) assert.ok(result.results[0].reasons.some((reason) => reason.startsWith("rrf:")));
  }
});

test("hybrid preserves auto/off and the established fallbackUsed auto-routing fact", async () => {
  const a = record("A.md", "needle");
  const never = async () => { throw new Error("must not call recall"); };
  for (const options of [{ semantic: false }, {}]) {
    const result = await hybridSearch([a], parseObsidianQuery("needle"), { ...options, fusion: config }, never);
    assert.equal(result.semanticError, null);
    assert.equal(result.hybridUsed, false);
  }
  const failed = await hybridSearch([a], parseObsidianQuery("needle"), { semantic: true, fusion: config }, async () => { throw new Error("provider timeout"); });
  assert.equal(failed.semanticUsed, false);
  assert.equal(failed.fallbackUsed, false);
  assert.equal(failed.semanticError, "provider timeout");
  const empty = await hybridSearch([a], parseObsidianQuery("needle"), { semantic: true, fusion: config }, async () => semantic([]));
  assert.equal(empty.semanticUsed, true);
  assert.equal(empty.semanticError, null);
  const disabled = await hybridSearch([a], parseObsidianQuery("needle"), { semantic: true, fusion: config }, async () => semantic([], { semanticUsed: false }));
  assert.equal(disabled.semanticUsed, false);
  assert.match(disabled.semanticError, /not configured/);
});

test("hybrid selected Vault cannot borrow a foreign exact or recall record", async () => {
  const a = record("Same.md", "needle", { vaultId: "a" });
  const b = record("Same.md", "needle", { vaultId: "b" });
  const result = await hybridSearch([a, b], parseObsidianQuery("needle"), { semantic: true, vaultId: "a", fusion: config }, async () => semantic([b]));
  assert.deepEqual(result.results.map((item) => item.vaultId), ["a"]);
});

test("untrusted unknown records and invalid fusion configuration fail closed", () => {
  assert.deepEqual(fuse({ semantic: semantic([record("Unknown.md", "needle")]), constraints: constraints([]), config }).results, []);
  for (const invalid of [{ k: -1 }, { candidateCap: Infinity }, { candidateCap: 0 }, { lexicalWeight: NaN }, { semanticWeight: -1 }]) {
    assert.throws(() => fuse({ constraints: constraints([]), config: { ...config, ...invalid } }), /fusion config/i);
  }
});
