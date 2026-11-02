import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { managedAdmin, TAB, httpEvidence } from "./helpers/vault-w3-admin-harness.js";

// The prototype row links its identity cell to the `?id=` drawer instead of carrying a data
// attribute, so "this Vault is visible in the page" is the row's own drawer link (`pages/vaults.js`
// `identityCell`). `data-vault-id` belonged to the retired `vault-git-view.js`.
const vaultRow = (body, id) => body.includes(`<a class="cell-link" href="${TAB}?id=${id}">`);

test("W3 real Admin refresh commits all faces; failed round preserves inventory; no request scans", async t => {
  const w = await managedAdmin(t);
  const before = w.registry.snapshot().revision;
  const page = await w.request();
  const model = await w.vaultGitAdmin.model();
  console.log("BEFORE", JSON.stringify({ revision: before, serving: w.registry.list().map(v => v.id), admin: model.vaults.map(v => v.id) }));
  assert.equal(page.response.status, 200);
  assert.equal(w.registry.snapshot().revision, before, "GET/model must not scan");
  await w.beta();
  const bad = await w.request(`${TAB}/refresh`, {}, { csrf: "invalid" });
  httpEvidence(`${TAB}/refresh`, bad, "invalid"); assert.equal(bad.response.status, 403);
  assert.equal(w.registry.snapshot().revision, before);
  const good = await w.request(`${TAB}/refresh`, {});
  httpEvidence(`${TAB}/refresh`, good); assert.equal(good.response.status, 200);
  assert.deepEqual(model.vaults.map(v => v.id).sort(), ["alpha", "vault"]);
  const after = w.registry.snapshot();
  assert.ok(after.revision > before); assert.equal(w.controller.store.entryFor("beta").admission, "pending");
  assert.equal(w.vaultRuntimeMap.has("beta"), false);
  assert.equal(w.primaryAuthorized(), true, "composition publish binds primary authorization");
  const projected = await w.vaultGitAdmin.model();
  console.log("AFTER", JSON.stringify({ revision: after.revision, serving: w.registry.list().map(v => v.id),
    admin: projected.vaults.map(v => ({ id: v.id, admission: v.admission })), htmlBeta: vaultRow(good.body, "beta") }));
  assert.ok(projected.vaults.some(v => v.id === "beta" && v.admission?.admission === "pending"));
  assert.equal(vaultRow(good.body, "beta"), true);
  // A real filesystem failure before publication, with a valid CSRF and the same session.
  await fs.rename(w.vaultsRoot, `${w.vaultsRoot}-offline`); await fs.writeFile(w.vaultsRoot, "not a directory");
  const failed = await w.request(`${TAB}/refresh`, {});
  httpEvidence(`${TAB}/refresh`, failed); assert.equal(failed.response.status, 503);
  assert.equal(w.registry.snapshot().revision, after.revision);
  assert.deepEqual((await w.vaultGitAdmin.model()).vaults.map(v => v.id).sort(), ["alpha", "beta", "vault"]);
  assert.equal((await w.request()).response.status, 200, "existing Admin session survives failure");
});

test("W3 pending projection and protected admission operations keep Git and content gates closed", async t => {
  const w = await managedAdmin(t); await w.beta();
  const refresh = await w.request(`${TAB}/refresh`, {});
  httpEvidence(`${TAB}/refresh`, refresh); assert.equal(refresh.response.status, 200);
  const pending = (await w.vaultGitAdmin.model()).vaults.find(v => v.id === "beta");
  assert.equal(pending.editable, false); assert.equal(pending.admission.admission, "pending");
  const generation = w.controller.store.entryFor("beta").generation;
  for (const operation of ["approve", "revoke", "initialize"]) {
    const route = `${TAB}/admission/${operation}`;
    assert.equal((await w.request(route, { vaultId: "beta" }, { authenticated: false, csrf: "invalid" })).response.status, 303);
    const denied = await w.request(route, { vaultId: "beta" }, { csrf: "invalid" });
    httpEvidence(route, denied, "invalid"); assert.equal(denied.response.status, 403);
  }
  assert.equal(w.controller.store.entryFor("beta").generation, generation);
  const save = await w.request(`${TAB}/save`, { vaultId: "beta", expectedRevision: "0", enabled: "true" });
  httpEvidence(`${TAB}/save`, save); assert.equal(save.response.status, 403);
  const verify = await w.request(`${TAB}/verify`, { vaultId: "beta" }); assert.equal(verify.response.status, 403);
  const spoof = await w.request(`${TAB}/admission/approve`, { vaultId: "beta", actor: "spoofed" });
  assert.equal(spoof.response.status, 400); assert.equal(w.vaultRuntimeMap.has("beta"), false);
  const approved = await w.request(`${TAB}/admission/approve`, { vaultId: "beta" });
  httpEvidence(`${TAB}/admission/approve`, approved); assert.equal(approved.response.status, 200);
  assert.equal(w.controller.store.entryFor("beta").approvedBy, "admin:auth-center");
  assert.equal(w.vaultRuntimeMap.has("beta"), true); assert.ok(w.registry.get("beta"));
  const old = w.vaultRuntimeMap.get("beta");
  const probe = path.join(w.vaultsRoot, "beta", "probe.md");
  await fs.writeFile(probe, "approved-body");
  assert.equal(await old.localFs.readLimitedText(probe), "approved-body");
  const revoked = await w.request(`${TAB}/admission/revoke`, { vaultId: "beta" });
  httpEvidence(`${TAB}/admission/revoke`, revoked); assert.equal(revoked.response.status, 200);
  assert.equal(w.vaultRuntimeMap.get("beta"), undefined);
  assert.throws(() => old.localFs.readLimitedText(probe), e => e.code === "VAULT_RUNTIME_LEASE_REVOKED");
  assert.equal(await fs.readFile(path.join(w.vaultsRoot, "beta", "probe.md"), "utf8"), "approved-body");
  assert.equal((await w.vaultGitAdmin.model()).vaults.find(v => v.id === "beta").admission.admission, "pending");
});

test("W3 explicit initialization requires confirmation and never approves discovered secondaries implicitly", async t => {
  const w = await managedAdmin(t, { initialized: false });
  assert.equal(w.registry.list().length, 0); assert.equal(w.primaryAuthorized(), false);
  const page = await w.request(); assert.equal(vaultRow(page.body, "alpha"), true);
  const denied = await w.request(`${TAB}/admission/initialize`, {});
  assert.equal(denied.response.status, 400); assert.equal(w.controller.store.isInitialized(), false);
  const result = await w.request(`${TAB}/admission/initialize`, { confirm: "vault" });
  httpEvidence(`${TAB}/admission/initialize`, result); assert.equal(result.response.status, 200);
  assert.equal(w.primaryAuthorized(), true); assert.equal(w.vaultRuntimeMap.has("alpha"), false);
  assert.equal(w.controller.store.entryFor("alpha").admission, "pending");
  const repeat = await w.request(`${TAB}/admission/initialize`, { confirm: "vault" });
  assert.equal(repeat.response.status, 400);
});

test("W3 already committed pending Vault is visible to Admin without a read-triggered scan", async t => {
  const w = await managedAdmin(t); await w.beta(); await w.controller.reconcile("manual");
  const revision = w.registry.snapshot().revision;
  const model = await w.vaultGitAdmin.model(); const page = await w.request();
  const htmlBeta = vaultRow(page.body, "beta");
  console.log("PENDING PROJECTION", JSON.stringify({ revision,
    admission: w.controller.store.entryFor("beta").admission,
    serving: w.registry.list().map(v => v.id), admin: model.vaults.map(v => v.id), htmlBeta }));
  assert.equal(htmlBeta, true); assert.ok(model.vaults.some(v => v.id === "beta"));
  assert.equal(w.registry.snapshot().revision, revision);
});

test("W3 coalesced revoke reports 202 and shows the durable pending decision immediately", { timeout: 10_000 }, async t => {
  const w = await managedAdmin(t);
  const hold = w.holdNextScan();
  const round = w.controller.reconcile("manual");
  try {
    await hold.started;
    const refresh = await w.request(`${TAB}/refresh`, {});
    httpEvidence(`${TAB}/refresh`, refresh);
    assert.equal(refresh.response.status, 202);
    const revoked = await w.request(`${TAB}/admission/revoke`, { vaultId: "alpha" });
    httpEvidence(`${TAB}/admission/revoke`, revoked);
    assert.equal(revoked.response.status, 202);
    assert.equal(w.controller.store.entryFor("alpha").admission, "pending");
    const item = (await w.vaultGitAdmin.model()).vaults.find(v => v.id === "alpha");
    assert.equal(item.admission.admission, "pending");
    assert.equal(item.editable, false);
    assert.equal(w.vaultRuntimeMap.get("alpha"), undefined);
  } finally { hold.release(); await round; }
  await w.controller.reconcile("manual");
  assert.equal(w.vaultRuntimeMap.has("alpha"), false);
});

test("W3 primary revoke and reapproval obey composition authorization through real HTTP", async t => {
  const w = await managedAdmin(t);
  const revoked = await w.request(`${TAB}/admission/revoke`, { vaultId: "vault" });
  httpEvidence(`${TAB}/admission/revoke`, revoked);
  assert.equal(revoked.response.status, 200);
  assert.equal(w.primaryAuthorized(), false);
  assert.equal(w.registry.get("vault"), undefined);
  const primary = (await w.vaultGitAdmin.model()).vaults.find(v => v.id === "vault");
  assert.equal(primary.editable, false);
  assert.equal(primary.admission.admission, "pending");
  assert.equal((await w.request(`${TAB}/refresh`, {})).response.status, 200);
  assert.equal(w.primaryAuthorized(), false, "refresh is never primary approval");
  const approved = await w.request(`${TAB}/admission/approve`, { vaultId: "vault" });
  httpEvidence(`${TAB}/admission/approve`, approved);
  assert.equal(approved.response.status, 200);
  assert.equal(w.primaryAuthorized(), true);
  assert.ok(w.vaultRuntimeMap.get("vault"));
});

test("W3 initialization accepts repeated confirmation fields and rejects unknown identities", async t => {
  const w = await managedAdmin(t, { initialized: false });
  const bad = await w.request(`${TAB}/admission/initialize`, { confirm: "unknown" });
  assert.equal(bad.response.status, 400);
  assert.equal(w.controller.store.isInitialized(), false);
  const good = await w.request(`${TAB}/admission/initialize`, { confirm: ["vault", "alpha"] });
  httpEvidence(`${TAB}/admission/initialize`, good);
  assert.equal(good.response.status, 200);
  assert.equal(w.controller.store.entryFor("alpha").admission, "approved");
  assert.equal(w.vaultRuntimeMap.has("alpha"), true);
});

test("W3 failed approval is a structured refusal and preserves the pending decision", async t => {
  const w = await managedAdmin(t); await w.beta(); await w.controller.reconcile("manual");
  await fs.rename(w.vaultsRoot, `${w.vaultsRoot}-offline`);
  await fs.writeFile(w.vaultsRoot, "not a directory");
  const denied = await w.request(`${TAB}/admission/approve`, { vaultId: "beta" });
  httpEvidence(`${TAB}/admission/approve`, denied);
  assert.equal(denied.response.status, 503);
  assert.equal(w.controller.store.entryFor("beta").admission, "pending");
  assert.equal(w.vaultRuntimeMap.get("beta"), undefined);
});

test("W3 coalesced initialization cannot report the prior history entry as this operation's success", { timeout: 10_000 }, async t => {
  const w = await managedAdmin(t, { initialized: false });
  assert.equal(w.controller.status().history.at(-1).status, "committed");
  const hold = w.holdNextScan(); const round = w.controller.reconcile("manual");
  try {
    await hold.started;
    const result = await w.request(`${TAB}/admission/initialize`, { confirm: "vault" });
    httpEvidence(`${TAB}/admission/initialize`, result);
    assert.equal(result.response.status, 202);
    assert.equal(w.controller.store.isInitialized(), true);
    assert.equal(w.primaryAuthorized(), false, "durable initialization alone never publishes service rights");
  } finally { hold.release(); await round; }
  await w.controller.reconcile("manual");
  assert.equal(w.primaryAuthorized(), true);
  assert.equal(w.vaultRuntimeMap.has("alpha"), false);
});
