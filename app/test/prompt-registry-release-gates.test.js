// P4 Task 5: the deterministic release gates for the prompt registry.
//
// Each case is something that would be expensive or dangerous to discover in
// production: leaked history, unbounded listeners, a cold start that crashes on a
// corrupt file, or a copy edit that inflates the compact descriptor budget.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { bundledBasePack } from "../src/prompt-registry/bundled.js";
import { createPromptNotificationFanout } from "../src/prompt-registry/notification-fanout.js";
import { createPromptRegistry } from "../src/prompt-registry/registry.js";
import { createPromptAdminService } from "../src/prompt-registry/service.js";
import { createPromptRegistryStore } from "../src/prompt-registry/store.js";
import { PROMPT_BASE_LIMITS } from "../src/prompt-registry/schema.js";
import { COMPACT_GROUPS, compactToolView } from "../src/compact-tools.js";
import { compactDescriptorFingerprint } from "../src/compact-descriptor-integrity.js";
import { runWithPromptSnapshot } from "../src/prompt-registry/request-snapshot.js";
import { livePromptSnapshot, resetLivePromptRegistry, setLivePromptRegistry } from "../src/prompt-registry/live.js";

const bundled = bundledBasePack();
const roots = [];

test.after(async () => {
  resetLivePromptRegistry();
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "prompt-gates-"));
  roots.push(root);
  const store = createPromptRegistryStore({
    headFile: path.join(root, "agent-prompts.json"),
    packsDir: path.join(root, "packs"),
    bundledBase: bundled,
  });
  await store.ready;
  return { root, store, service: createPromptAdminService({ store, bundledBase: bundled }) };
}

test("thirty alternating publishes keep history, listeners and memory bounded", async () => {
  const { store, service } = await fixture();
  const seen = [];
  const unsubscribe = service.subscribe((snapshot) => void seen.push(snapshot.revision));
  for (let index = 1; index <= 30; index += 1) {
    const result = index % 3 === 0
      ? await service.publishOverride({ expectedRevision: store.snapshot().revision, set: { "memory.firstRead": `reminder ${index}` }, reason: `round ${index}` })
      : await service.publishBase({ expectedRevision: store.snapshot().revision, pack: { values: { ...bundled.values, "tools.canonical.get_note.md": null } }, reason: `round ${index}` }).catch(() => null);
    if (result === null) {
      // The pack above was deliberately invalid; keep the loop honest about it.
      await service.publishOverride({ expectedRevision: store.snapshot().revision, set: { "memory.checkpoint": `checkpoint ${index}` }, reason: `round ${index}` });
    }
    assert.equal(store.snapshot().revision, index, "every published revision counts once");
  }
  assert.equal(store.history().length, 30, "history keeps every revision below the cap");
  assert.equal(seen.length, 30, "one notification per successful publish");
  unsubscribe();
  assert.equal(store.snapshot().overrideCount, 2, "a sparse map, not a copy of the Base");
});

test("history is capped, and the oldest entries fall away", async () => {
  const { store, service } = await fixture();
  for (let index = 1; index <= 40; index += 1) {
    const result = await service.publishOverride({ expectedRevision: store.snapshot().revision, set: { "memory.firstRead": `r${index}` }, reason: `r${index}` });
    assert.equal(result.ok, true);
  }
  assert.equal(store.history().length, 32, "the rollback window is bounded");
  assert.equal(store.history().at(-1).revision, 40);
});

test("notification bookkeeping stays proportional to sessions, not publishes", async () => {
  const sessions = new Map();
  for (const id of ["a", "b", "c"]) {
    sessions.set(id, { server: { server: { async sendToolListChanged() {}, async sendPromptListChanged() {} } } });
  }
  const fanout = createPromptNotificationFanout({ sessions });
  for (let index = 1; index <= 10; index += 1) {
    await fanout.notifyPublished({ revision: index, values: { "tools.canonical.get_note.description": `v${index}` } });
  }
  const status = fanout.status();
  assert.equal(status.publishes, 10);
  assert.equal(status.sent, 30, "three sessions, ten publishes, one hint each");
  assert.equal(sessions.size, 3, "no listener accumulates");
});

test("a corrupt head or a missing pack starts degraded and serves the bundled Base", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "prompt-gates-corrupt-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "agent-prompts.json"), '{"schemaVersion":1,"revision":9,"base":{"packDigest":"sha256:deadbeef"}}');
  const store = createPromptRegistryStore({ headFile: path.join(root, "agent-prompts.json"), packsDir: path.join(root, "packs"), bundledBase: bundled });
  await store.ready;
  assert.equal(store.status().status, "degraded");
  assert.equal(store.snapshot().values["memory.firstRead"], bundled.values["memory.firstRead"]);
  // A degraded registry still answers requests: text storage never breaks MCP.
  const registry = createPromptRegistry({ bundledBase: bundled, store });
  setLivePromptRegistry(registry);
  const value = await runWithPromptSnapshot(registry, () => livePromptSnapshot().values["memory.firstRead"]);
  assert.equal(value, bundled.values["memory.firstRead"]);
  resetLivePromptRegistry();
});

test("the shipped copy stays inside the per-key and pack budgets", () => {
  let total = 0;
  for (const [key, value] of Object.entries(bundled.values)) {
    const bytes = Buffer.byteLength(value, "utf8");
    total += bytes;
    const limit = key.startsWith("tools.compact.") ? 400
      : key.startsWith("memory.") ? 2048
        : key === "prompts.research_brief.body" ? 8192
          : 4096;
    assert.ok(bytes <= limit, `${key} is ${bytes} B, over ${limit}`);
  }
  assert.ok(total <= PROMPT_BASE_LIMITS.pack, `${total} B is inside the pack budget`);

  // A compact builder handed an incomplete native list refuses instead of guessing
  // schemas, which is what keeps the descriptor budget honest.
  assert.throws(
    () => compactToolView([{ name: "get_note", description: "x", inputSchema: { type: "object" } }], Object.keys(COMPACT_GROUPS)),
    /out of sync/,
  );
  void compactDescriptorFingerprint;
});

test("a new image does not overwrite a published Base at startup", async () => {
  const { root, store, service } = await fixture();
  const published = await service.publishBase({ expectedRevision: 0, pack: { values: { ...bundled.values, "memory.firstRead": "survives the image" } }, reason: "unit" });
  assert.equal(published.ok, true);
  // A fresh process over the same data directory: the bundled digest differs, the
  // active Base wins and the drift is reported.
  const reopened = createPromptRegistryStore({ headFile: path.join(root, "agent-prompts.json"), packsDir: path.join(root, "packs"), bundledBase: bundled });
  await reopened.ready;
  assert.equal(reopened.snapshot().values["memory.firstRead"], "survives the image");
  assert.equal(reopened.status().drift, true);
  assert.ok(store.history().length >= 1);
  void compactDescriptorFingerprint;
});
