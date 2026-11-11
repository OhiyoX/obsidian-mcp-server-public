// #642 follow-up: the account (the person) can carry a default Vault. A client's own default
// wins, a client without one inherits the account's, and neither ever swaps in a Vault the
// token is not allowed to open. Spec: docs/superpowers/specs/2026-11-05-account-default-vault-design.md

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { cleanupHarness, grant, newUser, registerClient, service } from "./helpers/i364-transfer-harness.js";

const { requestedVaults } = await import("../src/auth.js");

after(cleanupHarness);

let sequence = 0;

async function fixture({ userDefault = null, clientDefault = null, vaults = ["alpha", "beta"] } = {}) {
  sequence += 1;
  const { provider } = service();
  const user = await newUser(provider, `adv-${sequence}`, { vaults });
  const clientId = await registerClient(provider, `adv-client-${sequence}`);
  if (clientDefault) assert.equal(await provider.updateOAuthClientDefaultVault(clientId, clientDefault), true);
  if (userDefault) assert.equal(await provider.updateOAuthUserDefaultVault(user.id, userDefault), true);
  const tokens = grant(provider, clientId, user.id, { vaults });
  return { provider, userId: user.id, clientId, token: tokens.access_token };
}

test("a client default wins over the account default", async () => {
  const { provider, token } = await fixture({ userDefault: "beta", clientDefault: "alpha" });
  const auth = await provider.verifyAccessToken(token);
  assert.equal(auth.defaultVaultId, "alpha");
  assert.equal(auth.defaultVaultLayer, "client");
});

test("a client without a default inherits the account default", async () => {
  const { provider, token } = await fixture({ userDefault: "beta" });
  const auth = await provider.verifyAccessToken(token);
  assert.equal(auth.defaultVaultId, "beta");
  assert.equal(auth.defaultVaultLayer, "account");
});

test("neither layer set keeps the pre-existing behaviour", async () => {
  const { provider, token } = await fixture();
  const auth = await provider.verifyAccessToken(token);
  assert.equal(auth.defaultVaultId, null);
  assert.equal(auth.defaultVaultLayer, null);
});

test("one client's default never reaches another client of the same account", async () => {
  sequence += 1;
  const { provider } = service();
  const user = await newUser(provider, `adv-split-${sequence}`, { vaults: ["alpha", "beta"] });
  const first = await registerClient(provider, `adv-split-a-${sequence}`);
  const second = await registerClient(provider, `adv-split-b-${sequence}`);
  await provider.updateOAuthUserDefaultVault(user.id, "beta");
  await provider.updateOAuthClientDefaultVault(first, "alpha");
  const withOwn = await provider.verifyAccessToken(grant(provider, first, user.id, { vaults: ["alpha", "beta"] }).access_token);
  const inheriting = await provider.verifyAccessToken(grant(provider, second, user.id, { vaults: ["alpha", "beta"] }).access_token);
  assert.deepEqual([withOwn.defaultVaultId, withOwn.defaultVaultLayer], ["alpha", "client"]);
  assert.deepEqual([inheriting.defaultVaultId, inheriting.defaultVaultLayer], ["beta", "account"], "a client without its own default must not see its sibling's");
});

test("a saved account default survives a restart", async () => {
  const { provider, userId, clientId } = await fixture({ userDefault: "beta" });
  // Only the update method's own save may persist it: `save()` here would hide a missing one.
  await provider.drainPersistence();
  const restarted = service();
  await restarted.provider.ready;
  const auth = await restarted.provider.verifyAccessToken(grant(restarted.provider, clientId, userId, { vaults: ["alpha", "beta"] }).access_token);
  assert.equal(auth.defaultVaultId, "beta");
  assert.equal(auth.defaultVaultLayer, "account");
});

test("a record from before this field existed reads as inherit", async () => {
  const { provider, userId, token } = await fixture();
  assert.equal(Object.hasOwn(provider.data.oauthUsers[userId], "defaultVaultId"), false);
  assert.equal((await provider.verifyAccessToken(token)).defaultVaultId, null);
});

test("saving an out-of-scope account default is rejected", async () => {
  const { provider, userId } = await fixture();
  await assert.rejects(() => provider.updateOAuthUserDefaultVault(userId, "gamma"), /allowed Vaults/);
  assert.equal(provider.data.oauthUsers[userId].defaultVaultId ?? null, null);
});

test("saving a default for an unknown account reports false", async () => {
  const { provider } = await fixture();
  assert.equal(await provider.updateOAuthUserDefaultVault("no-such-user", "alpha"), false);
});

test("a default outside the token's allowed Vaults is projected, never swapped", async () => {
  // The account default stays saved while the grant narrows to one Vault: the call is
  // refused downstream, and the projection must not quietly fall back to "alpha".
  const { provider, userId, clientId } = await fixture({ userDefault: "beta" });
  const narrow = grant(provider, clientId, userId, { vaults: ["alpha"] });
  const auth = await provider.verifyAccessToken(narrow.access_token);
  assert.equal(auth.defaultVaultId, "beta");
  assert.deepEqual(auth.allowedVaults, ["alpha"]);
  assert.deepEqual(requestedVaults({ body: { method: "tools/call", params: { name: "list_notes", arguments: {} } } }, auth), ["beta"]);
});

test("changing the account default does not revoke the account's tokens", async () => {
  const { provider, userId, token } = await fixture();
  assert.equal(await provider.updateOAuthUserDefaultVault(userId, "alpha"), true);
  assert.equal((await provider.verifyAccessToken(token)).defaultVaultId, "alpha");
});

test("clearing the account default returns the account to inherit", async () => {
  const { provider, userId, token } = await fixture({ userDefault: "beta" });
  assert.equal(await provider.updateOAuthUserDefaultVault(userId, null), true);
  const auth = await provider.verifyAccessToken(token);
  assert.equal(auth.defaultVaultId, null);
  assert.equal(auth.defaultVaultLayer, null);
});

test("the audit trail records which Vault the account default points at", async () => {
  const { provider, userId } = await fixture();
  const details = () => provider.data.audit.filter((row) => row.action === "oauth.user.default-vault.update" && row.credentialId === userId).map((row) => row.detail);
  await provider.updateOAuthUserDefaultVault(userId, "alpha");
  await provider.updateOAuthUserDefaultVault(userId, null);
  assert.deepEqual(details(), ["alpha", "inherit"]);
});
