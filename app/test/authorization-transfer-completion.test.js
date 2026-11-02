// #364 authorization-transfer completion, expiry, cancel and the §17-5 account
// re-check — plus the negative control that proves the fence is what denies.
//
// Uses the same harness as `authorization-transfer-provider.test.js`. The store
// writes and the OAuth state writes are the real durable files, so the fault
// injections below (state save failed, completion store write failed) exercise the
// production code paths rather than a mock.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test, { after, beforeEach } from "node:test";

import {
  MCP_URL, STATE_FILE, audit, cleanupHarness, consentAndExchange, createAuthorizationTransferStore, drainProviders,
  grant, issueCode, newStoreFile, newUser, recordId, registerClient, rejection, service,
} from "./helpers/i364-transfer-harness.js";

after(cleanupHarness);
beforeEach(drainProviders);

test("the normal exchange completes exactly the matching pending intent and nothing else", async () => {
  const store = createAuthorizationTransferStore({ file: newStoreFile("complete") });
  const { provider } = service({ store });
  await registerClient(provider, "done-client");
  await registerClient(provider, "done-other-client");
  const [source, target, bystander] = await Promise.all([
    newUser(provider, "done-source"), newUser(provider, "done-target"), newUser(provider, "done-bystander"),
  ]);
  grant(provider, "done-client", source.id);
  const begun = await provider.beginAuthorizationTransfer({ clientId: "done-client", sourceUserId: source.id, targetUserId: target.id });
  await consentAndExchange(provider, "done-client", "done-bystander", { requested: ["obsidian.read"] });
  assert.equal(store.getTransfer(begun.transfer.id).status, "pending");
  await consentAndExchange(provider, "done-other-client", "done-target", { requested: ["obsidian.write"] });
  assert.equal(store.getTransfer(begun.transfer.id).status, "pending");
  assert.equal(audit(provider, "oauth.client.transfer.complete", { transferId: begun.transfer.id }).length, 0, "no false completion");

  const completed = await consentAndExchange(provider, "done-client", "done-target", { requested: ["obsidian.write"] });
  const stored = store.getTransfer(begun.transfer.id);
  assert.equal(stored.status, "completed");
  assert.equal(stored.completionUserId, target.id);
  const events = audit(provider, "oauth.client.transfer.complete", { transferId: begun.transfer.id });
  assert.equal(events.length, 1);
  assert.equal(events[0].completionUserId, target.id);
  const bAuth = await provider.verifyAccessToken(completed.tokens.access_token);
  assert.equal(bAuth.userId, target.id);
  assert.deepEqual(bAuth.scopes, ["obsidian.write"], "B's own consented scope");
  assert.deepEqual(bAuth.allowedVaults, ["default"]);
});

test("an expired intent is swept, audited, never completed and never lifts the fence", async () => {
  let clockMs = Date.parse("2026-10-09T00:00:00.000Z");
  const store = createAuthorizationTransferStore({ file: newStoreFile("expiry"), ttlMs: 60_000, now: () => clockMs });
  const { provider } = service({ store });
  await registerClient(provider, "exp-client");
  const [source, target] = await Promise.all([newUser(provider, "exp-source"), newUser(provider, "exp-target")]);
  const oldTokens = grant(provider, "exp-client", source.id);
  const begun = await provider.beginAuthorizationTransfer({ clientId: "exp-client", sourceUserId: source.id, targetUserId: target.id });
  clockMs += 60_001;
  const expired = await provider.sweepExpiredTransfers();
  assert.deepEqual(expired.map((item) => item.id), [begun.transfer.id]);
  assert.equal(audit(provider, "oauth.client.transfer.expire", { transferId: begun.transfer.id }).length, 1);
  await assert.rejects(provider.verifyAccessToken(oldTokens.access_token), /Invalid or expired/);
  const late = await consentAndExchange(provider, "exp-client", "exp-target", { requested: ["obsidian.read"] });
  assert.ok(late.tokens.access_token);
  assert.equal(store.getTransfer(begun.transfer.id).status, "expired", "a late exchange must not complete an expired intent");
  assert.equal(audit(provider, "oauth.client.transfer.complete", { transferId: begun.transfer.id }).length, 0);
});

test("cancel is explicit, audited, idempotent and never restores the source bearer", async () => {
  const store = createAuthorizationTransferStore({ file: newStoreFile("cancel") });
  const { provider } = service({ store });
  await registerClient(provider, "cancel-client");
  const [source, target] = await Promise.all([newUser(provider, "cancel-source"), newUser(provider, "cancel-target")]);
  const oldTokens = grant(provider, "cancel-client", source.id);
  const begun = await provider.beginAuthorizationTransfer({ clientId: "cancel-client", sourceUserId: source.id, targetUserId: target.id });
  const cancelled = await provider.cancelAuthorizationTransfer(begun.transfer.id, { actor: "admin-session" });
  assert.equal(cancelled.changed, true);
  assert.equal(cancelled.transfer.status, "cancelled");
  assert.equal(audit(provider, "oauth.client.transfer.cancel", { transferId: begun.transfer.id }).length, 1);
  assert.equal((await provider.cancelAuthorizationTransfer(begun.transfer.id)).changed, false);
  assert.equal(audit(provider, "oauth.client.transfer.cancel", { transferId: begun.transfer.id }).length, 1, "an idempotent repeat is not re-audited");
  await assert.rejects(provider.verifyAccessToken(oldTokens.access_token), /Invalid or expired/);
  assert.equal((await rejection(provider.cancelAuthorizationTransfer("no-such-transfer"))).error.status, 404);
  // Cancel does NOT restore the source: the same pair cannot start a new transfer until
  // A logs in again (I10), and only then does a new generation become reachable.
  const blocked = await rejection(provider.beginAuthorizationTransfer({ clientId: "cancel-client", sourceUserId: source.id, targetUserId: target.id }));
  assert.equal(blocked.error.status, 409);
  await consentAndExchange(provider, "cancel-client", "cancel-source", { requested: ["obsidian.read"] });
  const next = await provider.beginAuthorizationTransfer({ clientId: "cancel-client", sourceUserId: source.id, targetUserId: target.id });
  assert.equal(next.reused, false);
  assert.equal(next.transfer.generation, 2);
  assert.equal(store.getTransfer(begun.transfer.id).status, "cancelled");
});

test("a cancel write failure leaves the record pending and the existing fence in force", async () => {
  // Seat P1-2 premise, on the real core + real durable store: the fence is already committed,
  // the cancel write fails, so the committed record must still be `pending`, no `cancel` audit
  // may be written, and the old bearer must still be refused (the cancel never lifted anything).
  const file = newStoreFile("cancel-fail");
  const store = createAuthorizationTransferStore({ file });
  const { provider } = service({ store });
  await registerClient(provider, "cfail-cancel-client");
  const [source, target] = await Promise.all([newUser(provider, "cfail-cancel-source"), newUser(provider, "cfail-cancel-target")]);
  const oldTokens = grant(provider, "cfail-cancel-client", source.id);
  const begun = await provider.beginAuthorizationTransfer({ clientId: "cfail-cancel-client", sourceUserId: source.id, targetUserId: target.id });
  assert.equal(begun.degraded, false);
  assert.equal((await rejection(provider.verifyAccessToken(oldTokens.access_token))).thrown, true, "the begin already fenced the old bearer");

  const originalRename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === file) throw Object.assign(new Error("EIO: injected cancel failure"), { code: "EIO" });
    return originalRename(from, to);
  };
  let thrown = null;
  try {
    await provider.cancelAuthorizationTransfer(begun.transfer.id, { actor: "admin-session" });
  } catch (error) {
    thrown = error;
  } finally {
    fs.rename = originalRename;
  }
  assert.equal(thrown?.name, "AuthorizationTransferError", "the route only renders this typed error");
  assert.equal(thrown?.status, 503, "the failed cancel is an unavailable-store 503, never a false success");
  assert.equal(store.getTransfer(begun.transfer.id).status, "pending", "the committed record is unchanged");
  assert.equal(audit(provider, "oauth.client.transfer.cancel", { transferId: begun.transfer.id }).length, 0, "no cancel audit for a write that did not land");
  await assert.rejects(provider.verifyAccessToken(oldTokens.access_token), /Invalid or expired/, "the existing fence is not lifted by the failed cancel");
});

test("a normal exchange re-checks the current account: disabled, scope ceiling and vault ceiling", async () => {
  const { provider } = service({ store: createAuthorizationTransferStore({ file: newStoreFile("ceiling") }) });
  await registerClient(provider, "ceil-client");
  const [disabled, narrowed, reVault, emptied] = await Promise.all([
    newUser(provider, "ceil-disabled"), newUser(provider, "ceil-narrowed"), newUser(provider, "ceil-vault"), newUser(provider, "ceil-emptied"),
  ]);

  const codeForDisabled = await issueCode(provider, "ceil-client", "ceil-disabled", { requested: ["obsidian.read"] });
  // `revokeGrants: false` keeps the consent-time code alive so only the §17-5 account
  // re-check (not a wholesale grant revoke) can reject the exchange.
  await provider.updateOAuthUser(disabled.id, { disabled: true, revokeGrants: false });
  await assert.rejects(
    provider.exchangeAuthorizationCode(codeForDisabled.client, codeForDisabled.code, undefined, codeForDisabled.client.redirect_uris[0], MCP_URL),
    /no longer allowed/,
  );
  const codeForNarrowed = await issueCode(provider, "ceil-client", "ceil-narrowed", { requested: ["obsidian.read", "obsidian.write"] });
  await provider.updateOAuthUser(narrowed.id, { allowedScopes: ["obsidian.read"], revokeGrants: false });
  const clamped = await provider.exchangeAuthorizationCode(codeForNarrowed.client, codeForNarrowed.code, undefined, codeForNarrowed.client.redirect_uris[0], MCP_URL);
  assert.deepEqual(clamped.scope.split(" "), ["obsidian.read"], "consent-time scope is clamped to the current ceiling");
  const codeForVault = await issueCode(provider, "ceil-client", "ceil-vault", { requested: ["obsidian.read"] });
  await provider.updateOAuthUser(reVault.id, { allowedVaults: ["research"], revokeGrants: false });
  const reVaulted = await provider.exchangeAuthorizationCode(codeForVault.client, codeForVault.code, undefined, codeForVault.client.redirect_uris[0], MCP_URL);
  assert.deepEqual((await provider.verifyAccessToken(reVaulted.access_token)).allowedVaults, ["research"], "the current vault ceiling, never a copied list");
  const codeForEmptied = await issueCode(provider, "ceil-client", "ceil-emptied", { requested: ["obsidian.read"] });
  await provider.updateOAuthUser(emptied.id, { allowedScopes: ["obsidian.write"], revokeGrants: false });
  await assert.rejects(
    provider.exchangeAuthorizationCode(codeForEmptied.client, codeForEmptied.code, undefined, codeForEmptied.client.redirect_uris[0], MCP_URL),
    /no longer allows/,
  );
});

test("a completion persistence failure is audited and the intent stays pending (no false completion)", async () => {
  const file = newStoreFile("complete-fail");
  const store = createAuthorizationTransferStore({ file });
  const { provider } = service({ store });
  await registerClient(provider, "cfail-client");
  const [source, target] = await Promise.all([newUser(provider, "cfail-source"), newUser(provider, "cfail-target")]);
  grant(provider, "cfail-client", source.id);
  const begun = await provider.beginAuthorizationTransfer({ clientId: "cfail-client", sourceUserId: source.id, targetUserId: target.id });
  const code = await issueCode(provider, "cfail-client", "cfail-target", { requested: ["obsidian.read"] });
  const originalRename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === file) throw Object.assign(new Error("EIO: injected completion failure"), { code: "EIO" });
    return originalRename(from, to);
  };
  let tokens;
  try {
    tokens = await provider.exchangeAuthorizationCode(code.client, code.code, undefined, code.client.redirect_uris[0], MCP_URL);
  } finally {
    fs.rename = originalRename;
  }
  assert.ok(tokens.access_token, "the token response stays successful: B really is authorized");
  assert.equal(store.getTransfer(begun.transfer.id).status, "pending", "the intent is NOT completed");
  assert.equal(audit(provider, "oauth.client.transfer.complete", { transferId: begun.transfer.id }).length, 0, "no false completion");
  const failed = audit(provider, "oauth.client.transfer.complete_failed", { transferId: begun.transfer.id });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].outcome, "failure");
  const retried = await consentAndExchange(provider, "cfail-client", "cfail-target", { requested: ["obsidian.read"] });
  assert.ok(retried.tokens.access_token);
  assert.equal(store.getTransfer(begun.transfer.id).status, "completed", "a retry can still complete it");
});

test("fence durable but the OAuth state save failed: a restarted provider still denies the source", async () => {
  const storeFile = newStoreFile("fence-only");
  const { provider } = service({ store: createAuthorizationTransferStore({ file: storeFile }) });
  await registerClient(provider, "fence-only-client");
  const [source, target] = await Promise.all([newUser(provider, "fence-only-source"), newUser(provider, "fence-only-target")]);
  const oldTokens = grant(provider, "fence-only-client", source.id);
  const staleCode = await issueCode(provider, "fence-only-client", "fence-only-source", { requested: ["obsidian.read"] });
  await provider.save();
  const revokedTokenId = recordId(provider, "accessTokens", oldTokens.access_token);

  const originalSave = provider.save;
  const originalSchedule = provider.scheduleSave;
  provider.save = async () => { throw Object.assign(new Error("EIO: injected state save failure"), { code: "EIO" }); };
  provider.scheduleSave = () => {};
  let begun;
  try {
    begun = await provider.beginAuthorizationTransfer({ clientId: "fence-only-client", sourceUserId: source.id, targetUserId: target.id });
  } finally {
    provider.save = originalSave;
    provider.scheduleSave = originalSchedule;
  }
  assert.equal(begun.degraded, true, "the caller must be told the physical revoke did not sync");
  assert.equal(audit(provider, "oauth.client.transfer.source_revoke_sync_failed", { transferId: begun.transfer.id }).length, 1);

  const onDisk = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  assert.equal(Object.values(onDisk.accessTokens).find((record) => record.id === revokedTokenId).revokedAt, undefined, "the physical revoke must NOT be durable");
  const diskTransfers = JSON.parse(await fs.readFile(storeFile, "utf8"));
  assert.equal(Object.values(diskTransfers.generations)[0].generation, 1, "the fence must be durable");

  // Restart: a fresh instance reads only what is durable.
  const restarted = service({ store: createAuthorizationTransferStore({ file: storeFile }) });
  await restarted.provider.ready;
  const restartedRecord = Object.values(restarted.provider.data.accessTokens).find((record) => record.id === revokedTokenId);
  assert.equal(restartedRecord.generation, 0, "the unrevoked record is still the OLD generation");
  assert.equal(restartedRecord.revokedAt, undefined, "nothing revokes it at rest — only the fence can deny here");
  await assert.rejects(restarted.provider.verifyAccessToken(oldTokens.access_token), /Invalid or expired/);
  assert.equal((await rejection(restarted.provider.exchangeRefreshToken(restarted.provider.data.clients["fence-only-client"], oldTokens.refresh_token, ["obsidian.read"], MCP_URL))).error.name, "InvalidGrantError");
  // The pre-fence authorization code survived on disk and is refused BY THE FENCE.
  await assert.rejects(
    restarted.provider.exchangeAuthorizationCode(staleCode.client, staleCode.code, undefined, staleCode.client.redirect_uris[0], MCP_URL),
    /Invalid or expired authorization code/,
  );
  assert.equal(audit(restarted.provider, "oauth.client.transfer.deny", { credentialType: "oauth-code", clientId: "fence-only-client" }).length, 1);
  assert.equal(audit(restarted.provider, "oauth.client.transfer.deny", { credentialType: "oauth-refresh", clientId: "fence-only-client" }).length, 1, "the fence, not the physical revoke, produced this denial");

  // TRUE negative control: with the fence gate removed the same assertions must FAIL.
  const gate = restarted.provider.isCredentialFenced;
  restarted.provider.isCredentialFenced = () => false;
  try {
    const leaked = await restarted.provider.verifyAccessToken(oldTokens.access_token);
    assert.equal(leaked.clientId, "fence-only-client", "RED CONTROL: without the fence the old credential is accepted");
    const rotated = await restarted.provider.exchangeRefreshToken(restarted.provider.data.clients["fence-only-client"], oldTokens.refresh_token, ["obsidian.read"], MCP_URL);
    assert.ok(rotated.access_token, "RED CONTROL: without the fence the old refresh token rotates");
  } finally {
    restarted.provider.isCredentialFenced = gate;
  }
  await assert.rejects(restarted.provider.verifyAccessToken(oldTokens.access_token), /Invalid or expired/, "restoring the gate restores the denial");
});
