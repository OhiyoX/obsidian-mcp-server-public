// #434 lane A — sample matrix and boundary tests for the window presentation model
// (`app/src/admin/access-policy-window-presentation.js`).
//
// The matrix is the frozen resting place for the ruling's sample list: no weekly,
// several same-day intervals, duplicates/out-of-order, Sunday edge, date
// intersection, expiry, DST, unparsable data. Boundary additions found while
// reviewing: inherited prototype weekday names must be a reason (not a crash), the
// absence rule for empty fields, `24:00` only as an end boundary, and the exact
// code-point budget flip. Every case prints its raw
// view-model through `t.diagnostic` and then asserts the ruling's criteria, so a
// regression shows both the expected value and the produced one.
//
// Contract: `scratch/admin-review/DESIGN-RULING-434-437.md` (#434 items 2/3) and
// the ruling write-back on issue #434. Pure and offline: no clock, no I/O, no DOM.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatDateRangesText, formatWeeklyText } from "../src/admin/access-policy.js";
import {
  WINDOW_DAY_LABELS,
  WINDOW_SUMMARY_MAX_CODEPOINTS,
  WINDOW_SUMMARY_MAX_GROUPS,
  WINDOW_SCOPE_DISCLAIMER,
  WINDOW_UNPARSABLE_MESSAGE,
  countCodePoints,
  presentAccessPolicyWindow,
} from "../src/admin/access-policy-window-presentation.js";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Raw (unvalidated) window input: the model must tolerate hand-written data. */
function raw(overrides = {}) {
  return { weekly: {}, dateRanges: [], startsAt: null, expiresAt: null, timezone: "Asia/Shanghai", ...overrides };
}

const ALL_DAY = [["00:00", "24:00"]];
const ALL_DAYS_ALL_DAY = Object.fromEntries(
  ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [day, ALL_DAY]),
);
const WEEKDAYS_9_18 = Object.fromEntries(
  ["mon", "tue", "wed", "thu", "fri"].map((day) => [day, [["09:00", "18:00"]]]),
);

const DT = "2026-10-05T01:00:00.000Z";
const EX = "2026-10-06T01:00:00.000Z";

// name, input, expected headline. Extra assertions live in the focused tests below.
const MATRIX = [
  ["no weekly (weekly={})", raw(), { shape: "no-weekly", text: "每天全天", groupCount: 0 }],
  ["no weekly + date range + bounds", raw({ dateRanges: [{ from: "2026-10-01", to: "2026-10-07" }], startsAt: DT, expiresAt: EX }),
    { shape: "no-weekly", text: "每天全天", groupCount: 0, markers: 3 }],
  ["weekdays 09:00-18:00", raw({ weekly: WEEKDAYS_9_18 }), { shape: "groups", text: "工作日 09:00–18:00", groupCount: 1 }],
  ["weekend 10:00-16:00", raw({ weekly: { sat: [["10:00", "16:00"]], sun: [["10:00", "16:00"]] } }),
    { shape: "groups", text: "周末 10:00–16:00", groupCount: 1 }],
  ["every day all day", raw({ weekly: ALL_DAYS_ALL_DAY }),
    { shape: "all-day-every-day", text: "每天 00:00–24:00", groupCount: 1, allDayEveryDay: true }],
  ["same day, two intervals", raw({ weekly: { mon: [["09:00", "12:00"], ["13:00", "18:00"]], tue: [["09:00", "12:00"], ["13:00", "18:00"]] } }),
    { shape: "groups", text: "周一、周二 09:00–12:00、13:00–18:00", groupCount: 1 }],
  ["duplicates + out-of-order", raw({ weekly: { wed: [["13:00", "18:00"], ["09:00", "12:00"], ["09:00", "12:00"]], mon: [["13:00", "18:00"], ["09:00", "12:00"]] } }),
    { shape: "groups", text: "周一、周三 09:00–12:00、13:00–18:00", groupCount: 1 }],
  ["Sunday only (week boundary)", raw({ weekly: { sun: ALL_DAY } }),
    { shape: "groups", text: "周日 00:00–24:00", groupCount: 1 }],
  ["wrap-around sat+sun vs mon", raw({ weekly: { sat: [["10:00", "12:00"]], sun: [["10:00", "12:00"]], mon: [["09:00", "11:00"]] } }),
    { shape: "groups", text: "周一 09:00–11:00；周末 10:00–12:00", groupCount: 2 }],
  ["weekly ∩ date range ∩ bounds", raw({ weekly: WEEKDAYS_9_18, dateRanges: [{ from: "2026-10-05", to: "2026-10-06" }], startsAt: DT, expiresAt: EX }),
    { shape: "groups", text: "工作日 09:00–18:00", groupCount: 1, markers: 3 }],
  ["all day + expiry (never 'permanent')", raw({ weekly: ALL_DAYS_ALL_DAY, expiresAt: EX }),
    { shape: "all-day-every-day", text: "每天 00:00–24:00", groupCount: 1, markers: 1 }],
  ["DST zone (America/New_York) all day", raw({ weekly: ALL_DAYS_ALL_DAY, timezone: "America/New_York", dateRanges: [{ from: "2026-03-07", to: "2026-03-09" }] }),
    { shape: "all-day-every-day", text: "每天 00:00–24:00", groupCount: 1, markers: 1 }],
  ["3 groups -> 自定义", raw({ weekly: { ...WEEKDAYS_9_18, sat: ALL_DAY, sun: [["10:00", "11:00"]] } }),
    { shape: "custom", text: "自定义 · 3 个时段", groupCount: 3, overBudget: true }],
  ["2 groups over 48 code points -> 自定义", raw({ weekly: { mon: [["09:00", "12:00"], ["13:00", "18:00"]], tue: [["09:00", "12:00"], ["13:00", "18:00"]], wed: [["09:00", "12:00"], ["13:00", "18:00"]], thu: [["09:00", "12:00"], ["13:00", "18:00"]], fri: [["13:00", "18:00"]] } }),
    { shape: "custom", text: "自定义 · 2 个时段", groupCount: 2, overBudget: true }],
  ["2 groups under the budget stays grouped", raw({ weekly: { mon: [["09:00", "12:00"]], tue: [["09:00", "12:00"]], wed: [["09:00", "12:00"]], thu: [["13:00", "18:00"]], fri: [["13:00", "18:00"]] } }),
    { shape: "groups", text: "周一、周二、周三 09:00–12:00；周四、周五 13:00–18:00", groupCount: 2, overBudget: false }],
  // `24:00` is only ever an interval end boundary: a full interval plus a second
  // one must not be collapsed into 全天.
  ["all day plus a second interval is not 全天", raw({ weekly: { mon: [["00:00", "24:00"], ["09:00", "10:00"]] } }),
    { shape: "groups", text: "周一 00:00–24:00、09:00–10:00", groupCount: 1, allDayEveryDay: false }],
];

test("sample matrix prints every raw view-model and asserts the headline", (t) => {
  for (const [name, input, expected] of MATRIX) {
    const vm = presentAccessPolicyWindow(input);
    t.diagnostic(`[${name}]\n  summary=${JSON.stringify(vm.summary.text)} shape=${vm.summary.shape} groups=${vm.summary.groupCount} overBudget=${vm.summary.overBudget} allDayEveryDay=${vm.summary.allDayEveryDay}`);
    t.diagnostic(`  groupTexts=${JSON.stringify(vm.groups.map((group) => group.text))}`);
    t.diagnostic(`  markers=${JSON.stringify(vm.summary.markers)} markerTexts=${JSON.stringify({ dateRanges: vm.markers.dateRanges.text, startsAt: vm.markers.startsAt.text, expiresAt: vm.markers.expiresAt.text })}`);
    t.diagnostic(`  days=${vm.details.days.map((day) => `${day.label}:${day.text}`).join(" / ")}`);
    assert.equal(vm.ok, true, `${name}: expected a parseable policy`);
    for (const [key, value] of Object.entries(expected)) {
      if (key === "markers") assert.equal(vm.summary.markers.length, value, `${name}: marker count`);
      else assert.equal(vm.summary[key], value, `${name}: summary.${key}`);
    }
    assert.equal(vm.summary.markers.length, ["dateRanges", "startsAt", "expiresAt"].filter((field) => vm.markers[field].present).length,
      `${name}: every present constraint must keep a visible marker`);
    assert.equal(vm.details.days.length, 7, `${name}: details always cover Monday..Sunday`);
    assert.equal(vm.summary.disclaimer, WINDOW_SCOPE_DISCLAIMER, `${name}: window-only disclaimer`);
  }
});

test("every-day-all-day renders the prototype's own range text and never English weekday tokens", () => {
  const vm = presentAccessPolicyWindow(raw({ weekly: ALL_DAYS_ALL_DAY, expiresAt: EX }));
  assert.equal(vm.summary.text, "每天 00:00–24:00");
  assert.equal(vm.summary.text.split("00:00–24:00").length - 1, 1, "the literal range must appear exactly once");
  assert.doesNotMatch(vm.summary.text, /全天/, "the headline uses the prototype's literal range, not the plane's 全天 shorthand");
  assert.doesNotMatch(vm.summary.text, /mon|tue|wed|thu|fri|sat|sun/, "no repeated English weekday entries");
  // 全天 must not read as "permanent" or "currently allowed"; the expiry stays visible.
  assert.doesNotMatch(vm.summary.text, /永久|允许/);
  assert.equal(vm.markers.expiresAt.present, true);
  assert.ok(vm.summary.markers.includes("另有截止时间"));
  assert.match(vm.summary.disclaimer, /不代表永久有效或当前允许/);
  for (const day of vm.details.days) assert.equal(day.text, "全天", "details still list all seven days");
});

test("weekly={} and a missing day inside a constraint are never conflated", () => {
  const none = presentAccessPolicyWindow(raw({ weekly: {} }));
  const grid = presentAccessPolicyWindow(raw({ weekly: WEEKDAYS_9_18 }));
  assert.equal(none.hasWeeklyConstraint, false);
  assert.equal(grid.hasWeeklyConstraint, true);
  assert.deepEqual([...new Set(none.details.days.map((day) => day.state))], ["unspecified"]);
  assert.equal(none.details.days[5].text, "未设置周约束");
  assert.equal(grid.details.days[5].state, "empty");
  assert.equal(grid.details.days[5].text, "该日无生效时段");
  assert.notEqual(none.details.days[5].text, grid.details.days[5].text);

  // An explicitly empty day is the same as a missing day once a constraint exists.
  const declaredEmpty = presentAccessPolicyWindow(raw({ weekly: { ...WEEKDAYS_9_18, sat: [], sun: [] } }));
  assert.deepEqual(declaredEmpty.details.days.map((day) => day.state), grid.details.days.map((day) => day.state));
  // `{mon: []}` carries no active interval, so v1 semantics read it as no constraint.
  assert.equal(presentAccessPolicyWindow(raw({ weekly: { mon: [] } })).hasWeeklyConstraint, false);
});

test("the summary budget counts Unicode code points, not UTF-16 code units", () => {
  assert.equal(WINDOW_SUMMARY_MAX_GROUPS, 2);
  assert.equal(WINDOW_SUMMARY_MAX_CODEPOINTS, 48);
  assert.equal(countCodePoints("😀"), 1);
  assert.equal("😀".length, 2, "the naive UTF-16 length would over-count an astral character");
  assert.equal(countCodePoints("每".repeat(48)), 48);
  assert.equal(countCodePoints("每".repeat(49)), 49);
  // 24 emoji are 48 code points (but 48 UTF-16 units would be only 24 emoji + ...):
  // asserting both counters proves the budget cannot be satisfied by code units.
  assert.equal(countCodePoints("😀".repeat(24)), 24);
  assert.equal("😀".repeat(24).length, 48);

  const under = presentAccessPolicyWindow(MATRIX[14][1]);
  const over = presentAccessPolicyWindow(MATRIX[13][1]);
  const joinedUnder = under.groups.map((group) => group.text).join("；");
  const joinedOver = over.groups.map((group) => group.text).join("；");
  assert.equal(countCodePoints(joinedUnder), 38);
  assert.equal(countCodePoints(joinedOver), 50);
  assert.equal(under.summary.overBudget, countCodePoints(joinedUnder) > 48, "38 code points stay grouped");
  assert.equal(over.summary.overBudget, countCodePoints(joinedOver) > 48, "50 code points fall back");
  assert.equal(over.summary.text, `自定义 · ${over.summary.groupCount} 个时段`);
  // The fallback must not drop the date/bound markers.
  const dated = presentAccessPolicyWindow(raw({ ...MATRIX[13][1], dateRanges: [{ from: "2026-10-01", to: "2026-10-07" }], expiresAt: EX }));
  assert.equal(dated.summary.overBudget, true);
  assert.equal(dated.summary.markers.length, 2, "自定义 must still show the date and expiry markers");
});

test("unparsable data reports a checkable reason and never guesses 全天/无限制", () => {
  const cases = [
    ["weekly is a string", raw({ weekly: "mon 09:00-18:00" }), "weekly", "weekly", "weekly_must_be_an_object"],
    ["weekday intervals are not an array", raw({ weekly: { mon: "09:00-18:00" } }), "weekly", "weekly.mon", "intervals_must_be_an_array"],
    ["interval is not a pair", raw({ weekly: { mon: [["09:00"]] } }), "weekly", "weekly.mon[0]", "interval_must_be_a_pair"],
    ["start is not HH:MM", raw({ weekly: { mon: [["9:00", "18:00"]] } }), "weekly", "weekly.mon[0][0]", "invalid_start_time"],
    ["end is not HH:MM or 24:00", raw({ weekly: { mon: [["09:00", "25:00"]] } }), "weekly", "weekly.mon[0][1]", "invalid_end_time"],
    ["window crosses midnight", raw({ weekly: { mon: [["18:00", "09:00"]] } }), "weekly", "weekly.mon[0]", "window_must_not_cross_midnight"],
    ["unknown weekday", raw({ weekly: { funday: [["09:00", "18:00"]] } }), "weekly", "weekly.funday", "unknown_weekday"],
    ["dateRanges is not an array", raw({ dateRanges: "2026-10-01..2026-10-07" }), "dateRanges", "dateRanges", "date_ranges_must_be_an_array"],
    ["impossible calendar date", raw({ dateRanges: [{ from: "2026-02-30", to: "2026-03-01" }] }), "dateRanges", "dateRanges[0]", "invalid_calendar_date"],
    ["range starts after it ends", raw({ dateRanges: [{ from: "2026-10-07", to: "2026-10-01" }] }), "dateRanges", "dateRanges[0]", "from_must_not_be_after_to"],
    ["startsAt is not an ISO instant", raw({ startsAt: "not-a-time" }), "startsAt", "startsAt", "invalid_iso_instant"],
    ["expiresAt is not an ISO instant", raw({ expiresAt: "2026-13-45T99:99:99Z" }), "expiresAt", "expiresAt", "invalid_iso_instant"],
    ["timezone is not IANA", raw({ timezone: "Not/AZone" }), "timezone", "timezone", "invalid_iana_timezone"],
  ];
  for (const [name, input, field, expectedPath, expectedReason] of cases) {
    const vm = presentAccessPolicyWindow(input);
    const reason = vm.unparsable?.reasons.find((item) => item.reason === expectedReason);
    assert.ok(reason, `${name}: expected reason ${expectedReason}, got ${JSON.stringify(vm.unparsable)}`);
    assert.equal(reason.field, field, `${name}: field`);
    assert.equal(reason.path, expectedPath, `${name}: path`);
    assert.equal(vm.ok, false, `${name}: ok must be false`);
    assert.equal(vm.summary.text, WINDOW_UNPARSABLE_MESSAGE, `${name}: explicit unparsable text`);
    assert.doesNotMatch(vm.summary.text, /全天|无限制/, `${name}: must not be guessed as all-day/unlimited`);
    // A broken weekly grid never degrades into "no weekly constraint".
    if (field === "weekly") {
      assert.equal(vm.details.days.every((day) => day.state !== "unspecified"), true, `${name}: no 未设置周约束`);
    }
  }
  // A still-present but unreadable constraint keeps its visible marker.
  const badStart = presentAccessPolicyWindow(raw({ weekly: WEEKDAYS_9_18, startsAt: "nope" }));
  assert.equal(badStart.markers.startsAt.present, true);
  assert.equal(badStart.markers.startsAt.valid, false);
  assert.equal(badStart.markers.startsAt.text, "无法解析开始时间");
  assert.ok(badStart.summary.markers.includes("另有开始时间"));
});

test("negative control: the marker guard catches a dropped date marker", () => {
  const vm = presentAccessPolicyWindow(raw({ weekly: WEEKDAYS_9_18, dateRanges: [{ from: "2026-10-01", to: "2026-10-07" }], expiresAt: EX }));
  assert.equal(visibleMarkers(vm), true);
  const dropped = { ...vm, summary: { ...vm.summary, markers: vm.summary.markers.filter((token) => token !== "另有限定日期") } };
  assert.equal(visibleMarkers(dropped), false, "removing 另有限定日期 must be detectable");
  const hidden = { ...vm, markers: { ...vm.markers, dateRanges: { ...vm.markers.dateRanges, marker: null } } };
  assert.equal(visibleMarkers(hidden), false, "markers hidden from the summary must be detectable");
});

/** A visible marker is one the summary exposes for every present constraint. */
function visibleMarkers(vm) {
  const fields = ["dateRanges", "startsAt", "expiresAt"].filter((field) => vm.markers[field].present);
  return fields.every((field) => vm.markers[field].marker && vm.summary.markers.includes(vm.markers[field].marker))
    && vm.summary.markers.length === fields.length;
}

test("the policy is only read: nothing mutates the input and the output is frozen", () => {
  const weekly = { sun: [["13:00", "18:00"], ["09:00", "12:00"], ["09:00", "12:00"]], mon: [["13:00", "18:00"], ["09:00", "12:00"]] };
  const input = raw({ weekly, dateRanges: [{ from: "2026-10-07", to: "2026-10-07" }, { from: "2026-10-01", to: "2026-10-02" }] });
  const before = JSON.stringify(input);
  Object.freeze(weekly);
  Object.freeze(input);
  const vm = presentAccessPolicyWindow(input);
  assert.equal(JSON.stringify(input), before, "the input window data is never rewritten");
  assert.deepEqual(weekly.sun, [["13:00", "18:00"], ["09:00", "12:00"], ["09:00", "12:00"]], "input order is preserved");
  // Display sorting/dedup happens in the view-model, not in the policy.
  assert.deepEqual(vm.details.days[0].intervals.map((item) => item.text), ["09:00–12:00", "13:00–18:00"]);
  assert.deepEqual(vm.details.dateRanges.items.map((item) => item.text), ["2026-10-01..2026-10-02", "2026-10-07..2026-10-07"]);
  for (const node of [vm, vm.summary, vm.markers, vm.details, ...vm.details.days]) assert.equal(Object.isFrozen(node), true);
  assert.equal(Object.isFrozen(vm.groups[0]), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(presentAccessPolicyWindow(input))),
    JSON.parse(JSON.stringify(presentAccessPolicyWindow(input))),
    "the same input always produces the same view-model",
  );
});

test("the legacy edit formatters keep their exact output", () => {
  // These still back the edit form, so the grouped summary must never change them.
  assert.equal(formatWeeklyText(WEEKDAYS_9_18), "mon 09:00-18:00\ntue 09:00-18:00\nwed 09:00-18:00\nthu 09:00-18:00\nfri 09:00-18:00");
  assert.equal(formatWeeklyText({ sun: [["13:00", "18:00"], ["09:00", "12:00"]], mon: [["00:00", "24:00"]] }), "mon 00:00-24:00\nsun 13:00-18:00\nsun 09:00-12:00");
  assert.equal(formatWeeklyText({} ), "");
  assert.equal(formatWeeklyText(undefined), "");
  assert.equal(formatDateRangesText([{ from: "2026-10-07", to: "2026-10-07" }, { from: "2026-10-01", to: "2026-10-02" }]), "2026-10-07..2026-10-07\n2026-10-01..2026-10-02");
  assert.equal(formatDateRangesText([]), "");
});

test("the presentation module stays pure: no imports, no clock, no I/O", () => {
  const source = fs.readFileSync(path.join(APP_ROOT, "src/admin/access-policy-window-presentation.js"), "utf8");
  // Zero imports is the strongest available proof: no filesystem, no clock, no
  // decision core and no AuthZ state can be reached from this module.
  assert.doesNotMatch(source, /^\s*(?:import|export)\s[^;]*\sfrom\s/m, "the model must not import anything");
  assert.doesNotMatch(source, /require\(|import\(/);
  for (const pattern of [/Date\.now/, /new Date\(\s*\)/, /Math\.random/, /process\./]) {
    assert.doesNotMatch(source, pattern, `presentation model must not contain ${pattern}`);
  }
  assert.doesNotMatch(source, /<\/[a-z]+>|<[a-z]+\s[^>]*>/, "no markup: rendering belongs to lane B");
});

test("hostile inherited weekday names are a checkable reason, never an exception", () => {
  for (const key of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"]) {
    // JSON.parse creates own properties for these names (an object literal would set
    // the prototype instead), so the raw-input path really does see them.
    const weekly = JSON.parse(`{"${key}": [["09:00","18:00"]]}`);
    assert.equal(Object.hasOwn(weekly, key), true, `${key}: JSON.parse must create an own key`);
    // Control: a truthy lookup resolved an inherited Object.prototype member, which
    // then crashed on `days.get("<name>")` being undefined.
    assert.equal(Object.hasOwn(WINDOW_DAY_LABELS, key), false, `${key}: must not be a weekday label`);
    assert.notEqual(WINDOW_DAY_LABELS[key], undefined, `${key}: control needs a truthy inherited lookup`);

    const vm = presentAccessPolicyWindow(raw({ weekly }));
    assert.equal(vm.ok, false, `${key}: must be reported, not thrown`);
    assert.equal(vm.summary.text, WINDOW_UNPARSABLE_MESSAGE, `${key}: explicit unparsable text`);
    const reason = vm.unparsable.reasons.find((item) => item.reason === "unknown_weekday");
    assert.ok(reason, `${key}: expected unknown_weekday, got ${JSON.stringify(vm.unparsable)}`);
    assert.equal(reason.path, `weekly.${key}`, `${key}: reason path`);
    assert.equal(vm.details.days.every((day) => day.state === "unparsable"), true, `${key}: no day claimed unset`);
  }
});

test("absence vs invalid: the documented unset forms stay unset, wrong shapes stay unparsable", () => {
  // Absence rule shared by the four fields: undefined / null / "" and the canonical
  // empty container mean "not set" (mirrors the Admin form coercion). The summary must
  // still carry the window-only disclaimer, so "no weekly constraint" can never be
  // read as unlimited or currently allowed.
  for (const weekly of [undefined, null, "", {}]) {
    const vm = presentAccessPolicyWindow(raw({ weekly }));
    assert.equal(vm.ok, true, `weekly=${JSON.stringify(weekly)} must be unset`);
    assert.equal(vm.summary.shape, "no-weekly");
    assert.equal(vm.hasWeeklyConstraint, false);
    assert.equal(vm.summary.disclaimer, WINDOW_SCOPE_DISCLAIMER);
  }
  for (const dateRanges of [undefined, null, "", []]) {
    const vm = presentAccessPolicyWindow(raw({ dateRanges }));
    assert.equal(vm.ok, true, `dateRanges=${JSON.stringify(dateRanges)} must be unset`);
    assert.equal(vm.markers.dateRanges.present, false);
  }
  for (const field of ["startsAt", "expiresAt"]) {
    for (const value of [undefined, null, ""]) {
      const vm = presentAccessPolicyWindow(raw({ [field]: value }));
      assert.equal(vm.ok, true, `${field}=${JSON.stringify(value)} must be unset`);
      assert.equal(vm.markers[field].present, false);
    }
  }
  // Wrong shapes are still reported with a checkable reason, never read as absence.
  for (const weekly of ["mon 09:00-18:00", [], 0, true]) {
    const vm = presentAccessPolicyWindow(raw({ weekly }));
    assert.equal(vm.ok, false, `weekly=${JSON.stringify(weekly)} must be unparsable`);
    assert.ok(vm.unparsable.reasons.some((item) => item.reason === "weekly_must_be_an_object"));
  }
  for (const dateRanges of ["x", 0, true, {}]) {
    const vm = presentAccessPolicyWindow(raw({ dateRanges }));
    assert.equal(vm.ok, false, `dateRanges=${JSON.stringify(dateRanges)} must be unparsable`);
    assert.ok(vm.unparsable.reasons.some((item) => item.reason === "date_ranges_must_be_an_array"));
  }
  for (const field of ["startsAt", "expiresAt"]) {
    for (const value of [0, true, {}, []]) {
      const vm = presentAccessPolicyWindow(raw({ [field]: value }));
      assert.equal(vm.ok, false, `${field}=${JSON.stringify(value)} must be unparsable`);
      assert.ok(vm.unparsable.reasons.some((item) => item.reason === "invalid_iso_instant"));
    }
  }
});

test("the 48-code-point budget flips exactly once the joined text exceeds it", () => {
  // Realizable joined lengths are quantised (day labels plus HH:MM–HH:MM interval
  // text), so the boundary is proven by the closest realizable values on each side:
  // 47 code points stay grouped and the next realizable size (a second group) is over.
  const three = [["09:00", "12:00"], ["13:00", "18:00"], ["19:00", "20:00"]];
  const under = presentAccessPolicyWindow(raw({ weekly: { mon: three, tue: three, wed: three } }));
  const near = presentAccessPolicyWindow(raw({ weekly: { mon: three, tue: three, wed: three, thu: three } }));
  const over = presentAccessPolicyWindow(raw({ weekly: { mon: three, tue: three, wed: three, thu: [["09:00", "12:00"]] } }));
  assert.equal(countCodePoints(under.groups.map((group) => group.text).join("；")), 44);
  assert.equal(countCodePoints(near.groups.map((group) => group.text).join("；")), 47);
  assert.equal(under.summary.overBudget, false, "44 <= 48 stays grouped");
  assert.equal(under.summary.shape, "groups");
  assert.equal(near.summary.overBudget, false, "47 <= 48 stays grouped");
  assert.equal(over.summary.overBudget, true, "two groups exceed the 48-code-point budget");
  assert.equal(over.summary.shape, "custom");
  assert.equal(over.summary.text, `自定义 · ${over.summary.groupCount} 个时段`);
  // The detailed rows keep the full intervals either way.
  assert.deepEqual(near.details.days[3].intervals.map((item) => item.text), ["09:00–12:00", "13:00–18:00", "19:00–20:00"]);
  assert.deepEqual(over.details.days[3].intervals.map((item) => item.text), ["09:00–12:00"]);
});
