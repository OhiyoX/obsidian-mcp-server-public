// Focused tests for the AuthZ pure time core (app/src/access-policy/time.js).
//
// Every instant and timezone is explicit; no sleeps, no host-local timezone,
// no reliance on the machine clock. DST fixtures use Europe/Berlin
// 2026-03-29 (spring gap) and 2026-10-25 (fall repeat).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  WEEKDAYS,
  evaluatePolicySchedule,
  isValidTimeZone,
  localParts,
  nextTransition,
} from "../src/access-policy/time.js";

const UTC = "UTC";
const BERLIN = "Europe/Berlin";
const SHANGHAI = "Asia/Shanghai";
const at = (iso) => Date.parse(iso);

function policyOf(overrides = {}) {
  return {
    id: "policy-1",
    label: "fixture",
    enabled: true,
    subjects: ["api-key:configured-env"],
    mode: "suspend",
    capabilities: ["scope:obsidian.read"],
    timezone: UTC,
    weekly: {},
    dateRanges: [],
    startsAt: null,
    expiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const WEEKLY_MON_9_18 = Object.freeze({ mon: [["09:00", "18:00"]] });

test("WEEKDAYS is the frozen mon..sun order", () => {
  assert.deepEqual([...WEEKDAYS], ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
  assert.ok(Object.isFrozen(WEEKDAYS));
});

test("isValidTimeZone accepts IANA zones and rejects unusable input without throwing", () => {
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Asia/Shanghai"), true);
  assert.equal(isValidTimeZone("Europe/Berlin"), true);
  assert.equal(isValidTimeZone("Not/AZone"), false);
  assert.equal(isValidTimeZone(""), false);
  assert.equal(isValidTimeZone("x".repeat(81)), false);
  assert.equal(isValidTimeZone(42), false);
  assert.equal(isValidTimeZone(undefined), false);
});

test("localParts returns the frozen field shape and never a 24 hour value", () => {
  assert.deepEqual(localParts(at("2026-10-05T04:00:00Z"), UTC), {
    year: 2026,
    month: 10,
    day: 5,
    hour: 4,
    minute: 0,
    weekday: "mon",
    date: "2026-10-05",
    time: "04:00",
  });
  assert.deepEqual(localParts(at("2026-10-04T16:00:00Z"), SHANGHAI), {
    year: 2026,
    month: 10,
    day: 5,
    hour: 0,
    minute: 0,
    weekday: "mon",
    date: "2026-10-05",
    time: "00:00",
  });

  for (const zone of [BERLIN, SHANGHAI]) {
    for (let t = at("2026-01-01T00:00:00Z"); t < at("2027-01-01T00:00:00Z"); t += 12 * 3600 * 1000) {
      const parts = localParts(t, zone);
      assert.ok(parts.hour >= 0 && parts.hour <= 23, `${zone} ${new Date(t).toISOString()} hour ${parts.hour}`);
      assert.match(parts.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(parts.time, /^([01]\d|2[0-3]):[0-5]\d$/);
    }
  }
});

test("startsAt is inclusive: before denies as not_started, equal and after pass", () => {
  const policy = policyOf({ startsAt: "2026-10-05T00:00:00.000Z" });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-04T23:59:59.999Z")), { ok: false, reason: "not_started" });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-05T00:00:00.000Z")), { ok: true });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-05T00:00:00.001Z")), { ok: true });
});

test("expiresAt is exclusive: before passes, equal and after deny as expired", () => {
  const policy = policyOf({ expiresAt: "2026-10-05T00:00:00.000Z" });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-04T23:59:59.999Z")), { ok: true });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-05T00:00:00.000Z")), { ok: false, reason: "expired" });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-05T00:00:00.001Z")), { ok: false, reason: "expired" });
});

test("component reasons keep the frozen priority order", () => {
  const notStartedYet = policyOf({
    startsAt: "2026-10-05T00:00:00.000Z",
    expiresAt: "2026-10-10T00:00:00.000Z",
  });
  assert.equal(evaluatePolicySchedule(notStartedYet, at("2026-10-04T00:00:00Z")).reason, "not_started");

  const expiredAndOutOfRange = policyOf({
    expiresAt: "2026-10-05T00:00:00.000Z",
    dateRanges: [{ from: "2026-01-01", to: "2026-01-02" }],
  });
  assert.equal(evaluatePolicySchedule(expiredAndOutOfRange, at("2026-10-05T00:00:00Z")).reason, "expired");

  const outOfRangeAndOutsideWeekly = policyOf({
    timezone: UTC,
    weekly: WEEKLY_MON_9_18,
    dateRanges: [{ from: "2026-01-01", to: "2026-01-02" }],
  });
  assert.equal(evaluatePolicySchedule(outOfRangeAndOutsideWeekly, at("2026-10-05T10:00:00Z")).reason, "date_out_of_range");
});

test("weekly interval is start-inclusive and end-exclusive", () => {
  const policy = policyOf({ weekly: WEEKLY_MON_9_18 });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-05T08:59:00Z")), { ok: false, reason: "outside_weekly" });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-05T09:00:00Z")), { ok: true });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-05T17:59:00Z")), { ok: true });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-05T18:00:00Z")), { ok: false, reason: "outside_weekly" });
});

test("weekly uses the policy timezone, so local midnight can cross the UTC date", () => {
  const policy = policyOf({ timezone: SHANGHAI, weekly: { mon: [["00:00", "00:30"]] } });
  const midnight = localParts(at("2026-10-04T16:00:00Z"), SHANGHAI);
  assert.equal(midnight.date, "2026-10-05");
  assert.equal(midnight.weekday, "mon");
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-04T16:00:00Z")), { ok: true });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-04T16:15:00Z")), { ok: true });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-04T16:30:00Z")), { ok: false, reason: "outside_weekly" });
  assert.equal(nextTransition(policy, at("2026-10-04T16:30:00Z")).nextAllowedAt, at("2026-10-11T16:00:00Z"));
});

test("a 24:00 end terminates at the next local midnight and does not leak into Sunday->Monday", () => {
  const policy = policyOf({ weekly: { sun: [["23:00", "24:00"]] } });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-04T23:30:00Z")), { ok: true });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-05T00:00:00Z")), { ok: false, reason: "outside_weekly" });
  assert.equal(nextTransition(policy, at("2026-10-04T23:30:00Z")).nextChangeAt, at("2026-10-05T00:00:00Z"));
  assert.equal(nextTransition(policy, at("2026-10-05T00:00:00Z")).nextAllowedAt, at("2026-10-11T23:00:00Z"));
});

test("multiple intervals on one weekday are ORed", () => {
  const policy = policyOf({ weekly: { mon: [["09:00", "12:00"], ["13:00", "18:00"]] } });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-05T10:00:00Z")), { ok: true });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-05T12:00:00Z")), { ok: false, reason: "outside_weekly" });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-05T12:30:00Z")), { ok: false, reason: "outside_weekly" });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-05T13:00:00Z")), { ok: true });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-05T18:00:00Z")), { ok: false, reason: "outside_weekly" });
  assert.equal(nextTransition(policy, at("2026-10-05T12:30:00Z")).nextAllowedAt, at("2026-10-05T13:00:00Z"));
});

test("weekly and dateRanges are ANDed", () => {
  const policy = policyOf({ weekly: WEEKLY_MON_9_18, dateRanges: [{ from: "2026-10-05", to: "2026-10-05" }] });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-05T10:00:00Z")), { ok: true });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-06T10:00:00Z")), { ok: false, reason: "date_out_of_range" });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-12T10:00:00Z")), { ok: false, reason: "date_out_of_range" });
  assert.deepEqual(nextTransition(policy, at("2026-10-06T10:00:00Z")), { nextChangeAt: at("2026-10-07T00:00:00Z"), nextAllowedAt: null });
});

test("multiple dateRanges are ORed with both ends inclusive", () => {
  const policy = policyOf({
    dateRanges: [{ from: "2026-10-05", to: "2026-10-07" }, { from: "2026-10-20", to: "2026-10-21" }],
  });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-05T00:00:00Z")), { ok: true });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-07T23:59:59Z")), { ok: true });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-08T00:00:00Z")), { ok: false, reason: "date_out_of_range" });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-20T00:00:00Z")), { ok: true });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-22T00:00:00Z")), { ok: false, reason: "date_out_of_range" });
  assert.equal(nextTransition(policy, at("2026-10-08T00:00:00Z")).nextAllowedAt, at("2026-10-20T00:00:00Z"));
  assert.equal(nextTransition(policy, at("2026-10-22T00:00:00Z")).nextAllowedAt, null);
});

test("the same instant is decided differently in UTC and Asia/Shanghai", () => {
  const utcPolicy = policyOf({ timezone: UTC, weekly: { mon: [["01:00", "02:00"]] } });
  const shanghaiPolicy = policyOf({ timezone: SHANGHAI, weekly: { mon: [["01:00", "02:00"]] } });
  const instant = at("2026-10-05T01:30:00Z");
  assert.deepEqual(evaluatePolicySchedule(utcPolicy, instant), { ok: true });
  assert.deepEqual(evaluatePolicySchedule(shanghaiPolicy, instant), { ok: false, reason: "outside_weekly" });
});

test("Europe/Berlin 2026-03-29 spring gap: 02:30 wall time starts at the 03:00 gap end", () => {
  const policy = policyOf({ timezone: BERLIN, weekly: { sun: [["02:30", "03:30"]] } });
  assert.equal(localParts(at("2026-03-29T00:15:00Z"), BERLIN).time, "01:15");
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-03-29T00:15:00Z")), { ok: false, reason: "outside_weekly" });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-03-29T00:59:00Z")), { ok: false, reason: "outside_weekly" });
  assert.equal(localParts(at("2026-03-29T01:00:00Z"), BERLIN).time, "03:00");
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-03-29T01:00:00Z")), { ok: true });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-03-29T01:29:00Z")), { ok: true });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-03-29T01:30:00Z")), { ok: false, reason: "outside_weekly" });

  const transition = nextTransition(policy, at("2026-03-29T00:15:00Z"));
  assert.equal(transition.nextAllowedAt, at("2026-03-29T01:00:00Z"));
  assert.equal(transition.nextChangeAt, at("2026-03-29T01:00:00Z"));
});

test("Europe/Berlin 2026-10-25 fall repeat: both instants are local 02:30 and the earlier one wins", () => {
  const earlier = at("2026-10-25T00:30:00Z");
  const later = at("2026-10-25T01:30:00Z");
  assert.equal(localParts(earlier, BERLIN).time, "02:30");
  assert.equal(localParts(later, BERLIN).time, "02:30");
  assert.equal(localParts(earlier, BERLIN).date, "2026-10-25");

  const policy = policyOf({ timezone: BERLIN, weekly: { sun: [["02:30", "03:30"]] } });
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-25T00:00:00Z")), { ok: false, reason: "outside_weekly" });
  assert.deepEqual(evaluatePolicySchedule(policy, earlier), { ok: true });
  assert.deepEqual(evaluatePolicySchedule(policy, later), { ok: true });
  assert.equal(localParts(at("2026-10-25T02:30:00Z"), BERLIN).time, "03:30");
  assert.deepEqual(evaluatePolicySchedule(policy, at("2026-10-25T02:30:00Z")), { ok: false, reason: "outside_weekly" });

  const transition = nextTransition(policy, at("2026-10-25T00:00:00Z"));
  assert.equal(transition.nextAllowedAt, earlier);
  assert.equal(transition.nextChangeAt, earlier);
  assert.equal(
    nextTransition(policy, at("2026-10-25T02:35:00Z")).nextAllowedAt,
    at("2026-11-01T01:30:00Z"),
  );
});

test("nextAllowedAt is the first satisfying instant at or after fromMs", () => {
  const policy = policyOf({ weekly: WEEKLY_MON_9_18 });
  const inside = at("2026-10-05T10:00:00Z");
  assert.equal(nextTransition(policy, inside).nextAllowedAt, inside);
  assert.equal(nextTransition(policy, at("2026-10-05T18:00:00Z")).nextAllowedAt, at("2026-10-12T09:00:00Z"));
  assert.equal(nextTransition(policy, at("2026-10-05T07:00:00Z")).nextAllowedAt, at("2026-10-05T09:00:00Z"));
  assert.equal(nextTransition(policy, at("2026-10-06T20:00:00Z")).nextAllowedAt, at("2026-10-12T09:00:00Z"));
});

test("nextChangeAt is a deterministic future boundary, conservative but never in the past", () => {
  const policy = policyOf({ weekly: WEEKLY_MON_9_18 });
  assert.equal(nextTransition(policy, at("2026-10-05T07:00:00Z")).nextChangeAt, at("2026-10-05T09:00:00Z"));
  assert.equal(nextTransition(policy, at("2026-10-05T10:00:00Z")).nextChangeAt, at("2026-10-05T18:00:00Z"));

  const from = at("2026-10-05T20:00:00Z");
  const conservative = nextTransition(policy, from).nextChangeAt;
  assert.ok(conservative > from);
  assert.ok(conservative <= at("2026-10-06T09:00:00Z"));

  const startsLater = policyOf({ startsAt: "2026-11-01T00:00:00.000Z" });
  assert.equal(nextTransition(startsLater, at("2026-10-05T20:00:00Z")).nextChangeAt, at("2026-11-01T00:00:00.000Z"));
});

test("expired or past-only policies never fabricate a future instant", () => {
  const expired = policyOf({ expiresAt: "2026-10-05T10:00:00.000Z", weekly: WEEKLY_MON_9_18 });
  assert.deepEqual(evaluatePolicySchedule(expired, at("2026-10-05T10:00:00.000Z")), { ok: false, reason: "expired" });
  assert.deepEqual(nextTransition(expired, at("2026-10-05T10:00:00.000Z")), { nextChangeAt: null, nextAllowedAt: null });
  assert.equal(nextTransition(expired, at("2026-10-05T09:30:00Z")).nextAllowedAt, at("2026-10-05T09:30:00Z"));

  const pastOnly = policyOf({ dateRanges: [{ from: "2026-01-01", to: "2026-01-02" }] });
  assert.equal(nextTransition(pastOnly, at("2026-10-05T10:00:00Z")).nextAllowedAt, null);
});

test("nextAllowedAt honors the 366 day horizon", () => {
  const policy = policyOf({ dateRanges: [{ from: "2028-01-01", to: "2028-01-02" }] });
  const transition = nextTransition(policy, at("2026-10-05T10:00:00Z"));
  assert.equal(transition.nextAllowedAt, null);
  assert.equal(transition.nextChangeAt, at("2028-01-01T00:00:00.000Z"));
});

test("time helpers do not mutate frozen policies or read the host clock", async () => {
  const policy = deepFreeze(policyOf({
    timezone: BERLIN,
    weekly: { mon: [["09:00", "18:00"], ["20:00", "21:00"]] },
    dateRanges: [{ from: "2026-10-01", to: "2026-10-31" }],
    startsAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-11-01T00:00:00.000Z",
  }));
  evaluatePolicySchedule(policy, at("2026-10-05T10:00:00Z"));
  nextTransition(policy, at("2026-10-05T10:00:00Z"));
  nextTransition(policy, at("2026-10-05T22:00:00Z"));
  assert.equal(policy.weekly.mon.length, 2);

  const source = await readFile(new URL("../src/access-policy/time.js", import.meta.url), "utf8");
  assert.equal(/Date\.now\s*\(/.test(source), false, "time.js must not read Date.now()");
});
