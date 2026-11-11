// P2 / Task 9 — the shadow comparison and its bounded difference record.
//
// Contract: design §6.1 (the old verdict is the execution authority), §10 step 5
// (one row per request with the same instant, the same source revision and the
// same target; a pair that cannot be tied to one snapshot is `inconclusive`, never
// a match; only the whitelisted metadata is kept) and §11.2 (a comparator that
// accepts a dropped field, an empty row, a flipped boolean or an unknown result as
// `false` must fail).
//
// These tests run a small transport double: the old verdict decides the status,
// the bytes and whether the handler runs. The shadow comparison is inserted next
// to it, so any influence on the answer is visible as a changed status, byte count
// or handler count.

import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { verifiedActor } from "../src/authorization/actors.js";
import { AUTHORIZATION_CATALOG_VERSION } from "../src/authorization/catalog.js";
import { AUTHORIZATION_DECISION_CODES } from "../src/authorization/evaluate.js";
import { createAuthorizationRuntime } from "../src/authorization/runtime.js";
import {
  AUTHORIZATION_SHADOW_ROW_KEYS,
  createShadowCandidate,
  createShadowRecorder,
  currentShadowRequestId,
  observeAuthorization,
  shadowSummary,
  withShadowRequest,
} from "../src/authorization/shadow.js";

const { ALLOWED, CAPABILITY_DENIED, OUTSIDE_WINDOW, STATE_UNAVAILABLE } = AUTHORIZATION_DECISION_CODES;
const VAULT = "example-vault";
const SUBJECT = "api-key:key-1";
const NOW = Date.parse("2026-11-02T03:00:00.000Z");
const DATA_ROOT = process.env.DATA_PATH;

function candidateDocument({ grants = [{ target: { kind: "vault", vaultId: VAULT }, capabilities: ["get_note"] }] } = {}) {
  return {
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision: 4,
    timeConstraintsEnabled: false,
    subjects: { [SUBJECT]: { credentialEpoch: 0, grants } },
    constraints: [],
  };
}

const identityState = () => ({ subjects: { [SUBJECT]: { credentialEpoch: 0 } }, sessions: {} });
const vaultState = () => ({ [VAULT]: { admitted: true, readOnly: false } });

/** The request both algorithms receive: one actor, one capability, one target. */
function authorizationRequest() {
  return {
    actor: verifiedActor("api-key", {
      subjectIds: [SUBJECT],
      credentialId: "key-1",
      credentialEpochs: { [SUBJECT]: 0 },
      grantCeiling: null,
      audience: null,
      expiresAt: null,
      revoked: false,
      transferGeneration: 0,
      proof: null,
    }),
    capability: "get_note",
    target: { kind: "vault", vaultId: VAULT },
    surface: "mcp",
  };
}

/** A candidate built in memory from a "frozen legacy state" at one revision. */
function candidateAt(startRevision = 1, { fail = null } = {}) {
  const builds = [];
  const state = { sourceRevision: startRevision, document: candidateDocument() };
  const candidate = createShadowCandidate({
    liveRevision: () => state.sourceRevision,
    build: (sourceRevision) => {
      builds.push(sourceRevision);
      if (typeof fail === "function") fail(sourceRevision);
      return { status: "ready", document: { ...state.document, revision: 4 + sourceRevision } };
    },
  });
  return { candidate, builds, state };
}

async function runtimeWith({ mode = "shadow", document = candidateDocument(), candidate = null, now = () => NOW, sink = null, capacity = 64 } = {}) {
  const store = candidate ?? createShadowCandidate({ liveRevision: () => 1, build: () => ({ status: "ready", document }) });
  const recorder = createShadowRecorder({ capacity, sink });
  const runtime = createAuthorizationRuntime({
    store,
    identitySnapshot: identityState,
    vaultSnapshot: vaultState,
    publicationSnapshot: () => null,
    deployment: () => ({ readOnly: false }),
    now,
    mode,
    shadow: recorder,
  });
  await runtime.ready;
  return { runtime, recorder };
}

/**
 * The transport double: the OLD verdict alone decides the status, the body, the
 * byte count and whether the handler runs. The shadow call sits exactly where the
 * real adapters will place it — after the old gate, before the handler — and it
 * receives the same request object.
 */
function transport(runtime) {
  const seen = { handlerCalls: 0, bytes: 0, usage: { calls: 0 } };
  function serve(request, legacyDecision) {
    runtime.shadow?.compare?.({ request, legacyDecision, boundaryKey: "get_note", phase: "tool" });
    seen.usage.calls += 1;
    if (legacyDecision.allowed !== true) {
      const body = JSON.stringify({ error: legacyDecision.code });
      seen.bytes += Buffer.byteLength(body);
      return { status: legacyDecision.enforcement === "transport" ? 401 : 403, body };
    }
    seen.handlerCalls += 1;
    const body = JSON.stringify({ content: [{ type: "text", text: "note body" }] });
    seen.bytes += Buffer.byteLength(body);
    return { status: 200, body };
  }
  return { serve, seen };
}

test("shadow_mismatch_changes_no_response_handler_usage_or_state", async () => {
  // Case A: the old gate denies and the new model allows.
  const allowing = await runtimeWith({});
  const shadowOff = await runtimeWith({ mode: "legacy" });
  const legacyDeny = { allowed: false, code: "insufficient_scope", enforcement: "transport" };
  const requestA = authorizationRequest();
  const withoutShadowA = transport(shadowOff.runtime).serve(requestA, legacyDeny);
  const servedA = transport(allowing.runtime);
  const mismatchA = servedA.serve(requestA, legacyDeny);
  assert.deepEqual(mismatchA, withoutShadowA, "a new-allow beside an old-deny changes no response");
  assert.equal(servedA.seen.handlerCalls, 0, "the handler runs only for the old allow");
  const rowA = allowing.recorder.rows()[0];
  assert.equal(rowA.oldAllowed, false);
  assert.equal(rowA.newAllowed, true);
  assert.equal(allowing.recorder.summary().differences, 1);

  // Case B: the old gate allows and the new model denies (narrowed candidate).
  const narrowing = await runtimeWith({ document: candidateDocument({ grants: [] }) });
  const legacyAllow = { allowed: true, code: ALLOWED, enforcement: "operation" };
  const requestB = authorizationRequest();
  const withoutShadowB = transport(shadowOff.runtime).serve(requestB, legacyAllow);
  const servedB = transport(narrowing.runtime);
  const mismatchB = servedB.serve(requestB, legacyAllow);
  assert.deepEqual(mismatchB, withoutShadowB, "a new-deny beside an old-allow changes no response");
  assert.equal(servedB.seen.handlerCalls, 1, "exactly one handler run, driven by the old verdict");
  assert.equal(servedB.seen.bytes, Buffer.byteLength(withoutShadowB.body));
  assert.equal(narrowing.recorder.rows()[0].oldAllowed, true);
  assert.equal(narrowing.recorder.rows()[0].newAllowed, false);

  // A throwing sink changes no answer either.
  const throwing = await runtimeWith({ sink: () => { throw new Error("sink broke"); } });
  const servedThrowing = transport(throwing.runtime);
  assert.deepEqual(servedThrowing.serve(authorizationRequest(), legacyDeny), withoutShadowA);
  assert.equal(servedThrowing.seen.handlerCalls, 0);
  assert.equal(throwing.recorder.summary().sinkFailures, 1);

  // The comparison returns nothing a transport could enforce, and no state moves.
  assert.equal(throwing.runtime.shadow.compare({ request: authorizationRequest(), legacyDecision: legacyDeny, boundaryKey: "get_note", phase: "tool" }), undefined);
  assert.equal(allowing.runtime.snapshot().revision, 4);

  // The record holds no path, body or credential.
  const text = JSON.stringify(allowing.recorder.rows());
  for (const leak of ["/vault/", "note body", "Bearer", SUBJECT, VAULT]) {
    // `targetKind` says "vault"; the Vault id itself is never stored.
    assert.equal(text.includes(leak), false, `the row must not carry ${leak}`);
  }
});

test("an_incomparable_pair_is_inconclusive_and_never_agreement", async () => {
  const recorder = createShadowRecorder({ capacity: 16 });
  const row = { requestId: "req-1", surface: "mcp", capability: "get_note", targetKind: "vault", oldCode: ALLOWED, newCode: ALLOWED, sourceRevision: 1, newRevision: 1 };
  // Missing verdicts, unknown results and empty rows are never a match.
  recorder.observe({ ...row, oldAllowed: undefined, newAllowed: true });
  recorder.observe({ ...row, oldAllowed: true, newAllowed: null });
  recorder.observe({ ...row, oldAllowed: "false", newAllowed: false });
  recorder.observe({ ...row, oldAllowed: true, newAllowed: true, oldCode: undefined });
  recorder.observe({});
  recorder.observe(null);
  recorder.observe({ ...row, comparable: false, oldAllowed: true, newAllowed: true });
  assert.deepEqual(recorder.summary(), {
    compared: 7,
    matches: 0,
    differences: 0,
    inconclusive: 7,
    coveredBoundaryKeys: [],
    capacity: 16,
    dropped: 0,
    sinkFailures: 0,
    pendingScopes: 0,
  });

  // Both directions of a real mismatch are differences, and a different error
  // family is a difference even when both sides deny.
  recorder.observe({ ...row, boundaryKey: "get_note", oldAllowed: true, newAllowed: false, newCode: CAPABILITY_DENIED });
  recorder.observe({ ...row, boundaryKey: "get_note", oldAllowed: false, newAllowed: false, oldCode: "insufficient_scope" });
  recorder.observe({ ...row, boundaryKey: "get_note", oldAllowed: true, newAllowed: true });
  const summary = recorder.summary();
  assert.equal(summary.differences, 2);
  assert.equal(summary.matches, 1);
  assert.equal(summary.inconclusive, 7);
  assert.deepEqual(summary.coveredBoundaryKeys, ["get_note"]);

  // A runtime that cannot answer (bad clock) records inconclusive, never a
  // deny-as-match and never a difference invented from a non-answer.
  const badClock = await runtimeWith({ now: () => Number.NaN });
  badClock.runtime.shadow.compare({ request: authorizationRequest(), legacyDecision: { allowed: true, code: ALLOWED }, boundaryKey: "get_note", phase: "tool" });
  assert.equal(badClock.recorder.summary().inconclusive, 1);
  assert.equal(badClock.recorder.summary().matches, 0);
  assert.equal(badClock.recorder.summary().differences, 0);
});

test("the_record_is_bounded_and_carries_only_the_whitelist", async () => {
  const recorder = createShadowRecorder({ capacity: 4 });
  const pair = {
    requestId: "req-9",
    surface: "mcp",
    capability: "write_note",
    targetKind: "vault",
    boundaryKey: "write_note",
    oldAllowed: true,
    newAllowed: true,
    oldCode: ALLOWED,
    newCode: ALLOWED,
    sourceRevision: 7,
    newRevision: 4,
    // Everything below is request material and must never be stored.
    vaultId: "example-vault",
    path: "/vault/secret/note.md",
    body: { text: "note body" },
    token: "obmcp_secret",
    subjectIds: [SUBJECT],
    nowMs: NOW,
  };
  for (let index = 0; index < 10; index += 1) recorder.observe(pair);
  const summary = recorder.summary();
  assert.equal(summary.compared, 10);
  assert.equal(summary.matches, 10);
  assert.equal(summary.dropped, 6, "the record cannot grow without limit");
  const expectedKeys = [...AUTHORIZATION_SHADOW_ROW_KEYS].sort();
  for (const entry of recorder.rows()) assert.deepEqual(Object.keys(entry).sort(), expectedKeys);
  assert.equal(recorder.rows().length, 4);
  const text = JSON.stringify(recorder.rows());
  for (const leak of ["example-vault", "/vault/secret/note.md", "note body", "obmcp_secret", SUBJECT]) {
    assert.equal(text.includes(leak), false, `the bounded record must not carry ${leak}`);
  }
  assert.ok(Object.isFrozen(recorder.rows()[0]), "a stored row is immutable");

  // The sink is optional; a row is still exactly one whitelisted record.
  assert.equal(shadowSummary().compared, 0);
  assert.equal(shadowSummary(recorder).matches, 10);
  const sink = [];
  assert.equal(observeAuthorization(pair, (entry) => sink.push(entry)), undefined, "the observer returns nothing to enforce");
  assert.equal(sink.length, 1, "observeAuthorization writes exactly one row");
  assert.deepEqual(Object.keys(sink[0]).sort(), expectedKeys);
});

test("the_candidate_is_rebuilt_when_the_legacy_revision_moves_and_a_failed_build_denies", async () => {
  const { candidate, builds, state } = candidateAt(1);
  const recorder = createShadowRecorder({ capacity: 8 });
  const runtime = createAuthorizationRuntime({
    store: candidate,
    identitySnapshot: identityState,
    vaultSnapshot: vaultState,
    publicationSnapshot: () => null,
    deployment: () => ({ readOnly: false }),
    now: () => NOW,
    mode: "shadow",
    shadow: recorder,
  });
  await runtime.ready;
  const legacyAllow = { allowed: true, code: ALLOWED, enforcement: "operation" };
  runtime.shadow.compare({ request: authorizationRequest(), legacyDecision: legacyAllow, boundaryKey: "get_note", phase: "tool" });
  assert.deepEqual(builds, [1]);
  assert.equal(recorder.rows()[0].sourceRevision, 1);
  assert.equal(recorder.summary().matches, 1, "old allow and new allow agree");

  state.sourceRevision = 2;
  runtime.shadow.compare({ request: authorizationRequest(), legacyDecision: legacyAllow, boundaryKey: "get_note", phase: "tool" });
  assert.deepEqual(builds, [1, 2], "a moved legacy revision rebuilds the in-memory candidate");
  assert.equal(recorder.rows()[1].sourceRevision, 2);

  // A candidate that cannot be built denies (it never allows) and the old answer stands.
  const broken = candidateAt(3, { fail: () => { throw new Error("migration HOLD"); } });
  const brokenRecorder = createShadowRecorder({ capacity: 8 });
  const brokenRuntime = createAuthorizationRuntime({
    store: broken.candidate,
    identitySnapshot: identityState,
    vaultSnapshot: vaultState,
    publicationSnapshot: () => null,
    deployment: () => ({ readOnly: false }),
    now: () => NOW,
    mode: "shadow",
    shadow: brokenRecorder,
  });
  await brokenRuntime.ready;
  const served = transport(brokenRuntime);
  const answer = served.serve(authorizationRequest(), legacyAllow);
  assert.equal(answer.status, 200);
  assert.equal(served.seen.handlerCalls, 1);
  assert.equal(brokenRecorder.rows()[0].newAllowed, false);
  assert.equal(brokenRecorder.rows()[0].newCode, STATE_UNAVAILABLE);
  assert.equal(brokenRecorder.summary().differences, 1);
  assert.equal(broken.candidate.snapshot().status, "broken");
});

test("the_record_is_bounded_by_its_capacity_not_by_the_traffic", async () => {
  assert.equal(typeof DATA_ROOT, "string", "DATA_PATH must point at the isolated test root");
  await mkdir(DATA_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(DATA_ROOT, "shadow-"));
  const recorder = createShadowRecorder({ capacity: 3 });
  for (const boundaryKey of ["get_note", "obsidian://vault/index", "get_note", "no_such_tool"]) {
    recorder.observe({
      requestId: `req-${boundaryKey}`,
      boundaryKey,
      surface: "mcp",
      capability: boundaryKey === "obsidian://vault/index" ? "vault_index_read" : boundaryKey,
      targetKind: "vault",
      oldAllowed: true,
      newAllowed: true,
      oldCode: ALLOWED,
      newCode: ALLOWED,
      sourceRevision: 1,
      newRevision: 1,
    });
  }
  // Coverage is a set of boundary keys, not a per-request list, so unknown tools
  // and repeats cannot grow the record.
  assert.deepEqual(recorder.summary().coveredBoundaryKeys, ["get_note", "no_such_tool", "obsidian://vault/index"]);
  assert.equal(recorder.summary().compared, 4);
  assert.equal(recorder.rows().length, 3);
  assert.equal(root.length > 0, true);
});

/**
 * One authorization unit, answered by several layers. The recorder must emit ONE row
 * and take the old answer from the layer that decided — not from a layer that merely
 * ran before it.
 */
function layers(recorder, entries, requestId = "req-aggregate") {
  const scope = recorder.begin({ requestId });
  withShadowRequest(scope, () => {
    for (const entry of entries) recorder.record({ surface: "mcp", capability: "get_note", targetKind: "vault", ...entry });
  });
  scope.end();
  return scope;
}

const layer = (phase, boundary, legacyAllowed, legacyCode, newAllowed, newCode) => ({
  phase, boundary, legacyAllowed, legacyCode, newAllowed, newCode, sourceRevision: 1, newRevision: 2,
});

test("one_authorization_unit_with_three_layers_records_exactly_one_row", async () => {
  const recorder = createShadowRecorder({ capacity: 8 });
  layers(recorder, [
    layer("transport", "GET /api/web/v1/note", true, ALLOWED, true, ALLOWED),
    layer("tool", "get_note", true, ALLOWED, true, ALLOWED),
    layer("vault-scope", "get_note", true, ALLOWED, true, ALLOWED),
  ]);
  assert.equal(recorder.summary().compared, 1, "one unit, one row");
  assert.equal(recorder.summary().matches, 1);
  assert.equal(recorder.summary().differences, 0);
  assert.equal(recorder.rows()[0].requestId, "req-aggregate");
  assert.equal(recorder.rows()[0].phase, "vault-scope", "the deepest allowing layer names the unit");

  // The first capture of a request is the one kept: a later layer must not move it.
  let tick = NOW;
  const advancing = await runtimeWith({ now: () => (tick += 1) });
  const clockScope = advancing.runtime.shadow.begin({ requestId: "req-clock" });
  let firstInstant = null;
  withShadowRequest(clockScope, () => {
    advancing.runtime.shadow.compare({ request: authorizationRequest(), legacyDecision: { allowed: true, code: ALLOWED }, boundaryKey: "get_note", phase: "transport" });
    firstInstant = advancing.runtime.summary().captured.nowMs;
    advancing.runtime.shadow.compare({ request: authorizationRequest(), legacyDecision: { allowed: true, code: ALLOWED }, boundaryKey: "get_note", phase: "tool" });
  });
  clockScope.end();
  assert.equal(advancing.runtime.summary().captured.nowMs, firstInstant, "the first capture of the request is kept");
  assert.equal(advancing.recorder.summary().compared, 1);

  // The same request seen through the runtime: the first capture of the request wins,
  // and three layers still produce one row.
  const built = await runtimeWith({});
  const request = authorizationRequest();
  const allow = { allowed: true, code: ALLOWED };
  const scope = built.runtime.shadow.begin({ requestId: "req-runtime" });
  withShadowRequest(scope, () => {
    assert.equal(currentShadowRequestId(), "req-runtime");
    built.runtime.shadow.compare({ request, legacyDecision: allow, boundaryKey: "get_note", phase: "transport" });
    built.runtime.shadow.compare({ request, legacyDecision: allow, boundaryKey: "get_note", phase: "tool" });
  });
  scope.end();
  assert.equal(built.recorder.summary().compared, 1);
  assert.equal(built.recorder.summary().matches, 1);
  assert.equal(built.recorder.rows()[0].requestId, "req-runtime");
  // The capture recorded for the request is the first one, not the last.
  assert.equal(built.runtime.summary().captured.revision, 4);
});

test("a_suspended_request_keeps_the_effective_old_answer_and_adds_no_difference", async () => {
  const recorder = createShadowRecorder({ capacity: 8 });
  // Transport allows, then the temporal gate denies outside its window; the new model
  // denies at the same layer for the same reason.
  layers(recorder, [
    layer("transport", "get_note", true, ALLOWED, true, ALLOWED),
    layer("tool", "get_note", false, OUTSIDE_WINDOW, false, OUTSIDE_WINDOW),
  ]);
  const summary = recorder.summary();
  assert.equal(summary.compared, 1);
  assert.equal(summary.differences, 0, "an allowed transport layer must not fabricate a difference");
  assert.equal(summary.matches, 1);
  const row = recorder.rows()[0];
  assert.equal(row.oldAllowed, false, "the effective old answer is the deny that decided");
  assert.equal(row.newAllowed, false);
  assert.equal(row.oldCode, OUTSIDE_WINDOW);
  assert.equal(row.newCode, OUTSIDE_WINDOW);
  assert.equal(row.phase, "tool", "the row names the layer that decided");
  assert.equal(row.boundary, "get_note");

  // The reverse: the old gate allowed everywhere while the new model denies deeper.
  const denyDeeper = createShadowRecorder({ capacity: 8 });
  layers(denyDeeper, [
    layer("transport", "get_note", true, ALLOWED, true, ALLOWED),
    layer("vault-scope", "get_note", true, ALLOWED, false, CAPABILITY_DENIED),
  ]);
  assert.equal(denyDeeper.summary().differences, 1, "a real model difference is still reported");
  assert.equal(denyDeeper.rows()[0].oldAllowed, true);
  assert.equal(denyDeeper.rows()[0].newAllowed, false);
  assert.equal(denyDeeper.rows()[0].phase, "vault-scope");
});

test("a_member_without_its_own_old_verdict_is_inconclusive_with_a_reason", async () => {
  const recorder = createShadowRecorder({ capacity: 8 });
  layers(recorder, [
    {
      ...layer("transport", "get_note", true, ALLOWED, true, ALLOWED),
      inconclusiveReason: "batch_shared_verdict",
    },
  ]);
  const summary = recorder.summary();
  assert.equal(summary.compared, 1);
  assert.equal(summary.matches, 0, "a shared batch verdict is never agreement");
  assert.equal(summary.inconclusive, 1);
  assert.equal(recorder.rows()[0].inconclusiveReason, "batch_shared_verdict");

  // A batch of two members is two units: two rows, each with its own request id.
  const batch = createShadowRecorder({ capacity: 8 });
  const scope = batch.begin({ requestId: "req-batch" });
  withShadowRequest(scope, () => {
    batch.record({ surface: "mcp", capability: "get_note", targetKind: "vault", targetId: "vault", ...layer("tool", "get_note", true, ALLOWED, true, ALLOWED) });
    batch.record({ surface: "mcp", capability: "write_note", targetKind: "vault", targetId: "vault", ...layer("tool", "write_note", false, "insufficient_scope", false, CAPABILITY_DENIED) });
  });
  scope.end();
  assert.equal(batch.summary().compared, 2);
  assert.deepEqual(batch.rows().map((row) => row.requestId), ["req-batch#0", "req-batch#1"]);
  assert.equal(batch.summary().differences, 1, "the differing member is the only difference");
  assert.deepEqual(batch.rows().map((row) => row.capability), ["get_note", "write_note"]);
});

test("repeated_batch_members_of_one_tool_stay_separate_units", async () => {
  const recorder = createShadowRecorder({ capacity: 16 });
  const scope = recorder.begin({ requestId: "req-identical" });
  withShadowRequest(scope, () => {
    // Three members of the same tool on the same Vault: the transport pass records all
    // three first, then each handler adds its own tool and Vault-scope layers.
    for (let member = 0; member < 3; member += 1) {
      recorder.record({ surface: "mcp", capability: "get_note", targetKind: "vault", targetId: "vault", ...layer("transport", "get_note", true, ALLOWED, true, ALLOWED) });
    }
    for (const phase of ["tool", "vault-scope"]) {
      for (let member = 0; member < 3; member += 1) {
        recorder.record({ surface: "mcp", capability: "get_note", targetKind: "vault", targetId: "vault", ...layer(phase, "get_note", true, ALLOWED, true, ALLOWED) });
      }
    }
  });
  scope.end();
  assert.equal(recorder.summary().compared, 3, "three members are three units");
  assert.equal(recorder.summary().matches, 3);
  assert.deepEqual(recorder.rows().map((row) => row.requestId), ["req-identical#0", "req-identical#1", "req-identical#2"]);
  assert.deepEqual(recorder.rows().map((row) => row.phase), ["vault-scope", "vault-scope", "vault-scope"], "each row keeps the deepest layer of its own unit");

  // One member with the same layers is still exactly one unit.
  const single = createShadowRecorder({ capacity: 8 });
  const singleScope = single.begin({ requestId: "req-single" });
  withShadowRequest(singleScope, () => {
    for (const phase of ["transport", "tool", "vault-scope"]) {
      single.record({ surface: "mcp", capability: "get_note", targetKind: "vault", targetId: "vault", ...layer(phase, "get_note", true, ALLOWED, true, ALLOWED) });
    }
  });
  singleScope.end();
  assert.equal(single.summary().compared, 1);
});

test("the_pending_record_is_bounded_and_reports_its_overflow", async () => {
  const recorder = createShadowRecorder({ capacity: 64 });
  const scope = recorder.begin({ requestId: "req-many" });
  withShadowRequest(scope, () => {
    // 16 units fit; the 17th cannot, and the loss is reported, never silent.
    for (let index = 0; index < 17; index += 1) {
      recorder.record({
        surface: "mcp", capability: `tool_${index}`, targetKind: "vault", targetId: `vault-${index}`,
        ...layer("tool", `tool_${index}`, true, ALLOWED, true, ALLOWED),
      });
    }
  });
  scope.end();
  const summary = recorder.summary();
  assert.equal(summary.compared, 17, "16 bounded units plus one overflow row");
  assert.equal(summary.inconclusive, 1);
  assert.equal(recorder.rows().at(-1).inconclusiveReason, "pending_overflow");
  assert.equal(recorder.rows().at(-1).requestId, "req-many#overflow");
});
