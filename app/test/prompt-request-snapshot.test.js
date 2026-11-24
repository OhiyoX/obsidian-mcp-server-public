// P2 Task 1: one snapshot per request, even when a publish lands mid-call.

import assert from "node:assert/strict";
import test from "node:test";

import { bundledBasePack } from "../src/prompt-registry/bundled.js";
import { livePromptSnapshot, resetLivePromptRegistry, setLivePromptRegistry } from "../src/prompt-registry/live.js";
import { currentPromptSnapshot, runWithPromptSnapshot } from "../src/prompt-registry/request-snapshot.js";
import { resolveEffective } from "../src/prompt-registry/registry.js";

const bundled = bundledBasePack();
const KEY = "memory.firstRead";

function registryOf(revision, text) {
  const snapshot = resolveEffective({
    basePack: { digest: bundled.digest, values: { ...bundled.values, [KEY]: text } },
    revision,
    status: "ready",
  });
  return { snapshot: () => snapshot, status: () => ({ status: "ready", revision }) };
}

test("a request keeps its revision across an await, even after a publish", async () => {
  const rev1 = registryOf(1, "revision one");
  const rev2 = registryOf(2, "revision two");
  setLivePromptRegistry(rev1);
  let seen;
  await runWithPromptSnapshot(rev1, async () => {
    const first = livePromptSnapshot();
    setLivePromptRegistry(rev2); // a publish lands while the handler is suspended
    await Promise.resolve();
    const second = livePromptSnapshot();
    seen = { first: first.values[KEY], second: second.values[KEY], firstRev: first.revision, secondRev: second.revision };
  });
  resetLivePromptRegistry();
  assert.deepEqual(seen, { first: "revision one", second: "revision one", firstRev: 1, secondRev: 1 });
  assert.equal(livePromptSnapshot().values[KEY], bundled.values[KEY], "no live registry: bundled again");
});

test("a new request sees the new revision", async () => {
  const rev1 = registryOf(1, "old");
  const rev2 = registryOf(2, "new");
  const inside = await runWithPromptSnapshot(rev1, () => livePromptSnapshot().values[KEY]);
  const next = await runWithPromptSnapshot(rev2, () => livePromptSnapshot().values[KEY]);
  assert.equal(inside, "old");
  assert.equal(next, "new");
});

test("concurrent requests do not share a snapshot", async () => {
  const rev1 = registryOf(1, "one");
  const rev2 = registryOf(2, "two");
  const [a, b] = await Promise.all([
    runWithPromptSnapshot(rev1, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return livePromptSnapshot().values[KEY];
    }),
    runWithPromptSnapshot(rev2, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return livePromptSnapshot().values[KEY];
    }),
  ]);
  assert.equal(a, "one");
  assert.equal(b, "two");
});

test("outside a request there is no pinned snapshot to leak", () => {
  assert.equal(currentPromptSnapshot(), undefined);
  const value = runWithPromptSnapshot(registryOf(3, "scoped"), () => currentPromptSnapshot()?.revision);
  assert.equal(value, 3);
  assert.equal(currentPromptSnapshot(), undefined, "the context is gone after the call");
});

test("a throwing handler leaves no pinned snapshot behind", () => {
  const registry = registryOf(4, "boom");
  assert.throws(() => runWithPromptSnapshot(registry, () => {
    throw new Error("handler failed");
  }), /handler failed/);
  assert.equal(currentPromptSnapshot(), undefined);
});

test("a missing registry is tolerated: the callback still runs", () => {
  assert.equal(runWithPromptSnapshot(null, () => 7), 7);
  assert.equal(runWithPromptSnapshot(undefined, () => currentPromptSnapshot()), undefined);
});

test("discovery pins the snapshot at both protocol entries", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/discovery-runtime.js", import.meta.url), "utf8");
  assert.match(source, /ListToolsRequestSchema, async \(request, extra\) => runWithPromptSnapshot\(/);
  assert.match(source, /CallToolRequestSchema, async \(request, extra\) => runWithPromptSnapshot\(/);
  assert.match(source, /ListPromptsRequestSchema, async \(request, extra\) => runWithPromptSnapshot\(/);
  assert.match(source, /GetPromptRequestSchema, \(request, extra\) => runWithPromptSnapshot\(/);
});
