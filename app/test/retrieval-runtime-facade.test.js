// B3 — `src/retrieval.js` compatibility facade.
//
// Contract: Architecture/DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置
//   §10.1 transitional compatibility facade · §12 Retrieval runtime · §5.1 primary compatibility
//   · §43-5 facade allowlist · §45 mandatory gates
//
// The facade must keep every legacy export (name + arity + behavior) and simply *be* the
// primary runtime's methods. The primary index path must stay the legacy one via the A7
// primary mapping, and the injected tunables must be the live `config.js` values (the drift
// guard that keeps `DEFAULT_RETRIEVAL_CONFIG` from silently diverging).

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "mv-b3-retrieval-facade-"));
const vaultRoot = path.join(root, "vault");
const dataRoot = path.join(root, "data");
const indexPath = path.join(dataRoot, "index", "retrieval-index.json");
process.env.VAULT_PATH = vaultRoot;
process.env.DATA_PATH = dataRoot;
process.env.HISTORY_PATH = path.join(dataRoot, "history");
process.env.RETRIEVAL_INDEX_PATH = indexPath;
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

await fs.mkdir(vaultRoot, { recursive: true });
await fs.mkdir(dataRoot, { recursive: true });
await fs.writeFile(path.join(vaultRoot, "Note.md"), "# Note\n\nfacade-primary-needle\n", "utf8");

const retrieval = await import("../src/retrieval.js");
const config = await import("../src/config.js");

after(async () => {
  await retrieval.drainRetrievalIndex();
  await fs.rm(root, { recursive: true, force: true });
});

// Frozen snapshot of the BASE `retrieval.js` exports (name → arity), captured from
// `git show <BASE>:app/src/retrieval.js` behavior. The additive `primaryRetrievalRuntime`
// export is deliberately not part of the legacy set.
const FROZEN_LEGACY_EXPORTS = Object.freeze({
  chunkMarkdown: 1,
  drainRetrievalIndex: 0,
  embedTexts: 2,
  recall: 1,
  recallFromSnapshot: 1,
  requestRetrievalRefresh: 0,
  retrievalIndexStatus: 0,
  retrievalIndexStatusSnapshot: 0,
  scheduleRetrievalRefresh: 0,
  semanticConfiguration: 0,
  semanticHealth: 0,
  startRetrievalIndex: 0,
  syncRetrievalIndex: 0,
  tokenize: 1,
});

const DELEGATED_EXPORTS = Object.freeze([
  "chunkMarkdown",
  "tokenize",
  "syncRetrievalIndex",
  "startRetrievalIndex",
  "requestRetrievalRefresh",
  "scheduleRetrievalRefresh",
  "drainRetrievalIndex",
  "retrievalIndexStatus",
  "retrievalIndexStatusSnapshot",
  "recall",
  "recallFromSnapshot",
]);

test("facade keeps every legacy export name and arity (frozen snapshot)", () => {
  const legacyNames = Object.keys(FROZEN_LEGACY_EXPORTS).sort();
  const actual = Object.keys(retrieval).filter((name) => name !== "primaryRetrievalRuntime").sort();
  assert.deepEqual(actual, legacyNames);
  for (const [name, arity] of Object.entries(FROZEN_LEGACY_EXPORTS)) {
    assert.equal(typeof retrieval[name], "function", `${name} must stay a function`);
    assert.equal(retrieval[name].length, arity, `${name} arity changed`);
  }
  assert.ok(Object.isFrozen(retrieval.primaryRetrievalRuntime), "the additive instance export must be frozen");
});

test("legacy exports ARE the primary instance's own functions (delegation, not a second copy)", () => {
  for (const name of DELEGATED_EXPORTS) {
    assert.equal(retrieval[name], retrieval.primaryRetrievalRuntime[name], `${name} must delegate to the primary runtime`);
  }
  assert.equal(retrieval.primaryRetrievalRuntime.tokenize, retrieval.tokenize);
});

test("facade wires the live config.js tunables and the legacy (A7 primary) index path", () => {
  assert.equal(retrieval.primaryRetrievalRuntime.indexPath, indexPath);
  assert.deepEqual({ ...retrieval.primaryRetrievalRuntime.retrievalConfig }, {
    chunkSize: config.RETRIEVAL_CHUNK_SIZE,
    overlap: config.RETRIEVAL_CHUNK_OVERLAP,
    autoEmbed: config.RETRIEVAL_AUTO_EMBED,
    refreshDebounceMs: config.RETRIEVAL_REFRESH_DEBOUNCE_MS,
    embeddingBatchSize: config.EMBEDDING_BATCH_SIZE,
    embeddingIndexConcurrency: config.EMBEDDING_INDEX_CONCURRENCY,
  });
  assert.equal(retrieval.primaryRetrievalRuntime.capability.available, true);
  assert.equal(typeof retrieval.primaryRetrievalRuntime.capability.reason, "undefined");
});

test("primary behavior is unchanged: snapshot, index, status, recall", async () => {
  assert.equal(retrieval.retrievalIndexStatusSnapshot(), null, "must not cold-load the retrieval JSON");

  const sync = await retrieval.syncRetrievalIndex({ force: true });
  assert.equal(sync.notes, 1);
  assert.equal(sync.added, 1);
  assert.equal(sync.semanticError, null);

  const status = await retrieval.retrievalIndexStatus();
  assert.equal(status.available, true);
  assert.equal(status.path, indexPath);
  assert.equal(status.notes, 1);
  assert.equal(status.indexJob, null);
  assert.equal(status.semantic.enabled, false);
  assert.equal(status.capability.available, true);

  const snapshot = retrieval.retrievalIndexStatusSnapshot();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.notes, 1);
  assert.equal(snapshot.path, indexPath);

  const recalled = await retrieval.recall("facade-primary-needle");
  assert.ok(recalled.results.some((result) => result.path === "Note.md"));
  assert.equal(recalled.semanticUsed, false);
  assert.equal(recalled.unavailable, undefined);
  assert.equal(recalled.index.path, indexPath);

  const semantic = retrieval.primaryRetrievalRuntime.semanticCapability();
  assert.equal(semantic.available, false, "EMBEDDING_PROVIDER=disabled must be structured, not silent");
  assert.equal(typeof semantic.reason, "string");

  await assert.rejects(retrieval.recall("   "), /Recall query is required/);
  await assert.rejects(retrieval.recallFromSnapshot(""), /Recall query is required/);
});

test("chunkMarkdown / tokenize behavior is unchanged through the facade", () => {
  assert.deepEqual(retrieval.tokenize("OpenWrt 网络故障"), ["openwrt", "网络故障", "网", "络", "故", "障", "网络", "络故", "故障"]);
  const chunks = retrieval.chunkMarkdown(
    { basename: "Test", frontmatter: { title: "测试" }, content: "# 测试\n\n简介\n\n## 排障\n\n处理步骤", path: "Test.md" },
    { chunkSize: 400, overlap: 0 },
  );
  assert.ok(chunks.some((chunk) => chunk.heading === "排障" && chunk.text.includes("处理步骤")));
  // Omitted options must fall back to the injected config (BASE used the same config constants).
  const defaulted = retrieval.chunkMarkdown({ basename: "T", frontmatter: {}, content: "x".repeat(2000), path: "T.md" });
  assert.ok(defaulted.length >= 2, "the injected chunkSize must still split long content");
});
