// P2 / Task 19 — the restricted legacy backend and the boundary list.
//
// Contract: design §10 P2 and §6.1. Two properties decide this task:
//
//   1. ONLY `enforce` ANSWERS FROM THE NEW MODEL. In `legacy` and `shadow` mode the runtime
//      delegates to the injected old backend, so a shadow row compares the old algorithm
//      with the new one instead of the new model with itself (design §10 P2: the new verdict
//      never changes a response). In `enforce` mode the backend is not reached at all. Both
//      directions are asserted: an old allow beside a new deny answers the allow, and an old
//      deny beside a new allow answers the deny.
//   2. THE BOUNDARY LIST IS COMPLETE AND CANNOT DRIFT. `LEGACY_BACKEND_BOUNDARIES` is derived
//      from `catalog.js` and partitions every catalog boundary into exactly one of three
//      sets (legacy-backend, trusted context, exempt operation). A new boundary in the
//      catalog therefore cannot be classified silently: the partition test fails first.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { verifiedActor } from "../src/authorization/actors.js";
import { AUTHORIZATION_CATALOG_VERSION, catalogBoundaryKeys } from "../src/authorization/catalog.js";
import { createAuthorizationRuntime } from "../src/authorization/runtime.js";
import { createShadowCandidate, createShadowRecorder } from "../src/authorization/shadow.js";
import {
  EXEMPT_BOUNDARIES,
  LEGACY_BACKEND_BOUNDARIES,
  TRUSTED_BOUNDARIES,
  authorizeLegacy,
} from "../src/authorization/legacy-evaluate.js";

const VAULT = "vault";
const SUBJECT = "api-key:key-1";
const NOW = Date.parse("2026-11-02T03:00:00.000Z");
const APP_ROOT = path.resolve(import.meta.dirname, "..");

const actor = () => verifiedActor("api-key", {
  subjectIds: [SUBJECT], credentialId: "key-1", credentialEpochs: { [SUBJECT]: 0 },
  grantCeiling: null, audience: null, expiresAt: null, revoked: false, transferGeneration: 0, proof: null,
});
const request = () => ({ actor: actor(), capability: "get_note", target: { kind: "vault", vaultId: VAULT }, surface: "mcp" });

/** A counted legacy backend: the old gate's answer, with a call counter. */
function legacyBackend({ allowed = true, reason = "no_matching_policy", mode = null } = {}) {
  const calls = [];
  return {
    calls,
    evaluate(input) {
      calls.push(input?.capability ?? null);
      return { allowed, reason, mode, denyPolicyId: mode ? "policy-1" : null, enforcement: mode === "revoke" ? "transport" : "operation" };
    },
  };
}

function document({ capabilities = ["list_notes"] } = {}) {
  return {
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision: 2,
    timeConstraintsEnabled: false,
    subjects: { [SUBJECT]: { credentialEpoch: 0, grants: [{ target: { kind: "vault", vaultId: VAULT }, capabilities }] } },
    constraints: [],
  };
}

async function runtimeWith({ mode, legacy, shadow = true, capabilities = ["list_notes"] }) {
  const recorder = shadow ? createShadowRecorder({ capacity: 16 }) : null;
  const runtime = createAuthorizationRuntime({
    store: createShadowCandidate({ liveRevision: () => 1, build: () => ({ status: "ready", document: document({ capabilities }) }) }),
    identitySnapshot: () => ({ subjects: { [SUBJECT]: { credentialEpoch: 0, disabled: false } }, sessions: {} }),
    vaultSnapshot: () => ({ [VAULT]: { admitted: true, readOnly: false } }),
    publicationSnapshot: () => null,
    deployment: () => ({ readOnly: false }),
    now: () => NOW,
    mode,
    legacy,
    shadow: recorder,
  });
  await runtime.ready;
  return { runtime, recorder };
}

test("legacy_backend_matches_oracle_with_one_shared_input_snapshot", async () => {
  // 1. `legacy` mode delegates to the backend, and the backend is the decider.
  const allow = legacyBackend({ allowed: true });
  const legacyRun = await runtimeWith({ mode: "legacy", legacy: allow });
  const allowed = legacyRun.runtime.authorize(request());
  assert.equal(allow.calls.length, 1, "legacy mode calls the backend exactly once");
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.code, "allowed");

  const deny = legacyBackend({ allowed: false, reason: "outside_window", mode: "suspend" });
  const denying = await runtimeWith({ mode: "legacy", legacy: deny });
  const refused = denying.runtime.authorize(request());
  assert.equal(deny.calls.length, 1);
  assert.equal(refused.allowed, false);
  assert.equal(refused.code, "outside_authorized_window");
  assert.equal(refused.mode, "suspend");
  assert.equal(refused.denyConstraintId, "policy-1");
  assert.equal(refused.enforcement, "operation");

  const revoking = legacyBackend({ allowed: false, reason: "outside_window", mode: "revoke" });
  const revoked = (await runtimeWith({ mode: "legacy", legacy: revoking })).runtime.authorize(request());
  assert.equal(revoked.enforcement, "transport", "a legacy revoke keeps the transport enforcement");

  // 2a. SHADOW, old allow beside new deny: the response is the old allow. The new model
  //     denies (the document has no `get_note` grant), so a real difference is recorded.
  const untouched = legacyBackend({ allowed: true });
  const shadowRun = await runtimeWith({ mode: "shadow", legacy: untouched });
  const shadowAnswer = shadowRun.runtime.authorize(request());
  assert.equal(untouched.calls.length, 1, "shadow asks the old gate for the answer");
  assert.equal(shadowAnswer.allowed, true, "shadow must answer with the old verdict, never with the new one");
  assert.equal(shadowAnswer.code, "allowed");
  shadowRun.runtime.shadow.compare({ request: request(), legacyDecision: shadowAnswer, boundaryKey: "get_note", phase: "tool" });
  const summary = shadowRun.recorder.summary();
  assert.equal(summary.compared, 1);
  assert.equal(summary.differences, 1, "the old allow beside the new deny is a real difference");
  assert.equal(shadowRun.recorder.rows()[0].oldAllowed, true, "the row carries the old gate's verdict");
  assert.equal(shadowRun.recorder.rows()[0].newAllowed, false, "and the new model's own verdict");

  // 2b. SHADOW, old deny beside new allow: the response is the old deny. Without this
  //     control a runtime that always answers the allow would pass 2a.
  const refusing = legacyBackend({ allowed: false, reason: "outside_window", mode: "suspend" });
  const shadowDeniedRun = await runtimeWith({ mode: "shadow", legacy: refusing, capabilities: ["get_note"] });
  const shadowDenied = shadowDeniedRun.runtime.authorize(request());
  assert.equal(shadowDenied.allowed, false, "an old denial must survive a new allow in shadow mode");
  assert.equal(shadowDenied.code, "outside_authorized_window");

  // 3. ENFORCE: the backend is not reachable at all, and the new model decides both cases.
  const unused = legacyBackend({ allowed: true });
  const enforceRun = await runtimeWith({ mode: "enforce", legacy: unused, shadow: false });
  const enforced = enforceRun.runtime.authorize(request());
  assert.equal(unused.calls.length, 0, "enforce never reaches the legacy backend");
  assert.equal(enforced.allowed, false, "the new model decides in enforce mode");
  assert.equal(enforced.code, "capability_denied");

  // 3b. The other direction: the new model allows where the old gate denies.
  const deniedOld = legacyBackend({ allowed: false, reason: "outside_window", mode: "suspend" });
  const enforcedAllowRun = await runtimeWith({ mode: "enforce", legacy: deniedOld, shadow: false, capabilities: ["get_note"] });
  const enforcedAllow = enforcedAllowRun.runtime.authorize(request());
  assert.equal(deniedOld.calls.length, 0);
  assert.equal(enforcedAllow.allowed, true, "enforce answers the new model even when the old gate denies");

  // 4. A missing backend is a deny, never a guess.
  const empty = await runtimeWith({ mode: "legacy", legacy: null, shadow: false });
  const noBackend = empty.runtime.authorize(request());
  assert.equal(noBackend.allowed, false);
  assert.equal(noBackend.code, "authorization_state_unavailable");
  assert.equal(authorizeLegacy(request(), {}).code, "authorization_state_unavailable");
});

test("the_legacy_branch_still_reaches_the_audit_sink", async () => {
  const audited = [];
  const backend = legacyBackend({ allowed: false, reason: "outside_window", mode: "suspend" });
  const recorder = createShadowRecorder({ capacity: 8 });
  const runtime = createAuthorizationRuntime({
    store: createShadowCandidate({ liveRevision: () => 1, build: () => ({ status: "ready", document: document({ capabilities }) }) }),
    identitySnapshot: () => ({ subjects: { [SUBJECT]: { credentialEpoch: 0, disabled: false } }, sessions: {} }),
    vaultSnapshot: () => ({ [VAULT]: { admitted: true, readOnly: false } }),
    publicationSnapshot: () => null,
    deployment: () => ({ readOnly: false }),
    now: () => NOW,
    mode: "legacy",
    legacy: backend,
    shadow: recorder,
    audit: (decision) => audited.push(decision.code),
  });
  await runtime.ready;
  const decision = runtime.authorize(request());
  assert.equal(decision.code, "outside_authorized_window");
  assert.deepEqual(audited, ["outside_authorized_window"], "a legacy decision reaches the audit sink too");

  // A throwing sink never changes the legacy decision, and it is counted.
  const broken = createAuthorizationRuntime({
    store: createShadowCandidate({ liveRevision: () => 1, build: () => ({ status: "ready", document: document({ capabilities }) }) }),
    identitySnapshot: () => ({ subjects: { [SUBJECT]: { credentialEpoch: 0, disabled: false } }, sessions: {} }),
    vaultSnapshot: () => ({ [VAULT]: { admitted: true, readOnly: false } }),
    publicationSnapshot: () => null,
    deployment: () => ({ readOnly: false }),
    now: () => NOW,
    mode: "legacy",
    legacy: legacyBackend({ allowed: true }),
    shadow: null,
    audit: () => { throw new Error("sink down"); },
  });
  await broken.ready;
  const stillAllowed = broken.authorize(request());
  assert.equal(stillAllowed.allowed, true, "a broken sink never turns an old allow into a deny");
  assert.equal(broken.summary().auditFailures, 1);
});

test("the_boundary_list_partitions_the_catalog_and_cannot_drift", () => {
  const all = [...catalogBoundaryKeys].sort();
  const legacy = [...LEGACY_BACKEND_BOUNDARIES];
  const trusted = [...TRUSTED_BOUNDARIES];
  const exempt = [...EXEMPT_BOUNDARIES];

  // Every catalog boundary sits in exactly one set: a new boundary cannot be silent.
  const partition = [...legacy, ...trusted, ...exempt].sort();
  assert.deepEqual(partition, all, "the three sets must partition the catalog boundaries exactly");
  assert.equal(new Set(partition).size, all.length, "no boundary may appear in two sets");
  assert.equal(legacy.length + trusted.length + exempt.length, all.length);

  // The numbers the catalog produces today, so a change is a deliberate edit. 191 = the 186 rows the
  // catalog held before the per-Vault plan, plus Task 5's five constraint writes and Task 6's
  // `GET /authz` page (Task 7's `POST /authz/subjects` had its own row and lost it with the route),
  // minus the frozen editor's `GET /access-policy/preview` fragment, whose route is gone.
  assert.equal(all.length, 191);
  assert.equal(legacy.length, 129);
  assert.equal(trusted.length, 47);
  assert.equal(exempt.length, 15);
  // The list really contains the boundaries a client can reach the old plane through.
  for (const key of ["get_note", "write_note", "GET /api/web/v1/note", "PUT /uploads/:uploadId", "POST /oauth/token"]) {
    assert.equal(legacy.includes(key), true, `${key} must be a legacy-backend boundary`);
  }
  for (const key of ["ADMIN GET /", "GET /publish/:id", "GET /app", "obsidian://agent/memory-policy"]) {
    assert.equal(legacy.includes(key), false, `${key} must not claim a legacy plane verdict`);
  }
});

test("only_the_runtime_may_import_the_legacy_backend", async () => {
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (entry.name.endsWith(".js")) files.push(full);
    }
  }
  await walk(path.join(APP_ROOT, "src"));
  const importers = [];
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    if (/from\s+["'][^"']*legacy-evaluate\.js["']/.test(source)) importers.push(path.relative(APP_ROOT, file));
  }
  assert.deepEqual(importers, ["src/authorization/runtime.js"], "only the runtime may import the legacy backend");
});
