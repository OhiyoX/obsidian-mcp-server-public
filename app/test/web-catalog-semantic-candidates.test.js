// Phase 3B-1 semantic candidate join contract.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// > Phase 3B
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  SEMANTIC_CANDIDATE_LIMIT,
  SemanticUnavailableError,
  joinSemanticCandidates,
} from "../src/app/web-catalog/semantic-candidates.js";
import { ensureCatalogDirectories, openWebCatalogStore } from "../src/app/web-catalog/store.js";

function seed(store, paths) {
  store.batch(() => {
    for (const notePath of paths) {
      ensureCatalogDirectories(store, notePath);
      store.upsertNote({ path: notePath, content: `# ${notePath}`, raw: `# ${notePath}`, modifiedMs: 5 });
    }
  });
}

// A store whose locate() calls are counted: the join must do one PK lookup per
// examined candidate and never enumerate the Vault.
function countingStore(store) {
  let locates = 0;
  return {
    store: {
      generation: () => store.generation(),
      locate: (value) => {
        locates += 1;
        return store.locate(value);
      },
    },
    locates: () => locates,
    bump: () => store.bumpGeneration(),
  };
}

test("the join is pure: it never reads the Vault or the filesystem", async () => {
  const source = await fs.readFile(new URL("../src/app/web-catalog/semantic-candidates.js", import.meta.url), "utf8");
  // Comments are excluded: the prose deliberately names the forbidden APIs.
  const code = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /markdownFiles|readFile|readNote|node:fs/);
  assert.doesNotMatch(code, /listMarkdownUnder|createVaultCatalogSource/);
});

test("candidate count is bounded by the frozen window", () => {
  const store = openWebCatalogStore();
  const paths = Array.from({ length: 300 }, (_, index) => `Notes/n-${String(index).padStart(3, "0")}.md`);
  seed(store, paths);
  const recall = { results: paths.map((path, index) => ({ path, score: 1 - index / 1000 })) };

  const joined = joinSemanticCandidates({ store, recall });
  assert.equal(joined.items.length, SEMANTIC_CANDIDATE_LIMIT);
  assert.equal(joined.candidates, 300, "the caller sees how many candidates were offered");
  // An over-large limit is clamped, not honoured.
  assert.equal(joinSemanticCandidates({ store, recall, limit: 10_000 }).items.length, SEMANTIC_CANDIDATE_LIMIT);
  assert.equal(joinSemanticCandidates({ store, recall, limit: 5 }).items.length, 5);
  store.close();
});

test("the examined candidate window is hard-bounded even when nothing joins", () => {
  const store = openWebCatalogStore();
  seed(store, ["Notes/A.md"]);
  const counted = countingStore(store);
  const missing = Array.from({ length: 100_000 }, (_, index) => ({ path: `Ghost/g-${index}.md`, score: 1 }));
  const invalid = Array.from({ length: 5_000 }, (_, index) => ({ path: `/abs/g-${index}.md`, score: 1 }));
  // Missing (canonical, unknown to the catalog) first, so the whole 200-wide window
  // really performs 200 catalog lookups; the invalid paths then never enter it.
  const joined = joinSemanticCandidates({ store: counted.store, recall: { results: [...missing, ...invalid] }, limit: 5 });
  assert.equal(joined.candidates, 105_000, "the caller still sees the offered count");
  assert.equal(joined.window, SEMANTIC_CANDIDATE_LIMIT);
  assert.equal(joined.examined, SEMANTIC_CANDIDATE_LIMIT, "examined is capped by the window, not by the output limit");
  assert.equal(counted.locates(), SEMANTIC_CANDIDATE_LIMIT, `one lookup per windowed canonical candidate: ${counted.locates()}`);
  assert.equal(joined.skippedMissing, SEMANTIC_CANDIDATE_LIMIT);
  assert.equal(joined.skippedPath, 0, "the invalid tail never enters the window");
  assert.deepEqual(joined.items, []);
  store.close();
});

test("a late duplicate with a better score still wins at a small output limit", () => {
  const store = openWebCatalogStore();
  seed(store, ["Notes/A.md", "Notes/B.md", "Notes/C.md"]);
  // A=1, B=1, C=1, then A=9: with a naive "stop when accepted == limit" loop the
  // later A=9 would never be seen and A would stay at 1.
  const joined = joinSemanticCandidates({
    store,
    recall: {
      results: [
        { path: "Notes/A.md", score: 1 },
        { path: "Notes/B.md", score: 1 },
        { path: "Notes/C.md", score: 1 },
        { path: "Notes/A.md", score: 9 },
      ],
    },
    limit: 2,
  });
  assert.equal(joined.examined, 4, "the whole window is processed");
  assert.equal(joined.duplicates, 1);
  assert.deepEqual(joined.items.map((item) => item.path), ["Notes/A.md", "Notes/B.md"]);
  assert.equal(joined.items[0].semanticScore, 9, "best-score dedupe must win");
  store.close();
});

test("one catalog lookup per examined candidate, and no enumeration", () => {
  const store = openWebCatalogStore();
  seed(store, ["Notes/A.md", "Notes/B.md", "Notes/C.md"]);
  const counted = countingStore(store);
  const joined = joinSemanticCandidates({
    store: counted.store,
    recall: { results: [{ path: "Notes/A.md", score: 2 }, { path: "Missing.md", score: 1 }, { path: "Notes/B.md", score: 1 }] },
  });
  assert.equal(joined.examined, 3);
  assert.equal(counted.locates(), 3, "exactly one lookup per candidate");
  assert.equal(joined.skippedMissing, 1);
  assert.deepEqual(joined.items.map((item) => item.path), ["Notes/A.md", "Notes/B.md"]);
  store.close();
});

test("path join, dedupe and missing handling are deterministic", () => {
  const store = openWebCatalogStore();
  seed(store, ["Notes/A.md", "Notes/B.md", "Folder"]);
  store.batch(() => store.upsertDirectory({ path: "OnlyDir", name: "OnlyDir" }));

  const joined = joinSemanticCandidates({
    store,
    recall: {
      results: [
        { path: "Notes/A.md", score: 1 },
        { path: "Notes/A.md", score: 3 }, // duplicate: the better score wins
        { path: "/abs/Notes/A.md", score: 9 }, // absolute -> fail closed
        { path: "../escape.md", score: 9 }, // traversal -> fail closed
        { path: "Notes/Deleted.md", score: 9 }, // not in the catalog -> skipped
        { path: "OnlyDir", score: 9 }, // not a note -> skipped
        { path: "Notes/B.md", score: 2 },
      ],
    },
  });

  assert.deepEqual(joined.items.map((item) => item.path), ["Notes/A.md", "Notes/B.md"], "score order, path tie-break");
  assert.equal(joined.items[0].semanticScore, 3, "dedupe keeps the best score");
  assert.equal(joined.duplicates, 1);
  assert.equal(joined.skippedPath, 2);
  assert.equal(joined.skippedMissing, 2);
  // Identity comes from the catalog row.
  assert.equal(joined.items[0].kind, "note");
  assert.equal(joined.items[0].name, "A.md");
  assert.equal(joined.items[0].modifiedMs, 5);
  assert.ok(joined.items[0].revision === null || typeof joined.items[0].revision === "string");
  store.close();
});

test("a catalog generation move is reported instead of mixing snapshots", () => {
  const store = openWebCatalogStore();
  seed(store, ["Notes/A.md"]);
  const counted = countingStore(store);
  const recall = { results: [{ path: "Notes/A.md", score: 1 }] };

  const stable = joinSemanticCandidates({ store: counted.store, recall });
  assert.equal(stable.generationMismatch, false);

  // Simulate a mutation landing while the candidate snapshot is being joined.
  const racing = {
    generation: (() => {
      let calls = 0;
      return () => {
        calls += 1;
        return calls > 1 ? store.generation() + 1 : store.generation();
      };
    })(),
    locate: (value) => store.locate(value),
  };
  const moved = joinSemanticCandidates({ store: racing, recall });
  assert.equal(moved.generationMismatch, true, "the caller must fail closed");
  store.close();
});

// NOTE for 3B-2: recallFromSnapshot() currently throws a plain
// Error("Retrieval snapshot unavailable") rather than returning { unavailable: true },
// so the HTTP layer must map that producer error onto SemanticUnavailableError. The
// assertion below covers the injected result shape only.
test("an unavailable retrieval snapshot is an explicit error, never an empty result", () => {
  const store = openWebCatalogStore();
  assert.throws(() => joinSemanticCandidates({ store, recall: { unavailable: true } }), SemanticUnavailableError);
  assert.throws(() => joinSemanticCandidates({ store, recall: null }), SemanticUnavailableError);
  // A degraded retrieval snapshot is surfaced, not hidden.
  const joined = joinSemanticCandidates({
    store,
    recall: { results: [], semanticUsed: false, semanticError: "embedding provider not configured" },
  });
  assert.deepEqual(joined.items, []);
  assert.equal(joined.semanticUsed, false);
  assert.equal(joined.semanticError, "embedding provider not configured");
  store.close();
});
