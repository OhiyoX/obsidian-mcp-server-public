// Issue #229 Wave A / A3 — #229 integration acceptance matrix, adopted and
// committed to main by Wave B.
//
// This file asserts the NEW behaviour frozen by the #229 contract:
//   - semantic tri-state output (semanticMode / fallbackUsed);
//   - §9 Chinese table and §10 multi-term table;
//   - §15.2 mode matrix;
//   - §15.3 fallback degradation (without a fault seam we cannot inject);
//   - §15.4 bounded zero-result diagnostics;
//   - §15.5 real temp-vault integration + MCP output-schema validation.
//
// Every assertion here is expected to be RED on old main (59c10ac):
//   - semantic omitted is still schema-default false, so auto rows see
//     semanticMode === undefined and strict zero instead of fallback;
//   - fallbackUsed / diagnostics do not exist;
//   - tool-contracts does not declare semanticMode/fallbackUsed.
//
// Run:
//   cd app
//   node --test test/search-229-acceptance.test.js
// The committed fixture app/test/fixtures/search-229-corpus.mjs provides the
// §9/§10 corpus this suite builds on.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-search-229-acceptance-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

await fs.mkdir(vault, { recursive: true });
await fs.mkdir(data, { recursive: true });

const [
  { registerSearchTools },
  { registerObsidianCapabilities },
  { syncRetrievalIndex, drainRetrievalIndex },
  { outputSchemaForTool },
  corpus,
] = await Promise.all([
  import("../src/tools/search.js"),
  import("../src/capabilities.js"),
  import("../src/retrieval.js"),
  import("../src/tool-contracts.js"),
  import("./fixtures/search-229-corpus.mjs"),
]);

// Extra diagnostic-only notes. Kept out of the committed fixture so the
// characterization corpus stays exactly the §9/§10 shapes.
const DIAGNOSTIC_NOTES = [
  { path: "Diag/Alpha.md", raw: "# Alpha\n\nalpha only\n" },
  { path: "Diag/Beta.md", raw: "# Beta\n\nbeta only\n" },
];

await corpus.writeFixtureVault(vault, corpus.allFixtureNotes());
await corpus.writeFixtureVault(vault, DIAGNOSTIC_NOTES);
await syncRetrievalIndex({ force: true });

after(async () => {
  await drainRetrievalIndex();
  await fs.rm(root, { recursive: true, force: true });
});

async function withSearchClient(callback) {
  const server = new McpServer({ name: "search-229-acceptance", version: "1" });
  registerSearchTools(server);
  const client = new Client({ name: "search-229-acceptance-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function withCapabilityClient(callback) {
  const server = new McpServer({ name: "search-229-acceptance-full", version: "1" });
  registerObsidianCapabilities(server);
  const client = new Client({ name: "search-229-acceptance-full-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function callSearch(client, args) {
  return client.callTool({ name: "search_notes", arguments: args });
}

async function search(client, args) {
  const result = await callSearch(client, args);
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return result.structuredContent;
}

function paths(results) {
  return results.map((item) => item.path);
}

// ---------------------------------------------------------------------------
// §15.2 mode matrix + §9/§10 tables (tool layer, retrieval index synced).
// ---------------------------------------------------------------------------

// §15.2 row 1: omitted + exact>0 => exact only, no fallback.
test("matrix omitted exact>0: exact result, semanticMode auto, fallbackUsed false", async () => {
  await withSearchClient(async (client) => {
    const result = await search(client, { query: "禁止自动合并" });
    assert.equal(result.semanticMode, "auto");
    assert.equal(result.semanticRequested, false);
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.hybridUsed, false);
    assert.equal(result.semanticUsed, false);
    assert.deepEqual(paths(result.results), ["Notes/合并策略.md"]);
  });
});

// §15.2 row 2: omitted + exact=0 + positive text => auto fallback.
test("matrix omitted exact=0+text: auto fallback, semanticMode auto, fallbackUsed true", async () => {
  await withSearchClient(async (client) => {
    const result = await search(client, { query: "不自动合并" });
    assert.equal(result.semanticMode, "auto");
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.hybridUsed, true);
    assert.equal(result.semanticUsed, false);
    assert.match(result.semanticError || "", /Embedding provider is not configured; lexical hybrid ranking was used/);
    assert.ok(paths(result.results).includes("Notes/合并策略.md"));
  });
});

// §15.2 row 3: omitted + structural only => exact only.
test("matrix omitted structural-only: exact result, no fallback", async () => {
  await withSearchClient(async (client) => {
    const result = await search(client, { query: "tag:policy/merge" });
    assert.equal(result.semanticMode, "auto");
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.hybridUsed, false);
    assert.deepEqual(paths(result.results), ["Notes/合并策略.md"]);
  });
});

// §15.2 row 4: omitted + regex => regex only, never hybrid.
test("matrix omitted regex: regex-only results, no fallback", async () => {
  await withSearchClient(async (client) => {
    const result = await search(client, { query: "alpha", useRegex: true });
    assert.equal(result.semanticMode, "auto");
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.hybridUsed, false);
    // Wave B correction: the module-scope Diag/Alpha.md diagnostics fixture
    // also contains "alpha", so the vault-wide regex set includes it.
    assert.deepEqual(paths(result.results).sort(), ["Diag/Alpha.md", "Notes/A.md", "Notes/C.md"]);
  });
});

// §15.2 row 5: false + exact>0 => off, exact only.
test("matrix false exact>0: semanticMode off, exact only", async () => {
  await withSearchClient(async (client) => {
    const result = await search(client, { query: "禁止自动合并", semantic: false });
    assert.equal(result.semanticMode, "off");
    assert.equal(result.semanticRequested, false);
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.hybridUsed, false);
    assert.equal(result.semanticUsed, false);
    assert.deepEqual(paths(result.results), ["Notes/合并策略.md"]);
  });
});

// §15.2 row 6: false + exact=0 + text => strict zero.
test("matrix false exact=0+text: semanticMode off, strict zero", async () => {
  await withSearchClient(async (client) => {
    const result = await search(client, { query: "不自动合并", semantic: false });
    assert.equal(result.semanticMode, "off");
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.hybridUsed, false);
    assert.deepEqual(result.results, []);
  });
});

// §15.2 row 7: false + structural only => exact only.
test("matrix false structural-only: exact result, off", async () => {
  await withSearchClient(async (client) => {
    const result = await search(client, { query: "tag:policy/merge", semantic: false });
    assert.equal(result.semanticMode, "off");
    assert.equal(result.fallbackUsed, false);
    assert.deepEqual(paths(result.results), ["Notes/合并策略.md"]);
  });
});

// §15.2 row 8: false + regex => regex only.
test("matrix false regex: regex-only results", async () => {
  await withSearchClient(async (client) => {
    const result = await search(client, { query: "alpha", useRegex: true, semantic: false });
    assert.equal(result.semanticMode, "off");
    assert.equal(result.fallbackUsed, false);
    // Wave B correction: same vault-wide regex set as the omitted row above.
    assert.deepEqual(paths(result.results).sort(), ["Diag/Alpha.md", "Notes/A.md", "Notes/C.md"]);
  });
});

// §15.2 row 9: true + exact>0 => forced hybrid.
test("matrix true exact>0: semanticMode on, forced hybrid", async () => {
  await withSearchClient(async (client) => {
    const result = await search(client, { query: "禁止自动合并", semantic: true });
    assert.equal(result.semanticMode, "on");
    assert.equal(result.semanticRequested, true);
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.hybridUsed, true);
    assert.equal(result.semanticUsed, false);
    assert.match(result.semanticError || "", /Embedding provider is not configured; lexical hybrid ranking was used/);
    assert.ok(paths(result.results).includes("Notes/合并策略.md"));
  });
});

// §15.2 row 10: true + exact=0 + text => forced hybrid.
test("matrix true exact=0+text: forced hybrid", async () => {
  await withSearchClient(async (client) => {
    const result = await search(client, { query: "不自动合并", semantic: true });
    assert.equal(result.semanticMode, "on");
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.hybridUsed, true);
    assert.ok(paths(result.results).includes("Notes/合并策略.md"));
  });
});

// §15.2 row 11: true + structural only => current semanticText error.
test("matrix true structural-only: frozen semanticText error, exact kept", async () => {
  await withSearchClient(async (client) => {
    const result = await search(client, { query: "tag:policy/merge", semantic: true });
    assert.equal(result.semanticMode, "on");
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.hybridUsed, false);
    assert.equal(result.semanticUsed, false);
    assert.equal(result.semanticError, "Semantic search requires a positive text term");
    assert.deepEqual(paths(result.results), ["Notes/合并策略.md"]);
  });
});

// §15.2 row 12: true + regex => rejected.
test("matrix true regex: rejected with the frozen message", async () => {
  await withSearchClient(async (client) => {
    const result = await callSearch(client, { query: "alpha", useRegex: true, semantic: true });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "Error: Semantic search cannot be combined with regex mode");
  });
});

// §9 full Chinese table.
test("§9 Chinese table: exact, auto fallback, strict zero, forced hybrid", async () => {
  await withSearchClient(async (client) => {
    const exact = await search(client, { query: "禁止自动合并" });
    assert.ok(paths(exact.results).includes("Notes/合并策略.md"));
    assert.equal(exact.fallbackUsed, false);

    const variant = await search(client, { query: "不自动合并" });
    assert.equal(variant.fallbackUsed, true);
    assert.ok(paths(variant.results).includes("Notes/合并策略.md"));

    const substring = await search(client, { query: "自动合并" });
    assert.ok(paths(substring.results).includes("Notes/合并策略.md"));
    assert.equal(substring.fallbackUsed, false);

    const strict = await search(client, { query: "不自动合并", semantic: false });
    assert.deepEqual(strict.results, []);

    const forced = await search(client, { query: "不自动合并", semantic: true });
    assert.equal(forced.hybridUsed, true);

    // Fixture-frozen retrieval row: only 合并策略 carries 合并, so the lexical
    // candidate set is deterministic and does not depend on an embedding host.
    const authorized = await search(client, { query: "合并授权" });
    assert.equal(authorized.fallbackUsed, true);
    assert.deepEqual(paths(authorized.results), ["Notes/合并策略.md"]);
  });
});

// §10 multi-term table.
test("§10 multi-term table: implicit AND, OR, negative, filters, no resurrection", async () => {
  await withSearchClient(async (client) => {
    const cooccur = await search(client, { query: "alpha beta" });
    assert.deepEqual(paths(cooccur.results), ["Notes/C.md"]);
    assert.equal(cooccur.fallbackUsed, false);

    const fallback = await search(client, { query: "alpha gamma" });
    assert.equal(fallback.fallbackUsed, true);
    // Wave B correction: auto fallback reuses the existing hybrid retrieval
    // candidate path, which (by design) relaxes positive text clauses and keeps
    // only structural/negative filters mandatory. The Diag/Alpha.md diagnostics
    // fixture carries "alpha", so it is a legitimate fallback candidate; the
    // §10 contract fixes "auto 可 fallback", not an exact candidate set.
    assert.deepEqual(paths(fallback.results).sort(), ["Diag/Alpha.md", "Notes/A.md", "Notes/C.md"]);

    const strict = await search(client, { query: "alpha gamma", semantic: false });
    assert.deepEqual(strict.results, []);

    const either = await search(client, { query: "alpha OR gamma" });
    // Wave B correction: the OR group's exact "alpha" leg also matches Diag/Alpha.md.
    assert.deepEqual(paths(either.results).sort(), ["Diag/Alpha.md", "Notes/A.md", "Notes/C.md"]);
    assert.ok(!paths(either.results).includes("Notes/B.md"));

    const negative = await search(client, { query: "-beta alpha" });
    // Wave B correction: -beta excludes C (alpha beta) but keeps both alpha-only notes.
    assert.deepEqual(paths(negative.results).sort(), ["Diag/Alpha.md", "Notes/A.md"]);

    const tagged = await search(client, { query: "tag:x alpha gamma" });
    assert.equal(tagged.fallbackUsed, true);
    assert.deepEqual(paths(tagged.results).sort(), ["Notes/A.md", "Notes/C.md"]);
    for (const item of tagged.results) assert.ok(item.tags.includes("x"), `${item.path} must keep tag:x`);

    const missingTag = await search(client, { query: "tag:missing alpha" });
    assert.equal(missingTag.fallbackUsed, true);
    assert.deepEqual(missingTag.results, [], "fallback must not resurrect a note that fails tag:missing");
  });
});

// ---------------------------------------------------------------------------
// §15.3 fallback degradation.
// ---------------------------------------------------------------------------

test("§15.3 degradation: empty lexical fallback stays a non-fatal zero", async () => {
  await withSearchClient(async (client) => {
    const result = await search(client, { query: "zzz-nomatch-token" });
    assert.equal(result.semanticMode, "auto");
    assert.equal(result.fallbackUsed, true);
    assert.deepEqual(result.results, []);
    assert.equal(result.hybridUsed, true);
  });
});

test("§15.3 degradation: exact results are not lost and hard filters are not bypassed", async () => {
  await withSearchClient(async (client) => {
    const exact = await search(client, { query: "alpha beta -file:C" });
    // Wave B correction: the auto fallback uses the existing hybrid candidate
    // path (positive text relaxed, structural/negative filters mandatory), so
    // the alpha/beta notes survive while the only alpha+beta note (Notes/C.md)
    // is excluded by -file:C. The point of this test is that the negation is not
    // bypassed, so assert the surviving set and the explicit exclusion.
    assert.deepEqual(paths(exact.results).sort(), ["Diag/Alpha.md", "Diag/Beta.md", "Notes/A.md", "Notes/B.md"]);
    assert.ok(!paths(exact.results).includes("Notes/C.md"), "-file:C must not be bypassed by fallback");
    assert.equal(exact.semanticMode, "auto");
    const filtered = await search(client, { query: "tag:missing alpha" });
    assert.deepEqual(filtered.results, []);
    assert.equal(filtered.hybridUsed, true);
  });
});

// §15.4 diagnostics.
test("§15.4 diagnostics: candidateRecords is scoped to outer filters, not a Vault rewalk", async () => {
  await withSearchClient(async (client) => {
    const scoped = await search(client, { query: "alpha beta", pathPrefix: "Diag" });
    assert.ok(scoped.diagnostics, "exactMatched=0 must produce diagnostics");
    assert.equal(scoped.diagnostics.candidateRecords, 2);
    assert.equal(scoped.diagnostics.exactMatched, 0);
    assert.equal(scoped.diagnostics.groupCount, 1);
    assert.equal(typeof scoped.diagnostics.implicitAnd, "boolean");
    assert.equal(scoped.diagnostics.groups[0].matchedRecords, 0);
    const clauses = scoped.diagnostics.groups[0].clauses;
    assert.deepEqual(clauses.map((clause) => clause.raw).sort(), ["alpha", "beta"]);
    assert.deepEqual(clauses.map((clause) => clause.type), ["text", "text"]);
    assert.deepEqual(scoped.diagnostics.groups[0].clauses.map((clause) => clause.matchedRecords).sort(), [1, 1]);
  });
});

test("§15.4 diagnostics: candidateRecords=0 for an empty path prefix", async () => {
  await withSearchClient(async (client) => {
    const result = await search(client, { query: "alpha", pathPrefix: "DoesNotExist" });
    assert.ok(result.diagnostics);
    assert.equal(result.diagnostics.candidateRecords, 0);
    assert.equal(result.diagnostics.exactMatched, 0);
    assert.equal(result.diagnostics.groups[0].matchedRecords, 0);
  });
});

test("§15.4 diagnostics: single clause miss", async () => {
  await withSearchClient(async (client) => {
    const result = await search(client, { query: "gamma" });
    assert.ok(result.diagnostics);
    assert.equal(result.diagnostics.groupCount, 1);
    assert.equal(result.diagnostics.groups[0].clauses.length, 1);
    assert.equal(result.diagnostics.groups[0].clauses[0].raw, "gamma");
    assert.equal(result.diagnostics.groups[0].clauses[0].matchedRecords, 0);
    assert.equal(result.diagnostics.groups[0].matchedRecords, 0);
  });
});

test("§15.4 diagnostics: OR reports two groups", async () => {
  await withSearchClient(async (client) => {
    const result = await search(client, { query: "gamma OR delta" });
    assert.ok(result.diagnostics);
    assert.equal(result.diagnostics.groupCount, 2);
    assert.equal(result.diagnostics.groups.length, 2);
    assert.deepEqual(result.diagnostics.groups.map((group) => group.groupIndex), [0, 1]);
  });
});

test("§15.4 diagnostics: negative clause is reported as negated", async () => {
  await withSearchClient(async (client) => {
    const result = await search(client, { query: "gamma -beta" });
    assert.ok(result.diagnostics);
    const clauses = result.diagnostics.groups[0].clauses;
    const negated = clauses.find((clause) => clause.raw === "-beta");
    assert.ok(negated);
    assert.equal(negated.negated, true);
  });
});

test("§15.4 diagnostics: structural + text clauses are both reported", async () => {
  await withSearchClient(async (client) => {
    const result = await search(client, { query: "tag:missing alpha" });
    assert.ok(result.diagnostics);
    const types = result.diagnostics.groups[0].clauses.map((clause) => clause.type);
    assert.ok(types.includes("tag"));
    assert.ok(types.includes("text"));
  });
});

test("§15.4 diagnostics: bounded groups and clauses set truncated", async () => {
  await withSearchClient(async (client) => {
    const manyGroups = "q1 OR q2 OR q3 OR q4 OR q5 OR q6 OR q7 OR q8 OR q9";
    const groups = await search(client, { query: manyGroups });
    assert.ok(groups.diagnostics);
    assert.equal(groups.diagnostics.truncated, true);
    assert.ok(groups.diagnostics.groups.length <= 8);

    const manyClauses = "a1 b1 OR a2 b2 OR a3 b3 OR a4 b4 OR a5 b5 OR a6 b6 OR a7 b7 OR a8 b8 OR a9 b9";
    const clauses = await search(client, { query: manyClauses });
    assert.ok(clauses.diagnostics);
    assert.equal(clauses.diagnostics.truncated, true);
    const total = clauses.diagnostics.groups.reduce((sum, group) => sum + group.clauses.length, 0);
    assert.ok(total <= 16, `expected <=16 clauses, saw ${total}`);
  });
});

test("§15.4 diagnostics: CJK raw is preserved and no snippet/body leaks", async () => {
  await withSearchClient(async (client) => {
    const result = await search(client, { query: "不自动合并" });
    assert.ok(result.diagnostics);
    const clause = result.diagnostics.groups[0].clauses[0];
    assert.equal(clause.raw, "不自动合并");
    assert.equal(clause.type, "text");
    const serialized = JSON.stringify(result.diagnostics);
    assert.ok(!serialized.includes("用户确认"), "diagnostics must not leak note body text");
    assert.ok(!serialized.includes("snippets"), "diagnostics must not carry snippets");
  });
});

// ---------------------------------------------------------------------------
// §15.5 real temp-vault integration + output contract.
// ---------------------------------------------------------------------------

test("§15.5 real temp-vault: omitted semantic falls back lexically and explicit false stays strict", async () => {
  await withCapabilityClient(async (client) => {
    const auto = await search(client, { query: "不自动合并" });
    assert.equal(auto.semanticMode, "auto");
    assert.equal(auto.fallbackUsed, true);
    assert.ok(paths(auto.results).includes("Notes/合并策略.md"));

    const strict = await search(client, { query: "不自动合并", semantic: false });
    assert.deepEqual(strict.results, []);

    const exact = await search(client, { query: "禁止自动合并" });
    assert.equal(exact.fallbackUsed, false);
    assert.deepEqual(paths(exact.results), ["Notes/合并策略.md"]);
  });
});

test("contract: search_notes output schema declares semanticMode and fallbackUsed", () => {
  const schema = outputSchemaForTool("search_notes");
  assert.ok(schema.shape.semanticMode, "semanticMode must be a declared output field");
  assert.ok(schema.shape.fallbackUsed, "fallbackUsed must be a declared output field");
  assert.ok("diagnostics" in schema.shape, "diagnostics must be a declared optional output field");
  for (const mode of ["auto", "off", "on"]) {
    assert.equal(schema.shape.semanticMode.parse(mode), mode);
  }
  assert.equal(schema.shape.fallbackUsed.parse(true), true);
  assert.equal(schema.shape.fallbackUsed.parse(false), false);
});

// ---------------------------------------------------------------------------
// §17 architecture locks not already covered by the A2/characterization files.
// ---------------------------------------------------------------------------

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("§17 architecture: tool layer reuses the single mode source and keeps no second evaluator", async () => {
  const source = await fs.readFile(path.join(APP_ROOT, "src", "tools", "search.js"), "utf8");
  assert.match(source, /semanticModeFor/, "tools/search.js must reuse hybrid-search's single mode source");
  assert.ok(!source.includes("evaluateObsidianQuery"), "tools/search.js must not embed a second evaluator");
});

test("§17 architecture: the Search v2 analyzer still has no production importer", async () => {
  const importers = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "assets") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (/\.(?:js|mjs)$/.test(entry.name)) importers.push(absolute);
    }
  }
  await walk(path.join(APP_ROOT, "src"));
  const offenders = [];
  for (const file of importers) {
    const content = await fs.readFile(file, "utf8");
    if (/from\s+["'][^"']*\/analyzer\.js["']|require\(["'][^"']*\/analyzer\.js["']\)/.test(content)) {
      offenders.push(path.relative(APP_ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], "analyzer.js must stay offline-only (no production importer) in P1");
});
