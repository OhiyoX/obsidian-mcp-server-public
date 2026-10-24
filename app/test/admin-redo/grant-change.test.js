// The 「仅新增授权，不撤销现有会话」 guard. Adding a Vault to an account does not widen what an
// existing token can reach — tokens carry their own allowedVaults snapshot — so revoking every session
// for a pure grant is avoidable. Any removal (or a changed scope set) cannot be expressed by an old
// token and must still revoke.
//
// Context: on 2026-10-21 granting `secondary-vault` to an account revoked all 255 of its tokens
// (52 access / 203 refresh). That was correct per design and forced every client to re-authorize; the
// exit from it was a manual restore of `revokedAt`. This file is the "next time" path.
import test from "node:test";
import assert from "node:assert/strict";

import { decideGrantRevocation, isAdditiveGrantChange, sessionCountsFor } from "../../src/admin/grants.js";

const base = { beforeScopes: ["obsidian.read"], beforeVaults: ["vault"] };

test("adding a Vault is additive, so sessions can be kept", () => {
  assert.equal(isAdditiveGrantChange({ ...base, afterScopes: ["obsidian.read"], afterVaults: ["vault", "secondary-vault"] }), true);
  assert.equal(isAdditiveGrantChange({ ...base, afterScopes: ["obsidian.read", "obsidian.write"], afterVaults: ["vault"] }), true);
  assert.equal(isAdditiveGrantChange({ ...base, afterScopes: ["obsidian.read"], afterVaults: ["vault"] }), true, "an unchanged set is trivially additive");
});

test("removing a Vault or a scope is NOT additive (the old token would keep serving it)", () => {
  assert.equal(isAdditiveGrantChange({ beforeScopes: ["obsidian.read"], beforeVaults: ["vault", "secondary-vault"], afterScopes: ["obsidian.read"], afterVaults: ["vault"] }), false);
  assert.equal(isAdditiveGrantChange({ beforeScopes: ["obsidian.read", "obsidian.write"], beforeVaults: ["vault"], afterScopes: ["obsidian.read"], afterVaults: ["vault"] }), false);
  assert.equal(isAdditiveGrantChange({ beforeScopes: [], beforeVaults: ["vault", "work"], afterScopes: [], afterVaults: [] }), false);
});

test("a swap that keeps the same size still counts as a removal", () => {
  assert.equal(isAdditiveGrantChange({ beforeScopes: ["obsidian.read"], beforeVaults: ["vault"], afterScopes: ["obsidian.read"], afterVaults: ["work"] }), false);
});

test("session counts cover access + refresh and skip revoked records", () => {
  const grants = [
    { items: [
      { userId: "u1", type: "access", status: "active", clientId: "c1" },
      { userId: "u1", type: "refresh", status: "active", clientId: "c1" },
      { userId: "u1", type: "access", status: "revoked", clientId: "c1" },
    ] },
    { items: [
      { userId: "u2", type: "access", status: "active", clientId: "c2" },
      { userId: "u1", type: "refresh", status: "active", clientId: "c3" },
    ] },
  ];
  const counts = sessionCountsFor(grants, "u1");
  assert.deepEqual({ access: counts.access, refresh: counts.refresh, total: counts.total, clients: counts.clients }, { access: 1, refresh: 2, total: 3, clients: 2 });
  assert.equal(sessionCountsFor(grants, "u2").total, 1);
  assert.equal(sessionCountsFor([], "u1").total, 0);
});

test("the save decision: a pure addition keeps sessions automatically, a narrowing always revokes", () => {
  const additive = { beforeScopes: ["obsidian.read"], afterScopes: ["obsidian.read"], beforeVaults: ["vault"], afterVaults: ["vault", "secondary-vault"] };
  const narrowed = { beforeScopes: ["obsidian.read"], afterScopes: ["obsidian.read"], beforeVaults: ["vault", "secondary-vault"], afterVaults: ["vault"] };
  assert.deepEqual(decideGrantRevocation(additive), { keep: true, additive: true, reason: "additive" }, "adding a Vault must not log everyone out");
  assert.deepEqual(decideGrantRevocation(narrowed), { keep: false, additive: false, reason: "narrowed" }, "taking access away must revoke, or old tokens keep serving it");
});
