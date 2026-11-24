// P1 Task 3: the admin service — CAS, preview, rollback, audit and notifications.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPromptAdminService } from "../src/prompt-registry/service.js";
import { createPromptRegistryStore } from "../src/prompt-registry/store.js";
import { bundledBasePack } from "../src/prompt-registry/bundled.js";

const bundled = bundledBasePack();
const firstKey = Object.keys(bundled.values).sort()[0];
const roots = [];

test.after(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-service-"));
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

const packWith = (text) => ({ values: { ...bundled.values, [firstKey]: text } });

test("preview reports the diff and writes nothing", async () => {
  const { store, service } = await fixture();
  const preview = await service.previewBase({ pack: packWith("preview text") });
  assert.equal(preview.valid, true);
  assert.deepEqual(preview.diff.changed, [firstKey]);
  assert.deepEqual(preview.diff.added, []);
  assert.equal(preview.currentRevision, 0);
  assert.ok(preview.bytes > 0);
  assert.equal(store.snapshot().revision, 0, "preview never publishes");
  assert.equal(store.snapshot().values[firstKey], bundled.values[firstKey]);
});

test("two writers with one revision: one wins, the other is stale", async () => {
  const { store, service } = await fixture();
  const [a, b] = await Promise.all([
    service.publishBase({ expectedRevision: 0, pack: packWith("writer A"), reason: "A" }),
    service.publishBase({ expectedRevision: 0, pack: packWith("writer B"), reason: "B" }),
  ]);
  const winners = [a, b].filter((result) => result.ok);
  const losers = [a, b].filter((result) => !result.ok);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].code, "PROMPT_STALE_REVISION");
  assert.equal(store.snapshot().revision, 1);
});

test("a published revision notifies subscribers and is audited once", async () => {
  const { service, audit } = await fixture();
  const seen = [];
  const unsubscribe = service.subscribe((snapshot) => void seen.push(snapshot.revision));
  const result = await service.publishBase({ expectedRevision: 0, pack: packWith("notified"), reason: "unit" });
  assert.equal(result.ok, true);
  assert.equal(result.notified, 1);
  assert.deepEqual(seen, [1]);
  unsubscribe();
  await service.publishBase({ expectedRevision: 1, pack: packWith("silent"), reason: "unit" });
  assert.deepEqual(seen, [1], "an unsubscribed listener hears nothing");
  const successes = audit.filter((entry) => entry.outcome === "success");
  assert.equal(successes.length, 2);
  assert.equal(successes[0].action, "base.publish");
  assert.equal(successes[0].revision, 1);
});

test("a failed publish never records success", async () => {
  const { service, audit } = await fixture();
  const stale = await service.publishBase({ expectedRevision: 5, pack: packWith("stale"), reason: "unit" });
  assert.equal(stale.ok, false);
  assert.equal(audit.filter((entry) => entry.outcome === "success").length, 0);

  // An unusable pack is a client error, so it throws; nothing durable and no success audit.
  await assert.rejects(
    service.publishBase({ expectedRevision: 0, pack: { values: {} }, reason: "unit" }),
    (error) => error.code === "PROMPT_INVALID_PACK",
  );
  assert.equal(audit.filter((entry) => entry.outcome === "success").length, 0);

  await assert.rejects(service.publishBase({ expectedRevision: 0, pack: packWith("x"), reason: "  " }), /a reason is required/);
});

test("a notification failure does not undo a durable revision", async () => {
  const { store, service } = await fixture();
  service.subscribe(() => {
    throw new Error("SSE closed");
  });
  const result = await service.publishBase({ expectedRevision: 0, pack: packWith("durable"), reason: "unit" });
  assert.equal(result.ok, true);
  assert.equal(result.notificationFailures.length, 1);
  assert.equal(store.snapshot().revision, 1);
  assert.equal(store.snapshot().values[firstKey], "durable");
});

test("rollback publishes the older pack as a new revision and is audited", async () => {
  const { store, service, audit } = await fixture();
  const first = await service.publishBase({ expectedRevision: 0, pack: packWith("one"), reason: "first" });
  await service.publishBase({ expectedRevision: first.revision, pack: packWith("two"), reason: "second" });
  const rolled = await service.rollback({ expectedRevision: 2, targetRevision: 1, reason: "undo two" });
  assert.equal(rolled.ok, true);
  assert.equal(rolled.revision, 3);
  assert.equal(store.snapshot().values[firstKey], "one");
  assert.equal(audit.at(-1).action, "base.rollback");
  assert.equal(audit.at(-1).outcome, "success");
  assert.equal((await service.rollback({ expectedRevision: 3, targetRevision: 77, reason: "nope" })).ok, false);
});

test("adopt-bundled republishes the shipped copy after drift", async () => {
  const { store, service } = await fixture();
  await service.publishBase({ expectedRevision: 0, pack: packWith("drifted"), reason: "unit" });
  const adopted = await service.adoptBundled({ expectedRevision: 1, reason: "back to shipped" });
  assert.equal(adopted.ok, true);
  assert.equal(store.snapshot().values[firstKey], bundled.values[firstKey]);
  assert.equal(store.status().drift, false);
});

test("resetOverriddenKeys is accepted now and clears only keys that exist", async () => {
  const { service } = await fixture();
  // P3 adds the override write path; this commit path must already tolerate the
  // argument and must not invent an override just to delete it.
  const result = await service.publishBase({
    expectedRevision: 0,
    pack: packWith("x"),
    reason: "unit",
    resetOverriddenKeys: [firstKey, "memory.firstRead"],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.overriddenKeys, []);
});
