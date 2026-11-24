// M1 — a refresh with no actual change must not clone, stringify or write.
//
// Contract: "DESIGN - 检索内存优化与二进制索引 v2" §增量同步语义; plan 01 Task 3.
// A recall schedules a refresh every 10 s; before this change each of those
// rewrote the whole index (383 MiB on production data), so the observable proof
// is: zero index writes, identical bytes/mtime, and `updatedAt` not advancing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRetrievalRuntime } from "../src/vault-runtime/retrieval-runtime.js";

const SEMANTIC = Object.freeze({ enabled: true, identity: "probe:model:2" });

function record(notePath, revision, content) {
  return { path: notePath, basename: path.basename(notePath), revision, content, frontmatter: {}, tags: [], aliases: [], stat: { mtimeMs: 1, created: "2026-11-22T00:00:00.000Z", modified: "2026-11-22T00:00:00.000Z" } };
}

function harness({ indexPath, records, semantic = () => SEMANTIC }) {
  const calls = { embed: 0, scans: 0 };
  const runtime = createRetrievalRuntime({
    vaultRuntime: { id: "vault-a", paths: { retrievalIndex: indexPath } },
    embeddingProvider: {
      semanticConfiguration: semantic,
      embedTexts: async (texts) => {
        calls.embed += texts.length;
        return texts.map(() => [1, 0]);
      },
    },
    deps: {
      getVaultIndex: async () => {
        calls.scans += 1;
        return { records, stats: { files: records.length } };
      },
    },
  });
  return { runtime, calls };
}

// Count the index writes the runtime performs, without hiding them from the real fs.
function instrument(dir) {
  const original = { writeFile: fs.writeFile, rename: fs.rename };
  const seen = { writeFile: 0, rename: 0 };
  const inside = (candidate) => String(candidate).startsWith(dir);
  fs.writeFile = async (candidate, ...rest) => {
    if (inside(candidate)) seen.writeFile += 1;
    return original.writeFile.call(fs, candidate, ...rest);
  };
  fs.rename = async (from, to, ...rest) => {
    if (inside(from) || inside(to)) seen.rename += 1;
    return original.rename.call(fs, from, to, ...rest);
  };
  return {
    seen,
    restore() {
      fs.writeFile = original.writeFile;
      fs.rename = original.rename;
    },
  };
}

// M2: the runtime publishes a v2 generation, so "the index did not change" is the
// fingerprint of every published file (and the files themselves are immutable).
async function snapshot(indexPath) {
  const root = path.join(path.dirname(indexPath), "retrieval-index-v2");
  const walk = async (directory) => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    const rows = [];
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) rows.push(...await walk(full));
      else {
        const bytes = await fs.readFile(full);
        rows.push(`${path.relative(root, full)}:${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`);
      }
    }
    return rows;
  };
  const rows = (await walk(root)).sort();
  return { hash: createHash("sha256").update(rows.join("|")).digest("hex"), files: rows.length };
}

test("M1: an unchanged refresh performs zero index writes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-noop-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const indexPath = path.join(root, "index", "retrieval-index.json");
  const records = [record("A.md", "r1", "# A\n\nneedle alpha\n"), record("中文/B.md", "r1", "# B\n\n针\n")];
  const { runtime, calls } = harness({ indexPath, records });

  const first = await runtime.syncRetrievalIndex({ embeddings: true });
  assert.equal(first.added, 2);
  assert.equal(calls.embed, 2);
  const before = await snapshot(indexPath);
  assert.equal(before.files > 0, true, "the first sync must publish a generation");

  const probe = instrument(path.dirname(indexPath));
  let second;
  try {
    second = await runtime.syncRetrievalIndex({ embeddings: true });
  } finally {
    probe.restore();
  }
  assert.deepEqual(probe.seen, { writeFile: 0, rename: 0 }, "a no-change refresh must not write the index");
  assert.deepEqual(await snapshot(indexPath), before, "index bytes and mtime must stay identical");
  assert.equal(second.added, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.removed, 0);
  assert.equal(second.reused, 2);
  assert.equal(second.embeddedChunks, 0);
  assert.equal(second.notes, 2);
  assert.equal(second.updatedAt, first.updatedAt, "no-op must not advance updatedAt");
  assert.equal(calls.embed, 2, "no embedding call for an unchanged index");

  // Negative control: the same instrumentation does see a real write.
  const forced = instrument(path.dirname(indexPath));
  let forcedResult;
  try {
    forcedResult = await runtime.syncRetrievalIndex({ force: true, embeddings: true });
  } finally {
    forced.restore();
  }
  assert.equal(forced.seen.writeFile >= 1, true, "force must publish a new generation");
  assert.equal(forcedResult.updated, 2);
  assert.notEqual(forcedResult.updatedAt, first.updatedAt);
});

test("M1: a single changed note still writes and reuses untouched chunks", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-noop-single-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const indexPath = path.join(root, "index", "retrieval-index.json");
  const records = [record("A.md", "r1", "# A\n\nstable text\n"), record("B.md", "r1", "# B\n\nother\n")];
  const { runtime, calls } = harness({ indexPath, records });
  await runtime.syncRetrievalIndex({ embeddings: true });
  assert.equal(calls.embed, 2);

  records[1] = record("B.md", "r2", "# B\n\nother text now longer\n");
  const probe = instrument(path.dirname(indexPath));
  let second;
  try {
    second = await runtime.syncRetrievalIndex({ embeddings: true });
  } finally {
    probe.restore();
  }
  assert.equal(probe.seen.writeFile >= 1, true, "a real change must persist a new generation");
  assert.equal(second.updated, 1);
  assert.equal(second.reused, 1);
  assert.equal(second.added, 0);
});

test("M1: a removed note still deletes it from the index", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-noop-removed-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const indexPath = path.join(root, "index", "retrieval-index.json");
  const records = [record("A.md", "r1", "# A\n\nalpha\n"), record("B.md", "r1", "# B\n\nbeta\n")];
  const { runtime } = harness({ indexPath, records });
  await runtime.syncRetrievalIndex({ embeddings: false });
  records.pop();
  const result = await runtime.syncRetrievalIndex({ embeddings: false });
  assert.equal(result.removed, 1);
  assert.equal(result.notes, 1);
});

test("M1: a model identity change invalidates and re-embeds, never a no-op", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-noop-model-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const indexPath = path.join(root, "index", "retrieval-index.json");
  const records = [record("A.md", "r1", "# A\n\nalpha\n")];
  let identity = "probe:model:2";
  const { runtime, calls } = harness({ indexPath, records, semantic: () => ({ enabled: true, identity }) });
  await runtime.syncRetrievalIndex({ embeddings: true });
  assert.equal(calls.embed, 1);

  identity = "probe:model:3";
  const result = await runtime.syncRetrievalIndex({ embeddings: true });
  assert.equal(calls.embed, 2, "the new model must embed the note again");
  // Legacy counting parity: the note revision is unchanged, so it counts as reused
  // while its stale vectors are replaced (embeddedChunks reports the new work).
  assert.equal(result.updated, 0);
  assert.equal(result.reused, 1);
  assert.equal(result.embeddedChunks, 1);
});

test("M1: missing vectors are filled only when embeddings are requested", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-noop-missing-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const indexPath = path.join(root, "index", "retrieval-index.json");
  const records = [record("A.md", "r1", "# A\n\nalpha\n")];
  const { runtime, calls } = harness({ indexPath, records });

  // Lexical-only build leaves the chunk without a vector.
  await runtime.syncRetrievalIndex({ embeddings: false });
  assert.equal(calls.embed, 0);
  const lexicalAgain = await runtime.syncRetrievalIndex({ embeddings: false });
  assert.equal(lexicalAgain.reused, 1);
  assert.equal(lexicalAgain.embeddedChunks, 0);

  const filled = await runtime.syncRetrievalIndex({ embeddings: true });
  assert.equal(filled.embeddedChunks, 1);
  assert.equal(calls.embed, 1);
});
