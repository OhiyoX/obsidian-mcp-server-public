// #364 pure authorization-transfer runtime algebra.
//
// These are the properties the durable fence relies on. They are deliberately
// checked without a filesystem or a clock so the generation algebra can be
// reasoned about (and reviewed) independently of the store's durability work.

import assert from "node:assert/strict";
import test from "node:test";
import {
  currentPairGeneration,
  evaluateCredentialFence,
  findCompletionCandidate,
  generationRecordFor,
  normalizeGeneration,
  pairGenerationKey,
  parsePairGenerationKey,
  pendingTransfersForClient,
  transferRecords,
  transferStateView,
} from "../src/oauth/authorization-transfer-runtime.js";

const CLIENT = "client-A";
const SOURCE = "user-1";
const TARGET = "user-2";

function stateWith({ generation = null, transfers = {} } = {}) {
  const generations = generation === null ? {} : { [pairGenerationKey(CLIENT, SOURCE)]: generation };
  return { version: 1, generations, transfers };
}

function transfer(overrides = {}) {
  return {
    id: "t-1",
    clientId: CLIENT,
    sourceUserId: SOURCE,
    targetUserId: TARGET,
    status: "pending",
    generation: 1,
    sourceRevokedAt: "2026-10-09T00:00:00.000Z",
    createdAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T00:15:00.000Z",
    ...overrides,
  };
}

test("pair generation keys are injective and generation values normalize to the oldest", () => {
  assert.notEqual(pairGenerationKey("a", "b\u0000c"), pairGenerationKey("a\u0000b", "c"));
  assert.notEqual(pairGenerationKey("a", "b"), pairGenerationKey("ab", ""));
  assert.notEqual(pairGenerationKey("a", "b"), pairGenerationKey("a", "b "));
  assert.deepEqual(parsePairGenerationKey(pairGenerationKey("client", "user")), ["client", "user"]);
  assert.deepEqual(parsePairGenerationKey(pairGenerationKey("a\u0000b", "c\u0000d")), ["a\u0000b", "c\u0000d"]);
  assert.equal(parsePairGenerationKey("client:user"), null);
  assert.equal(parsePairGenerationKey("[\"only-one\"]"), null);
  assert.equal(normalizeGeneration(undefined), 0);
  assert.equal(normalizeGeneration(null), 0);
  assert.equal(normalizeGeneration(-3), 0);
  assert.equal(normalizeGeneration(1.5), 0);
  assert.equal(normalizeGeneration(Number.NaN), 0);
  assert.equal(normalizeGeneration("2"), 2);
  assert.equal(normalizeGeneration(7), 7);
});

test("currentPairGeneration is 0 without a record and the recorded value otherwise", () => {
  assert.equal(currentPairGeneration(stateWith(), CLIENT, SOURCE), 0);
  assert.equal(currentPairGeneration(stateWith({ generation: { generation: 3, transferId: "t-1" } }), CLIENT, SOURCE), 3);
  assert.equal(currentPairGeneration(stateWith(), CLIENT, "unknown"), 0);
  assert.equal(generationRecordFor(stateWith({ generation: { generation: 2, transferId: "t-2" } }), CLIENT, SOURCE).generation, 2);
  assert.equal(generationRecordFor(stateWith(), CLIENT, SOURCE), null);
});

test("a legacy credential without a generation is valid until its pair is fenced", () => {
  const legacy = { clientId: CLIENT, userId: SOURCE };
  assert.deepEqual(evaluateCredentialFence({ state: stateWith(), ...legacy }), {
    fenced: false, reason: "current", credentialGeneration: 0, currentGeneration: 0,
  });
  const afterFence = evaluateCredentialFence({ state: stateWith({ generation: { generation: 1, transferId: "t-1" } }), ...legacy });
  assert.equal(afterFence.fenced, true);
  assert.equal(afterFence.reason, "generation_mismatch");
  assert.equal(afterFence.currentGeneration, 1);
});

test("a credential minted at the new generation survives the fence (A may re-authorize)", () => {
  const state = stateWith({ generation: { generation: 1, transferId: "t-1" } });
  assert.equal(evaluateCredentialFence({ state, clientId: CLIENT, userId: SOURCE, generation: 1 }).fenced, false);
  assert.equal(evaluateCredentialFence({ state, clientId: CLIENT, userId: SOURCE, generation: 0 }).fenced, true);
  assert.equal(evaluateCredentialFence({ state, clientId: CLIENT, userId: SOURCE, generation: 2 }).fenced, true, "a future generation is not a pass");
});

test("generation equality (not a timestamp) is what closes the concurrent-issuance window", () => {
  // Any credential minted from a pre-fence source inherits generation 0, so no
  // interleaving of "issue" and "bump" can leave it valid at generation 1.
  const fenced = stateWith({ generation: { generation: 1, transferId: "t-1" } });
  const issuedBeforeOrDuringFence = [
    { generation: undefined }, { generation: 0 }, { generation: null },
  ];
  for (const credential of issuedBeforeOrDuringFence) {
    assert.equal(evaluateCredentialFence({ state: fenced, clientId: CLIENT, userId: SOURCE, ...credential }).fenced, true);
  }
  // Only a credential minted after the fence (a fresh consent) passes.
  assert.equal(evaluateCredentialFence({ state: fenced, clientId: CLIENT, userId: SOURCE, generation: 1 }).fenced, false);
});

test("a degraded or unreadable fence fails closed for every credential", () => {
  const degraded = evaluateCredentialFence({ state: null, degraded: true, clientId: CLIENT, userId: SOURCE, generation: 1 });
  assert.equal(degraded.fenced, true);
  assert.equal(degraded.reason, "store_unavailable");
  assert.equal(degraded.currentGeneration, null, "an unreadable fence cannot claim a current generation");
});

test("credentials without a pair (legacy/anonymous) are not fenced by a pair fence", () => {
  assert.equal(evaluateCredentialFence({ state: stateWith(), clientId: null, userId: SOURCE, generation: 0 }).fenced, false);
  assert.equal(evaluateCredentialFence({ state: stateWith(), clientId: CLIENT, userId: null, generation: 0 }).fenced, false);
  assert.equal(evaluateCredentialFence({ state: stateWith(), clientId: null, userId: null }).reason, "no_pair");
});

test("transferStateView treats a missing store as inert and a broken store as degraded", () => {
  assert.deepEqual(transferStateView(null), { state: null, degraded: false, configured: false });
  const healthy = { view: () => stateWith(), isHealthy: () => true };
  assert.deepEqual(transferStateView(healthy), { state: stateWith(), degraded: false, configured: true });
  assert.equal(transferStateView({ view: () => stateWith(), isHealthy: () => false }).degraded, true);
  assert.equal(transferStateView({ view: () => { throw new Error("boom"); } }).degraded, true);
  assert.equal(transferStateView({ isHealthy: () => { throw new Error("boom"); } }).degraded, true);
});

test("completion candidates match client + target only, and fail closed when ambiguous or expired", () => {
  const eligible = stateWith({ transfers: { "t-1": transfer() } });
  assert.equal(findCompletionCandidate({ state: eligible, clientId: CLIENT, targetUserId: TARGET, now: 0 }).reason, "eligible");
  assert.equal(findCompletionCandidate({ state: eligible, clientId: CLIENT, targetUserId: SOURCE, now: 0 }).reason, "none");
  assert.equal(findCompletionCandidate({ state: eligible, clientId: "client-B", targetUserId: TARGET, now: 0 }).reason, "none");
  assert.equal(findCompletionCandidate({ state: eligible, clientId: CLIENT, targetUserId: TARGET, now: Date.parse("2026-10-09T00:16:00.000Z") }).reason, "expired");
  const ambiguous = stateWith({ transfers: { "t-1": transfer(), "t-2": transfer({ id: "t-2" }) } });
  assert.equal(findCompletionCandidate({ state: ambiguous, clientId: CLIENT, targetUserId: TARGET, now: 0 }).reason, "ambiguous");
  assert.equal(findCompletionCandidate({ state: eligible, degraded: true, clientId: CLIENT, targetUserId: TARGET, now: 0 }).reason, "store_unavailable");
  const cancelled = stateWith({ transfers: { "t-1": transfer({ status: "cancelled" }) } });
  assert.equal(findCompletionCandidate({ state: cancelled, clientId: CLIENT, targetUserId: TARGET, now: 0 }).reason, "none");
});

test("projection readers copy and order records without mutating the store state", () => {
  const state = stateWith({
    transfers: {
      older: transfer({ id: "older", createdAt: "2026-10-09T00:00:00.000Z", status: "completed" }),
      newer: transfer({ id: "newer", createdAt: "2026-10-09T00:10:00.000Z" }),
      other: transfer({ id: "other", clientId: "client-B", createdAt: "2026-10-09T00:20:00.000Z" }),
    },
  });
  const frozen = JSON.stringify(state);
  assert.deepEqual(transferRecords(state).map((item) => item.id), ["other", "newer", "older"]);
  assert.deepEqual(pendingTransfersForClient(state, CLIENT).map((item) => item.id), ["newer"]);
  const [first] = pendingTransfersForClient(state, CLIENT);
  first.status = "mutated";
  assert.equal(JSON.stringify(state), frozen, "readers must not hand out live references");
});
