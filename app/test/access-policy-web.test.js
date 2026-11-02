// AuthZ Wave B / B3 — Web content-plane gate matrix.
//
// Contract: `scratch/authz/INTERFACE.md` §10.3. Deterministic: injected clocks,
// programmable fake runtimes and a real A4 runtime over the shared fixtures.
// No sleeps, no Vault I/O, no credentials.

import assert from "node:assert/strict";
import test from "node:test";

import { createAccessPolicyRuntime } from "../src/access-policy/runtime.js";
import { createWebAccessPolicy } from "../src/app/access-policy.js";
import {
  fakeClock,
  fakeStore,
  policyFixture,
  snapshotFixture,
} from "./helpers/access-policy-fixtures.js";

// Asia/Shanghai (UTC+8): Mon–Fri 09:00–18:00.
//   INSIDE_MS    = Monday 10:00 local (inside)
//   WINDOW_END_MS = Monday 18:00 local (exactly the interval end -> outside,
//                   the frozen weekly interval is `start <= t < end`)
//   OUTSIDE_MS   = Monday 20:00 local (outside)
const INSIDE_MS = Date.parse("2026-10-05T02:00:00.000Z");
const WINDOW_END_MS = Date.parse("2026-10-05T10:00:00.000Z");
const OUTSIDE_MS = Date.parse("2026-10-05T12:00:00.000Z");

const ALLOW = Object.freeze({
  allowed: true, mode: null, reason: "no_matching_policy", denyPolicyId: null, matchedPolicyIds: [],
});
const DENY_SUSPEND = Object.freeze({
  allowed: false, mode: "suspend", reason: "outside_window", denyPolicyId: "policy-suspend", matchedPolicyIds: ["policy-suspend"],
});
const DENY_REVOKE = Object.freeze({
  allowed: false, mode: "revoke", reason: "outside_window", denyPolicyId: "policy-revoke", matchedPolicyIds: ["policy-revoke"],
});
const BROKEN = Object.freeze({
  allowed: false, mode: null, reason: "policy_unavailable", denyPolicyId: null, matchedPolicyIds: [],
});

function fakeRuntime({ status = "ready", decision = ALLOW, explain = { nextAllowedAt: null }, auditThrows = false } = {}) {
  const calls = { evaluate: [], explain: [], audit: [] };
  return {
    status,
    calls,
    evaluate(input) {
      calls.evaluate.push(input);
      return decision;
    },
    explain(input) {
      calls.explain.push(input);
      return explain;
    },
    audit(event) {
      calls.audit.push(event);
      if (auditThrows) throw new Error("audit sink down");
    },
  };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

/** Invoke one middleware and record whether `next` was reached. */
function invoke(middleware, req = {}) {
  const res = makeRes();
  let nextCalled = 0;
  let nextError = null;
  middleware(req, res, (error) => {
    nextCalled += 1;
    if (error) nextError = error;
  });
  return { res, nextCalled, nextError };
}

/** Run an ordered middleware chain (caller-order fixture, no Express needed). */
function runChain(middlewares, req) {
  const res = makeRes();
  let index = -1;
  const next = (error) => {
    if (error) throw error;
    index += 1;
    if (index < middlewares.length) middlewares[index](req, res, next);
  };
  next();
  return res;
}

function session(overrides = {}) {
  return {
    id: "web-session-1",
    userId: "u1",
    vaultId: "vault-1",
    allowedVaults: ["vault-1"],
    csrf: "csrf-token",
    ...overrides,
  };
}

/** Faithful fixture of `manager.requireCsrf` (web-session-resolve.js). */
function requireCsrf(req, res, next) {
  const supplied = req.get?.("X-CSRF-Token");
  if (!supplied || supplied !== req.webSession.csrf) return res.status(403).json({ error: "CSRF validation failed" });
  return next();
}

function realRuntime({ mode = "suspend", capabilities = ["scope:obsidian.read"], startMs = INSIDE_MS } = {}) {
  const clock = fakeClock(startMs);
  const store = fakeStore({
    snapshot: snapshotFixture({ policies: [policyFixture({ mode, capabilities })] }),
  });
  const runtime = createAccessPolicyRuntime({ enabled: true, store, now: () => clock.now() });
  return { runtime, clock };
}

test("webCapabilities are frozen route-class instances", () => {
  const policy = createWebAccessPolicy({ runtime: fakeRuntime() });
  assert.deepEqual(policy.webCapabilities.read, ["all", "surface:web", "scope:obsidian.read"]);
  assert.deepEqual(policy.webCapabilities.write, ["all", "surface:web", "scope:obsidian.read", "scope:obsidian.write"]);
  assert.deepEqual(policy.webCapabilities.files, ["all", "surface:web", "scope:obsidian.read", "scope:obsidian.files"]);
  assert.deepEqual(policy.webCapabilities.metadata, []);
  assert.ok(Object.isFrozen(policy.webCapabilities));
  assert.ok(Object.isFrozen(policy.webCapabilities.read));
  assert.throws(() => createWebAccessPolicy({}), /requires an access-policy runtime/);
});

for (const [name, capabilities] of [
  ["requireWebRead", ["all", "surface:web", "scope:obsidian.read"]],
  ["requireWebWrite", ["all", "surface:web", "scope:obsidian.read", "scope:obsidian.write"]],
  ["requireWebFiles", ["all", "surface:web", "scope:obsidian.read", "scope:obsidian.files"]],
]) {
  test(`${name}: allow evaluates the exact route capabilities and continues`, () => {
    const runtime = fakeRuntime();
    const policy = createWebAccessPolicy({ runtime });
    const { res, nextCalled, nextError } = invoke(policy[name], { webSession: session() });
    assert.equal(nextCalled, 1);
    assert.equal(nextError, null);
    assert.equal(res.statusCode, null);
    assert.equal(runtime.calls.evaluate.length, 1);
    assert.deepEqual(runtime.calls.evaluate[0].subjects, ["oauth-user:u1"]);
    assert.deepEqual(runtime.calls.evaluate[0].capabilities, capabilities);
    assert.equal(runtime.calls.audit.length, 0);
    assert.equal(runtime.calls.explain.length, 0);
  });

  test(`${name}: suspend deny is a verbatim 403 and never calls next`, () => {
    const runtime = fakeRuntime({
      decision: DENY_SUSPEND,
      explain: { nextAllowedAt: "2026-10-06T01:00:00.000Z" },
    });
    const policy = createWebAccessPolicy({ runtime });
    const { res, nextCalled } = invoke(policy[name], { webSession: session() });
    assert.equal(nextCalled, 0);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, {
      error: "outside_authorized_window",
      mode: "suspend",
      policyId: "policy-suspend",
      nextAllowedAt: "2026-10-06T01:00:00.000Z",
    });
    assert.deepEqual(Object.keys(res.body).sort(), ["error", "mode", "nextAllowedAt", "policyId"]);
    // No Vault/secret field may leak into the denial.
    const wire = JSON.stringify(res.body);
    for (const forbidden of ["vault", "Vault", "path", "title", "revision", "token", "secret", "u1"]) {
      assert.ok(!wire.includes(forbidden), `deny body leaked ${forbidden}: ${wire}`);
    }
    assert.equal(runtime.calls.explain.length, 1);
    assert.equal(runtime.calls.audit.length, 1);
    assert.deepEqual(runtime.calls.audit[0], {
      action: "authz.deny",
      outcome: "failure",
      surface: "web",
      mode: "suspend",
      policyId: "policy-suspend",
      capabilities,
      nextAllowedAt: "2026-10-06T01:00:00.000Z",
    });
  });

  test(`${name}: revoke deny keeps the same 403 shape (Web never drops the session)`, () => {
    const runtime = fakeRuntime({ decision: DENY_REVOKE });
    const policy = createWebAccessPolicy({ runtime });
    const { res, nextCalled } = invoke(policy[name], { webSession: session() });
    assert.equal(nextCalled, 0);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, {
      error: "outside_authorized_window",
      mode: "revoke",
      policyId: "policy-revoke",
      nextAllowedAt: null,
    });
  });

  test(`${name}: broken policy plane fails closed with a verbatim 503`, () => {
    const runtime = fakeRuntime({ decision: BROKEN });
    const policy = createWebAccessPolicy({ runtime });
    const { res, nextCalled } = invoke(policy[name], { webSession: session() });
    assert.equal(nextCalled, 0);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: "authorization_policy_unavailable" });
    assert.deepEqual(Object.keys(res.body), ["error"]);
    assert.equal(runtime.calls.explain.length, 0);
    assert.deepEqual(runtime.calls.audit[0], {
      action: "authz.deny",
      outcome: "failure",
      surface: "web",
      mode: null,
      policyId: null,
      capabilities,
    });
  });

  test(`${name}: disabled runtime is zero-difference (next, no evaluate, no audit)`, () => {
    const runtime = fakeRuntime({ status: "disabled", decision: DENY_SUSPEND });
    const policy = createWebAccessPolicy({ runtime });
    const { res, nextCalled } = invoke(policy[name], { webSession: session() });
    assert.equal(nextCalled, 1);
    assert.equal(res.statusCode, null);
    assert.equal(runtime.calls.evaluate.length, 0);
    assert.equal(runtime.calls.audit.length, 0);
  });

  test(`${name}: a missing or subject-less web session fails closed`, () => {
    const runtime = fakeRuntime({ decision: ALLOW });
    const policy = createWebAccessPolicy({ runtime });
    for (const req of [{}, { webSession: null }, { webSession: {} }]) {
      const { res, nextCalled } = invoke(policy[name], req);
      assert.equal(nextCalled, 0);
      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.body, { error: "authorization_policy_unavailable" });
    }
  });

  test(`${name}: an evaluator exception fails closed (503, no next)`, () => {
    const runtime = fakeRuntime();
    runtime.evaluate = () => {
      throw new Error("snapshot exploded");
    };
    const policy = createWebAccessPolicy({ runtime });
    const { res, nextCalled } = invoke(policy[name], { webSession: session() });
    assert.equal(nextCalled, 0);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: "authorization_policy_unavailable" });
  });

  test(`${name}: an audit-sink failure never flips a deny into an allow`, () => {
    const runtime = fakeRuntime({ decision: DENY_SUSPEND, auditThrows: true });
    const policy = createWebAccessPolicy({ runtime });
    const { res, nextCalled } = invoke(policy[name], { webSession: session() });
    assert.equal(nextCalled, 0);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, "outside_authorized_window");
  });
}

test("requireWebMetadata never evaluates, in any runtime state", () => {
  for (const runtime of [
    fakeRuntime({ decision: DENY_REVOKE }),
    fakeRuntime({ status: "disabled" }),
    fakeRuntime({ decision: BROKEN }),
  ]) {
    const policy = createWebAccessPolicy({ runtime });
    const { res, nextCalled, nextError } = invoke(policy.requireWebMetadata, { webSession: session() });
    assert.equal(nextCalled, 1);
    assert.equal(nextError, null);
    assert.equal(res.statusCode, null);
    assert.equal(runtime.calls.evaluate.length, 0);
    assert.equal(runtime.calls.audit.length, 0);
  }
});

test("gate precedes content: a denied route never reaches the vault handler", () => {
  const runtime = fakeRuntime({ decision: DENY_SUSPEND });
  const policy = createWebAccessPolicy({ runtime });
  const vaultSpy = { stats: 0, reads: 0, cache: 0 };
  const contentHandler = () => {
    vaultSpy.stats += 1;
    vaultSpy.reads += 1;
    vaultSpy.cache += 1;
  };
  const res = runChain([policy.requireWebRead, contentHandler], { webSession: session() });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(vaultSpy, { stats: 0, reads: 0, cache: 0 });

  // The same chain with an allow decision does reach the handler.
  const allowed = createWebAccessPolicy({ runtime: fakeRuntime() });
  const res2 = runChain([allowed.requireWebRead, contentHandler], { webSession: session() });
  assert.equal(res2.statusCode, null);
  assert.deepEqual(vaultSpy, { stats: 1, reads: 1, cache: 1 });
});

test("CSRF ordering is not weakened: invalid CSRF never reaches the authz gate", () => {
  const runtime = fakeRuntime({ decision: DENY_SUSPEND });
  const policy = createWebAccessPolicy({ runtime });
  let handlerCalls = 0;
  const handler = () => { handlerCalls += 1; };
  const req = { webSession: session(), get: () => undefined };

  const invalid = runChain([requireCsrf, policy.requireWebWrite, handler], req);
  assert.equal(invalid.statusCode, 403);
  assert.deepEqual(invalid.body, { error: "CSRF validation failed" });
  assert.equal(runtime.calls.evaluate.length, 0, "authz gate must not run when CSRF already failed");
  assert.equal(handlerCalls, 0);

  // Valid CSRF + outside window -> the authz deny, still before the handler.
  const validReq = { webSession: session(), get: () => "csrf-token" };
  const denied = runChain([requireCsrf, policy.requireWebWrite, handler], validReq);
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(denied.body, {
    error: "outside_authorized_window",
    mode: "suspend",
    policyId: "policy-suspend",
    nextAllowedAt: null,
  });
  assert.equal(runtime.calls.evaluate.length, 1);
  assert.equal(handlerCalls, 0);

  // Valid CSRF + inside window -> the handler runs.
  const allowed = createWebAccessPolicy({ runtime: fakeRuntime() });
  const okReq = { webSession: session(), get: () => "csrf-token" };
  const ok = runChain([requireCsrf, allowed.requireWebWrite, handler], okReq);
  assert.equal(ok.statusCode, null);
  assert.equal(handlerCalls, 1);
});

test("revalidateWebRead: null session, subject-less session and disabled runtime", () => {
  const runtime = fakeRuntime();
  const policy = createWebAccessPolicy({ runtime });
  assert.equal(policy.revalidateWebRead({}), null);
  assert.equal(policy.revalidateWebRead({ webSession: null }), null);
  assert.equal(policy.revalidateWebRead({ webSession: {} }), null);
  assert.equal(runtime.calls.evaluate.length, 0);

  const disabled = createWebAccessPolicy({ runtime: fakeRuntime({ status: "disabled", decision: DENY_SUSPEND }) });
  const live = session();
  assert.equal(disabled.revalidateWebRead({ webSession: live }), live);
});

test("revalidateWebRead: allow keeps the session, suspend/revoke/broken close it", () => {
  const allowRuntime = fakeRuntime();
  const allowPolicy = createWebAccessPolicy({ runtime: allowRuntime });
  const live = session();
  assert.equal(allowPolicy.revalidateWebRead({ webSession: live }), live);
  assert.equal(allowRuntime.calls.evaluate.length, 1);
  assert.deepEqual(allowRuntime.calls.evaluate[0].capabilities, ["all", "surface:web", "scope:obsidian.read"]);
  assert.equal(allowRuntime.calls.audit.length, 0);

  for (const [decision, expectedAudit] of [
    [DENY_SUSPEND, { mode: "suspend", policyId: "policy-suspend" }],
    [DENY_REVOKE, { mode: "revoke", policyId: "policy-revoke" }],
    [BROKEN, { mode: null, policyId: null }],
  ]) {
    const runtime = fakeRuntime({ decision });
    const policy = createWebAccessPolicy({ runtime });
    assert.equal(policy.revalidateWebRead({ webSession: session() }), null);
    assert.equal(runtime.calls.audit.length, 1);
    assert.equal(runtime.calls.audit[0].action, "authz.deny");
    assert.equal(runtime.calls.audit[0].surface, "web");
    assert.equal(runtime.calls.audit[0].mode, expectedAudit.mode);
    assert.equal(runtime.calls.audit[0].policyId, expectedAudit.policyId);
  }
});

test("revalidateWebRead: an explicit freshly-resolved session wins over req.webSession", () => {
  const runtime = fakeRuntime({ decision: DENY_SUSPEND });
  const policy = createWebAccessPolicy({ runtime });
  const fresh = session({ userId: "u1" });
  assert.equal(policy.revalidateWebRead({ webSession: null }, fresh), null); // window deny
  assert.deepEqual(runtime.calls.evaluate[0].subjects, ["oauth-user:u1"]);
});

test("revalidateWebRead: evaluator exception fails closed", () => {
  const runtime = fakeRuntime();
  runtime.evaluate = () => { throw new Error("boom"); };
  const policy = createWebAccessPolicy({ runtime });
  assert.equal(policy.revalidateWebRead({ webSession: session() }), null);
});

test("real A4 runtime composition: window boundary on a real policy", async () => {
  const { runtime, clock } = realRuntime({ mode: "suspend" });
  await runtime.ready;
  assert.equal(runtime.status, "ready");
  const policy = createWebAccessPolicy({ runtime });

  const inside = invoke(policy.requireWebRead, { webSession: session() });
  assert.equal(inside.nextCalled, 1);

  clock.set(WINDOW_END_MS); // exactly the interval end -> outside
  const denied = invoke(policy.requireWebRead, { webSession: session() });
  assert.equal(denied.nextCalled, 0);
  assert.equal(denied.res.statusCode, 403);
  assert.equal(denied.res.body.error, "outside_authorized_window");
  assert.equal(denied.res.body.mode, "suspend");
  assert.equal(typeof denied.res.body.policyId, "string");
  assert.ok(denied.res.body.nextAllowedAt, "nextAllowedAt must be a real ISO instant");

  // SSE revalidation uses the same read decision.
  assert.equal(policy.revalidateWebRead({ webSession: session() }), null);
  clock.set(INSIDE_MS);
  assert.ok(policy.revalidateWebRead({ webSession: session() }));
});

test("real A4 runtime composition: route capabilities select the matching policy", async () => {
  const { runtime } = realRuntime({ mode: "suspend", capabilities: ["scope:obsidian.write"], startMs: OUTSIDE_MS });
  await runtime.ready;
  const policy = createWebAccessPolicy({ runtime });

  // A write-only policy cannot match the read route class...
  const read = invoke(policy.requireWebRead, { webSession: session() });
  assert.equal(read.nextCalled, 1);
  // ...but denies the write route class.
  const write = invoke(policy.requireWebWrite, { webSession: session() });
  assert.equal(write.nextCalled, 0);
  assert.equal(write.res.statusCode, 403);
  assert.equal(write.res.body.mode, "suspend");
});

test("real A4 runtime composition: broken store fails closed with 503", async () => {
  const clock = fakeClock(INSIDE_MS);
  const store = fakeStore({ snapshot: snapshotFixture({ status: "broken" }), ready: { ok: false, status: "broken", revision: null } });
  const runtime = createAccessPolicyRuntime({ enabled: true, store, now: () => clock.now() });
  await runtime.ready;
  assert.equal(runtime.status, "broken");
  const policy = createWebAccessPolicy({ runtime });

  const { res, nextCalled } = invoke(policy.requireWebRead, { webSession: session() });
  assert.equal(nextCalled, 0);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "authorization_policy_unavailable" });
  assert.equal(policy.revalidateWebRead({ webSession: session() }), null);
});

test("real A4 runtime composition: disabled runtime is zero-difference", async () => {
  const runtime = createAccessPolicyRuntime({ enabled: false, store: null });
  await runtime.ready;
  assert.equal(runtime.status, "disabled");
  const policy = createWebAccessPolicy({ runtime });
  const live = session();
  for (const helper of [policy.requireWebRead, policy.requireWebWrite, policy.requireWebFiles]) {
    const { nextCalled, res } = invoke(helper, { webSession: live });
    assert.equal(nextCalled, 1);
    assert.equal(res.statusCode, null);
  }
  assert.equal(policy.revalidateWebRead({ webSession: live }), live);
});
