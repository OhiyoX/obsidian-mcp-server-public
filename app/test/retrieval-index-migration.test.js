// M2 — legacy v1 -> v2 migration without re-embedding (plan 02 Task 3).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openIndexStore } from "../src/vault-runtime/retrieval-index-store.js";
import { legacyIndexState, migrateLegacyIndex } from "../src/vault-runtime/retrieval-index-migration.js";

function legacyState(notes, { embeddingModel = "probe:model:2", version = 1 } = {}) {
  return { version, updatedAt: "2026-11-20T00:00:00.000Z", embeddingModel, notes };
}

function legacyNote(notePath, revision, chunks) {
  return { path: notePath, revision, stat: { mtimeMs: 1 }, metadata: { title: notePath }, chunks };
}

async function fixture(t, state) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-migration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacyIndexPath = path.join(root, "index", "retrieval-index.json");
  await fs.mkdir(path.dirname(legacyIndexPath), { recursive: true });
  await fs.writeFile(legacyIndexPath, `${JSON.stringify(state)}\n`, "utf8");
  return { root, legacyIndexPath, store: openIndexStore({ legacyIndexPath }) };
}

test("a legacy index converts with zero embedding calls and keeps its bytes", async (t) => {
  const state = legacyState({
    "A.md": legacyNote("A.md", "r1", [
      { id: "A.md#0", ordinal: 0, heading: "A", text: "alpha", hash: "h0", embedding: [0.1, 0.2] },
      { id: "A.md#1", ordinal: 1, heading: "A", text: "beta", hash: "h1" },
    ]),
    "中文/B.md": legacyNote("中文/B.md", "r1", [{ id: "中文/B.md#0", ordinal: 0, heading: "题", text: "正文", hash: "h2", embedding: [1, 0] }]),
  });
  const { legacyIndexPath, store } = await fixture(t, state);
  const before = await fs.readFile(legacyIndexPath);
  const report = await migrateLegacyIndex({ legacyIndexPath, store });
  assert.equal(report.status, "migrated");
  assert.equal(report.convertedNotes, 2);
  assert.equal(report.convertedVectors, 2);
  assert.equal(report.formatVersion, 2);
  assert.equal(report.sourceDigest, createHash("sha256").update(before).digest("hex"));
  assert.deepEqual(await fs.readFile(legacyIndexPath), before, "the legacy file is never modified");

  const loaded = await store.load();
  assert.equal(loaded.embeddingModel, "probe:model:2");
  assert.deepEqual([...loaded.notes["A.md"].chunks[0].embedding], [Math.fround(0.1), Math.fround(0.2)]);
  assert.equal(loaded.notes["A.md"].chunks[1].embedding, undefined);
  assert.deepEqual([...loaded.notes["中文/B.md"].chunks[0].embedding], [1, 0]);
});

test("migration is idempotent and never overwrites a published generation", async (t) => {
  const state = legacyState({ "A.md": legacyNote("A.md", "r1", [{ id: "A.md#0", heading: "", text: "t", hash: "h", embedding: [1, 0] }]) });
  const { legacyIndexPath, store } = await fixture(t, state);
  const first = await migrateLegacyIndex({ legacyIndexPath, store });
  const second = await migrateLegacyIndex({ legacyIndexPath, store });
  assert.equal(first.status, "migrated");
  assert.equal(second.status, "already-migrated");
  assert.equal((await store.load()).generation, first.generation);
  const objects = await fs.readdir(path.join(path.dirname(legacyIndexPath), "retrieval-index-v2", "objects"));
  assert.equal(objects.length, 1, "a second run writes no duplicate object");
});

test("concurrent migration calls share one conversion", async (t) => {
  const state = legacyState({ "A.md": legacyNote("A.md", "r1", [{ id: "A.md#0", heading: "", text: "t", hash: "h", embedding: [1, 0] }]) });
  const { legacyIndexPath, store } = await fixture(t, state);
  const [left, right] = await Promise.all([migrateLegacyIndex({ legacyIndexPath, store }), migrateLegacyIndex({ legacyIndexPath, store })]);
  assert.equal(left.status, "migrated");
  assert.equal(right.status, "migrated");
  assert.equal(left.generation, right.generation);
});

test("mixed vector dimensions are rejected", async (t) => {
  const state = legacyState({
    "A.md": legacyNote("A.md", "r1", [{ id: "A.md#0", heading: "", text: "t", hash: "h", embedding: [1, 0] }]),
    "B.md": legacyNote("B.md", "r1", [{ id: "B.md#0", heading: "", text: "t", hash: "h", embedding: [1, 0, 0] }]),
  });
  const { legacyIndexPath, store } = await fixture(t, state);
  await assert.rejects(migrateLegacyIndex({ legacyIndexPath, store }), /dimension 3, expected 2/u);
  assert.equal(await store.load(), null, "a failed conversion publishes nothing");
});

test("an unsupported legacy version, missing file and oversized file fail gracefully", async (t) => {
  const { legacyIndexPath, store } = await fixture(t, legacyState({}, { version: 99 }));
  await assert.rejects(migrateLegacyIndex({ legacyIndexPath, store }), /version must be 1/u);

  const empty = await fixture(t, legacyState({}));
  assert.equal((await migrateLegacyIndex({ legacyIndexPath: empty.legacyIndexPath, store: empty.store })).status, "migrated");
  const missingPath = path.join(empty.root, "other-vault", "index", "absent.json");
  assert.equal((await migrateLegacyIndex({ legacyIndexPath: missingPath, store: openIndexStore({ legacyIndexPath: missingPath }) })).status, "no-legacy");

  const big = await fixture(t, legacyState({ "A.md": legacyNote("A.md", "r1", []) }));
  await assert.rejects(migrateLegacyIndex({ legacyIndexPath: big.legacyIndexPath, store: big.store, limitBytes: 10 }), /above the 10-byte migration limit/u);
});

test("legacyIndexState distinguishes absent, empty and present files", async (t) => {
  const { root, legacyIndexPath } = await fixture(t, legacyState({ "A.md": legacyNote("A.md", "r1", []) }));
  assert.deepEqual(await legacyIndexState(legacyIndexPath), { present: true, bytes: (await fs.stat(legacyIndexPath)).size });
  assert.deepEqual(await legacyIndexState(path.join(root, "absent.json")), { present: false, bytes: 0 });
});

test("corrupt JSON and malformed notes are rejected without publishing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-migration-bad-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacyIndexPath = path.join(root, "index", "retrieval-index.json");
  await fs.mkdir(path.dirname(legacyIndexPath), { recursive: true });
  const store = openIndexStore({ legacyIndexPath });
  await fs.writeFile(legacyIndexPath, "{nope", "utf8");
  await assert.rejects(migrateLegacyIndex({ legacyIndexPath, store }), /not valid JSON/u);
  await fs.writeFile(legacyIndexPath, JSON.stringify({ version: 1, notes: { "A.md": { chunks: "nope" } } }), "utf8");
  await assert.rejects(migrateLegacyIndex({ legacyIndexPath, store }), /no chunks array/u);
  assert.equal(await store.load(), null);
});

test("the offline CLI converts an isolated copy and refuses a real root", async (t) => {
  const { runMigration } = await import("../scripts/retrieval-v1-to-v2.mjs");
  const { default: fsPromises } = await import("node:fs/promises");
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "retrieval-migration-cli-"));
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "index", "retrieval-index.json");
  await fsPromises.mkdir(path.dirname(source), { recursive: true });
  await fsPromises.writeFile(source, JSON.stringify(legacyState({ "A.md": legacyNote("A.md", "r1", [{ id: "A.md#0", heading: "", text: "t", hash: "h", embedding: [1, 0] }]) })), "utf8");
  const report = path.join(root, "out", "migration.json");
  const summary = await runMigration({ source, report });
  assert.equal(summary.status, "migrated");
  assert.equal(summary.convertedVectors, 1);
  assert.equal(summary.legacyBytes > 0, true);
  assert.equal(summary.peak.rssBytes > 0, true);
  const written = JSON.parse(await fsPromises.readFile(report, "utf8"));
  assert.equal(written.convertedNotes, 1);
  await assert.rejects(runMigration({ source: "/data/index/retrieval-index.json" }), /refusing to convert inside/u);
});
