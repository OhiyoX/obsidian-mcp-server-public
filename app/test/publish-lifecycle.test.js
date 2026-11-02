// Lane A2 — pure Publish lifecycle model (#277/#278 Wave A).
//
// Contract: `Web/DEVELOPMENT - Issues 277-278 ... §5 (state machine), §5.1 (transition
// table), §8.1 (v1→v2 migration), §13.1-13.3 (lifecycle matrix), §17 (RETURN list)`.
//
// Every expected value is asserted by exact token (state, action, idPolicy, errorCode,
// issue token) — never by substring — and the full (lifecycle × observation) grid is
// expanded so no cell is "we will see in the code later". The module must stay pure:
// the source guard below is part of the contract, not decoration.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyObservation,
  isPublishedCandidate,
  migratePublishState,
  normalizeLegacyRecord,
  PERSISTABLE_LIFECYCLE_STATES,
  planPublish,
  planResolve,
  planRevoke,
  PUBLISH_ACTIONS,
  PUBLISH_ERROR_CODES,
  PUBLISH_ID_POLICY,
  PUBLISH_LIFECYCLE,
  PUBLISH_MIGRATION_ISSUES,
  PUBLISH_OBSERVATION,
  readLifecycle,
  STATE_VERSION_SOURCE,
  STATE_VERSION_TARGET,
} from "../src/publish/lifecycle.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.join(HERE, "..", "src", "publish", "lifecycle.js");

const { ACTIVE, ORPHANED, INVALID, UNKNOWN, REVOKED } = PUBLISH_LIFECYCLE;
const E = PUBLISH_ERROR_CODES;
const I = PUBLISH_MIGRATION_ISSUES;
const { MARKDOWN, MISSING, NON_MARKDOWN, UNVERIFIABLE } = PUBLISH_OBSERVATION;

const OBSERVATIONS = Object.freeze({
  [MARKDOWN]: Object.freeze({ exists: true, isMarkdown: true }),
  [MISSING]: Object.freeze({ exists: false, isMarkdown: false }),
  [NON_MARKDOWN]: Object.freeze({ exists: true, isMarkdown: false }),
  [UNVERIFIABLE]: Object.freeze({}),
});

function recordOf(lifecycle, extra = {}) {
  const base = {
    id: "old-id",
    vaultId: "vault",
    path: "Notes/a.md",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdBy: null,
  };
  if (lifecycle !== undefined) base.lifecycle = lifecycle;
  return Object.freeze({ ...base, ...extra });
}

const nextLifecycle = (decision) => decision.transition?.to ?? null;

test("§5.1-1 publish(existing Markdown, no record) → active + new id", () => {
  const plan = planPublish({ record: null, observation: OBSERVATIONS[MARKDOWN] });
  assert.equal(plan.ok, true);
  assert.equal(plan.action, PUBLISH_ACTIONS.PUBLISH_CREATE);
  assert.equal(plan.idPolicy, PUBLISH_ID_POLICY.NEW);
  assert.equal(plan.lifecycle, ACTIVE);
  assert.equal(plan.httpStatus, 200);
  assert.equal(plan.changed, true);
  assert.equal(plan.transition, null);
  assert.equal(plan.removeRecord, false);
  assert.equal(plan.errorCode, null);
});

test("§5.1-2 publish(existing Markdown, active record) → idempotent, same id", () => {
  const plan = planPublish({ record: recordOf(ACTIVE), observation: OBSERVATIONS[MARKDOWN] });
  assert.equal(plan.ok, true);
  assert.equal(plan.action, PUBLISH_ACTIONS.PUBLISH_REUSE);
  assert.equal(plan.idPolicy, PUBLISH_ID_POLICY.SAME);
  assert.equal(plan.lifecycle, ACTIVE);
  assert.equal(plan.changed, false);
  assert.equal(plan.transition, null);
  assert.equal(plan.removeRecord, false);
});

test("§5.1-3 resolve(active id, Markdown exists) → 200, no transition", () => {
  const plan = planResolve({ record: recordOf(ACTIVE), observation: OBSERVATIONS[MARKDOWN] });
  assert.equal(plan.ok, true);
  assert.equal(plan.action, PUBLISH_ACTIONS.RESOLVE_SERVE);
  assert.equal(plan.httpStatus, 200);
  assert.equal(plan.changed, false);
  assert.equal(plan.transition, null);
});

test("§5.1-4 resolve(active id, missing) → 404 + transition orphaned", () => {
  const plan = planResolve({ record: recordOf(ACTIVE), observation: OBSERVATIONS[MISSING] });
  assert.equal(plan.ok, false);
  assert.equal(plan.httpStatus, 404);
  assert.equal(plan.lifecycle, ORPHANED);
  assert.deepEqual(plan.transition, { from: ACTIVE, to: ORPHANED });
  assert.equal(plan.changed, true);
  assert.equal(plan.errorCode, E.PUBLISH_TARGET_MISSING);
});

test("§5.1-5 resolve(active id, non-Markdown) → 404 + transition invalid", () => {
  const plan = planResolve({ record: recordOf(ACTIVE), observation: OBSERVATIONS[NON_MARKDOWN] });
  assert.equal(plan.ok, false);
  assert.equal(plan.httpStatus, 404);
  assert.equal(plan.lifecycle, INVALID);
  assert.deepEqual(plan.transition, { from: ACTIVE, to: INVALID });
  assert.equal(plan.errorCode, E.PUBLISH_RECORD_INVALID);
});

test("§5.1-6 revoke by path → success for every lifecycle, no file existence required", () => {
  for (const lifecycle of [ACTIVE, ORPHANED, INVALID, UNKNOWN, REVOKED]) {
    const plan = planRevoke({ record: recordOf(lifecycle) });
    assert.equal(plan.ok, true, `revoke(${lifecycle})`);
    assert.equal(plan.action, PUBLISH_ACTIONS.REVOKE);
    assert.equal(plan.revoked, true);
    assert.equal(plan.removeRecord, true, `revoke(${lifecycle}) must delete the record`);
    assert.equal(plan.changed, true);
    assert.equal(plan.httpStatus, 200);
  }
  // Missing / unrecorded path: success with revoked:false, never a 404 (§13.3).
  const absent = planRevoke({ record: null });
  assert.equal(absent.ok, true);
  assert.equal(absent.action, PUBLISH_ACTIONS.REVOKE_NOOP);
  assert.equal(absent.revoked, false);
  assert.equal(absent.removeRecord, false);
  assert.equal(absent.httpStatus, 200);
  assert.equal(planRevoke({}).revoked, false);
});

test("§5.1-7 publish(Markdown, orphaned/invalid/revoked) → new id; old id never returns to active", () => {
  for (const lifecycle of [ORPHANED, INVALID, REVOKED]) {
    const plan = planPublish({ record: recordOf(lifecycle), observation: OBSERVATIONS[MARKDOWN] });
    assert.equal(plan.ok, true, `publish(${lifecycle})`);
    assert.equal(plan.action, PUBLISH_ACTIONS.PUBLISH_REPUBLISH);
    assert.equal(plan.idPolicy, PUBLISH_ID_POLICY.NEW, "explicit republish must mint a new opaque id");
    assert.equal(plan.lifecycle, ACTIVE);
    assert.equal(plan.removeRecord, true, "the dead record must be replaced, not duplicated");
    assert.equal(plan.transition, null, "the dead record must not be transitioned back");
    // The old id stays 404 even when the path is Markdown again.
    const resolve = planResolve({ record: recordOf(lifecycle), observation: OBSERVATIONS[MARKDOWN] });
    assert.equal(resolve.ok, false, `old ${lifecycle} id must stay denied`);
    assert.equal(resolve.httpStatus, 404);
    assert.equal(resolve.changed, false);
  }
});

test("§13.1 delete sequence: active → observed missing → orphaned → no revive → republish new id", () => {
  let current = null;
  assert.equal(planPublish({ record: current, observation: OBSERVATIONS[MARKDOWN] }).idPolicy, PUBLISH_ID_POLICY.NEW);
  current = recordOf(ACTIVE);
  const observed = planResolve({ record: current, observation: OBSERVATIONS[MISSING] });
  assert.deepEqual(observed.transition, { from: ACTIVE, to: ORPHANED });
  current = recordOf(ORPHANED);
  // File recreated at the same path: the old id must not revive.
  const revived = planResolve({ record: current, observation: OBSERVATIONS[MARKDOWN] });
  assert.equal(revived.ok, false);
  assert.equal(revived.httpStatus, 404);
  assert.equal(revived.changed, false);
  // Explicit republish → new id, and the new record is servable.
  const republished = planPublish({ record: current, observation: OBSERVATIONS[MARKDOWN] });
  assert.equal(republished.idPolicy, PUBLISH_ID_POLICY.NEW);
  assert.equal(planResolve({ record: recordOf(ACTIVE), observation: OBSERVATIONS[MARKDOWN] }).ok, true);
});

test("§13.2 rename: orphan revoke succeeds while target is missing; new path is not auto-published", () => {
  const revoked = planRevoke({ record: recordOf(ACTIVE, { path: "Notes/b.md" }) });
  assert.equal(revoked.revoked, true);
  assert.equal(planResolve({ record: recordOf(ORPHANED, { path: "Notes/b.md" }), observation: OBSERVATIONS[MISSING] }).ok, false);
  // New path has no record → first publish creates a fresh id.
  const created = planPublish({ record: null, observation: OBSERVATIONS[MARKDOWN] });
  assert.equal(created.action, PUBLISH_ACTIONS.PUBLISH_CREATE);
  assert.equal(created.idPolicy, PUBLISH_ID_POLICY.NEW);
});

test("§13.4 active edit: repeated publish stays idempotent while path is not observed missing", () => {
  const first = planPublish({ record: recordOf(ACTIVE), observation: OBSERVATIONS[MARKDOWN] });
  const second = planPublish({ record: recordOf(ACTIVE), observation: OBSERVATIONS[MARKDOWN] });
  assert.equal(first.idPolicy, PUBLISH_ID_POLICY.SAME);
  assert.equal(second.idPolicy, PUBLISH_ID_POLICY.SAME);
  assert.deepEqual(first, second);
  assert.equal(planResolve({ record: recordOf(ACTIVE), observation: OBSERVATIONS[MARKDOWN] }).ok, true);
});

test("§8.1 legacy normalization: v1 record without lifecycle → unknown, not active", () => {
  const { record, issues } = normalizeLegacyRecord({
    id: "legacy-id",
    vaultId: "vault",
    path: "Notes/a.md",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(record.lifecycle, UNKNOWN);
  assert.equal(record.lifecycle === ACTIVE, false, "migration must not assume active");
  assert.deepEqual(issues, [I.RECORD_LIFECYCLE_MISSING]);
  assert.equal(record.createdBy, null);
  assert.equal(isPublishedCandidate(record), false, "un-observed legacy record must not be a published candidate");
  assert.equal(STATE_VERSION_SOURCE, 1);
  assert.equal(STATE_VERSION_TARGET, 2);
});

test("§8.1 legacy record fails closed on non-Markdown and on missing targets", () => {
  const legacy = recordOf(undefined);
  const nonMarkdown = planPublish({ record: legacy, observation: OBSERVATIONS[NON_MARKDOWN] });
  assert.equal(nonMarkdown.ok, false);
  assert.equal(nonMarkdown.errorCode, E.UNSUPPORTED_PUBLISH_TARGET);
  assert.deepEqual(nonMarkdown.transition, { from: UNKNOWN, to: INVALID });
  assert.equal(nonMarkdown.lifecycle, INVALID);

  const missingPublish = planPublish({ record: legacy, observation: OBSERVATIONS[MISSING] });
  assert.equal(missingPublish.ok, false);
  assert.equal(missingPublish.httpStatus, 404);
  assert.deepEqual(missingPublish.transition, { from: UNKNOWN, to: ORPHANED });

  const missingResolve = planResolve({ record: legacy, observation: OBSERVATIONS[MISSING] });
  assert.equal(missingResolve.ok, false);
  assert.equal(missingResolve.httpStatus, 404);
  assert.deepEqual(missingResolve.transition, { from: UNKNOWN, to: ORPHANED });
  assert.equal(missingResolve.errorCode, E.PUBLISH_RECORD_ORPHANED);

  // The legacy placeholder spelling from the doc is accepted and reads as unknown.
  assert.equal(readLifecycle({ lifecycle: "legacy" }), UNKNOWN);
});

test("§8.1 legacy record is adopted only after a verified Markdown observation", () => {
  const legacy = recordOf(undefined);
  const serve = planResolve({ record: legacy, observation: OBSERVATIONS[MARKDOWN] });
  assert.equal(serve.ok, true);
  assert.equal(serve.httpStatus, 200);
  assert.deepEqual(serve.transition, { from: UNKNOWN, to: ACTIVE });

  const adopt = planPublish({ record: legacy, observation: OBSERVATIONS[MARKDOWN] });
  assert.equal(adopt.action, PUBLISH_ACTIONS.PUBLISH_ADOPT);
  assert.equal(adopt.idPolicy, PUBLISH_ID_POLICY.SAME);
  assert.deepEqual(adopt.transition, { from: UNKNOWN, to: ACTIVE });

  // Unverifiable observation never promotes a legacy record.
  const unverifiable = planResolve({ record: legacy, observation: OBSERVATIONS[UNVERIFIABLE] });
  assert.equal(unverifiable.ok, false);
  assert.equal(unverifiable.changed, false);
  assert.deepEqual(planResolve({ record: legacy, observation: { exists: true } }).transition, null);
});

test("§8.1 garbage lifecycle value fails closed as invalid (S07)", () => {
  const { record, issues } = normalizeLegacyRecord({ id: "x", vaultId: "vault", path: "Notes/a.md", lifecycle: "bogus" });
  assert.equal(record.lifecycle, INVALID);
  assert.deepEqual(issues, [I.RECORD_LIFECYCLE_UNRECOGNIZED]);
  assert.equal(readLifecycle({ lifecycle: 7 }), null);
  assert.equal(planResolve({ record: { id: "x", vaultId: "v", path: "a.md", lifecycle: 7 }, observation: OBSERVATIONS[MARKDOWN] }).ok, false);
});

test("§8.1 one bad record cannot stop the service; issues name the offending index", () => {
  const good = { id: "good", vaultId: "vault", path: "Notes/a.md" };
  const state = migratePublishState({ version: 1, records: [good, { vaultId: "vault", path: "Notes/b.md" }, null] });
  assert.equal(state.version, STATE_VERSION_TARGET);
  assert.equal(state.sourceVersion, 1);
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].id, "good");
  assert.equal(state.records[0].lifecycle, UNKNOWN);
  assert.equal(state.dropped, 2);
  assert.deepEqual(state.issues, [
    `records[0]: ${I.RECORD_LIFECYCLE_MISSING}`,
    `records[1]: ${I.RECORD_ID_MISSING}`,
    `records[2]: ${I.RECORD_NOT_AN_OBJECT}`,
  ]);
  assert.equal(state.issues.some((issue) => issue.startsWith("records[1]:")), true);
});

test("migration drops duplicates and preserves already-valid v2 lifecycles", () => {
  const records = [
    { id: "a", vaultId: "vault", path: "Notes/a.md", lifecycle: ACTIVE },
    { id: "a", vaultId: "vault", path: "Notes/other.md", lifecycle: ACTIVE },
    { id: "b", vaultId: "vault", path: "Notes/a.md", lifecycle: ORPHANED },
    { id: "c", vaultId: "vault", path: "Notes/c.md", lifecycle: INVALID },
  ];
  const state = migratePublishState({ version: 2, records });
  assert.deepEqual(state.records.map((item) => item.id), ["a", "c"]);
  assert.deepEqual(state.records.map((item) => item.lifecycle), [ACTIVE, INVALID]);
  assert.deepEqual(state.issues, [`records[1]: ${I.RECORD_ID_DUPLICATE}`, `records[2]: ${I.RECORD_DOCUMENT_DUPLICATE}`]);
  assert.equal(state.dropped, 2);
});

test("migration reports a structurally broken state instead of throwing", () => {
  assert.deepEqual(migratePublishState(null).issues, [I.STATE_NOT_AN_OBJECT]);
  assert.deepEqual(migratePublishState({ version: 1, records: "nope" }).issues, [I.RECORDS_NOT_AN_ARRAY]);
  assert.deepEqual(migratePublishState({ version: 1 }).records, []);
  assert.deepEqual(normalizeLegacyRecord("nope"), { record: null, issues: [I.RECORD_NOT_AN_OBJECT] });
  assert.deepEqual(migratePublishState({ version: 1, records: [] }).sourceVersion, 1);
  assert.equal(migratePublishState({ records: [] }).sourceVersion, null);
});

test("§9 published candidate is active only", () => {
  assert.equal(isPublishedCandidate(recordOf(ACTIVE)), true);
  for (const lifecycle of [ORPHANED, INVALID, UNKNOWN, REVOKED]) {
    assert.equal(isPublishedCandidate(recordOf(lifecycle)), false, lifecycle);
  }
  assert.equal(isPublishedCandidate(recordOf(undefined)), false, "un-observed legacy record is not a candidate");
  assert.deepEqual(PERSISTABLE_LIFECYCLE_STATES, [ACTIVE, ORPHANED, INVALID, UNKNOWN]);
});

test("observation classification is total and fail-closed", () => {
  assert.equal(classifyObservation({ exists: true, isMarkdown: true }), MARKDOWN);
  assert.equal(classifyObservation({ exists: false, isMarkdown: false }), MISSING);
  assert.equal(classifyObservation({ exists: false, isMarkdown: true }), MISSING);
  assert.equal(classifyObservation({ exists: true, isMarkdown: false }), NON_MARKDOWN);
  assert.equal(classifyObservation({ exists: false, isMarkdown: false, observedMissing: true }), MISSING);
  assert.equal(classifyObservation({ observedMissing: true }), MISSING);
  for (const unexpected of [
    undefined,
    null,
    {},
    { exists: true },
    { exists: "yes", isMarkdown: true },
    { exists: true, isMarkdown: "yes" },
    { exists: true, isMarkdown: true, observedMissing: true },
    { observedMissing: "maybe" },
  ]) {
    assert.equal(classifyObservation(unexpected), UNVERIFIABLE, JSON.stringify(unexpected));
  }
});

test("exhaustive (lifecycle × observation) resolve grid — 20 cells, no gaps", () => {
  const expected = {
    [ACTIVE]: {
      [MARKDOWN]: [true, null],
      [MISSING]: [false, ORPHANED],
      [NON_MARKDOWN]: [false, INVALID],
      [UNVERIFIABLE]: [false, null],
    },
    [UNKNOWN]: {
      [MARKDOWN]: [true, ACTIVE],
      [MISSING]: [false, ORPHANED],
      [NON_MARKDOWN]: [false, INVALID],
      [UNVERIFIABLE]: [false, null],
    },
    [ORPHANED]: { [MARKDOWN]: [false, null], [MISSING]: [false, null], [NON_MARKDOWN]: [false, null], [UNVERIFIABLE]: [false, null] },
    [INVALID]: { [MARKDOWN]: [false, null], [MISSING]: [false, null], [NON_MARKDOWN]: [false, null], [UNVERIFIABLE]: [false, null] },
    [REVOKED]: { [MARKDOWN]: [false, null], [MISSING]: [false, null], [NON_MARKDOWN]: [false, null], [UNVERIFIABLE]: [false, null] },
  };
  let cells = 0;
  for (const [lifecycle, byObservation] of Object.entries(expected)) {
    for (const [kind, [ok, next]] of Object.entries(byObservation)) {
      cells += 1;
      const plan = planResolve({ record: recordOf(lifecycle), observation: OBSERVATIONS[kind] });
      assert.equal(plan.ok, ok, `${lifecycle}/${kind} ok`);
      assert.equal(nextLifecycle(plan), next, `${lifecycle}/${kind} next`);
      assert.equal(plan.httpStatus, ok ? 200 : 404, `${lifecycle}/${kind} status`);
      assert.equal(plan.changed, next !== null, `${lifecycle}/${kind} changed`);
    }
  }
  assert.equal(cells, 20);
});

test("exhaustive (record state × observation) publish grid — 24 cells, no gaps", () => {
  const expected = {
    null: {
      [MARKDOWN]: [true, PUBLISH_ACTIONS.PUBLISH_CREATE, PUBLISH_ID_POLICY.NEW, null, false],
      [MISSING]: [false, PUBLISH_ACTIONS.PUBLISH_DENY, PUBLISH_ID_POLICY.NONE, null, false],
      [NON_MARKDOWN]: [false, PUBLISH_ACTIONS.PUBLISH_DENY, PUBLISH_ID_POLICY.NONE, null, false],
      [UNVERIFIABLE]: [false, PUBLISH_ACTIONS.PUBLISH_DENY, PUBLISH_ID_POLICY.NONE, null, false],
    },
    [ACTIVE]: {
      [MARKDOWN]: [true, PUBLISH_ACTIONS.PUBLISH_REUSE, PUBLISH_ID_POLICY.SAME, null, false],
      [MISSING]: [false, PUBLISH_ACTIONS.PUBLISH_DENY, PUBLISH_ID_POLICY.NONE, ORPHANED, false],
      [NON_MARKDOWN]: [false, PUBLISH_ACTIONS.PUBLISH_DENY, PUBLISH_ID_POLICY.NONE, INVALID, false],
      [UNVERIFIABLE]: [false, PUBLISH_ACTIONS.PUBLISH_DENY, PUBLISH_ID_POLICY.NONE, null, false],
    },
    [UNKNOWN]: {
      [MARKDOWN]: [true, PUBLISH_ACTIONS.PUBLISH_ADOPT, PUBLISH_ID_POLICY.SAME, ACTIVE, false],
      [MISSING]: [false, PUBLISH_ACTIONS.PUBLISH_DENY, PUBLISH_ID_POLICY.NONE, ORPHANED, false],
      [NON_MARKDOWN]: [false, PUBLISH_ACTIONS.PUBLISH_DENY, PUBLISH_ID_POLICY.NONE, INVALID, false],
      [UNVERIFIABLE]: [false, PUBLISH_ACTIONS.PUBLISH_DENY, PUBLISH_ID_POLICY.NONE, null, false],
    },
    [ORPHANED]: {
      [MARKDOWN]: [true, PUBLISH_ACTIONS.PUBLISH_REPUBLISH, PUBLISH_ID_POLICY.NEW, null, true],
      [MISSING]: [false, PUBLISH_ACTIONS.PUBLISH_DENY, PUBLISH_ID_POLICY.NONE, null, false],
      [NON_MARKDOWN]: [false, PUBLISH_ACTIONS.PUBLISH_DENY, PUBLISH_ID_POLICY.NONE, null, false],
      [UNVERIFIABLE]: [false, PUBLISH_ACTIONS.PUBLISH_DENY, PUBLISH_ID_POLICY.NONE, null, false],
    },
    [INVALID]: {
      [MARKDOWN]: [true, PUBLISH_ACTIONS.PUBLISH_REPUBLISH, PUBLISH_ID_POLICY.NEW, null, true],
      [MISSING]: [false, PUBLISH_ACTIONS.PUBLISH_DENY, PUBLISH_ID_POLICY.NONE, null, false],
      [NON_MARKDOWN]: [false, PUBLISH_ACTIONS.PUBLISH_DENY, PUBLISH_ID_POLICY.NONE, null, false],
      [UNVERIFIABLE]: [false, PUBLISH_ACTIONS.PUBLISH_DENY, PUBLISH_ID_POLICY.NONE, null, false],
    },
    [REVOKED]: {
      [MARKDOWN]: [true, PUBLISH_ACTIONS.PUBLISH_REPUBLISH, PUBLISH_ID_POLICY.NEW, null, true],
      [MISSING]: [false, PUBLISH_ACTIONS.PUBLISH_DENY, PUBLISH_ID_POLICY.NONE, null, false],
      [NON_MARKDOWN]: [false, PUBLISH_ACTIONS.PUBLISH_DENY, PUBLISH_ID_POLICY.NONE, null, false],
      [UNVERIFIABLE]: [false, PUBLISH_ACTIONS.PUBLISH_DENY, PUBLISH_ID_POLICY.NONE, null, false],
    },
  };
  let cells = 0;
  for (const [state, byObservation] of Object.entries(expected)) {
    for (const [kind, [ok, action, idPolicy, next, removeRecord]] of Object.entries(byObservation)) {
      cells += 1;
      const plan = planPublish({ record: state === "null" ? null : recordOf(state), observation: OBSERVATIONS[kind] });
      const label = `${state}/${kind}`;
      assert.equal(plan.ok, ok, `${label} ok`);
      assert.equal(plan.action, action, `${label} action`);
      assert.equal(plan.idPolicy, idPolicy, `${label} idPolicy`);
      assert.equal(nextLifecycle(plan), next, `${label} next`);
      assert.equal(plan.removeRecord, removeRecord, `${label} removeRecord`);
      // A successful publish writes state unless it is the idempotent reuse; a denial
      // writes state only when it also returns a transition to persist.
      const changed = ok ? action !== PUBLISH_ACTIONS.PUBLISH_REUSE : next !== null;
      assert.equal(plan.changed, changed, `${label} changed`);
    }
  }
  assert.equal(cells, 24);
});

test("planners are pure: frozen outputs, identical repeats, no input mutation", () => {
  const record = recordOf(ACTIVE);
  const observation = OBSERVATIONS[MARKDOWN];
  const snapshot = JSON.stringify({ record, observation });

  const plan = planResolve({ record, observation });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.transition), true);
  assert.deepEqual(plan, planResolve({ record, observation }));
  assert.equal(JSON.stringify({ record, observation }), snapshot, "planner must not mutate its inputs");

  const transitioned = planResolve({ record, observation: OBSERVATIONS[MISSING] });
  assert.equal(Object.isFrozen(transitioned.transition), true);
  assert.equal(JSON.stringify({ record, observation }), snapshot);

  const normalized = normalizeLegacyRecord({ id: "x", vaultId: "v", path: "a.md" });
  assert.equal(Object.isFrozen(normalized.record), true);
  assert.equal(Object.isFrozen(normalized.issues), true);
  const state = migratePublishState({ version: 1, records: [] });
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.records), true);
  assert.equal(Object.isFrozen(state.issues), true);
  assert.equal(Object.isFrozen(PUBLISH_LIFECYCLE), true);
  assert.equal(Object.isFrozen(PERSISTABLE_LIFECYCLE_STATES), true);

  // Frozen outputs cannot be mutated (ESM is strict mode, so this must throw).
  assert.throws(() => {
    plan.reason = "tampered";
  }, TypeError);
  assert.throws(() => {
    transitioned.transition.to = ACTIVE;
  }, TypeError);
  assert.throws(() => {
    normalized.record.lifecycle = ACTIVE;
  }, TypeError);
});

test("source guard: the model stays free of IO, clock and randomness", async () => {
  const source = await fs.readFile(SOURCE_PATH, "utf8");
  assert.equal(/from\s+["']node:(?:fs|fs\/promises|crypto|http|https|child_process|perf_hooks|net|os)["']/.test(source), false, "no IO/host imports");
  assert.equal(/\brequire\s*\(/.test(source), false, "no CommonJS require");
  assert.equal(/\bDate\.now\b|\bnew Date\b|\bMath\.random\b|hrtime|randomBytes|randomUUID/.test(source), false, "no clock/randomness");
  assert.equal(source.includes("process.env"), false, "no environment coupling");
});
