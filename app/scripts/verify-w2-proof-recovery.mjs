// R-C: real proof loss/restoration, without identity/fs injection or raw Map commits.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdmissionStore } from "../src/vault-runtime/admission-store.js";
import { createVaultRegistry } from "../src/vault-runtime/registry.js";
import { createVaultServingGate } from "../src/vault-runtime/serving-gate.js";
import { createVaultRuntimeMap } from "../src/vault-runtime/instances.js";
import { createVaultRuntime } from "../src/vault-runtime/runtime.js";
import { PRIMARY_PATH_KEYS } from "../src/vault-runtime/paths.js";
import { createReconciliationService } from "../src/vault-runtime/reconciliation.js";
import { INCARNATION_FILE } from "../src/vault-runtime/incarnation.js";
import { leaseOfHandle } from "../src/vault-runtime/runtime-lease.js";

const quiet = { info() {}, warn() {}, log() {} };
export const actor = "admin:proof-recovery-test";

export async function openRecoveryWorld({ onPrimaryLease, primaryRuntime, base } = {}) {
  base ??= await fs.mkdtemp(path.join(process.platform === "linux" ? "/var/tmp" : os.tmpdir(), "i437-rc-"));
  const primaryRoot = path.join(base, "primary");
  const root = path.join(base, "vaults", "alpha");
  const dataRoot = path.join(base, "data");
  await fs.mkdir(primaryRoot, { recursive: true });
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(dataRoot, { recursive: true });
  const servingGate = createVaultServingGate(); servingGate.arm();
  let service;
  const registry = createVaultRegistry({ primaryRoot, primaryId: "vault", vaultsRoot: path.dirname(root),
    servingGate, gate: descriptor => service.gate(descriptor) });
  const store = createAdmissionStore({ file: path.join(dataRoot, "vault-admissions.json"), logger: quiet });
  await store.load();
  const paths = Object.fromEntries(PRIMARY_PATH_KEYS.map(key => [key, path.join(dataRoot, key)]));
  primaryRuntime ??= createVaultRuntime({ descriptor: { id: "vault", root: primaryRoot, primary: true }, paths, dataRoot });
  const map = createVaultRuntimeMap({ registry, dataRoot, primaryRuntime, onPrimaryLease, logger: quiet });
  service = createReconciliationService({ registry, runtimeMap: map, admissions: store, logger: quiet });
  await fs.writeFile(path.join(root, "note.md"), "same-original-vault");
  await fs.writeFile(path.join(primaryRoot, "note.md"), "same-original-vault");
  await service.initializeVaults({ confirm: ["alpha"], actor, source: "explicit-test" });
  await service.reconcile("startup");
  return { base, root, primaryRoot, store, registry, map, service,
    async close() { service.stop(); map.dispose(); await map.settleRetirements(); await fs.rm(base, { recursive: true, force: true }); } };
}

export async function restoreAndApprove(w, id = "alpha", beforeLoss = async () => {}) {
  const root = id === "vault" ? w.primaryRoot : w.root;
  const note = path.join(root, "note.md");
  const proofFile = path.join(root, INCARNATION_FILE);
  const old = w.map.get(id);
  const oldLease = leaseOfHandle(old);
  const oldGeneration = oldLease.generation;
  const originalIdentity = w.store.entryFor(id).identity.digest;
  assert.equal(await old.localFs.readLimitedText(note), "same-original-vault");
  assert.equal(w.map.get(id), old, "healthy repeated resolution is idempotent");
  await beforeLoss(old);
  const proof = await fs.readFile(proofFile);
  await fs.rm(proofFile);
  await assert.rejects(async () => old.localFs.readLimitedText(note), { code: "VAULT_RUNTIME_LEASE_REVOKED" });
  assert.equal(oldLease.revoked, true);
  const revokedGeneration = oldLease.generation;
  // No scan, revoke, replacement or fresh proof: restore the EXACT original bytes.
  await fs.writeFile(proofFile, proof);
  const round = await w.service.approve(id, { actor });
  const fresh = w.map.get(id);
  let read = null; let readCode = null;
  try { read = await fresh.localFs.readLimitedText(note); } catch (error) { readCode = error.code; }
  const evidence = { platform: process.platform, filesystemType: (await fs.statfs(w.base)).type, id,
    oldGeneration, revokedGeneration, committedGeneration: w.registry.admission(id).generation,
    admission: w.store.entryFor(id).admission, proofExactlyRestored: proof.equals(await fs.readFile(proofFile)),
    bindingSame: w.store.entryFor(id).identity.digest === originalIdentity, outcome: round.status,
    refusal: w.registry.refusal(id), mapHas: w.map.has(id), returnedOldHandle: fresh === old,
    freshGeneration: leaseOfHandle(fresh).generation, freshRevoked: leaseOfHandle(fresh).revoked,
    read, readCode, oldStillRevoked: oldLease.revoked };
  return { evidence, old, fresh, oldLease, note };
}

export function assertRecovery({ evidence, old, fresh, oldLease }) {
  assert.equal(evidence.oldGeneration, 1);
  assert.equal(evidence.revokedGeneration, 2);
  assert.equal(evidence.committedGeneration, 2);
  assert.equal(evidence.admission, "approved");
  assert.equal(evidence.proofExactlyRestored, true);
  assert.equal(evidence.bindingSame, true);
  assert.equal(evidence.outcome, "committed");
  assert.equal(evidence.refusal, null);
  assert.equal(evidence.mapHas, true);
  assert.equal(evidence.read, "same-original-vault", "restored same identity, explicitly approved: newly resolved handle must be usable");
  assert.notEqual(fresh, old);
  assert.notEqual(leaseOfHandle(fresh), oldLease);
  assert.equal(evidence.freshRevoked, false);
  assert.equal(evidence.oldStillRevoked, true);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const w = await openRecoveryWorld();
  try {
    const result = await restoreAndApprove(w, process.argv[2] ?? "alpha");
    console.log(JSON.stringify(result.evidence));
    assertRecovery(result);
    await assert.rejects(async () => result.old.localFs.readLimitedText(result.note), { code: "VAULT_RUNTIME_LEASE_REVOKED" });
    assert.equal(w.map.get(result.evidence.id), result.fresh, "fresh healthy facade remains memoized");
  } finally { await w.close(); }
}
