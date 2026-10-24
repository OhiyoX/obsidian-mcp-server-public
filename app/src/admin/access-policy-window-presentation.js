// Admin "定时授权" window presentation model — issue #434 lane A.
//
// Frozen contract: `scratch/admin-review/DESIGN-RULING-434-437.md` (#434 items 2/3),
// the ruling write-back on issue #434, and the seat response
// `scratch/admin-review/codex-seat/RULING-434-437-RESPONSE.md`. This module is a *pure presentation*
// model: plain policy window fields in, one frozen view-model out. No I/O, no
// clock, no DOM, no HTML, and no AuthZ decision — it never answers "is this
// allowed right now?" and it never reads an instant.
//
// Ruling invariants implemented here:
//  - days that share the same interval expression are merged, so one time
//    expression appears once; the display layer sorts and de-duplicates while the
//    policy document is only read, never rewritten;
//  - the main summary allows at most 2 merged weekly groups and at most 48 Unicode
//    code points; over budget it becomes `自定义 · N 个时段` (N = merged group
//    count) and the date/bound constraints stay visible as separate markers;
//  - `weekly = {}` means "no weekly constraint", while a missing day inside a
//    non-empty weekly grid means "no active interval that day"; the two never share
//    a day state or a label;
//  - dateRanges / startsAt / expiresAt always keep a visible marker, and the
//    details carry their full values next to the policy IANA timezone;
//  - "每天 00:00–24:00" never implies "permanently valid" or "currently allowed";
//  - DST is never converted into a fixed UTC offset and local day length is never
//    inferred; `24:00` is only ever an interval end boundary.
//
// Boundary note: this module deliberately does not import
// `src/access-policy/time.js`. `app/test/access-policy-architecture.test.js` (①)
// keeps `time.js`/`evaluate.js` imports inside `src/access-policy/`, and the A3
// schema stays the authoritative validator. `isValidIanaTimeZone` below only
// labels one value for display; it performs no timezone arithmetic.

export const WINDOW_SUMMARY_MAX_GROUPS = 2;
export const WINDOW_SUMMARY_MAX_CODEPOINTS = 48;
/** Explicit text for invalid window data; never guessed as all-day/unlimited. */
export const WINDOW_UNPARSABLE_MESSAGE = "无法解析时间窗口";
/** Distinguishes a time window from "permanent" and from "currently allowed". */
export const WINDOW_SCOPE_DISCLAIMER = "仅表示生效时间窗口，不代表永久有效或当前允许";
export const WINDOW_DAY_KEYS = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export const WINDOW_DAY_LABELS = Object.freeze({
  mon: "周一", tue: "周二", wed: "周三", thu: "周四", fri: "周五", sat: "周六", sun: "周日",
});

const MARKER_LABELS = Object.freeze({
  dateRanges: "另有限定日期", startsAt: "另有开始时间", expiresAt: "另有截止时间",
});
const DAY_STATES = Object.freeze({
  ALL_DAY: "all-day", INTERVALS: "intervals", EMPTY: "empty",
  UNSPECIFIED: "unspecified", UNPARSABLE: "unparsable",
});

const START_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const END_TIME_PATTERN = /^(?:([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const EN_DASH = "–";

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Budget counting is by Unicode code point, never by UTF-16 code unit. */
export function countCodePoints(text) {
  return [...String(text ?? "")].length;
}

/** Bounded echo of an offending value: enough to check, never the whole blob. */
function shortValue(value) {
  if (typeof value === "string") return JSON.stringify(value.length > 32 ? `${value.slice(0, 32)}…` : value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return typeof value;
}

function reason(field, path, code, detail) {
  return { field, path, reason: code, detail };
}

function isCalendarDate(value) {
  if (typeof value !== "string") return false;
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

/**
 * Display-level IANA label check. Mirrors the schema's bound (<= 80 characters) and
 * `Intl` acceptance so the UI never labels an unusable zone as usable; it extracts
 * no offset and infers no local day length (see the boundary note above).
 */
function isValidIanaTimeZone(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 80) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function sortIntervals(intervals) {
  return [...intervals].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
}

/** Sorting + de-duplication is display-only: the policy JSON keeps its own order. */
function sortAndDedupeIntervals(intervals) {
  const seen = new Set();
  return sortIntervals(intervals).filter(([start, end]) => {
    const key = `${start}-${end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isAllDayIntervals(intervals) {
  return intervals.length === 1 && intervals[0][0] === "00:00" && intervals[0][1] === "24:00";
}

// ---- Vocabulary: the prototype's own (`5-render.js:windowSummary`, L67-L100 of the prototype's
// `index.html`) — 「工作日 / 每天 / 周末」 day labels, the literal `HH:MM–HH:MM` range text (all-day
// included: `00:00–24:00`), groups joined with 「；」, and 「每天全天」 when no weekly window is stored.
  // Wave Q aligned this: the plane used a second dialect («工作日 · 09:00–18:00», 「未设置周时段»,
// 「每天 · 全天» joined with 「 · ») for the SAME datum, so the 允许时间窗口 column, the mobile card and
// the editor preview all read differently from the prototype. Only the budget guard below
// (「自定义 · N 个时段」) and the unparsable text are plane-only, and they are documented as such.
function intervalTextOf(intervals) {
  return intervals.map(([start, end]) => `${start}${EN_DASH}${end}`).join("、");
}

function daySetLabel(dayKeys) {
  const set = new Set(dayKeys);
  if (dayKeys.length === 7) return "每天";
  if (dayKeys.length === 5 && ["mon", "tue", "wed", "thu", "fri"].every((day) => set.has(day))) return "工作日";
  if (dayKeys.length === 2 && set.has("sat") && set.has("sun")) return "周末";
  return dayKeys.map((day) => WINDOW_DAY_LABELS[day]).join("、");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Field parsers. Each one reports its own checkable reasons and never guesses.
// ---------------------------------------------------------------------------

/** `weekly` -> `{ ok, days: Map<day, [start, end][]>, brokenDays: Set<day> }`. */
function parseWeekly(raw, reasons) {
  const days = new Map(WINDOW_DAY_KEYS.map((day) => [day, []]));
  const brokenDays = new Set();
  // Absence rule, shared with the other three fields: `undefined` / `null` / `""`
  // mean "not set", mirroring the Admin form coercion (`coerceWeekly`). The
  // canonical empty container (`{}`) means the same thing.
  if (raw === undefined || raw === null || raw === "") return { ok: true, days, brokenDays };
  if (!isRecord(raw)) {
    for (const day of WINDOW_DAY_KEYS) brokenDays.add(day);
    reasons.push(reason("weekly", "weekly", "weekly_must_be_an_object", "weekly 必须是「星期 → 区间数组」对象"));
    return { ok: false, days, brokenDays };
  }
  let ok = true;
  for (const rawKey of Object.keys(raw)) {
    const day = String(rawKey).toLowerCase();
    const path = `weekly.${rawKey}`;
    // `Object.hasOwn` rather than a truthy lookup: an own key such as `__proto__`,
    // `constructor` or `toString` (JSON.parse creates own properties for these)
    // would otherwise resolve to a truthy `Object.prototype` member and then crash
    // the interval-bucket lookup below. Inherited names are unknown weekdays, and
    // unknown weekdays are a checkable reason, never an exception.
    if (!Object.hasOwn(WINDOW_DAY_LABELS, day)) {
      reasons.push(reason("weekly", path, "unknown_weekday", `未知星期键 ${shortValue(rawKey)}`));
      ok = false;
      continue;
    }
    const label = WINDOW_DAY_LABELS[day];
    const intervals = raw[rawKey];
    if (!Array.isArray(intervals)) {
      brokenDays.add(day);
      reasons.push(reason("weekly", path, "intervals_must_be_an_array", `${label}的区间必须是数组`));
      ok = false;
      continue;
    }
    const bucket = days.get(day);
    intervals.forEach((interval, index) => {
      const intervalPath = `${path}[${index}]`;
      if (!Array.isArray(interval) || interval.length !== 2) {
        brokenDays.add(day);
        reasons.push(reason("weekly", intervalPath, "interval_must_be_a_pair", `${label}的区间必须是 [开始, 结束]`));
        ok = false;
        return;
      }
      const [start, end] = interval;
      if (typeof start !== "string" || !START_TIME_PATTERN.test(start)) {
        brokenDays.add(day);
        reasons.push(reason("weekly", `${intervalPath}[0]`, "invalid_start_time", `开始时刻不是 HH:MM：${shortValue(start)}`));
        ok = false;
        return;
      }
      if (typeof end !== "string" || !END_TIME_PATTERN.test(end)) {
        brokenDays.add(day);
        reasons.push(reason("weekly", `${intervalPath}[1]`, "invalid_end_time", `结束时刻不是 HH:MM 或 24:00：${shortValue(end)}`));
        ok = false;
        return;
      }
      if (start >= end) {
        brokenDays.add(day);
        reasons.push(reason("weekly", intervalPath, "window_must_not_cross_midnight", `区间 ${start}${EN_DASH}${end} 跨午夜或为空`));
        ok = false;
        return;
      }
      bucket.push([start, end]);
    });
  }
  for (const day of WINDOW_DAY_KEYS) days.set(day, sortAndDedupeIntervals(days.get(day)));
  return { ok, days, brokenDays };
}

function parseDateRanges(raw, reasons) {
  const empty = { present: false, valid: true, items: [] };
  if (raw === undefined || raw === null || raw === "") return empty;
  if (!Array.isArray(raw)) {
    reasons.push(reason("dateRanges", "dateRanges", "date_ranges_must_be_an_array", "dateRanges 必须是 { from, to } 数组"));
    return { present: true, valid: false, items: [] };
  }
  if (raw.length === 0) return empty;
  const items = [];
  let valid = true;
  raw.forEach((range, index) => {
    const path = `dateRanges[${index}]`;
    if (!isRecord(range)) {
      reasons.push(reason("dateRanges", path, "range_must_be_an_object", "日期区间必须是 { from, to }"));
      valid = false;
      return;
    }
    const { from, to } = range;
    if (!isCalendarDate(from) || !isCalendarDate(to)) {
      reasons.push(reason("dateRanges", path, "invalid_calendar_date", `日期必须是 YYYY-MM-DD：${shortValue(from)}..${shortValue(to)}`));
      valid = false;
      return;
    }
    if (from > to) {
      reasons.push(reason("dateRanges", path, "from_must_not_be_after_to", `起点晚于终点：${from}..${to}`));
      valid = false;
      return;
    }
    items.push({ from, to, text: `${from}..${to}` });
  });
  const seen = new Set();
  const sorted = items
    .sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) : a.from < b.from ? -1 : 1))
    .filter((item) => {
      if (seen.has(item.text)) return false;
      seen.add(item.text);
      return true;
    });
  return { present: true, valid, items: sorted };
}

function parseInstant(raw, field, reasons) {
  if (raw === undefined || raw === null || raw === "") return { present: false, valid: true, value: null };
  if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw))) {
    reasons.push(reason(field, field, "invalid_iso_instant", `${field} 不是合法的 ISO 时刻：${shortValue(raw)}`));
    return { present: true, valid: false, value: null };
  }
  return { present: true, valid: true, value: raw };
}

// ---------------------------------------------------------------------------
// Grouping and summary
// ---------------------------------------------------------------------------

function buildGroups(days) {
  const byExpression = new Map();
  for (const day of WINDOW_DAY_KEYS) {
    const intervals = days.get(day) ?? [];
    if (intervals.length === 0) continue;
    const signature = intervals.map(([start, end]) => `${start}-${end}`).join(",");
    if (!byExpression.has(signature)) byExpression.set(signature, { signature, dayKeys: [], intervals });
    byExpression.get(signature).dayKeys.push(day);
  }
  return [...byExpression.values()]
    .sort((a, b) => WINDOW_DAY_KEYS.indexOf(a.dayKeys[0]) - WINDOW_DAY_KEYS.indexOf(b.dayKeys[0]))
    .map((group) => {
      const dayLabel = daySetLabel(group.dayKeys);
      const intervalText = intervalTextOf(group.intervals);
      return { dayKeys: group.dayKeys, dayLabel, intervals: group.intervals, intervalText, text: `${dayLabel} ${intervalText}` };
    });
}

function buildSummary({ windowOk, groups, markers }) {
  const markerTokens = [markers.dateRanges.marker, markers.startsAt.marker, markers.expiresAt.marker].filter(Boolean);
  const base = {
    groupCount: groups.length,
    overBudget: false,
    allDayEveryDay: false,
    markers: markerTokens,
    disclaimer: WINDOW_SCOPE_DISCLAIMER,
  };
  // Any unreadable window field makes the headline explicitly unparsable instead
  // of letting "每天全天" stand in for an unreadable constraint.
  if (!windowOk) return { ...base, shape: "unparsable", text: WINDOW_UNPARSABLE_MESSAGE };
  if (groups.length === 0) return { ...base, shape: "no-weekly", text: "每天全天" };
  const joined = groups.map((group) => group.text).join("；");
  if (groups.length > WINDOW_SUMMARY_MAX_GROUPS || countCodePoints(joined) > WINDOW_SUMMARY_MAX_CODEPOINTS) {
    return { ...base, shape: "custom", text: `自定义 · ${groups.length} 个时段`, overBudget: true };
  }
  const allDayEveryDay = groups.length === 1 && groups[0].dayKeys.length === 7 && isAllDayIntervals(groups[0].intervals);
  return { ...base, shape: allDayEveryDay ? "all-day-every-day" : "groups", text: joined, allDayEveryDay };
}

function buildDayView(day, state, intervals) {
  const list = intervals.map(([start, end]) => ({
    start, end, allDay: start === "00:00" && end === "24:00", text: `${start}${EN_DASH}${end}`,
  }));
  const text = state === DAY_STATES.ALL_DAY ? "全天"
    : state === DAY_STATES.INTERVALS ? list.map((item) => item.text).join("、")
    : state === DAY_STATES.EMPTY ? "该日无生效时段"
    : state === DAY_STATES.UNSPECIFIED ? "未设置周约束"
    : "无法解析";
  return { key: day, label: WINDOW_DAY_LABELS[day], state, allDay: state === DAY_STATES.ALL_DAY, intervals: list, text };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * `presentAccessPolicyWindow(policy)` — #434 lane A frozen view-model.
 *
 * Reads only `weekly` / `dateRanges` / `startsAt` / `expiresAt` / `timezone`; any
 * other policy field (label, subjects, capabilities, id, mode, enabled) is ignored,
 * so no identity or secret-bearing value can reach the window summary. `policy` may
 * be a schema-normalized policy or raw unvalidated input; invalid window data is
 * reported through `unparsable` and never rendered as all-day/unlimited.
 *
 * `ok: false` means at least one window field could not be parsed. `summary.shape`
 * is then `"unparsable"` and `summary.text` is the explicit unparsable message
 * (fields that did parse stay inspectable through `groups` / `markers` / `details`).
 *
 * `hasWeeklyConstraint` is a fact about the parsed grid: at least one day carries a
 * valid interval. When `weekly.ok` is false it describes only the days that parsed,
 * and `details.days` marks every unreadable day as `unparsable` (never as
 * "no weekly constraint").
 */
export function presentAccessPolicyWindow(policy) {
  const source = isRecord(policy) ? policy : {};
  const reasons = [];

  const weekly = parseWeekly(source.weekly, reasons);
  const dateRanges = parseDateRanges(source.dateRanges, reasons);
  const startsAt = parseInstant(source.startsAt, "startsAt", reasons);
  const expiresAt = parseInstant(source.expiresAt, "expiresAt", reasons);
  const timezone = typeof source.timezone === "string" ? source.timezone : null;
  const timezoneValid = isValidIanaTimeZone(source.timezone);
  if (!timezoneValid) {
    reasons.push(reason("timezone", "timezone", "invalid_iana_timezone", `timezone 不是合法的 IANA 时区：${shortValue(source.timezone)}`));
  }

  const hasWeeklyConstraint = WINDOW_DAY_KEYS.some((day) => (weekly.days.get(day) ?? []).length > 0);
  const groups = buildGroups(weekly.days);

  const markers = {
    dateRanges: {
      present: dateRanges.present,
      valid: dateRanges.valid,
      marker: dateRanges.present ? MARKER_LABELS.dateRanges : null,
      text: dateRanges.present ? (dateRanges.valid ? dateRanges.items.map((item) => item.text).join("、") : "无法解析日期区间") : null,
    },
    startsAt: {
      present: startsAt.present,
      valid: startsAt.valid,
      marker: startsAt.present ? MARKER_LABELS.startsAt : null,
      text: startsAt.present ? (startsAt.valid ? startsAt.value : "无法解析开始时间") : null,
    },
    expiresAt: {
      present: expiresAt.present,
      valid: expiresAt.valid,
      marker: expiresAt.present ? MARKER_LABELS.expiresAt : null,
      text: expiresAt.present ? (expiresAt.valid ? expiresAt.value : "无法解析截止时间") : null,
    },
  };

  const dayView = (day) => {
    const intervals = weekly.days.get(day) ?? [];
    if (weekly.brokenDays.has(day)) return buildDayView(day, DAY_STATES.UNPARSABLE, []);
    if (intervals.length > 0) {
      return buildDayView(day, isAllDayIntervals(intervals) ? DAY_STATES.ALL_DAY : DAY_STATES.INTERVALS, intervals);
    }
    // A malformed weekly grid can never be read as "no weekly constraint", so an
    // empty day inside it stays unparsable instead of claiming "未设置周约束".
    if (!weekly.ok) return buildDayView(day, DAY_STATES.UNPARSABLE, []);
    return buildDayView(day, hasWeeklyConstraint ? DAY_STATES.EMPTY : DAY_STATES.UNSPECIFIED, []);
  };

  return deepFreeze({
    ok: reasons.length === 0,
    unparsable: reasons.length === 0 ? null : { message: WINDOW_UNPARSABLE_MESSAGE, reasons },
    timezone,
    timezoneValid,
    hasWeeklyConstraint,
    summary: buildSummary({ windowOk: reasons.length === 0, groups, markers }),
    groups,
    markers,
    details: {
      timezone,
      timezoneValid,
      days: WINDOW_DAY_KEYS.map((day) => dayView(day)),
      dateRanges: { present: dateRanges.present, valid: dateRanges.valid, items: dateRanges.items },
      startsAt: { present: startsAt.present, valid: startsAt.valid, value: startsAt.value },
      expiresAt: { present: expiresAt.present, valid: expiresAt.valid, value: expiresAt.value },
    },
  });
}
