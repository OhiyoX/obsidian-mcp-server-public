// Focused tests for AuthZ Wave B / B4 Admin access-policy service
// (app/src/admin/access-policy.js).
//
// The service is exercised against a *real* A3 store backed by a temporary
// directory plus the real A4 runtime, so CAS, durability and the schema are the
// production ones. Clock is injected; no sleeps; no network.
//
// Contract: `scratch/authz/INTERFACE.md` §10.4 + the B4 BRIEF §2/§3.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ACCESS_POLICY_CODES } from "../src/access-policy/errors.js";
import { createAccessPolicyRuntime } from "../src/access-policy/runtime.js";
import { parseAccessPolicyDocument } from "../src/access-policy/schema.js";
import { createAccessPolicyStore } from "../src/access-policy/store.js";
import {
  ACCESS_POLICY_ADMIN_CODES,
  createAccessPolicyAdmin,
  formatDateRangesText,
  formatWeeklyText,
  orphanedSubjects,
  snapshotSubjects,
} from "../src/admin/access-policy.js";
import { FIXTURE_WEEKLY, fakeClock, policyFixture } from "./helpers/access-policy-fixtures.js";

// Monday 2026-10-05, 05:00 UTC = 13:00 Asia/Shanghai (inside 09:00–18:00).
const MONDAY_INSIDE = Date.parse("2026-10-05T05:00:00.000Z");
// Same Monday, 11:00 UTC = 19:00 Asia/Shanghai (outside the window).
const MONDAY_OUTSIDE = Date.parse("2026-10-05T11:00:00.000Z");
// Tuesday 2026-10-06, 01:00 UTC = 09:00 Asia/Shanghai (next opening).
const TUESDAY_OPEN = "2026-10-06T01:00:00.000Z";

async function makeStore(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "admin-access-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "access-policy.json");
  const store = createAccessPolicyStore({ file });
  await store.ready;
  return { dir, file, store };
}

function suspendDraft(overrides = {}) {
  return {
    label: "工作时间",
    subjects: ["oauth-user:u1"],
    mode: "suspend",
    capabilities: ["scope:obsidian.read"],
    timezone: "Asia/Shanghai",
    weekly: { ...FIXTURE_WEEKLY },
    ...overrides,
  };
}

test("create/list/update/enable/disable/delete persist through the real store with a monotonic revision", async (t) => {
  const { file, store } = await makeStore(t);
  const clock = fakeClock(MONDAY_INSIDE);
  const admin = createAccessPolicyAdmin({ store, runtime: null, now: clock.now });

  const created = await admin.createPolicy(suspendDraft());
  assert.equal(created.ok, true);
  assert.equal(created.revision, 1);
  assert.equal(created.policy.label, "工作时间");
  assert.deepEqual(created.policy.subjects, ["oauth-user:u1"]);
  assert.equal(created.policy.createdAt, new Date(MONDAY_INSIDE).toISOString());
  assert.equal(created.policy.updatedAt, new Date(MONDAY_INSIDE).toISOString());
  assert.equal(Object.keys(created.policy).length, 13);

  // The durable file is exactly the committed snapshot (no pending buffer).
  const persisted = parseAccessPolicyDocument(await readFile(file, "utf8"));
  assert.equal(persisted.ok, true);
  assert.equal(persisted.document.revision, 1);
  assert.deepEqual(persisted.document.policies, store.snapshot().policies);

  const listed = await admin.listPolicies();
  assert.equal(listed.status, "ready");
  assert.equal(listed.revision, 1);
  assert.deepEqual(listed.policies, store.snapshot().policies);

  clock.advance(60_000);
  const updated = await admin.updatePolicy(created.policy.id, { label: "新标签" }, 1);
  assert.equal(updated.ok, true);
  assert.equal(updated.revision, 2);
  assert.equal(updated.policy.label, "新标签");
  assert.equal(updated.policy.createdAt, created.policy.createdAt, "createdAt is preserved across edits");
  assert.equal(updated.policy.updatedAt, new Date(MONDAY_INSIDE + 60_000).toISOString());

  const disabled = await admin.setEnabled(created.policy.id, false, 2);
  assert.equal(disabled.ok, true);
  assert.equal(disabled.revision, 3);
  assert.equal(disabled.policy.enabled, false);
  assert.equal(store.snapshot().policies[0].enabled, false);

  const deleted = await admin.deletePolicy(created.policy.id, 3);
  assert.equal(deleted.ok, true);
  assert.equal(deleted.revision, 4);
  assert.deepEqual((await admin.listPolicies()).policies, []);
});

test("stale revisions lose the CAS race; the first writer's commit is never overwritten", async (t) => {
  const { store } = await makeStore(t);
  const admin = createAccessPolicyAdmin({ store, now: () => MONDAY_INSIDE });
  const created = await admin.createPolicy(suspendDraft());
  assert.equal(created.revision, 1);

  // Two writers both read revision 0 before the create: A (the create) won,
  // B must be rejected with the frozen stale code and a truthful `current`.
  const loser = await admin.updatePolicy(created.policy.id, { label: "loser" }, 0);
  assert.equal(loser.ok, false);
  assert.equal(loser.code, ACCESS_POLICY_CODES.STALE_REVISION);
  assert.equal(loser.current.revision, 1);
  assert.equal(store.snapshot().policies[0].label, "工作时间");

  const loserCreate = await admin.createPolicy(suspendDraft({ label: "second" }), 0);
  assert.equal(loserCreate.ok, false);
  assert.equal(loserCreate.code, ACCESS_POLICY_CODES.STALE_REVISION);
  assert.equal(store.snapshot().policies.length, 1);

  const loserDelete = await admin.deletePolicy(created.policy.id, 0);
  assert.equal(loserDelete.code, ACCESS_POLICY_CODES.STALE_REVISION);
  assert.equal(store.snapshot().policies.length, 1);
});

test("invalid drafts return the specific code and leave the store untouched", async (t) => {
  const { store } = await makeStore(t);
  const admin = createAccessPolicyAdmin({ store, now: () => MONDAY_INSIDE });

  const cases = [
    ["revoke requires all", suspendDraft({ mode: "revoke", capabilities: ["scope:obsidian.read"] }), ACCESS_POLICY_CODES.REVOKE_REQUIRES_ALL],
    ["cross midnight", suspendDraft({ weekly: { mon: [["22:00", "02:00"]] } }), ACCESS_POLICY_CODES.INVALID_WINDOW],
    ["unknown subject namespace", suspendDraft({ subjects: ["user:alice"] }), ACCESS_POLICY_CODES.UNKNOWN_SUBJECT],
    ["unknown capability", suspendDraft({ capabilities: ["scope:obsidian.nope"] }), ACCESS_POLICY_CODES.UNKNOWN_CAPABILITY],
    ["unknown timezone", suspendDraft({ timezone: "Mars/Olympus" }), ACCESS_POLICY_CODES.INVALID_TIMEZONE],
    ["no time constraint", suspendDraft({ weekly: {}, dateRanges: [], startsAt: null, expiresAt: null }), ACCESS_POLICY_CODES.INVALID_POLICY],
  ];
  for (const [name, draft, code] of cases) {
    const result = await admin.createPolicy(draft);
    assert.equal(result.ok, false, name);
    assert.equal(result.code, code, name);
    assert.equal(store.snapshot().revision, 0, name);
    assert.deepEqual(store.snapshot().policies, [], name);
  }

  // A valid policy commits; an invalid *update* must not disturb it.
  const created = await admin.createPolicy(suspendDraft());
  assert.equal(created.ok, true);
  const badUpdate = await admin.updatePolicy(created.policy.id, { mode: "revoke", capabilities: ["scope:obsidian.read"] }, 1);
  assert.equal(badUpdate.ok, false);
  assert.equal(badUpdate.code, ACCESS_POLICY_CODES.REVOKE_REQUIRES_ALL);
  assert.equal(store.snapshot().revision, 1);
  assert.equal(store.snapshot().policies[0].mode, "suspend");
});

test("unknown policy ids are reported and writes never happen", async (t) => {
  const { store } = await makeStore(t);
  const admin = createAccessPolicyAdmin({ store, now: () => MONDAY_INSIDE });
  const missingId = "11111111-1111-4111-8111-111111111111";
  assert.equal((await admin.updatePolicy(missingId, { label: "x" }, 0)).code, ACCESS_POLICY_ADMIN_CODES.UNKNOWN_POLICY_ID);
  assert.equal((await admin.setEnabled(missingId, false, 0)).code, ACCESS_POLICY_ADMIN_CODES.UNKNOWN_POLICY_ID);
  assert.equal((await admin.deletePolicy(missingId, 0)).code, ACCESS_POLICY_ADMIN_CODES.UNKNOWN_POLICY_ID);
  assert.equal(store.snapshot().revision, 0);
});

test("previewForSubject reports the current decision and the next opening", async (t) => {
  const { store } = await makeStore(t);
  const clock = fakeClock(MONDAY_INSIDE);
  const runtime = createAccessPolicyRuntime({ enabled: true, store, now: clock.now });
  await runtime.ready;
  const admin = createAccessPolicyAdmin({ store, runtime, now: clock.now });
  const created = await admin.createPolicy(suspendDraft());
  assert.equal(created.ok, true);

  const inside = await admin.previewForSubject("oauth-user:u1");
  assert.equal(inside.subject, "oauth-user:u1");
  assert.equal(inside.decision.allowed, true);
  assert.equal(inside.timezone, "Asia/Shanghai");
  assert.equal(inside.nextAllowedAt, new Date(MONDAY_INSIDE).toISOString(), "inside the window the current instant is allowed");
  assert.equal(inside.now, new Date(MONDAY_INSIDE).toISOString());

  clock.set(MONDAY_OUTSIDE);
  const outside = await admin.previewForSubject("oauth-user:u1");
  assert.equal(outside.decision.allowed, false);
  assert.equal(outside.decision.mode, "suspend");
  assert.equal(outside.decision.reason, "outside_window");
  assert.equal(outside.decision.denyPolicyId, created.policy.id);
  assert.deepEqual(outside.decision.matchedPolicyIds, [created.policy.id]);
  assert.equal(outside.nextAllowedAt, TUESDAY_OPEN);
  assert.equal(typeof outside.nextChangeAt, "string");

  const other = await admin.previewForSubject("oauth-user:nobody");
  assert.equal(other.decision.allowed, true);
  assert.equal(other.decision.reason, "no_matching_policy");
  assert.equal(other.timezone, null);
});

test("orphaned subjects are flagged for the operator but never block a save", async (t) => {
  const { store } = await makeStore(t);
  const admin = createAccessPolicyAdmin({ store, now: () => MONDAY_INSIDE });

  const created = await admin.createPolicy(suspendDraft({ subjects: ["oauth-user:ghost"] }));
  assert.equal(created.ok, true, "an orphaned subject must not be rejected");

  const listed = await admin.listPolicies({ subjects: ["oauth-user:u2", "api-key:configured-env"] });
  assert.deepEqual(listed.orphaned, ["oauth-user:ghost"]);
  assert.equal(listed.policies.length, 1);
  assert.deepEqual(listed.policies[0].subjects, ["oauth-user:ghost"]);

  // No list provided -> orphan state is simply not computed.
  assert.deepEqual((await admin.listPolicies()).orphaned, []);

  const known = snapshotSubjects({
    apiKeys: [{ id: "key-1" }],
    clients: [{ clientId: "client-1" }],
    oauthUsers: [{ id: "u1" }],
  }, { configuredApiKeyEnabled: true });
  assert.deepEqual(known, ["api-key:configured-env", "api-key:key-1", "oauth-client:client-1", "oauth-user:u1"]);
  assert.deepEqual(orphanedSubjects(listed.policies, known), ["oauth-user:ghost"]);
  assert.deepEqual(orphanedSubjects(listed.policies, ["oauth-user:ghost"]), []);
});

test("repairFromCandidate recovers a broken store to ready at old revision + 1", async (t) => {
  const { dir } = await makeStore(t);
  const file = path.join(dir, "broken.json");
  await writeFile(file, "{ this is not valid json", "utf8");
  const store = createAccessPolicyStore({ file });
  await store.ready;
  assert.equal(store.snapshot().status, "broken");
  assert.equal(store.snapshot().revision, null);
  const admin = createAccessPolicyAdmin({ store, now: () => MONDAY_INSIDE });

  const rejected = await admin.repairFromCandidate("{ still not json");
  assert.equal(rejected.ok, false);
  assert.equal(store.snapshot().status, "broken", "a rejected repair must not publish a snapshot");

  const repaired = await admin.repairFromCandidate({ schemaVersion: 1, revision: 0, policies: [policyFixture()] });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.revision, 1);
  assert.equal(store.snapshot().status, "ready");
  assert.equal(store.snapshot().revision, 1);
  assert.equal(store.snapshot().policies.length, 1);

  // The repair surface is a normal write path afterwards.
  const created = await admin.createPolicy(suspendDraft());
  assert.equal(created.ok, true);
  assert.equal(created.revision, 2);
});

test("writes fail closed while the store is broken; the repair surface stays reachable", async (t) => {
  const { dir } = await makeStore(t);
  const file = path.join(dir, "broken.json");
  await writeFile(file, "{ broken", "utf8");
  const store = createAccessPolicyStore({ file });
  await store.ready;
  const admin = createAccessPolicyAdmin({ store, now: () => MONDAY_INSIDE });

  const result = await admin.createPolicy(suspendDraft());
  assert.equal(result.ok, false);
  assert.equal(result.code, ACCESS_POLICY_ADMIN_CODES.STORE_UNAVAILABLE);
  assert.equal(result.current.status, "broken");

  const listed = await admin.listPolicies();
  assert.equal(listed.status, "broken");
  assert.deepEqual(listed.policies, []);
  assert.equal(listed.revision, null);
});

test("the Admin service is not gated by its own suspend/revoke policies", async (t) => {
  const { store } = await makeStore(t);
  const clock = fakeClock(MONDAY_OUTSIDE);
  const runtime = createAccessPolicyRuntime({ enabled: true, store, now: clock.now });
  await runtime.ready;
  const admin = createAccessPolicyAdmin({ store, runtime, now: clock.now });

  // A revoke policy that names the Admin operator and is outside its window.
  const block = await admin.createPolicy({
    label: "block admin",
    subjects: ["oauth-user:admin"],
    mode: "revoke",
    capabilities: ["all"],
    timezone: "Asia/Shanghai",
    weekly: { mon: [["09:00", "18:00"]] },
  });
  assert.equal(block.ok, true);

  // Every Admin CRUD still succeeds while the operator is "revoked".
  const second = await admin.createPolicy(suspendDraft({ subjects: ["oauth-user:u1"] }), 1);
  assert.equal(second.ok, true);
  assert.equal(second.revision, 2);
  const disabled = await admin.setEnabled(second.policy.id, false, 2);
  assert.equal(disabled.ok, true);
  assert.equal(disabled.revision, 3);

  // The service reports (not enforces) the revoke: the preview is denied while
  // the policy is still present.
  const preview = await admin.previewForSubject("oauth-user:admin");
  assert.equal(preview.decision.allowed, false);
  assert.equal(preview.decision.mode, "revoke");

  const removed = await admin.deletePolicy(block.policy.id, 3);
  assert.equal(removed.ok, true);
  assert.equal(removed.revision, 4);
});

test("revision tokens accept numeric strings but a malformed token fails closed", async (t) => {
  const { store } = await makeStore(t);
  const admin = createAccessPolicyAdmin({ store, now: () => MONDAY_INSIDE });
  const created = await admin.createPolicy(suspendDraft());
  assert.equal(created.revision, 1);

  // A form-encoded revision ("1") still wins its CAS slot.
  const updated = await admin.updatePolicy(created.policy.id, { label: "string rev" }, "1");
  assert.equal(updated.ok, true);
  assert.equal(updated.revision, 2);

  // A malformed token must not be read as "use current" (that would be a
  // silent lost update when Wave C forwards a raw form field).
  const malformed = await admin.updatePolicy(created.policy.id, { label: "bad" }, "not-a-revision");
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, ACCESS_POLICY_CODES.STALE_REVISION);
  assert.equal(store.snapshot().revision, 2);
  assert.equal(store.snapshot().policies[0].label, "string rev");
  assert.equal((await admin.deletePolicy(created.policy.id, "NaN")).code, ACCESS_POLICY_CODES.STALE_REVISION);
  assert.equal(store.snapshot().policies.length, 1);
});

test("form-shaped drafts (text weekly/date ranges, string flags) normalize to the frozen document", async (t) => {
  const { store } = await makeStore(t);
  const admin = createAccessPolicyAdmin({ store, now: () => MONDAY_INSIDE });
  const created = await admin.createPolicy({
    label: "form",
    subjects: "oauth-user:u1,oauth-user:u1",
    mode: "suspend",
    capabilities: "scope:obsidian.read scope:obsidian.write",
    timezone: "Asia/Shanghai",
    weekly: "mon 09:00-18:00\ntue 09:00-12:00",
    dateRanges: "2026-10-01..2026-10-07",
    enabled: "true",
    startsAt: "",
    expiresAt: "",
  });
  assert.equal(created.ok, true);
  assert.deepEqual(created.policy.subjects, ["oauth-user:u1"]);
  assert.deepEqual(created.policy.capabilities, ["scope:obsidian.read", "scope:obsidian.write"]);
  assert.deepEqual(created.policy.weekly.mon, [["09:00", "18:00"]]);
  assert.deepEqual(created.policy.dateRanges, [{ from: "2026-10-01", to: "2026-10-07" }]);
  assert.equal(created.policy.enabled, true);
  assert.equal(created.policy.startsAt, null);

  const roundTrip = await admin.updatePolicy(created.policy.id, {
    weekly: formatWeeklyText(created.policy.weekly),
    dateRanges: formatDateRangesText(created.policy.dateRanges),
  }, 1);
  assert.equal(roundTrip.ok, true);
  assert.deepEqual(roundTrip.policy.weekly, created.policy.weekly);
  assert.deepEqual(roundTrip.policy.dateRanges, created.policy.dateRanges);
});
