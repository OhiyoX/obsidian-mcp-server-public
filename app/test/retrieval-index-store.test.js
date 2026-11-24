// M2 — generation store: publication, reuse, crash injection, pruning, A/B isolation.
//
// Contract (plan 02 Task 2): objects and manifests are immutable and
// content-addressed; the pointer is the only publication step; a failure before
// the pointer rename leaves the previous generation readable; a Vault never sees
// another Vault's state.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openIndexStore } from "../src/vault-runtime/retrieval-index-store.js";

const MODEL = "probe:model:2";

function stateOf(entries, embeddingModel = MODEL) {
  const notes = {};
  for (const [notePath, revision, vector] of entries) {
    notes[notePath] = {
      path: notePath,
      revision,
      stat: { mtimeMs: 1 },
      metadata: { title: notePath },
      chunks: [{ id: `${notePath}#0`, ordinal: 0, heading: "", text: "t", hash: `h-${revision}`, embedding: vector ? Float32Array.from(vector) : undefined }],
    };
  }
  return { version: 2, updatedAt: "2026-11-22T00:00:00.000Z", embeddingModel, notes };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, legacyIndexPath: path.join(root, "index", "retrieval-index.json") };
}

test("a store without a published generation loads as null", async (t) => {
  const { legacyIndexPath } = await fixture(t);
  const store = openIndexStore({ legacyIndexPath });
  assert.equal(await store.load(), null);
});

test("commit publishes, load reads back the same vectors, and no legacy file is written", async (t) => {
  const { legacyIndexPath, root } = await fixture(t);
  const store = openIndexStore({ legacyIndexPath });
  const state = stateOf([["A.md", "r1", [0.25, -0.5]], ["中文/B.md", "r1", [1, 0]]]);
  const report = await store.commit(state, ["A.md", "中文/B.md"]);
  assert.equal(report.notes, 2);
  assert.equal(report.objectsWritten, 2);

  const loaded = await store.load();
  assert.equal(loaded.generation, report.generation);
  assert.equal(loaded.embeddingModel, MODEL);
  assert.deepEqual([...loaded.notes["A.md"].chunks[0].embedding], [0.25, -0.5]);
  assert.deepEqual([...loaded.notes["中文/B.md"].chunks[0].embedding], [1, 0]);
  await assert.rejects(fs.stat(legacyIndexPath), { code: "ENOENT" }, "the store never touches the legacy JSON");
  assert.equal(await fs.readFile(path.join(store.currentPath), "utf8").then((text) => JSON.parse(text).previous), null);
  assert.ok(root.length > 0);
});

test("an unchanged note keeps its object and manifest entry untouched", async (t) => {
  const { legacyIndexPath } = await fixture(t);
  const store = openIndexStore({ legacyIndexPath });
  const first = stateOf([["A.md", "r1", [1, 0]], ["B.md", "r1", [0, 1]]]);
  const reportOne = await store.commit(first, ["A.md", "B.md"]);
  const objects = await fs.readdir(path.join(path.dirname(legacyIndexPath), "retrieval-index-v2", "objects"));
  const objectStats = await Promise.all(objects.map(async (name) => (await fs.stat(path.join(path.dirname(legacyIndexPath), "retrieval-index-v2", "objects", name))).mtimeMs));

  const second = structuredClone(first);
  second.notes["B.md"].revision = "r2";
  second.notes["B.md"].chunks[0].embedding = Float32Array.from([0, 0.5]);
  const reportTwo = await store.commit(second, ["B.md"]);
  assert.equal(reportTwo.objectsWritten, 1, "only the changed note writes a new object");
  assert.equal(reportTwo.previous, reportOne.generation);

  const after = await fs.readdir(path.join(path.dirname(legacyIndexPath), "retrieval-index-v2", "objects"));
  assert.equal(after.length, 3, "two original objects plus one new shard");
  const unchanged = await Promise.all(objects.map(async (name) => (await fs.stat(path.join(path.dirname(legacyIndexPath), "retrieval-index-v2", "objects", name))).mtimeMs));
  assert.deepEqual(unchanged, objectStats, "immutable objects are never rewritten");

  const loaded = await store.load();
  assert.deepEqual([...loaded.notes["A.md"].chunks[0].embedding], [1, 0]);
  assert.deepEqual([...loaded.notes["B.md"].chunks[0].embedding], [0, 0.5]);
});

test("a note without vectors roundtrips as an unembedded chunk", async (t) => {
  const { legacyIndexPath } = await fixture(t);
  const store = openIndexStore({ legacyIndexPath });
  await store.commit(stateOf([["A.md", "r1", null]]), ["A.md"]);
  const loaded = await store.load();
  assert.equal(loaded.notes["A.md"].chunks[0].embedding, undefined);
});

test("the pointer rename is the publication point: a failure there keeps the old generation", async (t) => {
  const { legacyIndexPath } = await fixture(t);
  const store = openIndexStore({ legacyIndexPath });
  const first = stateOf([["A.md", "r1", [1, 0]]]);
  const published = await store.commit(first, ["A.md"]);

  const failing = openIndexStore({
    legacyIndexPath,
    io: { before: (step) => { if (step === "pointer:write") throw new Error("injected pointer failure"); } },
  });
  const second = stateOf([["A.md", "r2", [0, 1]]]);
  await assert.rejects(failing.commit(second, ["A.md"]), /injected pointer failure/u);
  const stillOld = await store.load();
  assert.equal(stillOld.generation, published.generation);
  assert.deepEqual([...stillOld.notes["A.md"].chunks[0].embedding], [1, 0]);

  // A failure while writing an object must not publish either.
  const objectFail = openIndexStore({
    legacyIndexPath,
    io: { before: (step) => { if (step === "object:write") throw new Error("injected object failure"); } },
  });
  await assert.rejects(objectFail.commit(stateOf([["A.md", "r3", [0, 0]]]), ["A.md"]), /injected object failure/u);
  assert.equal((await store.load()).generation, published.generation);
});

test("a missing or corrupt object fails loudly instead of loading an empty index", async (t) => {
  const { legacyIndexPath } = await fixture(t);
  const store = openIndexStore({ legacyIndexPath });
  const report = await store.commit(stateOf([["A.md", "r1", [1, 0]]]), ["A.md"]);
  const objectsDir = path.join(path.dirname(legacyIndexPath), "retrieval-index-v2", "objects");
  const [objectName] = await fs.readdir(objectsDir);
  const original = await fs.readFile(path.join(objectsDir, objectName));
  await fs.writeFile(path.join(objectsDir, objectName), Buffer.concat([original.subarray(0, original.length - 4), Buffer.from([1, 2, 3, 4])]));
  await assert.rejects(store.load(), /payload length|holds|digest|not finite/u);
  await fs.rm(path.join(objectsDir, objectName));
  await assert.rejects(store.load(), /is missing/u);
  assert.equal(report.generation.length, 64);
});

test("a broken pointer or manifest is rejected", async (t) => {
  const { legacyIndexPath } = await fixture(t);
  const store = openIndexStore({ legacyIndexPath });
  await store.commit(stateOf([["A.md", "r1", [1, 0]]]), ["A.md"]);
  await fs.writeFile(store.currentPath, "{not json", "utf8");
  await assert.rejects(store.load(), /current\.json is not valid JSON/u);
  await fs.writeFile(store.currentPath, JSON.stringify({ version: 1, active: "../escape", previous: null }), "utf8");
  await assert.rejects(store.load(), /active must be a sha256 digest/u);
  await fs.writeFile(store.currentPath, JSON.stringify({ version: 1, active: "a".repeat(64), previous: null }), "utf8");
  await assert.rejects(store.load(), /is missing/u);
});

test("two Vaults with the same note path never share state", async (t) => {
  const { legacyIndexPath } = await fixture(t);
  const otherLegacy = path.join(path.dirname(legacyIndexPath), "vault-b", "retrieval-index.json");
  const storeA = openIndexStore({ legacyIndexPath });
  const storeB = openIndexStore({ legacyIndexPath: otherLegacy });
  await storeA.commit(stateOf([["A.md", "r1", [1, 0]]], "model-a"), ["A.md"]);
  await storeB.commit(stateOf([["A.md", "r1", [0, 1]]], "model-b"), ["A.md"]);
  const loadedA = await storeA.load();
  const loadedB = await storeB.load();
  assert.deepEqual([...loadedA.notes["A.md"].chunks[0].embedding], [1, 0]);
  assert.deepEqual([...loadedB.notes["A.md"].chunks[0].embedding], [0, 1]);
  assert.notEqual(loadedA.generation, loadedB.generation);
});

test("prune keeps the active and previous generation and respects the age window", async (t) => {
  const { legacyIndexPath } = await fixture(t);
  const store = openIndexStore({ legacyIndexPath });
  const base = stateOf([["A.md", "r1", [1, 0]]]);
  const first = await store.commit(base, ["A.md"]);
  const second = structuredClone(base);
  second.notes["A.md"].revision = "r2";
  second.notes["A.md"].chunks[0].embedding = Float32Array.from([0, 1]);
  const secondReport = await store.commit(second, ["A.md"]);
  const third = structuredClone(second);
  third.notes["A.md"].revision = "r3";
  third.notes["A.md"].chunks[0].embedding = Float32Array.from([1, 1]);
  const thirdReport = await store.commit(third, ["A.md"]);

  const young = await store.prune({ minAgeMs: 60 * 60 * 1000 });
  assert.equal(young.objectsRemoved, 0, "young orphans wait for the age window");
  const old = await store.prune({ minAgeMs: 0 });
  assert.equal(old.objectsRemoved, 1, "the generation before previous is collected");
  assert.equal(old.manifestsRemoved, 1);
  assert.equal((await store.load()).generation, thirdReport.generation);
  assert.equal(thirdReport.previous, secondReport.generation);
  assert.ok(first.generation.length === 64);
});

test("commit rejects a malformed state", async (t) => {
  const { legacyIndexPath } = await fixture(t);
  const store = openIndexStore({ legacyIndexPath });
  await assert.rejects(store.commit(null), /state object with a notes map/u);
  await assert.rejects(store.commit({ notes: null }), /state object with a notes map/u);
  assert.throws(() => openIndexStore({ legacyIndexPath: "" }), /non-empty path string/u);
  assert.throws(() => openIndexStore({ legacyIndexPath, io: { before: 5 } }), /io\.before must be a function/u);
});

test("commit prunes orphan generations once the age window allows it", async (t) => {
  const { legacyIndexPath } = await fixture(t);
  const store = openIndexStore({ legacyIndexPath, pruneIntervalMs: 0, pruneMinAgeMs: 0, log: { error() {} } });
  const base = stateOf([["A.md", "r1", [1, 0]]]);
  const first = await store.commit(base, ["A.md"]);
  const second = structuredClone(base);
  second.notes["A.md"].revision = "r2";
  second.notes["A.md"].chunks[0].embedding = Float32Array.from([0, 1]);
  const secondReport = await store.commit(second, ["A.md"]);
  const third = structuredClone(second);
  third.notes["A.md"].revision = "r3";
  third.notes["A.md"].chunks[0].embedding = Float32Array.from([1, 1]);
  const thirdReport = await store.commit(third, ["A.md"]);

  assert.equal(thirdReport.pruned.objectsRemoved, 1, "the generation before previous is collected");
  assert.equal(thirdReport.pruned.manifestsRemoved, 1);
  assert.equal(first.generation.length, 64);
  assert.equal(thirdReport.previous, secondReport.generation, "the previous generation stays readable");
  assert.notEqual((await store.load()).generation, secondReport.generation);
});

test("a prune failure never fails the commit", async (t) => {
  const { legacyIndexPath } = await fixture(t);
  const errors = [];
  const store = openIndexStore({ legacyIndexPath, pruneIntervalMs: 0, pruneMinAgeMs: 0, log: { error: (...args) => errors.push(args.join(" ")) } });
  const first = await store.commit(stateOf([["A.md", "r1", [1, 0]]]), ["A.md"]);
  const realReaddir = fs.readdir;
  fs.readdir = async (directory, ...rest) => {
    if (String(directory).includes("objects")) throw new Error("injected readdir failure");
    return realReaddir.call(fs, directory, ...rest);
  };
  let second;
  try {
    const next = stateOf([["A.md", "r2", [0, 1]]]);
    second = await store.commit(next, ["A.md"]);
  } finally {
    fs.readdir = realReaddir;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /injected readdir failure/u);
  assert.equal(second.generation.length, 64);
  assert.equal((await store.load()).generation, second.generation);
  assert.notEqual(second.generation, first.generation);
});

test("a manifest whose bytes do not match its digest is refused", async (t) => {
  const { legacyIndexPath } = await fixture(t);
  const store = openIndexStore({ legacyIndexPath });
  const report = await store.commit(stateOf([["A.md", "r1", [1, 0]]]), ["A.md"]);
  const manifestFile = path.join(path.dirname(legacyIndexPath), "retrieval-index-v2", "manifests", `${report.generation}.json`);
  const original = await fs.readFile(manifestFile, "utf8");
  await fs.writeFile(manifestFile, original.replace("A.md", "A2.md"), "utf8");
  await assert.rejects(store.load(), /content digest/u);
});
