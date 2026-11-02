// Focused tests for the AuthZ decision core (app/src/access-policy/evaluate.js)
// and the frozen error taxonomy (app/src/access-policy/errors.js).
//
// Pure functions only: a snapshot and an instant are injected explicitly.
// No store, no I/O, no host clock.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ACCESS_DENY_CODES,
  ACCESS_POLICY_CODES,
  AccessPolicyError,
  isAccessPolicyError,
} from "../src/access-policy/errors.js";
import { evaluateAccess, explainAccess } from "../src/access-policy/evaluate.js";

const at = (iso) => Date.parse(iso);
const NOW = at("2026-10-05T10:00:00.000Z"); // Monday 10:00 UTC
const SUBJECTS = ["oauth-user:user-1", "oauth-client:client-1"];
const CAPABILITIES = ["all", "surface:mcp", "scope:obsidian.read"];

function policyOf(overrides = {}) {
  return {
    id: "policy-1",
    label: "fixture",
    enabled: true,
    subjects: ["oauth-user:user-1"],
    mode: "suspend",
    capabilities: ["scope:obsidian.read"],
    timezone: "UTC",
    weekly: {},
    dateRanges: [],
    startsAt: null,
    expiresAt: null,
    ...overrides,
  };
}

const readySnapshot = (policies, revision = 7) => ({ status: "ready", revision, policies });
const weekly = (id, timezone, mon, overrides = {}) => policyOf({ id, timezone, weekly: { mon }, ...overrides });
const OPENS_9_12 = [["09:00", "12:00"]]; // satisfied at NOW
const OPENS_1_2 = [["01:00", "02:00"]]; // denied at NOW

test("error taxonomy exposes the frozen codes and error shape", () => {
  assert.deepEqual(ACCESS_POLICY_CODES, {
    INVALID_DOCUMENT: "invalid_access_policy",
    INVALID_POLICY: "invalid_access_policy_record",
    UNSUPPORTED_SCHEMA: "unsupported_access_policy_schema",
    LIMIT_EXCEEDED: "access_policy_limit_exceeded",
    UNKNOWN_SUBJECT: "unknown_access_policy_subject",
    UNKNOWN_CAPABILITY: "unknown_access_policy_capability",
    INVALID_TIMEZONE: "invalid_access_policy_timezone",
    INVALID_WINDOW: "invalid_access_policy_window",
    REVOKE_REQUIRES_ALL: "revoke_requires_all_capability",
    STALE_REVISION: "stale_policy_revision",
    STORE_IO: "access_policy_store_io_error",
  });
  assert.deepEqual(ACCESS_DENY_CODES, {
    OUTSIDE_WINDOW: "outside_authorized_window",
    POLICY_UNAVAILABLE: "authorization_policy_unavailable",
  });
  assert.ok(Object.isFrozen(ACCESS_POLICY_CODES));
  assert.ok(Object.isFrozen(ACCESS_DENY_CODES));

  const error = new AccessPolicyError(ACCESS_POLICY_CODES.INVALID_WINDOW, "bad window", {
    details: { path: "policies[0].weekly" },
  });
  assert.ok(error instanceof Error);
  assert.equal(error.name, "AccessPolicyError");
  assert.equal(error.code, "invalid_access_policy_window");
  assert.deepEqual(error.details, { path: "policies[0].weekly" });
  assert.equal(isAccessPolicyError(error), true);
  assert.equal(isAccessPolicyError(new Error("plain")), false);
  assert.equal(isAccessPolicyError(null), false);

  const noDetails = new AccessPolicyError(ACCESS_POLICY_CODES.STORE_IO);
  assert.equal(noDetails.message, "access_policy_store_io_error");
  assert.equal(noDetails.details, undefined);
});

test("empty policies allow as no_matching_policy", () => {
  const decision = evaluateAccess({ snapshot: readySnapshot([]), subjects: SUBJECTS, capabilities: CAPABILITIES, nowMs: NOW });
  assert.deepEqual(decision, {
    allowed: true,
    mode: null,
    reason: "no_matching_policy",
    denyPolicyId: null,
    matchedPolicyIds: [],
  });
});

test("disabled, subject-mismatched and capability-mismatched policies are ignored", () => {
  const policies = [
    policyOf({ id: "disabled", enabled: false, weekly: { mon: OPENS_1_2 } }),
    policyOf({ id: "other-subject", subjects: ["oauth-user:someone-else"], weekly: { mon: OPENS_1_2 } }),
    policyOf({ id: "other-capability", capabilities: ["tool:other"], weekly: { mon: OPENS_1_2 } }),
  ];
  const decision = evaluateAccess({ snapshot: readySnapshot(policies), subjects: SUBJECTS, capabilities: CAPABILITIES, nowMs: NOW });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "no_matching_policy");
  assert.deepEqual(decision.matchedPolicyIds, []);
});

test("one passing and one denying match deny with the denying policy id", () => {
  const policies = [
    weekly("allow-a", "UTC", OPENS_9_12),
    weekly("deny-b", "UTC", OPENS_1_2),
  ];
  const decision = evaluateAccess({ snapshot: readySnapshot(policies), subjects: SUBJECTS, capabilities: CAPABILITIES, nowMs: NOW });
  assert.deepEqual(decision, {
    allowed: false,
    mode: "suspend",
    reason: "outside_window",
    denyPolicyId: "deny-b",
    matchedPolicyIds: ["allow-a", "deny-b"],
  });
});

test("all matching policies passing allow and report every matched id in document order", () => {
  const policies = [
    weekly("allow-a", "UTC", OPENS_9_12),
    weekly("allow-b", "UTC", [["08:00", "18:00"]]),
  ];
  const decision = evaluateAccess({ snapshot: readySnapshot(policies), subjects: SUBJECTS, capabilities: CAPABILITIES, nowMs: NOW });
  assert.deepEqual(decision, {
    allowed: true,
    mode: null,
    reason: "allowed",
    denyPolicyId: null,
    matchedPolicyIds: ["allow-a", "allow-b"],
  });
});

test("oauth-user and oauth-client subjects can both match", () => {
  const policies = [
    policyOf({ id: "user-rule", subjects: ["oauth-user:user-1"] }),
    policyOf({ id: "client-rule", subjects: ["oauth-client:client-1"] }),
  ];
  const decision = evaluateAccess({ snapshot: readySnapshot(policies), subjects: SUBJECTS, capabilities: CAPABILITIES, nowMs: NOW });
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.matchedPolicyIds, ["user-rule", "client-rule"]);
});

test("revoke wins over suspend and denyPolicyId is the first denied policy with the final mode", () => {
  const policies = [
    weekly("suspend-a", "UTC", OPENS_1_2),
    weekly("revoke-b", "UTC", OPENS_1_2, { mode: "revoke", capabilities: ["all"] }),
    weekly("suspend-c", "UTC", OPENS_1_2),
    weekly("revoke-d", "UTC", OPENS_1_2, { mode: "revoke", capabilities: ["all"] }),
  ];
  const decision = evaluateAccess({ snapshot: readySnapshot(policies), subjects: SUBJECTS, capabilities: CAPABILITIES, nowMs: NOW });
  assert.equal(decision.allowed, false);
  assert.equal(decision.mode, "revoke");
  assert.equal(decision.denyPolicyId, "revoke-b");
  assert.deepEqual(decision.matchedPolicyIds, ["suspend-a", "revoke-b", "suspend-c", "revoke-d"]);
});

test("a passing revoke policy does not upgrade a suspend denial", () => {
  const policies = [
    weekly("suspend-a", "UTC", OPENS_1_2),
    weekly("revoke-b", "UTC", OPENS_9_12, { mode: "revoke", capabilities: ["all"] }),
  ];
  const decision = evaluateAccess({ snapshot: readySnapshot(policies), subjects: SUBJECTS, capabilities: CAPABILITIES, nowMs: NOW });
  assert.equal(decision.allowed, false);
  assert.equal(decision.mode, "suspend");
  assert.equal(decision.denyPolicyId, "suspend-a");
  assert.deepEqual(decision.matchedPolicyIds, ["suspend-a", "revoke-b"]);
});

test("a broken snapshot is policy_unavailable and never degrades to allow", () => {
  for (const policies of [[], [weekly("deny-b", "UTC", OPENS_1_2)]]) {
    const snapshot = { status: "broken", revision: null, policies, errorCode: ACCESS_POLICY_CODES.STORE_IO };
    const decision = evaluateAccess({ snapshot, subjects: SUBJECTS, capabilities: CAPABILITIES, nowMs: NOW });
    assert.deepEqual(decision, {
      allowed: false,
      mode: null,
      reason: "policy_unavailable",
      denyPolicyId: null,
      matchedPolicyIds: [],
    });
  }
  const missing = evaluateAccess({ snapshot: undefined, subjects: SUBJECTS, capabilities: CAPABILITIES, nowMs: NOW });
  assert.equal(missing.allowed, false);
  assert.equal(missing.reason, "policy_unavailable");
});

test("explainAccess reports the injected instant, timezone and next boundaries", () => {
  const policies = [
    weekly("allow-a", "Asia/Shanghai", [["17:00", "19:00"]]), // local 18:00 at NOW
    weekly("allow-b", "UTC", [["08:00", "18:00"]]),
  ];
  const explanation = explainAccess({ snapshot: readySnapshot(policies), subjects: SUBJECTS, capabilities: CAPABILITIES, nowMs: NOW });
  assert.deepEqual(Object.keys(explanation), [
    "allowed", "mode", "reason", "denyPolicyId", "matchedPolicyIds", "now", "timezone", "nextChangeAt", "nextAllowedAt",
  ]);
  assert.equal(explanation.allowed, true);
  assert.equal(explanation.now, "2026-10-05T10:00:00.000Z");
  assert.equal(explanation.timezone, "Asia/Shanghai");
  assert.equal(explanation.nextAllowedAt, "2026-10-05T10:00:00.000Z");
  assert.equal(explanation.nextChangeAt, "2026-10-05T11:00:00.000Z"); // 19:00 Asia/Shanghai
});

test("explainAccess returns null boundaries for an unmatched request", () => {
  const explanation = explainAccess({
    snapshot: readySnapshot([weekly("allow-a", "UTC", OPENS_9_12)]),
    subjects: ["api-key:configured-env"],
    capabilities: CAPABILITIES,
    nowMs: NOW,
  });
  assert.equal(explanation.reason, "no_matching_policy");
  assert.equal(explanation.timezone, null);
  assert.equal(explanation.nextChangeAt, null);
  assert.equal(explanation.nextAllowedAt, null);
  assert.equal(explanation.now, "2026-10-05T10:00:00.000Z");
});

test("explainAccess uses the deny policy timezone and a union search across matched policies", () => {
  const policies = [
    weekly("early", "Europe/Berlin", [["13:00", "18:00"]]), // local 12:00 at NOW
    weekly("late", "Europe/Berlin", [["15:00", "17:00"]]),
  ];
  const explanation = explainAccess({ snapshot: readySnapshot(policies), subjects: SUBJECTS, capabilities: CAPABILITIES, nowMs: NOW });
  assert.equal(explanation.allowed, false);
  assert.equal(explanation.mode, "suspend");
  assert.equal(explanation.denyPolicyId, "early");
  assert.equal(explanation.timezone, "Europe/Berlin");
  assert.equal(explanation.nextChangeAt, "2026-10-05T11:00:00.000Z"); // 13:00 Europe/Berlin
  assert.equal(explanation.nextAllowedAt, "2026-10-05T13:00:00.000Z"); // 15:00 Europe/Berlin
});

test("explainAccess returns a null nextAllowedAt when a matched policy has no future window", () => {
  const policies = [
    weekly("early", "UTC", [["13:00", "18:00"]]),
    policyOf({ id: "past-only", timezone: "UTC", dateRanges: [{ from: "2026-01-01", to: "2026-01-02" }] }),
  ];
  const explanation = explainAccess({ snapshot: readySnapshot(policies), subjects: SUBJECTS, capabilities: CAPABILITIES, nowMs: NOW });
  assert.equal(explanation.allowed, false);
  assert.equal(explanation.nextAllowedAt, null);
});

test("explainAccess on a broken snapshot exposes no policy detail", () => {
  const snapshot = { status: "broken", revision: null, policies: [], errorCode: ACCESS_POLICY_CODES.INVALID_DOCUMENT };
  const explanation = explainAccess({ snapshot, subjects: SUBJECTS, capabilities: CAPABILITIES, nowMs: NOW });
  assert.equal(explanation.allowed, false);
  assert.equal(explanation.reason, "policy_unavailable");
  assert.equal(explanation.timezone, null);
  assert.equal(explanation.nextChangeAt, null);
  assert.equal(explanation.nextAllowedAt, null);
});

test("the hot path returns only the frozen decision fields and never calls nextTransition", async () => {
  const decision = evaluateAccess({ snapshot: readySnapshot([]), subjects: SUBJECTS, capabilities: CAPABILITIES, nowMs: NOW });
  assert.deepEqual(Object.keys(decision), ["allowed", "mode", "reason", "denyPolicyId", "matchedPolicyIds"]);
  assert.equal("nextChangeAt" in decision, false);
  assert.equal("nextAllowedAt" in decision, false);

  const source = await readFile(new URL("../src/access-policy/evaluate.js", import.meta.url), "utf8");
  const hotPath = source.slice(source.indexOf("export function evaluateAccess"), source.indexOf("function unionNextAllowed"));
  assert.equal(hotPath.includes("nextTransition"), false, "evaluateAccess must not search future transitions");
  assert.equal(/Date\.now\s*\(/.test(source), false, "evaluate.js must not read Date.now()");
});
