import { initializeIncarnation } from "../src/vault-runtime/incarnation.js";
// W2FIX4 (#437 W2FIX4 item C) — explicit recovery must preserve the DURABLE revision floor.
//
// The seat's extended check (`seat-w2fix3-recovery-floor-probe.log`) showed the store writing
// revision 1 after a record loss while the managed-mode sentinel had already witnessed revision 2
// ("explicit recovery wrote 1 below 2"), so the very next start refused the recovered record with
// `VAULT_ADMISSIONS_RECOVERY_REQUIRED`.
//
// Negative controls:
//   * an explicit `initialize()` after an ENOENT record loss writes AT OR ABOVE the sentinel floor
//     and the record is still loadable across a fresh store (restart);
//   * the reverse control proves the floor really gates loading: a hand-written record BELOW the
//     sentinel revision is refused instead of being trusted.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAdmissionStore } from "../src/vault-runtime/admission-store.js";
import { resolveVaultIdentity } from "../src/vault-runtime/identity.js";

const quiet = { info() {}, warn() {}, log() {} };
const ACTOR = "admin:test-session";

async function makeFixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w2fix4-floor-"));
  const data = path.join(base, "data");
  const root = path.join(base, "vault");
  await fs.mkdir(data, { recursive: true });
  await fs.mkdir(root, { recursive: true });
  const file = path.join(data, "vault-admissions.json");
  const sentinelFile = path.join(data, "vault-admission-enrollment.json");
  await initializeIncarnation(root);
  const identity = await resolveVaultIdentity({ root });
  const item = { id: "vault", root, identity, primary: true, writable: true };
  return { base, data, root, file, sentinelFile, item };
}

test("W2FIX4-C: explicit recovery after a record loss preserves the durable revision floor and stays loadable", async () => {
  const { base, data, file, item } = await makeFixture();
  try {
    const store = createAdmissionStore({ file, logger: quiet });
    await store.load();
    await store.initialize({ approved: [item], actor: ACTOR, source: "test-explicit", configDigest: "seat" });
    await store.revoke("vault", { actor: ACTOR });
    const before = { revision: store.revision(), generation: store.entryFor("vault").generation, admission: store.entryFor("vault").admission };
    assert.equal(before.admission, "pending");

    // Record loss: the sentinel survives, so the instance is still managed and floors the revision.
    await fs.unlink(file);
    const recovery = createAdmissionStore({ file, logger: quiet });
    await recovery.load();
    assert.equal(recovery.isManaged(), true, "a lost record is not 'never managed'");
    await recovery.initialize({ approved: [item], actor: ACTOR, source: "test-recovery", configDigest: "seat" });
    const recovered = { revision: recovery.revision(), generation: recovery.entryFor("vault").generation, admission: recovery.entryFor("vault").admission };
    assert.ok(recovered.revision >= before.revision, `explicit recovery wrote ${recovered.revision} below ${before.revision}`);
    assert.ok(recovered.generation > before.generation, "the recovery still advances the generation");
    assert.equal(recovered.admission, "approved");

    // Cross-restart: a fresh store must LOAD the recovered record (no VAULT_ADMISSIONS_RECOVERY_REQUIRED).
    const next = createAdmissionStore({ file, logger: quiet });
    const loaded = await next.load();
    assert.equal(loaded.exists, true);
    assert.equal(loaded.kept, false);
    assert.equal(next.revision(), recovered.revision);
    assert.equal(next.entryFor("vault").admission, "approved");
    assert.equal(next.entryFor("vault").generation, recovered.generation);
    const sentinel = JSON.parse(await fs.readFile(path.join(data, "vault-admission-enrollment.json"), "utf8"));
    assert.ok(next.revision() >= sentinel.revision, "the record is never behind the sentinel floor");
    assert.ok(sentinel.revision >= before.revision, "the sentinel floor never moves backwards");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("W2FIX4-C control: a record BELOW the sentinel revision is still refused (the floor gates loading)", async () => {
  const { base, file } = await makeFixture();
  try {
    const store = createAdmissionStore({ file, logger: quiet });
    await store.load();
    await store.initialize({ approved: [item0(await resolveVaultIdentity({ root: path.join(base, "vault") }), path.join(base, "vault"))], actor: ACTOR, source: "test-explicit", configDigest: "seat" });
    await store.revoke("vault", { actor: ACTOR });
    const sentinelRevision = JSON.parse(await fs.readFile(file.replace("vault-admissions.json", "vault-admission-enrollment.json"), "utf8")).revision;
    assert.ok(sentinelRevision >= 2);

    // Hand-write an OLDER record (revision 1) with the same identity: it must be refused, not trusted.
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    record.revision = 1;
    record.registry.revision = 1;
    await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    const stale = createAdmissionStore({ file, logger: quiet });
    await assert.rejects(stale.load(), (error) => error.code === "VAULT_ADMISSIONS_RECOVERY_REQUIRED", "a record below the sentinel floor is refused");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

function item0(identity, root) {
  return { id: "vault", root, identity, primary: true, writable: true };
}
