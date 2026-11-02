// Focused tests for AuthZ Wave A / A3 access-policy document schema
// (app/src/access-policy/schema.js). Pure module tests: no I/O, no clock.
// Contract: scratch/authz/INTERFACE.md §7.

import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_NAMES } from "../src/config.js";
import { AccessPolicyError } from "../src/access-policy/errors.js";
import {
  ACCESS_POLICY_LIMITS,
  ACCESS_POLICY_SCHEMA_VERSION,
  isPolicyId,
  newPolicyId,
  parseAccessPolicyDocument,
  serializeAccessPolicyDocument,
  validateAccessPolicyDocument,
} from "../src/access-policy/schema.js";

const POLICY_KEYS = [
  "id", "label", "enabled", "subjects", "mode", "capabilities", "timezone",
  "weekly", "dateRanges", "startsAt", "expiresAt", "createdAt", "updatedAt",
];

function basePolicy(overrides = {}) {
  return {
    id: newPolicyId(),
    label: "work hours",
    enabled: true,
    subjects: ["oauth-user:u1"],
    mode: "suspend",
    capabilities: ["scope:obsidian.write"],
    timezone: "Asia/Shanghai",
    weekly: { mon: [["09:00", "18:00"]] },
    dateRanges: [],
    startsAt: null,
    expiresAt: null,
    createdAt: "2026-10-05T00:00:00+08:00",
    updatedAt: "2026-10-05T00:00:00+08:00",
    ...overrides,
  };
}

function baseDocument(policies = [basePolicy()], revision = 3) {
  return { schemaVersion: ACCESS_POLICY_SCHEMA_VERSION, revision, policies };
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
}

test("valid document normalizes to the frozen three keys and 13 policy keys", () => {
  const document = validateAccessPolicyDocument(baseDocument());
  assert.deepEqual(Object.keys(document), ["schemaVersion", "revision", "policies"]);
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.revision, 3);
  assert.equal(document.policies.length, 1);
  assert.deepEqual(Object.keys(document.policies[0]), POLICY_KEYS);
  // createdAt/updatedAt + startsAt/expiresAt normalize to ISO Z.
  assert.equal(document.policies[0].createdAt, "2026-10-04T16:00:00.000Z");
});

test("newPolicyId/isPolicyId follow the UUID v1-5 shape", () => {
  const id = newPolicyId();
  assert.equal(isPolicyId(id), true);
  for (const value of ["", "x", "not-a-uuid", "7a3551da-261a-4d7a-9e09-d58eb265ca0", null, 42, {}]) {
    assert.equal(isPolicyId(value), false, `${JSON.stringify(value)} must not be a policy id`);
  }
  assert.equal(isPolicyId(id.toUpperCase()), true);
});

test("unknown fields at any level are rejected", () => {
  const topLevel = baseDocument();
  topLevel.extra = true;
  assert.equal(codeOf(() => validateAccessPolicyDocument(topLevel)), "invalid_access_policy");
  const policyLevel = baseDocument();
  policyLevel.policies[0].extra = true;
  assert.equal(codeOf(() => validateAccessPolicyDocument(policyLevel)), "invalid_access_policy_record");
  const rangeLevel = baseDocument([basePolicy({ weekly: {}, dateRanges: [{ from: "2026-01-01", to: "2026-01-02", extra: 1 }] })]);
  assert.equal(codeOf(() => validateAccessPolicyDocument(rangeLevel)), "invalid_access_policy_record");
});

test("unsupported schema versions and bad revisions are rejected", () => {
  assert.equal(codeOf(() => validateAccessPolicyDocument({ ...baseDocument(), schemaVersion: 2 })), "unsupported_access_policy_schema");
  assert.equal(codeOf(() => validateAccessPolicyDocument({ ...baseDocument(), schemaVersion: "1" })), "unsupported_access_policy_schema");
  for (const revision of [-1, 1.5, "3", null, undefined]) {
    const document = { schemaVersion: 1, revision, policies: [basePolicy()] };
    assert.equal(codeOf(() => validateAccessPolicyDocument(document)), "invalid_access_policy");
  }
});

test("duplicate policy ids are rejected", () => {
  const id = newPolicyId();
  const document = baseDocument([basePolicy({ id }), basePolicy({ id })]);
  assert.equal(codeOf(() => validateAccessPolicyDocument(document)), "invalid_access_policy");
});

test("hard bounds trigger LIMIT_EXCEEDED", async (t) => {
  const distinctSubjects = (count) => Array.from({ length: count }, (_, index) => `oauth-user:u${index}`);
  const distinctCapabilities = (count) => TOOL_NAMES.slice(0, count).map((name) => `tool:${name}`);
  const intervals = (count) => Array.from({ length: count }, () => ["00:00", "00:01"]);
  const ranges = (count) => Array.from({ length: count }, () => ({ from: "2026-01-01", to: "2026-01-02" }));
  assert.ok(TOOL_NAMES.length >= 65, "the catalog must provide >= 65 distinct tools for the capability bound");

  const cases = [
    ["policies", () => baseDocument(Array.from({ length: ACCESS_POLICY_LIMITS.maxPolicies + 1 }, () => basePolicy()))],
    ["subjects", () => baseDocument([basePolicy({ subjects: distinctSubjects(33) })])],
    ["capabilities", () => baseDocument([basePolicy({ capabilities: distinctCapabilities(65) })])],
    ["weekly", () => baseDocument([basePolicy({ weekly: { mon: intervals(65) } })])],
    ["dateRanges", () => baseDocument([basePolicy({ weekly: {}, dateRanges: ranges(65) })])],
    ["label", () => baseDocument([basePolicy({ label: "a".repeat(121) })])],
    ["timezone", () => baseDocument([basePolicy({ timezone: "A".repeat(81) })])],
  ];
  for (const [name, make] of cases) {
    await t.test(name, () => assert.equal(codeOf(() => validateAccessPolicyDocument(make())), "access_policy_limit_exceeded"));
  }
  await t.test("fileBytes", () => {
    const result = parseAccessPolicyDocument("x".repeat(ACCESS_POLICY_LIMITS.fileBytes + 1));
    assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code: "access_policy_limit_exceeded" });
  });
  // The exact upper bound is still accepted.
  assert.equal(codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({
    subjects: distinctSubjects(32),
    capabilities: distinctCapabilities(64),
  })]))), null);
  assert.equal(codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({
    weekly: { mon: intervals(64) },
  })]))), null);
});

test("subjects and capabilities dedupe keeping the first occurrence", () => {
  const document = validateAccessPolicyDocument(baseDocument([basePolicy({
    subjects: ["oauth-user:b", "oauth-user:a", "oauth-user:b"],
    capabilities: ["scope:obsidian.write", "all", "scope:obsidian.write"],
  })]));
  assert.deepEqual(document.policies[0].subjects, ["oauth-user:b", "oauth-user:a"]);
  assert.deepEqual(document.policies[0].capabilities, ["scope:obsidian.write", "all"]);
});

test("a policy needs at least one time constraint", () => {
  const document = baseDocument([basePolicy({ weekly: {}, dateRanges: [], startsAt: null, expiresAt: null })]);
  assert.equal(codeOf(() => validateAccessPolicyDocument(document)), "invalid_access_policy_record");
  assert.equal(codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({
    weekly: {}, dateRanges: [], startsAt: "2026-10-05T00:00:00Z", expiresAt: null,
  })]))), null);
  assert.equal(codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({
    weekly: {}, dateRanges: [], startsAt: null, expiresAt: "2027-01-01T00:00:00Z",
  })]))), null);
});

test("weekly windows never cross midnight and never invert", async (t) => {
  const cases = [
    ["crosses midnight", [["22:00", "02:00"]]],
    ["equal bounds", [["09:00", "09:00"]]],
    ["inverted bounds", [["18:00", "09:00"]]],
    ["24:00 as start", [["24:00", "24:00"]]],
    ["bad minute", [["09:60", "10:00"]]],
  ];
  for (const [name, intervals] of cases) {
    await t.test(name, () => assert.equal(
      codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({ weekly: { mon: intervals } })]))),
      "invalid_access_policy_window",
    ));
  }
  await t.test("24:00 as end is legal", () => assert.equal(
    codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({ weekly: { mon: [["00:00", "24:00"]] } })]))),
    null,
  ));
  await t.test("unknown weekday is rejected", () => assert.equal(
    codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({ weekly: { monday: [["09:00", "10:00"]] } })]))),
    "invalid_access_policy_record",
  ));
});

test("weekly normalizes day keys to lowercase and sorts intervals by start", () => {
  const document = validateAccessPolicyDocument(baseDocument([basePolicy({
    weekly: { MON: [["18:00", "19:00"], ["09:00", "10:00"]], sat: [["00:00", "24:00"]] },
  })]));
  assert.deepEqual(Object.keys(document.policies[0].weekly), ["mon", "sat"]);
  assert.deepEqual(document.policies[0].weekly.mon, [["09:00", "10:00"], ["18:00", "19:00"]]);
  assert.deepEqual(document.policies[0].weekly.sat, [["00:00", "24:00"]]);
});

test("dateRanges require real calendar dates and ordered bounds", async (t) => {
  const invalid = [
    ["non-calendar day", [{ from: "2026-02-30", to: "2026-03-01" }]],
    ["reversed", [{ from: "2026-03-02", to: "2026-03-01" }]],
    ["non-leap Feb 29", [{ from: "2026-02-29", to: "2026-03-01" }]],
    ["out of range month", [{ from: "2026-13-01", to: "2026-13-02" }]],
  ];
  for (const [name, dateRanges] of invalid) {
    await t.test(name, () => assert.equal(
      codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({ weekly: {}, dateRanges })]))),
      "invalid_access_policy_window",
    ));
  }
  await t.test("leap Feb 29 is accepted", () => assert.equal(
    codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({ weekly: {}, dateRanges: [{ from: "2028-02-29", to: "2028-02-29" }] })]))),
    null,
  ));
});

test("startsAt/expiresAt ordering and ISO normalization", () => {
  const reversed = baseDocument([basePolicy({ startsAt: "2027-01-01T00:00:00Z", expiresAt: "2026-01-01T00:00:00Z" })]);
  assert.equal(codeOf(() => validateAccessPolicyDocument(reversed)), "invalid_access_policy_window");
  const equal = baseDocument([basePolicy({ startsAt: "2027-01-01T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z" })]);
  assert.equal(codeOf(() => validateAccessPolicyDocument(equal)), "invalid_access_policy_window");
  const offset = validateAccessPolicyDocument(baseDocument([basePolicy({ startsAt: "2026-10-05T08:00:00+08:00", expiresAt: "2026-10-06T00:00:00+08:00" })]));
  assert.equal(offset.policies[0].startsAt, "2026-10-05T00:00:00.000Z");
  assert.equal(offset.policies[0].expiresAt, "2026-10-05T16:00:00.000Z");
  const unparseable = baseDocument([basePolicy({ startsAt: "not-a-date", expiresAt: null })]);
  assert.equal(codeOf(() => validateAccessPolicyDocument(unparseable)), "invalid_access_policy_record");
});

test("timezones must pass the A1 Intl validator", () => {
  assert.equal(codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({ timezone: "Not/AZone" })]))), "invalid_access_policy_timezone");
  assert.equal(codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({ timezone: "" })]))), "invalid_access_policy_timezone");
  assert.equal(codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({ timezone: "UTC" })]))), null);
});

test("mode rules: revoke is all-only, suspend is non-empty", () => {
  assert.equal(codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({
    mode: "revoke", capabilities: ["all", "tool:get_note"],
  })]))), "revoke_requires_all_capability");
  assert.equal(codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({
    mode: "revoke", capabilities: [],
  })]))), "revoke_requires_all_capability");
  assert.equal(codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({
    mode: "revoke", capabilities: ["all"],
  })]))), null);
  assert.equal(codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({
    mode: "revoke", capabilities: ["all", "all"],
  })]))), null);
  assert.equal(codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({
    mode: "suspend", capabilities: ["all"],
  })]))), null);
  assert.equal(codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({
    mode: "suspend", capabilities: [],
  })]))), "invalid_access_policy_record");
  assert.equal(codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({ mode: "grant" })]))), "invalid_access_policy_record");
});

test("knownness fails closed after syntax", async (t) => {
  await t.test("unknown subject", () => assert.equal(
    codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({ subjects: ["user:1"] })]))),
    "unknown_access_policy_subject",
  ));
  const unknownCapabilities = [
    ["tool", ["tool:search_note"]],
    ["toolset", ["toolset:nope"]],
    ["resource", ["resource:obsidian://vault/nope"]],
    ["scope", ["scope:obsidian.admin"]],
    ["surface", ["surface:desktop"]],
    ["mixed", ["scope:obsidian.read", "scope:obsidian.admin"]],
  ];
  for (const [name, capabilities] of unknownCapabilities) {
    await t.test(`unknown ${name}`, () => assert.equal(
      codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({ capabilities })]))),
      "unknown_access_policy_capability",
    ));
  }
  await t.test("non-string capability", () => assert.equal(
    codeOf(() => validateAccessPolicyDocument(baseDocument([basePolicy({ capabilities: [42] })]))),
    "invalid_access_policy_record",
  ));
});

test("serialize/parse round-trips are idempotent", () => {
  const document = baseDocument([basePolicy({
    subjects: ["oauth-user:b", "oauth-user:a", "oauth-user:b"],
    weekly: { MON: [["18:00", "19:00"], ["09:00", "10:00"]] },
    startsAt: "2026-10-05T08:00:00+08:00",
    dateRanges: [{ from: "2026-10-01", to: "2026-10-31" }],
  })]);
  const normalized = validateAccessPolicyDocument(document);
  const text = serializeAccessPolicyDocument(normalized);
  const parsed = parseAccessPolicyDocument(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.document, normalized);
  assert.equal(serializeAccessPolicyDocument(parsed.document), text);
  assert.deepEqual(validateAccessPolicyDocument(parsed.document), parsed.document);
  assert.ok(text.endsWith("\n"));
  assert.equal(text.includes("\r"), false);
  assert.equal(text.split(/\r?\n/).at(-1), "");
});

test("parseAccessPolicyDocument never throws and never echoes content", () => {
  const valid = parseAccessPolicyDocument(baseDocument());
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.document, validateAccessPolicyDocument(baseDocument(valid.document.policies)));

  const corrupt = parseAccessPolicyDocument("{ not json");
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.code, "invalid_access_policy");
  assert.equal(typeof corrupt.detail, "string");

  for (const raw of [null, 42, [], "[]"]) {
    const result = parseAccessPolicyDocument(raw);
    assert.equal(result.ok, false, `${JSON.stringify(raw)} must not parse`);
    assert.equal(typeof result.code, "string");
  }

  const secret = baseDocument();
  secret.policies[0].secretField = "TOPSECRET-VALUE";
  const leaked = parseAccessPolicyDocument(secret);
  assert.equal(leaked.ok, false);
  assert.equal(JSON.stringify(leaked).includes("TOPSECRET-VALUE"), false);
});

test("validateAccessPolicyDocument throws AccessPolicyError with the frozen code", () => {
  assert.throws(
    () => validateAccessPolicyDocument({ ...baseDocument(), schemaVersion: 9 }),
    (error) => error instanceof AccessPolicyError && error.code === "unsupported_access_policy_schema" && error.name === "AccessPolicyError",
  );
});
