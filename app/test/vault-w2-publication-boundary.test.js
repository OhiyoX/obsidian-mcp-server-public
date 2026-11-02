import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAdmissionStore } from "../src/vault-runtime/admission-store.js";
import { CAPABILITY_KEYS, unavailable } from "../src/vault-runtime/descriptor.js";
import { createVaultRuntimeMap } from "../src/vault-runtime/instances.js";
import { createReconciliationService } from "../src/vault-runtime/reconciliation.js";
import { createVaultRegistry } from "../src/vault-runtime/registry.js";
import { createVaultServingGate } from "../src/vault-runtime/serving-gate.js";
import { composedRecord, createComposedCommit, publishComposedRecord, instancesOf } from "../src/vault-runtime/composed-commit.js";

const quiet = { warn() {}, log() {} };
const planForOld = w => w.map.prepare(w.registry.snapshot().vaults).next;
async function world(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "w2-publication-"));
  const primaryRoot = path.join(base, "primary");
  const vaultsRoot = path.join(base, "vaults");
  await fs.mkdir(primaryRoot); await fs.mkdir(path.join(vaultsRoot, "alpha"), { recursive: true });
  await fs.writeFile(path.join(vaultsRoot, "alpha", "proof.md"), "alpha-body");
  let fact = "old";
  const capabilitiesFor = () => Object.fromEntries(CAPABILITY_KEYS.map(key => [key, unavailable(fact)]));
  const gate = createVaultServingGate(); gate.arm();
  let service;
  const registry = createVaultRegistry({ primaryRoot, primaryId: "vault", vaultsRoot,
    capabilitiesFor, gate: descriptor => service.gate(descriptor), servingGate: gate });
  const store = createAdmissionStore({ file: path.join(base, "data", "vault-admissions.json"), logger: quiet });
  await fs.mkdir(path.join(base, "data"));
  await store.load();
  const map = createVaultRuntimeMap({ registry, dataRoot: path.join(base, "data"), capabilitiesFor,
    primaryRuntime: { id: "vault", root: primaryRoot, primary: true, localFs: {} } });
  service = createReconciliationService({ registry, runtimeMap: map, admissions: store, logger: quiet });
  t.after(async () => { service.stop(); map.dispose(); await map.settleRetirements(); await fs.rm(base, { recursive: true, force: true }); });
  await service.initializeVaults({ confirm: ["alpha"], actor: "admin:test", source: "test" });
  await service.reconcile("startup");
  return { registry, store, map, gate, service, change() { fact = "new"; } };
}

test("F1: attached registry refresh/commit/applyStaged refuse without any half publication", async t => {
  const w = await world(t); const prior = w.registry.composedCommit.current();
  w.change();
  const candidate = await w.registry.prepare(); const staged = w.registry.stageCommit(candidate);
  for (const publish of [() => w.registry.refresh(), () => w.registry.commit(candidate), () => w.registry.applyStaged(staged),
    () => publishComposedRecord(w.registry.composedCommit, { snapshot: staged.snapshot }),
    () => w.registry.composedCommit.publish({ snapshot: staged.snapshot }),
    () => w.registry.composedCommit.clear(),
    () => composedRecord({ snapshot: staged.snapshot, instances: planForOld(w), serving: { allowed: ["vault", "alpha"] } }),
    () => w.gate.publish(["vault", "alpha", "unknown"]), () => w.map.refresh()]) {
    await assert.rejects(async () => publish(), error => error.code === "VAULT_COMPOSED_COMMIT_INVALID");
    assert.equal(w.registry.composedCommit.current(), prior);
    assert.equal(w.registry.get("alpha").capabilities.notes.reason, "old");
    assert.equal(w.map.get("alpha").capabilities.notes.reason, "old");
    assert.equal(await w.map.get("alpha").localFs.readLimitedText(path.join(w.map.get("alpha").root, "proof.md")), "alpha-body");
  }
  assert.equal((await w.service.reconcile("manual")).status, "committed");
  assert.equal(w.registry.snapshot().revision, w.store.revision());
  assert.equal(w.registry.get("alpha").capabilities.notes.reason, "new");
  assert.equal(w.map.get("alpha").capabilities.notes.reason, "new");
});

test("F2: callbacks, iterators, symbols and retained plan aliases cannot mutate committed membership", async t => {
  const w = await world(t);
  const plan = w.map.prepare(w.registry.snapshot().vaults);
  w.map.commit(plan);
  const record = w.registry.composedCommit.current();
  record.instances.forEach((value, key, view) => {
    assert.equal(view, record.instances); assert.equal(view.delete, undefined);
    assert.equal(Object.isFrozen(value), true);
  });
  record.serving.allowedSet.forEach((value, key, view) => {
    assert.equal(view, record.serving.allowedSet); assert.equal(view.add, undefined); assert.equal(key, value);
  });
  assert.equal(Object.getOwnPropertySymbols(record).length, 0);
  const retainedEntry = plan.next.get("alpha");
  plan.next.clear(); retainedEntry.descriptor = null;
  const pair = record.instances.entries().next().value; pair[0] = "unknown";
  assert.equal(w.registry.composedCommit.current(), record);
  assert.equal(w.map.has("alpha"), true);
  assert.equal(w.map.descriptorOf("alpha").id, "alpha");
  assert.notEqual(w.gate.refusalFor("unknown"), null);
  w.registry.refuse("alpha", { admitted: false, reason: "awaiting-approval" });
  w.gate.publish(record.serving.allowed, record.serving.refusals);
  assert.notEqual(w.registry.refusal("alpha"), null, "owner-only rebaseline cannot clear a later refusal");
  await w.service.revoke("alpha", { actor: "admin:test" });
  assert.equal(w.map.get("alpha"), undefined, "lease revocation still works despite immutable membership");
});

test("F1/F2: standalone registry remains usable; retained serving aliases are copied", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "w2-standalone-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const registry = createVaultRegistry({ primaryRoot: base, primaryId: "vault" });
  assert.equal((await registry.refresh()).ready, true);
  const allowed = ["vault"]; const refusals = new Map([["missing", { reason: "refused" }]]);
  const instances = new Map([["vault", { descriptor: registry.get("vault"), runtime: { id: "vault", root: base } }]]);
  const record = composedRecord({ snapshot: registry.snapshot(), instances, serving: { allowed, refusals } });
  const holder = createComposedCommit(); holder.publish(record);
  allowed.push("unknown"); instances.clear(); refusals.clear();
  assert.equal(record.instances.has("vault"), true);
  assert.equal(record.serving.allowedSet.has("unknown"), false);
  assert.equal(record.serving.refusals.has("missing"), true);
});

test("R-A: public previous, entries, released and accessor cannot alter the committed three faces", async t => {
  const w = await world(t);
  const record = w.registry.composedCommit.current();
  const consistent = () => {
    assert.equal(w.registry.composedCommit.current(), record);
    assert.equal(record.instances.has("alpha"), true);
    assert.equal(w.registry.snapshot().vaults.some(v => v.id === "alpha"), true);
    assert.equal(w.map.has("alpha"), true);
    assert.equal(w.registry.refusal("alpha"), null);
  };
  const plan = w.map.prepare(w.registry.snapshot().vaults);
  for (const mutate of [
    () => plan.previous.delete("alpha"), () => plan.previous.clear(),
    () => plan.previous.set("alpha", {}),
    () => { plan.previous.alpha = {}; },
    () => { plan.previous.get("alpha").descriptor = null; },
    () => { plan.next.get("alpha").descriptor = null; },
    () => plan.next.clear(),
    () => instancesOf(record).delete("alpha"), () => instancesOf(record).clear(),
    () => { instancesOf(record).get("alpha").descriptor = null; },
  ]) {
    try { mutate(); } catch (error) { assert.equal(error instanceof TypeError, true); }
    consistent();
  }
  const removal = w.map.prepare(w.registry.snapshot().vaults.filter(v => v.id !== "alpha"));
  try { removal.released[0].descriptor = null; } catch (error) { assert.equal(error instanceof TypeError, true); }
  consistent();
  assert.equal(w.map.descriptorOf("alpha").id, "alpha");
  assert.equal(w.map.get("alpha"), w.map.get("alpha"), "current handle stays idempotent");
  await w.service.revoke("alpha", { actor: "admin:test" });
  assert.equal(w.map.get("alpha"), undefined);
});

for (const [label, mutate] of [
  ["previous.delete", (w, record) => w.map.prepare(w.registry.snapshot().vaults).previous.delete("alpha")],
  ["previous.clear", (w, record) => w.map.prepare(w.registry.snapshot().vaults).previous.clear()],
  ["instancesOf.delete", (w, record) => instancesOf(record).delete("alpha")],
]) test(`R-A paired counterexample: ${label}`, async t => {
  const w = await world(t); const record = w.registry.composedCommit.current();
  try { mutate(w, record); } catch (error) { assert.equal(error instanceof TypeError, true); }
  const evidence = { attack: label, recordSame: w.registry.composedCommit.current() === record,
    publicRecordHasAlpha: record.instances.has("alpha"), registryHasAlpha: Boolean(w.registry.get("alpha")),
    mapHasAlpha: w.map.has("alpha"), refusal: w.registry.refusal("alpha") };
  t.diagnostic(JSON.stringify(evidence));
  assert.equal(evidence.mapHasAlpha, true); assert.equal(evidence.registryHasAlpha, true);
  assert.equal(evidence.publicRecordHasAlpha, true); assert.equal(evidence.recordSame, true); assert.equal(evidence.refusal, null);
});
