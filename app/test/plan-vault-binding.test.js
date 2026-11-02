// B6 — plan ↔ Vault binding (§13.1, §36.1, §44.6).
//
// Proves the P0 cross-call gate: a plan created under Vault A can only be read
// or applied under Vault A. A cross-Vault get/apply returns the stable
// `VAULT_CONTEXT_MISMATCH` code and performs no filesystem work at all.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mv-plan-binding-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.GIT_ENABLED = "false";
process.env.VERSION_HISTORY_ENABLED = "true";

const { createNotePlan, getNotePlan, applyNotePlan } = await import("../src/mutation-plans.js");
const { withRequestContext } = await import("../src/request-context.js");
const { createVaultRuntime } = await import("../src/vault-runtime/runtime.js");
const { vaultDataPaths } = await import("../src/vault-runtime/paths.js");
const { vaultDataKey } = await import("../src/vault-runtime/descriptor.js");

after(() => fs.rm(root, { recursive: true, force: true }));

const AUTHOR = { agent: "b6-plan-binding", model: "test" };
const VAULT_A = "vault-a";
const VAULT_B = "vault-b";

// Wave D / D-files: a *selected* Vault whose runtime is materialized resolves its paths through
// `requestContext().vaultRuntime` (contract §10.1), and a bare `vaultId` without a runtime now
// fails closed as `vault_unavailable` instead of silently planning against primary storage (§47).
// The two Vaults below therefore carry a real runtime, exactly as Wave C's registrar hands one to
// a handler once the process has materialized the Vault; the refusal itself is asserted at the end.
const runtimeFor = (id) => createVaultRuntime({
  descriptor: { id, name: id, root: vault, primary: false, writable: true },
  paths: vaultDataPaths({ primary: false, dataRoot: data, dataKey: vaultDataKey(id) }),
  deps: { requireRequestAuthor: () => AUTHOR },
});
const RUNTIMES = Object.freeze({ [VAULT_A]: runtimeFor(VAULT_A), [VAULT_B]: runtimeFor(VAULT_B) });
const as = (vaultId, callback, author = AUTHOR) => withRequestContext({ author, vaultId, vaultRuntime: RUNTIMES[vaultId] }, callback);

// Every async fs/promises method the Vault plane can reach. The namespace object
// is mutable, so wrapping it counts real I/O performed by the production modules.
const FS_ASYNC = Object.freeze([
  "access", "appendFile", "chmod", "chown", "copyFile", "cp", "lchmod", "lchown", "link", "lstat",
  "lutimes", "mkdir", "mkdtemp", "open", "opendir", "readdir", "readFile", "readlink", "realpath",
  "rename", "rm", "rmdir", "stat", "statfs", "symlink", "truncate", "unlink", "utimes", "writeFile",
]);

async function countFsDuring(callback) {
  const original = new Map();
  let calls = 0;
  for (const name of FS_ASYNC) {
    const value = fsPromises[name];
    if (typeof value !== "function") continue;
    original.set(name, value);
    fsPromises[name] = (...args) => { calls += 1; return value(...args); };
  }
  let error = null;
  try { await callback(); } catch (caught) { error = caught; }
  finally { for (const [name, value] of original) fsPromises[name] = value; }
  return { calls, error };
}

test("plan public result carries the creating Vault and round-trips under it (§13.1)", async () => {
  const plan = await as(VAULT_A, () => createNotePlan([
    { path: "Binding/A.md", operation: "write", content: "body-a", mustNotExist: true },
  ]));
  assert.equal(Object.hasOwn(plan, "vaultId"), true, "public plan result must expose vaultId");
  assert.equal(plan.vaultId, VAULT_A);
  assert.equal(Object.hasOwn(plan, "changes"), true);

  const refetched = await as(VAULT_A, () => getNotePlan(plan.planId));
  assert.equal(refetched.vaultId, VAULT_A);
  assert.equal(refetched.planHash, plan.planHash);

  const applied = await as(VAULT_A, () => applyNotePlan(plan.planId, plan.planHash, "b6-plan-a-key-0001"));
  assert.equal(applied.applied, true);
  assert.equal(applied.idempotentReplay, false);
  assert.match(await fs.readFile(path.join(vault, "Binding/A.md"), "utf-8"), /body-a/);
});

test("create in A then get/apply in B is VAULT_CONTEXT_MISMATCH (§13.1 / §36.1)", async () => {
  const plan = await as(VAULT_A, () => createNotePlan([
    { path: "Binding/B.md", operation: "write", content: "body-b", mustNotExist: true },
  ]));

  assert.throws(
    () => as(VAULT_B, () => getNotePlan(plan.planId)),
    (error) => error?.code === "VAULT_CONTEXT_MISMATCH",
    "get in another Vault must fail with the stable mismatch code",
  );
  await assert.rejects(
    as(VAULT_B, () => applyNotePlan(plan.planId, plan.planHash, "b6-plan-b-key-0001")),
    (error) => error?.code === "VAULT_CONTEXT_MISMATCH",
    "apply in another Vault must fail with the stable mismatch code",
  );
  await assert.rejects(fs.access(path.join(vault, "Binding/B.md")),
    "a rejected cross-Vault apply must not write the note");
});

test("a cross-Vault plan apply performs 0 filesystem calls (§13.1 / §36.1)", async () => {
  const plan = await as(VAULT_A, () => createNotePlan([
    { path: "Binding/C.md", operation: "write", content: "body-c", mustNotExist: true },
  ]));

  const getAttempt = await countFsDuring(() => as(VAULT_B, () => getNotePlan(plan.planId)));
  assert.equal(getAttempt.error?.code, "VAULT_CONTEXT_MISMATCH");
  assert.equal(getAttempt.calls, 0, "cross-Vault get must not touch the filesystem");

  const applyAttempt = await countFsDuring(
    () => as(VAULT_B, () => applyNotePlan(plan.planId, plan.planHash, "b6-plan-c-key-0001")),
  );
  assert.equal(applyAttempt.error?.code, "VAULT_CONTEXT_MISMATCH");
  assert.equal(applyAttempt.calls, 0, "cross-Vault apply must not touch the filesystem");
  await assert.rejects(fs.access(path.join(vault, "Binding/C.md")));
});

test("a plan created without an explicit Vault stays in the legacy primary scope (§22.4)", async () => {
  const plan = await withRequestContext({ author: AUTHOR }, () => createNotePlan([
    { path: "Binding/Primary.md", operation: "write", content: "primary", mustNotExist: true },
  ]));
  assert.equal(Object.hasOwn(plan, "vaultId"), true);
  assert.equal(plan.vaultId, null);
  const refetched = await withRequestContext({ author: AUTHOR }, () => getNotePlan(plan.planId));
  assert.equal(refetched.vaultId, null);
  // A secondary request must not be able to read the primary plan.
  assert.throws(
    () => as(VAULT_A, () => getNotePlan(plan.planId)),
    (error) => error?.code === "VAULT_CONTEXT_MISMATCH",
  );
});

test("a selected Vault without a materialized runtime is refused, never planned against the primary (§47)", async () => {
  await assert.rejects(
    withRequestContext({ author: AUTHOR, vaultId: VAULT_A }, () => createNotePlan([
      { path: "Binding/Refused.md", operation: "write", content: "body-refused", mustNotExist: true },
    ])),
    (error) => error?.code === "vault_unavailable",
    "a bare vaultId must fail closed instead of silently planning against the primary Vault",
  );
  await assert.rejects(fs.access(path.join(vault, "Binding/Refused.md")), "the refused plan must write nothing");
});
