// B6 — per-Vault idempotency space (§13.2, §36.3, §22.4).
//
// Proves the same idempotency key is two independent replay spaces, that the
// durable record carries its Vault, that a record from one Vault is never read in
// another, and that legacy schema 1 records stay primary-only.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mv-idempotency-scope-"));
const data = path.join(root, "data");
await fs.mkdir(data, { recursive: true });
process.env.DATA_PATH = data;

const {
  idempotencyDigest, readAppliedRecord, saveAppliedRecord, clearMutationVaultScopes,
} = await import("../src/mutation-idempotency.js");
const { vaultDataKey } = await import("../src/vault-runtime/descriptor.js");
const { withRequestContext } = await import("../src/request-context.js");

after(() => fs.rm(root, { recursive: true, force: true }));

const AUTHOR = { agent: "b6-idempotency", model: "test" };
const VAULT_A = "vault-a";
const VAULT_B = "vault-b";
const as = (vaultId, callback) => withRequestContext({ author: AUTHOR, vaultId }, callback);
const primary = (callback) => withRequestContext({ author: AUTHOR }, callback);

const DIGEST = idempotencyDigest("shared-idempotency-key-0001");
const recordFor = (planId, extra = {}) => ({
  digest: DIGEST,
  planId,
  planHash: `sha256:${"a".repeat(64)}`,
  author: AUTHOR,
  unchanged: [],
  appliedAt: new Date().toISOString(),
  expiresAtMs: Date.now() + 3_600_000,
  result: { planId, applied: true, changed: [], unchanged: [] },
  ...extra,
});

beforeEach(async () => {
  clearMutationVaultScopes();
  await fs.rm(path.join(data, "mutation-idempotency"), { recursive: true, force: true });
});

test("the same key is an independent space per Vault and persists its vaultId (§13.2 / §36.3)", async () => {
  await as(VAULT_A, () => saveAppliedRecord(recordFor("plan-a")));
  await as(VAULT_B, () => saveAppliedRecord(recordFor("plan-b")));

  const readA = await as(VAULT_A, () => readAppliedRecord(DIGEST));
  const readB = await as(VAULT_B, () => readAppliedRecord(DIGEST));
  assert.equal(readA.planId, "plan-a");
  assert.equal(readB.planId, "plan-b");
  assert.equal(readA.vaultId, VAULT_A);
  assert.equal(readB.vaultId, VAULT_B);
  assert.equal(readA.schema, 2);
  assert.equal(readB.schema, 2);

  // Mirror of the W0-C probe: records live in per-Vault roots under the legacy
  // data dir, each stamped with its own vaultId.
  const fileA = path.join(data, "mutation-idempotency", vaultDataKey(VAULT_A), `${DIGEST}.json`);
  const fileB = path.join(data, "mutation-idempotency", vaultDataKey(VAULT_B), `${DIGEST}.json`);
  assert.notEqual(vaultDataKey(VAULT_A), vaultDataKey(VAULT_B));
  assert.equal(JSON.parse(await fs.readFile(fileA, "utf-8")).vaultId, VAULT_A);
  assert.equal(JSON.parse(await fs.readFile(fileB, "utf-8")).vaultId, VAULT_B);
});

test("a replay written under A is never returned under B (§13.2 / §36.3)", async () => {
  await as(VAULT_A, () => saveAppliedRecord(recordFor("plan-a")));

  // B has no record for the same key yet, and must not fall back to A's record.
  assert.equal(await as(VAULT_B, () => readAppliedRecord(DIGEST)), null);

  await as(VAULT_B, () => saveAppliedRecord(recordFor("plan-b")));
  const readB = await as(VAULT_B, () => readAppliedRecord(DIGEST));
  assert.equal(readB.planId, "plan-b");
  assert.notEqual(readB.planId, "plan-a");

  // A's own space is unaffected by B's replay.
  assert.equal((await as(VAULT_A, () => readAppliedRecord(DIGEST))).planId, "plan-a");
});

test("saving a record whose vaultId disagrees with the request Vault is rejected (§13.2)", async () => {
  await assert.rejects(
    as(VAULT_A, () => saveAppliedRecord(recordFor("plan-x", { vaultId: VAULT_B }))),
    (error) => error?.code === "VAULT_CONTEXT_MISMATCH",
  );
  assert.equal(await as(VAULT_A, () => readAppliedRecord(DIGEST)), null);
});

test("primary writes stay schema 1 so an older build can still read them (§5.1 / §49.4)", async () => {
  await primary(() => saveAppliedRecord(recordFor("primary-plan")));
  const persisted = JSON.parse(await fs.readFile(path.join(data, "mutation-idempotency", `${DIGEST}.json`), "utf-8"));
  assert.equal(persisted.schema, 1);
  assert.equal(persisted.vaultId, null);
  assert.equal((await primary(() => readAppliedRecord(DIGEST))).planId, "primary-plan");
  assert.equal(await as(VAULT_A, () => readAppliedRecord(DIGEST)), null);
});

test("legacy schema 1 records are primary-only (§22.4)", async () => {
  const legacy = { schema: 1, ...recordFor("legacy-plan"), vaultId: undefined };
  delete legacy.vaultId;
  const legacyRoot = path.join(data, "mutation-idempotency");
  await fs.mkdir(legacyRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(legacyRoot, `${DIGEST}.json`), JSON.stringify(legacy));

  const readPrimary = await primary(() => readAppliedRecord(DIGEST));
  assert.equal(readPrimary.planId, "legacy-plan");

  // Placed inside a secondary namespace, a schema 1 record is refused, never
  // reinterpreted as that secondary Vault's record.
  const secondaryRoot = path.join(legacyRoot, vaultDataKey(VAULT_A));
  await fs.mkdir(secondaryRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(secondaryRoot, `${DIGEST}.json`), JSON.stringify(legacy));
  await assert.rejects(
    as(VAULT_A, () => readAppliedRecord(DIGEST)),
    (error) => error?.code === "VAULT_CONTEXT_MISMATCH",
  );
});
