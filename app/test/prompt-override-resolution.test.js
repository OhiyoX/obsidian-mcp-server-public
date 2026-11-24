// P3: Runtime Override — sparse, default-empty, allowlisted, and reversible.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { bundledBasePack } from "../src/prompt-registry/bundled.js";
import { createPromptAdminService } from "../src/prompt-registry/service.js";
import { resolveEffective } from "../src/prompt-registry/registry.js";
import { validateOverridePatch, INVALID_OVERRIDE_KEY } from "../src/prompt-registry/schema.js";
import { createPromptRegistryStore } from "../src/prompt-registry/store.js";

const bundled = bundledBasePack();
const roots = [];

test.after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-override-"));
  roots.push(root);
  const store = createPromptRegistryStore({
    headFile: path.join(root, "agent-prompts.json"),
    packsDir: path.join(root, "packs"),
    bundledBase: bundled,
  });
  await store.ready;
  const audit = [];
  const service = createPromptAdminService({ store, bundledBase: bundled, audit: async (entry) => void audit.push(entry) });
  return { store, service, audit };
}

test("a fresh install has no overrides at all", async () => {
  const { store, service } = await fixture();
  assert.deepEqual(store.snapshot().overrides, {});
  const published = await service.publishOverride({ expectedRevision: 0, set: {}, removeKeys: [], reason: "noop-free" });
  assert.equal(published.ok, true);
  assert.deepEqual(store.snapshot().overrides, {});
  assert.equal(store.snapshot().overrideCount, 0);
});

test("an override wins for its key, survives a Base publish, and reset returns the live Base", async () => {
  const { store, service } = await fixture();
  const key = "memory.firstRead";
  const first = await service.publishOverride({ expectedRevision: 0, set: { [key]: "override text" }, reason: "unit" });
  assert.equal(first.ok, true);
  assert.equal(store.snapshot().sources[key], "override");
  assert.deepEqual(store.snapshot().shadowedKeys, [key]);

  const basePublish = await service.publishBase({
    expectedRevision: store.snapshot().revision,
    pack: { values: { ...bundled.values, [key]: "base moved on" } },
    reason: "base update",
  });
  assert.equal(basePublish.ok, true);
  assert.equal(store.snapshot().values[key], "override text", "the override still shadows the new Base");

  const reset = await service.resetOverride({ expectedRevision: store.snapshot().revision, keys: [key], reason: "reset" });
  assert.equal(reset.ok, true);
  assert.deepEqual(store.snapshot().overrides, {}, "reset is an empty map, never a blank string");
  assert.equal(store.snapshot().values[key], "base moved on", "reset inherits the current Base");
  assert.equal(store.snapshot().sources[key], "base");
});

test("blank text, unknown keys and base-only keys are refused", async () => {
  const { service } = await fixture();
  for (const set of [{ "memory.firstRead": "" }, { "memory.firstRead": "   " }, { "unknown.key": "x" }, { "bootstrap.instructions": "x" }, { "bootstrap.boundary.1": "x" }]) {
    await assert.rejects(
      service.publishOverride({ expectedRevision: 0, set, reason: "unit" }),
      (error) => error.code === INVALID_OVERRIDE_KEY,
      JSON.stringify(set),
    );
  }
  assert.throws(
    () => validateOverridePatch({ patch: { set: { "tools.canonical.memory_capture.description": "no placeholder" } }, basePack: bundled }),
    (error) => error.code === INVALID_OVERRIDE_KEY,
  );
});

test("the reminder cadence is a bounded integer tuning", async () => {
  const { store, service } = await fixture();
  await assert.rejects(service.publishOverride({ expectedRevision: 0, set: {}, tuning: { repeatAfterReads: 0 }, reason: "x" }), /integer 1\.\.100/);
  await assert.rejects(service.publishOverride({ expectedRevision: 0, set: {}, tuning: { repeatAfterReads: 101 }, reason: "x" }), /integer 1\.\.100/);
  const ok = await service.publishOverride({ expectedRevision: 0, set: {}, tuning: { repeatAfterReads: 5 }, reason: "x" });
  assert.equal(ok.ok, true);
  assert.equal(store.snapshot().tuning.repeatAfterReads, 5);
  assert.equal(store.snapshot().runtimeRevision, 1);
});

test("two writers with one revision: one wins, the other is stale", async () => {
  const { store, service } = await fixture();
  const [a, b] = await Promise.all([
    service.publishOverride({ expectedRevision: 0, set: { "memory.firstRead": "A" }, reason: "A" }),
    service.publishOverride({ expectedRevision: 0, set: { "memory.firstRead": "B" }, reason: "B" }),
  ]);
  assert.equal([a, b].filter((result) => result.ok).length, 1);
  assert.equal([a, b].filter((result) => !result.ok)[0].code, "PROMPT_STALE_REVISION");
  assert.ok(["A", "B"].includes(store.snapshot().values["memory.firstRead"]));
});

test("preview says what would change and writes nothing", async () => {
  const { store, service } = await fixture();
  await service.publishOverride({ expectedRevision: 0, set: { "memory.firstRead": "current" }, reason: "seed" });
  const preview = await service.previewOverride({ set: { "memory.checkpoint": "next" }, removeKeys: ["memory.firstRead"] });
  assert.deepEqual(preview.changedKeys, ["memory.checkpoint", "memory.firstRead"]);
  assert.equal(preview.overrideCount, 1);
  assert.equal(store.snapshot().values["memory.firstRead"], "current", "preview never publishes");
});

test("rollback restores the sparse map that was active at that revision", async () => {
  const { store, service } = await fixture();
  await service.publishOverride({ expectedRevision: 0, set: { "memory.firstRead": "one" }, reason: "one" });
  await service.publishOverride({ expectedRevision: 1, set: { "memory.checkpoint": "two" }, reason: "two" });
  assert.deepEqual(Object.keys(store.snapshot().overrides).sort(), ["memory.checkpoint", "memory.firstRead"]);

  const rolled = await service.rollback({ expectedRevision: 2, targetRevision: 1, reason: "undo two" });
  assert.equal(rolled.ok, true);
  assert.deepEqual(Object.keys(store.snapshot().overrides), ["memory.firstRead"]);
  assert.equal(store.snapshot().values["memory.checkpoint"], bundled.values["memory.checkpoint"]);
});

test("the effective snapshot is deep-frozen and reports per-key sources", async () => {
  const snapshot = resolveEffective({ basePack: bundled, overrides: { "memory.firstRead": "x" }, revision: 3, status: "ready" });
  assert.equal(snapshot.sources["memory.firstRead"], "override");
  assert.equal(snapshot.sources["memory.checkpoint"], "base");
  assert.equal(Object.isFrozen(snapshot.sources), true);
  assert.equal(Object.isFrozen(snapshot.overrides), true);
  assert.equal(Object.isFrozen(snapshot.tuning), true);
  assert.throws(() => {
    snapshot.overrides["memory.checkpoint"] = "y";
  });
});
