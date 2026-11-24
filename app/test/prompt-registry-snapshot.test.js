// P1 Task 1: the effective snapshot and its two layers.

import assert from "node:assert/strict";
import test from "node:test";

import { createPromptRegistry, resolveEffective } from "../src/prompt-registry/registry.js";
import { bundledBasePack } from "../src/prompt-registry/bundled.js";

const base = bundledBasePack();
const firstKey = Object.keys(base.values).sort()[0];

test("an empty override set reports base as the source of every key", () => {
  const snapshot = resolveEffective({ basePack: base, overrides: {}, revision: 0, status: "ready" });
  assert.equal(snapshot.sources[firstKey], "base");
  assert.equal(snapshot.overrideCount, 0);
  assert.deepEqual(snapshot.shadowedKeys, []);
  assert.equal(snapshot.baseDigest, base.digest);
  assert.equal(snapshot.effectiveDigest, base.digest);
});

test("the snapshot is frozen and cannot be edited by a caller", () => {
  const snapshot = resolveEffective({ basePack: base, overrides: {}, status: "ready" });
  assert.throws(() => {
    snapshot.values[firstKey] = "hijacked";
  });
  assert.throws(() => {
    snapshot.overrides[firstKey] = "hijacked";
  });
  assert.throws(() => {
    snapshot.sources[firstKey] = "override";
  });
  // A second snapshot is unaffected by the first.
  assert.notEqual(resolveEffective({ basePack: base, overrides: {}, status: "ready" }).values[firstKey], "hijacked");
});

test("an override wins for its key and is reported as shadowing the Base", () => {
  const overrides = { [firstKey]: "overridden text" };
  const snapshot = resolveEffective({ basePack: base, overrides, revision: 4, status: "ready" });
  assert.equal(snapshot.values[firstKey], "overridden text");
  assert.equal(snapshot.sources[firstKey], "override");
  assert.deepEqual(snapshot.shadowedKeys, [firstKey]);
  assert.equal(snapshot.overrideCount, 1);
  assert.notEqual(snapshot.effectiveDigest, base.digest);
  assert.equal(snapshot.revision, 4);
});

test("an override must carry text, and one that names no real key is reported, not thrown", () => {
  // #827 F-4: a stale override on a key this Base does not have must not turn every
  // request into a 5xx; it is dropped, listed, and the Base copy serves.
  const dropped = resolveEffective({ basePack: base, overrides: { "not.a.key": "x" } });
  assert.deepEqual(dropped.ignoredOverrideKeys, ["not.a.key"]);
  assert.equal(dropped.overrideCount, 0);
  assert.equal(dropped.values[firstKey], base.values[firstKey]);
  assert.throws(() => resolveEffective({ basePack: base, overrides: { [firstKey]: "   " } }), /must be text/);
  assert.throws(() => resolveEffective({ basePack: base, overrides: { [firstKey]: 7 } }), /must be text/);
  assert.throws(() => resolveEffective({ basePack: null }), /needs a base pack/);
});

test("the effective digest is stable for equal content and changes with text", () => {
  const a = resolveEffective({ basePack: base, status: "ready" });
  const b = resolveEffective({ basePack: base, status: "ready" });
  assert.equal(a.effectiveDigest, b.effectiveDigest);
  const c = resolveEffective({ basePack: base, overrides: { [firstKey]: "different" }, status: "ready" });
  assert.notEqual(c.effectiveDigest, a.effectiveDigest);
});

test("the registry facade reads synchronously from the store", async () => {
  let snapshot = resolveEffective({ basePack: base, status: "ready" });
  const store = {
    ready: Promise.resolve(),
    snapshot: () => snapshot,
    status: () => ({ status: "ready", revision: snapshot.revision }),
  };
  const registry = createPromptRegistry({ bundledBase: base, store });
  assert.equal(registry.snapshot(), snapshot);
  snapshot = resolveEffective({ basePack: base, revision: 9, status: "ready" });
  assert.equal(registry.snapshot().revision, 9);
  await registry.ready;
});
