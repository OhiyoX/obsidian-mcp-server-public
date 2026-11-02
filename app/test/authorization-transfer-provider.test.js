// #364 authorization-transfer provider service: begin, refusal, fence, pair revoke.
//
// The contract the Admin route (slice 2) will call. Completion/expiry/cancel and the
// account re-check live in `authorization-transfer-completion.test.js`; the durable
// store algebra in `authorization-transfer-store.test.js`; the real MCP transport in
// `authorization-transfer-transport.test.js`.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { after, beforeEach } from "node:test";

import {
  AuthorizationTransferError, MCP_URL, audit, cleanupHarness, consentAndExchange, createAuthorizationTransferStore,
  drainProviders, grant, issueCode, newStoreFile, newUser, recordId, registerClient, rejection, root, service,
} from "./helpers/i364-transfer-harness.js";

after(cleanupHarness);
beforeEach(drainProviders);

test("revokeClientUserGrants is pair-scoped: the client's other account and the account's other client survive", async () => {
  const { provider } = service();
  const [source, other] = await Promise.all([newUser(provider, "pair-source"), newUser(provider, "pair-other")]);
  await registerClient(provider, "pair-client-x");
  await registerClient(provider, "pair-client-y");
  const sourceX = grant(provider, "pair-client-x", source.id);
  const sourceY = grant(provider, "pair-client-y", source.id);
  const otherX = grant(provider, "pair-client-x", other.id);
  const sourceCodeX = await issueCode(provider, "pair-client-x", "pair-source");
  const sourceCodeY = await issueCode(provider, "pair-client-y", "pair-source");

  const revoked = provider.revokeClientUserGrants("pair-client-x", source.id);
  assert.equal(revoked.clientId, "pair-client-x");
  assert.equal(revoked.userId, source.id);
  assert.equal(revoked.changed, true);
  assert.deepEqual(revoked.revokedTokenIds.sort(), [
    recordId(provider, "accessTokens", sourceX.access_token),
    recordId(provider, "refreshTokens", sourceX.refresh_token),
  ].sort());
  assert.equal(revoked.removedCodeCount, 1);
  await provider.save();

  await assert.rejects(provider.verifyAccessToken(sourceX.access_token), /Invalid or expired/);
  assert.equal((await provider.verifyAccessToken(otherX.access_token)).userId, other.id);
  assert.equal((await provider.verifyAccessToken(sourceY.access_token)).clientId, "pair-client-y");
  await assert.rejects(
    provider.exchangeAuthorizationCode(sourceCodeX.client, sourceCodeX.code, undefined, sourceCodeX.client.redirect_uris[0], MCP_URL),
    /Invalid or expired authorization code/,
  );
  const crossClient = await provider.exchangeAuthorizationCode(sourceCodeY.client, sourceCodeY.code, undefined, sourceCodeY.client.redirect_uris[0], MCP_URL);
  assert.ok(crossClient.access_token, "the same account's other client keeps its unconsumed code");
  const snapshot = await provider.authorizationSnapshot();
  assert.ok(snapshot.tokens.some((item) => item.clientId === "pair-client-y" && item.userId === source.id && item.status === "active"));
});

test("begin refuses invalid, missing, disabled, unbound and already-authorized pairs with zero side effects", async () => {
  const store = createAuthorizationTransferStore({ file: newStoreFile("refusals") });
  const { provider } = service({ store });
  await registerClient(provider, "guard-client");
  const [source, target, disabled, unbound] = await Promise.all([
    newUser(provider, "guard-source"), newUser(provider, "guard-target"), newUser(provider, "guard-disabled"), newUser(provider, "guard-unbound"),
  ]);
  await provider.updateOAuthUser(disabled.id, { disabled: true });
  grant(provider, "guard-client", source.id);
  grant(provider, "guard-client", target.id);
  const sourceTokens = grant(provider, "guard-client", source.id, { scopes: ["obsidian.write"] });
  const before = store.snapshot();
  const auditBefore = provider.data.audit.length;
  const refusals = [
    [{ clientId: "missing-client", sourceUserId: source.id, targetUserId: target.id }, 404],
    [{ clientId: "guard-client", sourceUserId: "missing-user", targetUserId: target.id }, 404],
    [{ clientId: "guard-client", sourceUserId: source.id, targetUserId: source.id }, 400],
    [{ clientId: "guard-client", sourceUserId: source.id, targetUserId: disabled.id }, 409],
    [{ clientId: "guard-client", sourceUserId: unbound.id, targetUserId: target.id }, 409],
    [{ clientId: "guard-client", sourceUserId: source.id, targetUserId: target.id }, 409],
    [{ clientId: "", sourceUserId: source.id, targetUserId: target.id }, 400],
  ];
  for (const [input, status] of refusals) {
    const outcome = await rejection(provider.beginAuthorizationTransfer({ ...input, actor: "admin-session" }));
    assert.equal(outcome.thrown, true, `must reject ${JSON.stringify(input)} with ${status}`);
    assert.ok(outcome.error instanceof AuthorizationTransferError);
    assert.equal(outcome.error.status, status);
  }
  assert.deepEqual(store.snapshot(), before, "no fence, no transfer, no generation after a refusal");
  assert.deepEqual(provider.data.audit.slice(auditBefore), [], "a refusal must not emit a transfer audit event");
  assert.equal((await provider.verifyAccessToken(sourceTokens.access_token)).clientId, "guard-client");
});

test("begin returns only after the fence is durable, and a store write failure leaves the source usable", async () => {
  const file = newStoreFile("fault-503");
  // Let the initial store creation succeed; fail only the begin's write.
  let writes = 0;
  const faultFs = {
    ...fs,
    rename: async (from, to) => {
      if (to === file) {
        writes += 1;
        if (writes === 2) throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
      }
      return fs.rename(from, to);
    },
  };
  const { provider } = service({ store: createAuthorizationTransferStore({ file, fsModule: faultFs }) });
  await registerClient(provider, "fault-client");
  const [source, target] = await Promise.all([newUser(provider, "fault-source"), newUser(provider, "fault-target")]);
  const sourceTokens = grant(provider, "fault-client", source.id);

  const failed = await rejection(provider.beginAuthorizationTransfer({ clientId: "fault-client", sourceUserId: source.id, targetUserId: target.id }));
  assert.equal(failed.error.status, 503);
  assert.equal(failed.error.code, "unavailable");
  assert.equal((await provider.verifyAccessToken(sourceTokens.access_token)).clientId, "fault-client", "§9.5: a 503 must not revoke or half-fence the source");
  assert.equal(audit(provider, "oauth.client.transfer.begin", { clientId: "fault-client" }).length, 0);
  const leftovers = (await fs.readdir(path.dirname(file))).filter((name) => name.startsWith(path.basename(file)));
  assert.deepEqual(leftovers, [path.basename(file)], "a failed write leaves no temp file");

  const begun = await provider.beginAuthorizationTransfer({ clientId: "fault-client", sourceUserId: source.id, targetUserId: target.id });
  assert.equal(begun.degraded, false);
  assert.equal(begun.transfer.generation, 1, "the failed attempt must not have consumed a generation");
  assert.equal(audit(provider, "oauth.client.transfer.begin", { transferId: begun.transfer.id }).length, 1);
});

test("begin cuts the source on verify, refresh and code exchange while unrelated credentials keep working", async () => {
  const closeCalls = [];
  const closeSessions = async (clientId, { userId } = {}) => {
    closeCalls.push({ clientId, userId });
    return { clientId, userId, matched: 2, closed: 2, failed: 0, sessionIds: ["s-a", "s-b"], failures: [] };
  };
  const { provider } = service({ store: createAuthorizationTransferStore({ file: newStoreFile("cut") }), closeSessions });
  await registerClient(provider, "cut-client");
  await registerClient(provider, "cut-other-client");
  const [source, other, target] = await Promise.all([
    newUser(provider, "cut-source"), newUser(provider, "cut-other"), newUser(provider, "cut-target"),
  ]);
  const sourceTokens = grant(provider, "cut-client", source.id);
  const otherTokens = grant(provider, "cut-client", other.id);
  const crossTokens = grant(provider, "cut-other-client", source.id);
  const staleCode = await issueCode(provider, "cut-client", "cut-source");
  assert.ok((await provider.verifyAccessToken(sourceTokens.access_token)).clientId);

  const begun = await provider.beginAuthorizationTransfer({
    clientId: "cut-client", sourceUserId: source.id, targetUserId: target.id, actor: "admin-session", source: "127.0.0.1", userAgent: "i364-test",
  });
  assert.equal(begun.degraded, false);
  assert.equal(begun.revoke.changed, true);
  assert.equal(begun.revoke.removedCodeCount, 1);
  assert.equal(begun.transfer.status, "pending");
  assert.equal(begun.transfer.sourceRevokedAt, begun.transfer.createdAt);
  assert.deepEqual(closeCalls, [{ clientId: "cut-client", userId: source.id }], "I06: exactly the source pair is closed, once");
  assert.equal(begun.sessions.matched, 2);
  assert.equal(begun.sessions.closed, 2);
  assert.equal(begun.sessions.failed, 0);

  await assert.rejects(provider.verifyAccessToken(sourceTokens.access_token), /Invalid or expired/);
  const refreshDenied = await rejection(provider.exchangeRefreshToken(provider.data.clients["cut-client"], sourceTokens.refresh_token, ["obsidian.read"], MCP_URL));
  assert.equal(refreshDenied.error.name, "InvalidGrantError");
  await assert.rejects(
    provider.exchangeAuthorizationCode(staleCode.client, staleCode.code, undefined, staleCode.client.redirect_uris[0], MCP_URL),
    /Invalid or expired authorization code/,
  );
  assert.equal((await provider.verifyAccessToken(otherTokens.access_token)).userId, other.id);
  assert.equal((await provider.verifyAccessToken(crossTokens.access_token)).clientId, "cut-other-client");
  assert.ok((await provider.exchangeRefreshToken(provider.data.clients["cut-client"], otherTokens.refresh_token, ["obsidian.read"], MCP_URL)).access_token);

  const beginEvents = audit(provider, "oauth.client.transfer.begin", { transferId: begun.transfer.id });
  assert.equal(beginEvents.length, 1);
  assert.equal(beginEvents[0].sourceUserId, source.id);
  assert.equal(beginEvents[0].targetUserId, target.id);
  assert.equal(beginEvents[0].actor, "admin-session");
  assert.equal(beginEvents[0].source, "127.0.0.1");
  assert.equal(beginEvents[0].outcome, "success");
  const auditJson = JSON.stringify(provider.data.audit);
  for (const secret of [sourceTokens.access_token, sourceTokens.refresh_token, "i364-test-password"]) {
    assert.equal(auditJson.includes(secret), false, "audit must never carry a raw credential");
  }
  // After a successful physical revoke the credential is already invalid, so the fence
  // is a second line of defence; the fence-only denial is proven in the completion suite.
  assert.equal(audit(provider, "oauth.client.transfer.deny", { clientId: "cut-client" }).length, 0);
});

test("idempotent duplicate begin reuses the pending fence, and a conflicting target creates nothing", async () => {
  const store = createAuthorizationTransferStore({ file: newStoreFile("idempotent") });
  const { provider } = service({ store });
  await registerClient(provider, "dup-client");
  const [source, target, otherTarget] = await Promise.all([
    newUser(provider, "dup-source"), newUser(provider, "dup-target"), newUser(provider, "dup-other-target"),
  ]);
  grant(provider, "dup-client", source.id);
  const first = await provider.beginAuthorizationTransfer({ clientId: "dup-client", sourceUserId: source.id, targetUserId: target.id });
  const second = await provider.beginAuthorizationTransfer({ clientId: "dup-client", sourceUserId: source.id, targetUserId: target.id });
  assert.equal(second.reused, true);
  assert.equal(second.transfer.id, first.transfer.id);
  assert.equal(Object.keys(store.view().transfers).length, 1);
  assert.equal(store.view().generations[JSON.stringify(["dup-client", source.id])].generation, 1);

  const conflicting = await rejection(provider.beginAuthorizationTransfer({ clientId: "dup-client", sourceUserId: source.id, targetUserId: otherTarget.id }));
  assert.equal(conflicting.error.status, 409);
  const pending = Object.values(store.view().transfers).filter((item) => item.status === "pending" && item.sourceUserId === source.id);
  assert.deepEqual(pending.map((item) => item.targetUserId), [target.id], "the conflicting target created nothing");
  assert.equal(store.view().generations[JSON.stringify(["dup-client", source.id])].generation, 1, "the conflict spent no generation");
  grant(provider, "dup-client", otherTarget.id);
  const chained = await provider.beginAuthorizationTransfer({ clientId: "dup-client", sourceUserId: otherTarget.id, targetUserId: source.id });
  assert.equal(chained.transfer.status, "pending", "a different pair on the same client is allowed");
});

test("A may re-authorize at the new generation; old refresh/code can never upgrade across the fence", async () => {
  const store = createAuthorizationTransferStore({ file: newStoreFile("generation") });
  const { provider } = service({ store });
  await registerClient(provider, "gen-client");
  const [source, target, secondTarget] = await Promise.all([
    newUser(provider, "gen-source", { scopes: ["obsidian.read"] }),
    newUser(provider, "gen-target", { scopes: ["obsidian.write"] }),
    newUser(provider, "gen-second-target", { scopes: ["obsidian.write"] }),
  ]);
  const oldTokens = grant(provider, "gen-client", source.id, { scopes: ["obsidian.read"] });
  const oldCode = await issueCode(provider, "gen-client", "gen-source", { requested: ["obsidian.read"] });
  const begun = await provider.beginAuthorizationTransfer({ clientId: "gen-client", sourceUserId: source.id, targetUserId: target.id });

  const fresh = await consentAndExchange(provider, "gen-client", "gen-source", { requested: ["obsidian.read"] });
  const freshAuth = await provider.verifyAccessToken(fresh.tokens.access_token);
  assert.deepEqual(freshAuth.scopes, ["obsidian.read"]);
  assert.deepEqual(freshAuth.allowedVaults, ["default"], "the account's own vault ceiling, never a copied one");
  await assert.rejects(provider.verifyAccessToken(oldTokens.access_token), /Invalid or expired/);
  const oldRefresh = await rejection(provider.exchangeRefreshToken(provider.data.clients["gen-client"], oldTokens.refresh_token, ["obsidian.read"], MCP_URL));
  assert.equal(oldRefresh.error.name, "InvalidGrantError");
  const oldCodeExchange = await rejection(provider.exchangeAuthorizationCode(oldCode.client, oldCode.code, undefined, oldCode.client.redirect_uris[0], MCP_URL));
  assert.equal(oldCodeExchange.error.name, "InvalidGrantError");

  await provider.cancelAuthorizationTransfer(begun.transfer.id);
  await provider.beginAuthorizationTransfer({ clientId: "gen-client", sourceUserId: source.id, targetUserId: secondTarget.id });
  assert.equal(store.view().generations[JSON.stringify(["gen-client", source.id])].generation, 2);
  await assert.rejects(provider.verifyAccessToken(fresh.tokens.access_token), /Invalid or expired/, "a later transfer fences the earlier new-generation grant too");
});

test("an unreadable transfer store fails closed for a credential and refuses a begin", async () => {
  const { provider } = service({ store: createAuthorizationTransferStore({ file: newStoreFile("degraded") }) });
  await registerClient(provider, "degraded-client");
  const [source, target] = await Promise.all([newUser(provider, "degraded-source"), newUser(provider, "degraded-target")]);
  const tokens = grant(provider, "degraded-client", source.id);
  assert.ok((await provider.verifyAccessToken(tokens.access_token)).clientId);
  provider.transferStore = { view: () => { throw new Error("unreadable"); }, isHealthy: () => false };
  await assert.rejects(provider.verifyAccessToken(tokens.access_token), /Invalid or expired/);
  const denied = await rejection(provider.beginAuthorizationTransfer({ clientId: "degraded-client", sourceUserId: source.id, targetUserId: target.id }));
  assert.equal(denied.error.status, 503);
  const snapshot = await provider.authorizationTransferSnapshot();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.healthy, false);
  assert.deepEqual(snapshot.transfers, []);
});

test("one snapshot past the pending TTL already projects the committed expiry, and a repeat read does not re-audit", async () => {
  // Regression for the L1 return on `5eb0da78`: the snapshot captured the store view
  // BEFORE its sweep. Because every commit publishes a NEW state object, that stale
  // reference kept returning `pending` while the committed state was already `expired`.
  let clockMs = Date.parse("2026-10-09T00:00:00.000Z");
  const store = createAuthorizationTransferStore({ file: newStoreFile("snapshot-expiry"), ttlMs: 60_000, now: () => clockMs });
  const { provider } = service({ store });
  await registerClient(provider, "snapshot-client");
  const [source, target] = await Promise.all([newUser(provider, "snapshot-source"), newUser(provider, "snapshot-target")]);
  const oldTokens = grant(provider, "snapshot-client", source.id);
  const begun = await provider.beginAuthorizationTransfer({ clientId: "snapshot-client", sourceUserId: source.id, targetUserId: target.id });
  clockMs += 60_001;

  // ONE call must both commit the sweep and project the COMMITTED state.
  const first = await provider.authorizationTransferSnapshot();
  const projected = first.transfers.find((item) => item.id === begun.transfer.id);
  assert.equal(projected.status, "expired", "the first snapshot past the TTL must already project the committed expiry");
  assert.equal(store.snapshot().transfers[begun.transfer.id].status, "expired", "the committed state really is expired");
  assert.equal(audit(provider, "oauth.client.transfer.expire", { transferId: begun.transfer.id }).length, 1);

  const second = await provider.authorizationTransferSnapshot();
  assert.equal(second.transfers.find((item) => item.id === begun.transfer.id).status, "expired", "the second read agrees");
  assert.equal(audit(provider, "oauth.client.transfer.expire", { transferId: begun.transfer.id }).length, 1, "a repeat read must not re-audit the same expiry");
  await assert.rejects(provider.verifyAccessToken(oldTokens.access_token), /Invalid or expired/, "reporting the expiry never lifts the fence");
});

test("a snapshot whose expiry sweep write failed reports the committed state instead of claiming the expiry landed", async () => {
  let clockMs = Date.parse("2026-10-09T00:00:00.000Z");
  const file = newStoreFile("snapshot-sweep-fail");
  let failRenames = 0;
  const faultFs = {
    ...fs,
    rename: async (from, to) => {
      if (to === file && failRenames > 0) {
        failRenames -= 1;
        throw Object.assign(new Error("EIO: injected sweep failure"), { code: "EIO" });
      }
      return fs.rename(from, to);
    },
  };
  const store = createAuthorizationTransferStore({ file, fsModule: faultFs, ttlMs: 60_000, now: () => clockMs });
  const { provider } = service({ store });
  await registerClient(provider, "snapfail-client");
  const [source, target] = await Promise.all([newUser(provider, "snapfail-source"), newUser(provider, "snapfail-target")]);
  const oldTokens = grant(provider, "snapfail-client", source.id);
  const begun = await provider.beginAuthorizationTransfer({ clientId: "snapfail-client", sourceUserId: source.id, targetUserId: target.id });
  clockMs += 60_001;
  failRenames = 1; // only the snapshot's own sweep write fails

  const snapshot = await provider.authorizationTransferSnapshot();
  const projected = snapshot.transfers.find((item) => item.id === begun.transfer.id);
  assert.equal(projected.status, "pending", "an unpersisted expiry must never be reported as expired");
  assert.equal(projected.closedReason, null, "and no close reason may be invented");
  assert.equal(store.snapshot().transfers[begun.transfer.id].status, "pending", "the committed state is unchanged");
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).transfers[begun.transfer.id].status, "pending", "the on-disk state is unchanged");
  assert.equal(audit(provider, "oauth.client.transfer.expire", { transferId: begun.transfer.id }).length, 0, "no expiry is claimed for a write that failed");
  assert.equal(audit(provider, "oauth.client.transfer.complete", { transferId: begun.transfer.id }).length, 0, "and no completion is claimed either");

  // The lazy deadline is independent of the failed sweep: the old credential is fenced.
  await assert.rejects(provider.verifyAccessToken(oldTokens.access_token), /Invalid or expired/, "the fence denies regardless of the sweep outcome");

  // Once writes recover, the same read reports the durable expiry exactly once.
  const recovered = await provider.authorizationTransferSnapshot();
  assert.equal(recovered.transfers.find((item) => item.id === begun.transfer.id).status, "expired");
  assert.equal(audit(provider, "oauth.client.transfer.expire", { transferId: begun.transfer.id }).length, 1, "the expiry is reported when it is finally durable");
});

test("a duplicate begin waits for the in-flight durable commit and never reports a fence that is not on disk", async () => {
  const file = newStoreFile("dup-inflight");
  let block = false;
  let entered = null;
  let release = null;
  const blockedFs = {
    ...fs,
    rename: async (from, to) => {
      if (block && to === file) {
        entered?.();
        await new Promise((resolve) => { release = resolve; });
      }
      return fs.rename(from, to);
    },
  };
  const { provider } = service({ store: createAuthorizationTransferStore({ file, fsModule: blockedFs }) });
  await registerClient(provider, "inflight-client");
  const [source, target] = await Promise.all([newUser(provider, "inflight-source"), newUser(provider, "inflight-target")]);
  grant(provider, "inflight-client", source.id);
  block = true;
  let signal;
  const enteredWrite = new Promise((resolve) => { signal = resolve; });
  entered = signal;
  const first = provider.beginAuthorizationTransfer({ clientId: "inflight-client", sourceUserId: source.id, targetUserId: target.id });
  await enteredWrite;
  assert.equal(provider.transferStore.pendingForSource("inflight-client", source.id), null, "the fence must not be observable before it is durable");
  let settled = null;
  const second = provider.beginAuthorizationTransfer({ clientId: "inflight-client", sourceUserId: source.id, targetUserId: target.id }).then((value) => { settled = value; return value; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, null, "a duplicate begin must wait for the commit instead of reporting an early success");
  release();
  const [begun, duplicate] = await Promise.all([first, second]);
  assert.equal(begun.reused, false);
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.transfer.id, begun.transfer.id);
  const persisted = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(Object.keys(persisted.transfers), [begun.transfer.id], "exactly one fence exists on disk");
  assert.equal(persisted.transfers[begun.transfer.id].status, "pending");
});

test("a duplicate begin reports the real close outcome instead of a false healthy result", async () => {
  const closeSessions = async (clientId, { userId } = {}) => ({
    clientId, userId, matched: 1, closed: 0, failed: 1, sessionIds: ["stuck-session"], failures: [{ sessionId: "stuck-session", error: "close exploded" }],
  });
  const store = createAuthorizationTransferStore({ file: newStoreFile("dup-degraded") });
  const { provider } = service({ store, closeSessions });
  await registerClient(provider, "deg-client");
  const [source, target] = await Promise.all([newUser(provider, "deg-source"), newUser(provider, "deg-target")]);
  grant(provider, "deg-client", source.id);
  const first = await provider.beginAuthorizationTransfer({ clientId: "deg-client", sourceUserId: source.id, targetUserId: target.id });
  assert.equal(first.degraded, true);
  const second = await provider.beginAuthorizationTransfer({ clientId: "deg-client", sourceUserId: source.id, targetUserId: target.id });
  assert.equal(second.reused, true);
  assert.equal(second.sessions.failed, 1);
  assert.equal(second.degraded, true, "the duplicate must report the close failure it actually observed");
  const reusedEvents = audit(provider, "oauth.client.transfer.begin", { transferId: first.transfer.id }).filter((entry) => entry.reused === true);
  assert.equal(reusedEvents.length, 1);
  assert.equal(reusedEvents[0].degraded, true, "the audit must not claim a healthy duplicate");
  assert.equal(reusedEvents[0].sessionsFailed, 1);
});

test("an expired intent stays incomplete even when its sweep could not be persisted", async () => {
  // The intent is past its TTL for BOTH clocks (store and the exchange's real clock),
  // so the runtime guard is the only layer that can refuse the completion here.
  let clockMs = Date.now() - 120_000;
  const file = newStoreFile("expired-no-complete");
  let failRenames = 0;
  const faultFs = {
    ...fs,
    rename: async (from, to) => {
      if (to === file && failRenames > 0) {
        failRenames -= 1;
        throw Object.assign(new Error("EIO: injected sweep failure"), { code: "EIO" });
      }
      return fs.rename(from, to);
    },
  };
  const store = createAuthorizationTransferStore({ file, fsModule: faultFs, ttlMs: 60_000, now: () => clockMs });
  const { provider } = service({ store });
  await registerClient(provider, "late-client");
  const [source, target] = await Promise.all([newUser(provider, "late-source"), newUser(provider, "late-target")]);
  const oldTokens = grant(provider, "late-client", source.id);
  const begun = await provider.beginAuthorizationTransfer({ clientId: "late-client", sourceUserId: source.id, targetUserId: target.id });
  // The store clock now crosses the deadline too: the intent is expired for both clocks.
  clockMs = Date.now() + 1_000;
  // The explicit sweep AND the completion hook's own sweep both fail to persist.
  failRenames = 2;
  await assert.rejects(provider.sweepExpiredTransfers(), (error) => error.code === "unavailable");
  const late = await consentAndExchange(provider, "late-client", "late-target", { requested: ["obsidian.read"] });
  assert.ok(late.tokens.access_token, "the token response itself stays successful");
  assert.equal(failRenames, 0, "both sweeps hit the injected failure, so the store was never asked to complete");
  assert.equal(store.snapshot().transfers[begun.transfer.id].status, "pending", "an expired intent must never be completed");
  assert.equal(audit(provider, "oauth.client.transfer.complete", { transferId: begun.transfer.id }).length, 0, "no false completion");
  assert.equal(audit(provider, "oauth.client.transfer.complete_failed", { transferId: begun.transfer.id }).length, 0, "and no completion write was even attempted");
  const expired = await provider.sweepExpiredTransfers();
  assert.deepEqual(expired.map((item) => item.id), [begun.transfer.id], "the intent is still reported as expired once writes recover");
  assert.equal(store.snapshot().transfers[begun.transfer.id].status, "expired");
  await assert.rejects(provider.verifyAccessToken(oldTokens.access_token), /Invalid or expired/, "expiry never lifts the fence");
});

test("a completion that lands after the deadline is refused by the store's serial re-check", async () => {
  // The store clock is ahead of the wall clock, so the completion hook still sees the
  // candidate as eligible and asks the store to complete it — exactly the "queued past
  // the deadline" case. The completion write itself succeeds; only the store's own
  // deadline re-check may refuse it.
  const realStart = Date.now();
  let clockMs = realStart - 30_000;
  const file = newStoreFile("late-completion");
  let failRenames = 0;
  const faultFs = {
    ...fs,
    rename: async (from, to) => {
      if (to === file && failRenames > 0) {
        failRenames -= 1;
        throw Object.assign(new Error("EIO: injected sweep failure"), { code: "EIO" });
      }
      return fs.rename(from, to);
    },
  };
  const store = createAuthorizationTransferStore({ file, fsModule: faultFs, ttlMs: 60_000, now: () => clockMs });
  const { provider } = service({ store });
  await registerClient(provider, "queued-client");
  const [source, target] = await Promise.all([newUser(provider, "queued-source"), newUser(provider, "queued-target")]);
  const oldTokens = grant(provider, "queued-client", source.id);
  const begun = await provider.beginAuthorizationTransfer({ clientId: "queued-client", sourceUserId: source.id, targetUserId: target.id });
  clockMs = realStart + 31_000;
  // Both sweeps fail; the completion write itself succeeds (the third rename), which
  // is exactly the window in which an expired intent must not become "completed".
  failRenames = 2;
  await assert.rejects(provider.sweepExpiredTransfers(), (error) => error.code === "unavailable");
  const late = await consentAndExchange(provider, "queued-client", "queued-target", { requested: ["obsidian.read"] });
  assert.ok(late.tokens.access_token, "the token response stays successful: the target really is authorized");
  assert.equal(failRenames, 0, "the completion write itself succeeded, so only the deadline guard can refuse it");
  const stored = store.snapshot().transfers[begun.transfer.id];
  assert.equal(stored.status, "expired", "the deadline, not the last successful sweep, decides");
  assert.equal(audit(provider, "oauth.client.transfer.complete", { transferId: begun.transfer.id }).length, 0, "no false completion");
  assert.equal(audit(provider, "oauth.client.transfer.complete_failed", { transferId: begun.transfer.id }).length, 0, "the refusal is not a persistence failure");
  const expireEvents = audit(provider, "oauth.client.transfer.expire", { transferId: begun.transfer.id });
  assert.equal(expireEvents.length, 1);
  assert.equal(expireEvents[0].detail, "pending_ttl_elapsed_in_commit");
  assert.deepEqual(await provider.sweepExpiredTransfers(), [], "the durable expiry is reported once");
  await assert.rejects(provider.verifyAccessToken(oldTokens.access_token), /Invalid or expired/, "expiry never lifts the fence");
});
