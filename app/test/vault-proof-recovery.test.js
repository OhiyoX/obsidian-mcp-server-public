import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { INCARNATION_FILE } from "../src/vault-runtime/incarnation.js";
import { openRecoveryWorld, restoreAndApprove, assertRecovery, actor } from "../scripts/verify-w2-proof-recovery.mjs";

for (const id of ["alpha", "vault"]) {
  test(`R-C: ${id} reapproval at the latched revocation generation returns a live new facade`, async () => {
    const bindings = [];
    const w = await openRecoveryWorld({ onPrimaryLease: (lease, check) => bindings.push({ lease, check }) });
    try {
      const result = await restoreAndApprove(w, id);
      assertRecovery(result);
      await assert.rejects(async () => result.old.localFs.readLimitedText(result.note), { code: "VAULT_RUNTIME_LEASE_REVOKED" });
      assert.equal(w.map.get(id), result.fresh);
      if (id === "vault") {
        const binding = bindings.at(-1);
        assert.equal(binding.lease, w.map.leaseOf(id), "publish binds the new primary lease without a resolver query");
        assert.notEqual(binding.lease, result.oldLease);
        assert.equal(binding.check(), true);
        assert.equal(bindings.find(entry => entry.lease === result.oldLease).check(), false);
      }
    } finally { await w.close(); }
  });
}

for (const state of ["missing", "changed", "restored-without-approval"]) {
  test(`R-C negative control: ${state} proof never renews a latched handle`, async () => {
    const w = await openRecoveryWorld();
    try {
      const old = w.map.get("alpha"); const lease = w.map.leaseOf("alpha");
      const file = path.join(w.root, INCARNATION_FILE); const proof = await fs.readFile(file);
      const note = path.join(w.root, "note.md"); const record = await fs.readFile(w.store.file);
      await fs.rm(file);
      await assert.rejects(async () => old.localFs.readLimitedText(note), { code: "VAULT_RUNTIME_LEASE_REVOKED" });
      if (state === "changed") {
        const value = JSON.parse(proof); value.incarnation = value.incarnation[0] === "0" ? "1".repeat(64) : "0".repeat(64);
        await fs.writeFile(file, JSON.stringify(value));
      } else if (state === "restored-without-approval") await fs.writeFile(file, proof);
      if (state !== "restored-without-approval") {
        await assert.rejects(w.service.approve("alpha", { actor }), { code: "VAULT_ADMISSION_IDENTITY_CONFLICT" });
        assert.ok(record.equals(await fs.readFile(w.store.file)), "failed approval never changes authority");
      }
      const resolved = w.map.get("alpha");
      assert.equal(w.map.leaseOf("alpha"), lease, "no new lease from old authority or invalid proof");
      assert.equal(lease.revoked, true);
      assert.equal(w.registry.admission("alpha").generation, 1);
      if (resolved) await assert.rejects(async () => resolved.localFs.readLimitedText(note), { code: "VAULT_RUNTIME_LEASE_REVOKED" });
      await assert.rejects(async () => old.localFs.readLimitedText(note), { code: "VAULT_RUNTIME_LEASE_REVOKED" });
    } finally { await w.close(); }
  });
}
