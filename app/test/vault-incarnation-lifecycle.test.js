import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createAdmissionStore } from "../src/vault-runtime/admission-store.js";
import { createVaultRegistry } from "../src/vault-runtime/registry.js";
import { createVaultServingGate } from "../src/vault-runtime/serving-gate.js";
import { createVaultRuntimeMap } from "../src/vault-runtime/instances.js";
import { createReconciliationService } from "../src/vault-runtime/reconciliation.js";
import { computeIdentityDigest, resolveVaultIdentity } from "../src/vault-runtime/identity.js";
import { INCARNATION_FILE, initializeIncarnation } from "../src/vault-runtime/incarnation.js";

const quiet = { info() {}, warn() {}, log() {} };
const actor = "admin:test";
const exists = file => fs.access(file).then(() => true, () => false);
async function open(base, primaryId = "vault", fsApi) {
  const primaryRoot = path.join(base, "primary"); const root = path.join(base, "vaults", "alpha");
  const gate = createVaultServingGate(); gate.arm(); let service;
  const registry = createVaultRegistry({ primaryRoot, primaryId, vaultsRoot: path.dirname(root),
    gate: descriptor => service.gate(descriptor), servingGate: gate });
  const store = createAdmissionStore({ file: path.join(base, "data", "vault-admissions.json"), fsApi, logger: quiet });
  await store.load();
  const map = createVaultRuntimeMap({ registry, dataRoot: path.join(base, "data"),
    primaryRuntime: { id: primaryId, root: primaryRoot, primary: true, localFs: {} } });
  service = createReconciliationService({ registry, runtimeMap: map, admissions: store, logger: quiet });
  return { root, registry, store, map, service, async close() { service.stop(); map.dispose(); await map.settleRetirements(); } };
}
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "w2-incarnation-"));
  await fs.mkdir(path.join(base, "primary")); await fs.mkdir(path.join(base, "data"));
  await fs.mkdir(path.join(base, "vaults", "alpha"), { recursive: true });
  const worlds = [];
  t.after(async () => { for (const w of worlds) await w.close(); await fs.rm(base, { recursive: true, force: true }); });
  return { base, async open(primaryId, fsApi) { const w = await open(base, primaryId, fsApi); worlds.push(w); return w; } };
}

test("R-B: scans never initialize proof; explicit confirmed approval binds record and sentinel", async t => {
  const f = await fixture(t); const w = await f.open();
  await w.service.reconcile("startup");
  assert.equal(await exists(path.join(w.root, INCARNATION_FILE)), false);
  await assert.rejects(w.service.initializeVaults({ confirm: ["alpha"], source: "test" }));
  assert.equal(await exists(path.join(w.root, INCARNATION_FILE)), false, "no marker without trusted actor");
  await w.service.initializeVaults({ confirm: [], actor, source: "test" });
  await w.service.reconcile("manual");
  assert.equal(w.store.entryFor("alpha").identity, null);
  assert.equal(await exists(path.join(w.root, INCARNATION_FILE)), false, "unconfirmed secondary has no proof");
  await w.service.approve("alpha", { actor });
  const identity = w.store.entryFor("alpha").identity;
  assert.equal(identity.identityVersion, 2); assert.equal(w.map.has("alpha"), true);
  assert.equal(w.store.enrollment().bindings.alpha.identity.digest, identity.digest);
  const restarted = await f.open(); await restarted.service.reconcile("startup");
  assert.equal(restarted.map.has("alpha"), true); assert.equal(restarted.store.entryFor("alpha").identity.digest, identity.digest);
});

test("R-B: missing/changed proof keeps old binding; record-loss recovery cannot recreate proof", async t => {
  const f = await fixture(t); const w = await f.open();
  await w.service.initializeVaults({ confirm: ["alpha"], actor, source: "test" }); await w.service.reconcile("startup");
  const old = w.store.entryFor("alpha").identity;
  const proof = path.join(w.root, INCARNATION_FILE);
  await fs.rm(proof); await fs.rm(w.store.file);
  const restarted = await f.open();
  await assert.rejects(restarted.service.initializeVaults({ confirm: ["alpha"], actor, source: "recover" }), error => error.code === "VAULT_ADMISSION_IDENTITY_CONFLICT");
  assert.equal(await exists(proof), false); assert.equal(await exists(w.store.file), false);
  assert.equal(restarted.store.bindingFor("alpha").digest, old.digest);
  await initializeIncarnation(w.root); // new explicit proof is not the trusted old proof
  assert.notEqual((await resolveVaultIdentity({ root: w.root })).digest, old.digest);
  await assert.rejects(restarted.service.initializeVaults({ confirm: ["alpha"], actor, source: "recover" }), error => error.code === "VAULT_ADMISSION_IDENTITY_CONFLICT");
  assert.equal(await exists(w.store.file), false);
});

test("R-B: explicit v1 migration requires NEW IDs and never transfers old approval/data keys", async t => {
  const f = await fixture(t); const oldWorld = await f.open("legacy");
  const root = path.join(f.base, "primary"); const stat = await fs.stat(root, { bigint: true });
  const tuple = { identityVersion: 1, canonicalRoot: (await fs.realpath(root)).replaceAll("\\", "/").toLowerCase(), volumeId: String(stat.dev), fileId: String(stat.ino) };
  if (process.platform !== "win32") tuple.canonicalRoot = await fs.realpath(root);
  const v1 = { ...tuple, digest: computeIdentityDigest(tuple) };
  await oldWorld.store.initialize({ approved: [{ id: "legacy", root, identity: v1, primary: true }], actor, source: "v1-fixture", configDigest: "test" });
  await oldWorld.service.reconcile("startup");
  assert.equal(oldWorld.map.has("legacy"), false); assert.equal(await exists(path.join(root, INCARNATION_FILE)), false);
  await assert.rejects(oldWorld.service.approve("legacy", { actor }), error => error.code === "VAULT_ADMISSION_IDENTITY_CONFLICT");
  // Administrator explicitly changes the configured ID; scanning still cannot grant it.
  const migrated = await f.open("v2vault"); await migrated.service.reconcile("startup");
  assert.equal(migrated.map.has("v2vault"), false); assert.equal(await exists(path.join(root, INCARNATION_FILE)), false);
  await migrated.service.approve("v2vault", { actor });
  assert.equal(migrated.store.entryFor("legacy").identity.digest, v1.digest);
  assert.equal(migrated.store.entryFor("v2vault").identity.identityVersion, 2);
  assert.equal(migrated.store.enrollment().bindings.legacy.identity.digest, v1.digest);
  assert.equal(migrated.map.has("v2vault"), true); assert.equal(migrated.map.has("legacy"), false);
  const restarted = await f.open("v2vault"); await restarted.service.reconcile("startup");
  assert.equal(restarted.map.has("v2vault"), true); assert.equal(restarted.store.entryFor("legacy").identity.digest, v1.digest);
});

test("R-B: corrupt proof is bounded, refused and never overwritten by explicit approval", async t => {
  const f = await fixture(t); const w = await f.open();
  await w.service.initializeVaults({ confirm: ["alpha"], actor, source: "test" }); await w.service.reconcile("startup");
  const file = path.join(w.root, INCARNATION_FILE); const bytes = "x".repeat(300);
  await fs.writeFile(file, bytes); const round = await w.service.reconcile("manual");
  assert.equal(round.status, "committed"); assert.equal(w.map.has("alpha"), false);
  await assert.rejects(w.service.approve("alpha", { actor }), error => error.code === "VAULT_ADMISSION_IDENTITY_CONFLICT");
  assert.equal(await fs.readFile(file, "utf8"), bytes);
});

test("R-B: failed record write leaves proof without authority; explicit recovery respects sentinel floor", async t => {
  const f = await fixture(t); let failRecord = true;
  const w = await f.open(undefined, { ...fs, async rename(from, to) {
    if (failRecord && to.endsWith("vault-admissions.json")) throw Object.assign(new Error("record write fault"), { code: "EIO" });
    return fs.rename(from, to);
  } });
  await assert.rejects(w.service.initializeVaults({ confirm: ["alpha"], actor, source: "test" }), error => error.code === "VAULT_ADMISSIONS_WRITE_FAILED");
  const proof = await fs.readFile(path.join(w.root, INCARNATION_FILE), "utf8");
  const floor = w.store.enrollmentRevision();
  assert.equal(await exists(w.store.file), false); assert.equal(w.map.has("alpha"), false);
  failRecord = false;
  const recovered = await f.open(); await recovered.service.reconcile("startup");
  assert.equal(recovered.map.has("alpha"), false, "sentinel and marker never grant permission without record");
  await recovered.service.initializeVaults({ confirm: ["alpha"], actor, source: "explicit-recover" });
  assert.equal(recovered.store.revision(), floor + 1);
  await recovered.service.reconcile("manual"); assert.equal(recovered.map.has("alpha"), true);
  assert.equal(await fs.readFile(path.join(w.root, INCARNATION_FILE), "utf8"), proof);
  const restarted = await f.open(); await restarted.service.reconcile("startup"); assert.equal(restarted.map.has("alpha"), true);
});
