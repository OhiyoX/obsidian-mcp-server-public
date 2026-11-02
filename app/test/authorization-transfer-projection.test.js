// #364 slice 2 — pure projection tests for the authorization-transfer fence overlay
// and the clients-tab pending view.
//
// The overlay is the security-relevant part: a credential whose generation is behind its
// pair's committed transfer generation must stop being a "current authorization" even
// while its own record still says `status: "active"` and its `revokedAt` is still null
// (the physical revoke is best-effort). The negative control at the end proves the
// assertion has discriminating power: without the fence input the same account is shown
// as current.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { applyAuthorizationTransferFence, countOAuthClientsForUser, linkedOAuthAccountLabel, linkedOAuthAccountsForClient } from "../src/admin/auth-center-oauth-linkage.js";
import { pairGenerationKey } from "../src/oauth/authorization-transfer-runtime.js";
import { isUnpersistedExpiry, loadAdminProjection, pendingTransferNotice, transferAccountLabel } from "../src/admin/auth-center-transfer-view.js";
import { cleanupHarness, createAuthorizationTransferStore, grant, newStoreFile, newUser, registerClient, service } from "./helpers/i364-transfer-harness.js";

const users = [
  { id: "u-a", username: "alice", displayName: "Alice" },
  { id: "u-b", username: "bob", displayName: "Bob" },
  { id: "u-c", username: "carol", displayName: "Carol" },
];

function snapshot(tokens) {
  return { oauthUsers: users, clients: [], tokens, apiKeys: [], audit: [], configuredApiKeyUsage: {} };
}

function transferSnapshot({ generations = [], transfers = [], available = true, healthy = true } = {}) {
  return { available, healthy, transfers, generations };
}

test("a fenced credential is not current even while its record is still active and unrevoked", () => {
  const raw = snapshot([
    { id: "t-a", clientId: "client-x", userId: "u-a", type: "access", status: "active", generation: 0, revokedAt: null },
    { id: "t-c", clientId: "client-x", userId: "u-c", type: "access", status: "active", generation: 0, revokedAt: null },
  ]);
  const overlaid = applyAuthorizationTransferFence(raw, transferSnapshot({
    generations: [{ key: pairGenerationKey("client-x", "u-a"), generation: 1, transferId: "tr-1" }],
  }));
  assert.equal(linkedOAuthAccountLabel({ clientId: "client-x" }, overlaid), "Carol（carol）");
  const fenced = overlaid.tokens.find((token) => token.id === "t-a");
  assert.equal(fenced.status, "revoked");
  assert.equal(fenced.transferFenced, true);
  assert.equal(fenced.revokedAt, null, "the deny is generation-based, not a persisted revoke");
  assert.equal(raw.tokens.find((token) => token.id === "t-a").status, "active", "the input snapshot is never mutated");
});

test("the unrelated account and the source's other client stay current", () => {
  const raw = snapshot([
    { id: "t-a-x", clientId: "client-x", userId: "u-a", type: "access", status: "active", generation: 0 },
    { id: "t-c-x", clientId: "client-x", userId: "u-c", type: "access", status: "active", generation: 0 },
    { id: "t-a-z", clientId: "client-z", userId: "u-a", type: "access", status: "active", generation: 0 },
  ]);
  const overlaid = applyAuthorizationTransferFence(raw, transferSnapshot({
    generations: [{ key: pairGenerationKey("client-x", "u-a"), generation: 1 }],
  }));
  assert.equal(linkedOAuthAccountLabel({ clientId: "client-x" }, overlaid), "Carol（carol）");
  assert.equal(linkedOAuthAccountLabel({ clientId: "client-z" }, overlaid), "Alice（alice）");
  assert.deepEqual(linkedOAuthAccountsForClient({ clientId: "client-z" }, overlaid).map((account) => account.username), ["alice"]);
});

test("a fresh credential minted at the new generation is current again", () => {
  const raw = snapshot([
    { id: "t-old", clientId: "client-x", userId: "u-a", type: "access", status: "active", generation: 0 },
    { id: "t-new", clientId: "client-x", userId: "u-a", type: "access", status: "active", generation: 1 },
  ]);
  const overlaid = applyAuthorizationTransferFence(raw, transferSnapshot({
    generations: [{ key: pairGenerationKey("client-x", "u-a"), generation: 1 }],
  }));
  assert.equal(linkedOAuthAccountLabel({ clientId: "client-x" }, overlaid), "Alice（alice）");
});

test("an unreadable fence fails closed and withdraws every active grant", () => {
  const raw = snapshot([
    { id: "t-a", clientId: "client-x", userId: "u-a", type: "access", status: "active", generation: 0 },
    { id: "t-c", clientId: "client-y", userId: "u-c", type: "access", status: "active", generation: 0 },
  ]);
  const overlaid = applyAuthorizationTransferFence(raw, transferSnapshot({ healthy: false }));
  assert.equal(linkedOAuthAccountLabel({ clientId: "client-x" }, overlaid), "无有效授权");
  assert.equal(linkedOAuthAccountLabel({ clientId: "client-y" }, overlaid), "无有效授权");
});

// Return fix (seat P1-1): the degraded withdrawal must happen BEFORE the pair check. A
// credential with no usable pair — missing `userId`, or a legacy username-only record — must
// also stop being current while the store is unreadable, because the runtime's
// `evaluateCredentialFence({ degraded: true })` is fenced for ANY credential. The same record
// with a HEALTHY, empty fence stays current, so the withdrawal is tied to `degraded` and not
// to "no pair".
test("an unreadable fence also withdraws a pair-less legacy credential (missing userId, old username)", () => {
  const raw = snapshot([
    { id: "t-legacy", clientId: "client-x", username: "alice", type: "access", status: "active" },
    { id: "t-missing", clientId: "client-y", type: "access", status: "active" },
  ]);
  const overlaid = applyAuthorizationTransferFence(raw, transferSnapshot({ healthy: false }));
  for (const token of overlaid.tokens) {
    assert.equal(token.status, "revoked", `${token.id} must be withdrawn while the fence is unreadable`);
    assert.equal(token.transferFenced, true);
  }
  // Account relation: no client may still show the legacy username as its current account.
  assert.equal(linkedOAuthAccountLabel({ clientId: "client-x" }, overlaid), "无有效授权");
  assert.equal(linkedOAuthAccountLabel({ clientId: "client-y" }, overlaid), "无有效授权");
  assert.deepEqual(linkedOAuthAccountsForClient({ clientId: "client-x" }, overlaid), []);
  // Activity count for the legacy username must drop to zero with the same overlay.
  const alice = users.find((user) => user.username === "alice");
  assert.equal(countOAuthClientsForUser(alice, overlaid), 0);

  // Negative control: a healthy, empty fence leaves the pair-less record untouched.
  const healthy = applyAuthorizationTransferFence(raw, transferSnapshot({ generations: [] }));
  assert.equal(linkedOAuthAccountLabel({ clientId: "client-x" }, healthy), "Alice（alice）");
  assert.equal(countOAuthClientsForUser(alice, healthy), 1);
});

test("an absent or unavailable transfer snapshot leaves the projection untouched", () => {
  const raw = snapshot([{ id: "t-a", clientId: "client-x", userId: "u-a", type: "access", status: "active", generation: 0 }]);
  assert.equal(applyAuthorizationTransferFence(raw, null), raw);
  assert.equal(applyAuthorizationTransferFence(raw, transferSnapshot({ available: false })), raw);
  assert.equal(linkedOAuthAccountLabel({ clientId: "client-x" }, raw), "Alice（alice）");
});

test("loadAdminProjection overlays the fence and returns the committed transfer rows", async () => {
  const raw = snapshot([{ id: "t-a", clientId: "client-x", userId: "u-a", type: "access", status: "active", generation: 0 }]);
  const transfer = { id: "tr-1", clientId: "client-x", sourceUserId: "u-a", targetUserId: "u-b", status: "pending", expiresAt: "2030-01-01T00:00:00.000Z", createdAt: "2026-10-09T00:00:00.000Z" };
  const provider = { authorizationTransferSnapshot: async () => transferSnapshot({ generations: [{ key: pairGenerationKey("client-x", "u-a"), generation: 1 }], transfers: [transfer] }) };
  const projection = await loadAdminProjection(provider, raw, 1);
  assert.equal(linkedOAuthAccountLabel({ clientId: "client-x" }, projection.snapshot), "无有效授权");
  assert.deepEqual(projection.transfers, [transfer]);
  assert.equal(projection.now, 1);
  const absent = await loadAdminProjection({}, raw, 2);
  assert.equal(absent.snapshot, raw);
  assert.deepEqual(absent.transfers, []);
});

test("pending uses the frozen wording, an unpersisted expiry is reported separately", () => {
  const transfer = { id: "tr-1", clientId: "client-x", sourceUserId: "u-a", targetUserId: "u-b", status: "pending", expiresAt: "2026-10-09T00:15:00.000Z", createdAt: "2026-10-09T00:00:00.000Z" };
  const snap = snapshot([]);
  const live = pendingTransferNotice({ clientId: "client-x", snapshot: snap, transfers: [transfer], now: Date.parse("2026-10-09T00:05:00.000Z") });
  assert.match(live, /转移待 Bob 重新授权/);
  assert.equal(isUnpersistedExpiry(transfer, Date.parse("2026-10-09T00:05:00.000Z")), false);

  const expired = pendingTransferNotice({ clientId: "client-x", snapshot: snap, transfers: [transfer], now: Date.parse("2026-10-09T00:20:00.000Z") });
  assert.match(expired, /转移期限已过/);
  assert.match(expired, /尚未落盘/);
  assert.doesNotMatch(expired, /转移待/);
  assert.equal(isUnpersistedExpiry(transfer, Date.parse("2026-10-09T00:20:00.000Z")), true);
  assert.equal(transferAccountLabel(snap, "u-b"), "Bob");
  assert.equal(transferAccountLabel(snap, "u-gone"), "u-gone");
});

// Negative control (must be RED without the overlay): the same snapshot WITHOUT the
// fence input keeps showing the source as the current account, so the assertion above
// ("Alice is no longer current") genuinely depends on the overlay.
test("negative control: without the fence input the fenced account is still current", () => {
  const raw = snapshot([
    { id: "t-a", clientId: "client-x", userId: "u-a", type: "access", status: "active", generation: 0, revokedAt: null },
  ]);
  const fenced = applyAuthorizationTransferFence(raw, transferSnapshot({
    generations: [{ key: pairGenerationKey("client-x", "u-a"), generation: 1 }],
  }));
  assert.equal(linkedOAuthAccountLabel({ clientId: "client-x" }, fenced), "无有效授权");
  assert.equal(linkedOAuthAccountLabel({ clientId: "client-x" }, raw), "Alice（alice）");
  assert.notEqual(
    linkedOAuthAccountLabel({ clientId: "client-x" }, fenced),
    linkedOAuthAccountLabel({ clientId: "client-x" }, raw),
    "the fence overlay must change the projected relation",
  );
});

// Integration with the REAL provider: when the expiry sweep cannot be written the
// committed record stays `pending` (slice 1 proves this), so the projection — not the
// failed sweep — must apply the lazy deadline. It may not claim the expiry landed, and
// it must stop offering the transfer as live.
test("a real provider whose expiry sweep cannot be written still projects the deadline", async (t) => {
  t.after(cleanupHarness);
  let failRename = false;
  const fsModule = {
    mkdir: (...args) => fs.mkdir(...args),
    readFile: (...args) => fs.readFile(...args),
    writeFile: (...args) => fs.writeFile(...args),
    chmod: (...args) => fs.chmod(...args),
    rm: (...args) => fs.rm(...args),
    rename: async (...args) => {
      if (failRename) throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
      return fs.rename(...args);
    },
  };
  const store = createAuthorizationTransferStore({ file: newStoreFile("sweep"), ttlMs: 1, fsModule });
  const { provider } = service({ store });
  await provider.ready;
  await registerClient(provider, "client-ttl");
  const source = await newUser(provider, "ttl-source");
  const target = await newUser(provider, "ttl-target");
  grant(provider, "client-ttl", source.id);
  await provider.beginAuthorizationTransfer({ clientId: "client-ttl", sourceUserId: source.id, targetUserId: target.id });
  await new Promise((resolve) => setTimeout(resolve, 20));

  failRename = true;
  const raw = await provider.authorizationSnapshot();
  const projection = await loadAdminProjection(provider, raw, Date.now());
  assert.equal(projection.transfers[0].status, "pending", "the failed sweep must not publish an expiry");
  assert.equal(store.snapshot().transfers[projection.transfers[0].id].status, "pending");
  const notice = pendingTransferNotice({ clientId: "client-ttl", snapshot: projection.snapshot, transfers: projection.transfers, now: projection.now });
  assert.match(notice, /转移期限已过/);
  assert.match(notice, /尚未落盘/);
  assert.doesNotMatch(notice, /转移待/);
  assert.equal(provider.data.audit.filter((entry) => entry.action === "oauth.client.transfer.expire").length, 0);

  failRename = false;
  const recovered = await loadAdminProjection(provider, raw, Date.now());
  assert.equal(recovered.transfers[0].status, "expired", "a later successful sweep commits the expiry");
  assert.equal(pendingTransferNotice({ clientId: "client-ttl", snapshot: recovered.snapshot, transfers: recovered.transfers, now: recovered.now }), "");
  assert.equal(provider.data.audit.filter((entry) => entry.action === "oauth.client.transfer.expire").length, 1, "the expiry is audited exactly once");
});
