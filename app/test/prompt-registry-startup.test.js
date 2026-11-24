// P1 Task 4: startup wiring, drift and the health view.
//
// These assertions cover the pieces `server.js` composes: a durable head that wins
// over the bundled pack across a restart, a broken head that degrades instead of
// blocking startup, and a health view that reports digests without leaking text.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bundledBasePack } from "../src/prompt-registry/bundled.js";
import {
  livePromptSnapshot,
  livePromptStatus,
  resetLivePromptRegistry,
  setLivePromptRegistry,
} from "../src/prompt-registry/live.js";
import { createPromptRegistry } from "../src/prompt-registry/registry.js";
import { createPromptRegistryStore } from "../src/prompt-registry/store.js";

const bundled = bundledBasePack();
const firstKey = Object.keys(bundled.values).sort()[0];
const roots = [];

test.after(async () => {
  resetLivePromptRegistry();
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function dataDir() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-startup-"));
  roots.push(root);
  return root;
}

async function boot(root) {
  const store = createPromptRegistryStore({
    headFile: path.join(root, "agent-prompts.json"),
    packsDir: path.join(root, "prompt-registry", "packs"),
    bundledBase: bundled,
  });
  await store.ready;
  const registry = createPromptRegistry({ bundledBase: bundled, store });
  setLivePromptRegistry(registry);
  return { store, registry };
}

test("with no head, the live snapshot is the bundled pack", async () => {
  await boot(await dataDir());
  const status = livePromptStatus();
  assert.equal(status.status, "bootstrap");
  assert.equal(status.revision, 0);
  assert.equal(status.baseDigest, bundled.digest);
  assert.equal(status.bundledBaseDigest, bundled.digest);
  assert.equal(status.overrideCount, 0);
  assert.equal(livePromptSnapshot().values[firstKey], bundled.values[firstKey]);
});

test("a published head survives a restart and is reported as drift", async () => {
  const root = await dataDir();
  const first = await boot(root);
  const result = await first.store.commitBase({
    expectedRevision: 0,
    pack: { values: { ...bundled.values, [firstKey]: "published for real" } },
    reason: "unit",
    sourceCommit: "749011a5",
  });
  assert.equal(result.ok, true);

  resetLivePromptRegistry();
  await boot(root);
  const status = livePromptStatus();
  assert.equal(status.status, "ready");
  assert.equal(status.revision, 1);
  assert.equal(status.drift, true);
  assert.equal(livePromptSnapshot().values[firstKey], "published for real");
});

test("a corrupt head degrades, keeps the revision visible and serves bundled text", async () => {
  const root = await dataDir();
  await fs.writeFile(path.join(root, "agent-prompts.json"), "not json at all");
  await boot(root);
  const status = livePromptStatus();
  assert.equal(status.status, "degraded");
  assert.equal(status.reasonCode ?? "head-invalid-json", "head-invalid-json");
  assert.equal(livePromptSnapshot().values[firstKey], bundled.values[firstKey]);
});

test("the health view carries digests and counts, never prompt text", async () => {
  await boot(await dataDir());
  const status = livePromptStatus();
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes(bundled.values[firstKey]), false);
  assert.match(status.effectiveDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(status.baseDigest, /^sha256:/);
  for (const field of ["status", "revision", "baseDigest", "bundledBaseDigest", "effectiveDigest", "overrideCount", "drift"]) {
    assert.ok(Object.hasOwn(status, field), field);
  }
  for (const value of Object.values(status)) assert.notEqual(typeof value, "object", "no nested payloads");
});

test("a publish reaches the live snapshot of an already built registrar", async () => {
  const root = await dataDir();
  const { store } = await boot(root);
  const snapshotBefore = livePromptSnapshot();
  assert.equal(snapshotBefore.values["memory.firstRead"], bundled.values["memory.firstRead"]);

  await store.commitBase({
    expectedRevision: 0,
    pack: { values: { ...bundled.values, "memory.firstRead": "read this instead" } },
    reason: "unit",
  });

  const snapshotAfter = livePromptSnapshot();
  assert.equal(snapshotAfter.values["memory.firstRead"], "read this instead");
  assert.equal(snapshotAfter.revision, 1);
  assert.notEqual(snapshotAfter.effectiveDigest, snapshotBefore.effectiveDigest);
});

test("server.js wires the registry before it listens and reports it", async () => {
  const source = await fs.readFile(new URL("../server.js", import.meta.url), "utf8");
  const bootIndex = source.indexOf("setLivePromptRegistry(promptRegistry)");
  const listenIndex = source.indexOf("app.listen(PORT, HOST");
  assert.ok(bootIndex > 0, "server.js installs the live registry");
  assert.ok(listenIndex > bootIndex, "the registry is ready before the socket opens");
  assert.match(source, /await promptStore\.ready/);
  assert.match(source, /promptRegistry: livePromptStatus\(\)/);
  const info = await fs.readFile(new URL("../src/tools/info.js", import.meta.url), "utf8");
  assert.match(info, /promptRegistry: livePromptStatus\(\)/);
});

// #827 F-3: the registry existed but production never injected it, so "one snapshot
// per request" held only in tests. Both entry points must carry it.
test("server.js injects the registry into the request entry points", async () => {
  const source = await fs.readFile(new URL("../server.js", import.meta.url), "utf8");
  const discovery = source.slice(source.indexOf("createDiscoveryRuntimePolicy(server, discoveryOperatorConfig"));
  assert.match(discovery.slice(0, 200), /promptRegistry/, "tools/list, tools/call and prompts/* pin through the registry");
  const capabilities = source.slice(source.indexOf("registerObsidianCapabilities(discovery"));
  assert.match(capabilities.slice(0, 260), /promptRegistry/, "memory guidance reads the pinned snapshot");
  const caps = await fs.readFile(new URL("../src/capabilities.js", import.meta.url), "utf8");
  assert.match(caps, /createMemoryGuidanceRegistrar\(server, \{ registry: promptRegistry \}\)/);
  const helper = await fs.readFile(new URL("./helpers/prompt-live.mjs", import.meta.url), "utf8");
  assert.match(helper, /promptRegistry: registry/, "the test stack mirrors production");
});
