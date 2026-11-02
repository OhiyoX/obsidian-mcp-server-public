// Access-policy time semantics for AuthZ Wave A (A1).
//
// Contract: pure and deterministic. Every entry point receives an explicit
// epoch-ms instant plus the policy's IANA timezone. This module never reads the
// ambient clock, never uses the host timezone, never stores a fixed UTC offset
// and never keeps module-level mutable state. Instant -> local uses
// Intl.DateTimeFormat(..., { hourCycle: "h23" }); local -> instant uses the
// frozen resolver below (iterate + verify + minute scan across DST edges).

export const WEEKDAYS = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const HORIZON_MS = 366 * DAY_MS;
const RESOLVE_SCAN_MINUTES = 180;
const MAX_SCHEDULE_STEPS = 512;

const WEEKDAY_SHORT = Object.freeze({
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
  Sun: "sun",
});

function pad2(value) {
  return String(value).padStart(2, "0");
}

function localFormatter(timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
}

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone.length < 1 || timeZone.length > 80) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function localParts(instantMs, timeZone) {
  const fields = {};
  for (const part of localFormatter(timeZone).formatToParts(new Date(instantMs))) {
    fields[part.type] = part.value;
  }
  const year = Number(fields.year);
  const month = Number(fields.month);
  const day = Number(fields.day);
  const hour = Number(fields.hour);
  const minute = Number(fields.minute);
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday: WEEKDAY_SHORT[fields.weekday] ?? WEEKDAYS[(new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7],
    date: `${fields.year}-${fields.month}-${fields.day}`,
    time: `${pad2(hour)}:${pad2(minute)}`,
  };
}

function shiftDate(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

function weekdayOfDate(date) {
  const [year, month, day] = date.split("-").map(Number);
  return WEEKDAYS[(new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7];
}

function wallMs(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

function matchesWall(parts, target) {
  return parts.year === target.year
    && parts.month === target.month
    && parts.day === target.day
    && parts.hour === target.hour
    && parts.minute === target.minute;
}

function targetOf(date, time) {
  // "24:00" is only valid as an interval end and means the next day at 00:00.
  const day = time === "24:00" ? shiftDate(date, 1) : date;
  const clock = time === "24:00" ? "00:00" : time;
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  const [hour, minute] = clock.split(":").map(Number);
  return { year, month, day: dayOfMonth, hour, minute };
}

// Frozen resolver (INTERFACE §3.5): iterate twice from Date.UTC(wall), verify
// the round-trip, then handle DST edges. A repeated wall time resolves to the
// earlier instant; a non-existent wall time resolves to the gap end.
function resolveLocal(timeZone, date, time) {
  const target = targetOf(date, time);
  const targetWall = wallMs(target);
  let guess = targetWall;
  let parts = localParts(guess, timeZone);
  for (let i = 0; i < 2 && !matchesWall(parts, target); i++) {
    guess -= wallMs(parts) - targetWall;
    parts = localParts(guess, timeZone);
  }
  if (matchesWall(parts, target)) {
    const back = guess - RESOLVE_SCAN_MINUTES * MINUTE_MS;
    const backParts = localParts(back, timeZone);
    const repeatShift = (wallMs(backParts) - back) - (wallMs(parts) - guess);
    if (repeatShift > 0) {
      const earlier = guess - repeatShift;
      if (matchesWall(localParts(earlier, timeZone), target)) return earlier;
    }
    return guess;
  }
  let firstAtOrAfter = null;
  const scanFrom = guess - RESOLVE_SCAN_MINUTES * MINUTE_MS;
  for (let i = 0; i <= 2 * RESOLVE_SCAN_MINUTES; i++) {
    const candidate = scanFrom + i * MINUTE_MS;
    const candidateParts = localParts(candidate, timeZone);
    if (matchesWall(candidateParts, target)) return candidate;
    if (firstAtOrAfter === null && wallMs(candidateParts) >= targetWall) firstAtOrAfter = candidate;
  }
  return firstAtOrAfter ?? guess;
}

function intervalsOf(weekly, weekday) {
  const intervals = weekly?.[weekday];
  return Array.isArray(intervals) ? intervals : [];
}

function sortByStart(intervals) {
  return [...intervals].sort((a, b) => {
    const left = String(a?.[0] ?? "");
    const right = String(b?.[0] ?? "");
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function weeklyIsActive(policy) {
  const weekly = policy.weekly;
  if (!weekly || typeof weekly !== "object") return false;
  return WEEKDAYS.some((day) => intervalsOf(weekly, day).length > 0);
}

export function evaluatePolicySchedule(policy, nowMs) {
  const startsAt = policy.startsAt ? Date.parse(policy.startsAt) : null;
  if (startsAt !== null && !(startsAt <= nowMs)) return { ok: false, reason: "not_started" };
  const expiresAt = policy.expiresAt ? Date.parse(policy.expiresAt) : null;
  if (expiresAt !== null && !(nowMs < expiresAt)) return { ok: false, reason: "expired" };
  const local = localParts(nowMs, policy.timezone);
  const dateRanges = Array.isArray(policy.dateRanges) ? policy.dateRanges : [];
  if (dateRanges.length > 0 && !dateRanges.some((range) => range && range.from <= local.date && local.date <= range.to)) {
    return { ok: false, reason: "date_out_of_range" };
  }
  if (weeklyIsActive(policy)) {
    const inside = intervalsOf(policy.weekly, local.weekday)
      .some(([start, end]) => start <= local.time && local.time < end);
    if (!inside) return { ok: false, reason: "outside_weekly" };
  }
  return { ok: true };
}

// First instant strictly after `cursorMs` at which the failing reason can flip.
function nextCandidate(policy, cursorMs, reason) {
  if (reason === "expired") return null;
  const timeZone = policy.timezone;
  if (reason === "not_started") {
    const startsAt = policy.startsAt ? Date.parse(policy.startsAt) : NaN;
    return Number.isFinite(startsAt) && startsAt > cursorMs ? startsAt : null;
  }
  if (reason === "date_out_of_range") {
    const local = localParts(cursorMs, timeZone);
    let best = null;
    for (const range of Array.isArray(policy.dateRanges) ? policy.dateRanges : []) {
      if (!range || range.to < local.date) continue;
      const candidate = resolveLocal(timeZone, range.from, "00:00");
      if (candidate > cursorMs && (best === null || candidate < best)) best = candidate;
    }
    return best;
  }
  if (reason === "outside_weekly") {
    const local = localParts(cursorMs, timeZone);
    for (let offset = 0; offset <= 7; offset++) {
      const date = shiftDate(local.date, offset);
      for (const [start] of sortByStart(intervalsOf(policy.weekly, weekdayOfDate(date)))) {
        if (offset === 0 && start <= local.time) continue;
        const candidate = resolveLocal(timeZone, date, start);
        if (candidate > cursorMs) return candidate;
      }
    }
    return null;
  }
  return null;
}

function findNextAllowed(policy, fromMs, expiresAt) {
  const horizon = expiresAt === null ? fromMs + HORIZON_MS : Math.min(expiresAt, fromMs + HORIZON_MS);
  let cursor = fromMs;
  if (policy.startsAt) {
    const startsAt = Date.parse(policy.startsAt);
    if (Number.isFinite(startsAt) && startsAt > cursor) cursor = startsAt;
  }
  for (let step = 0; step < MAX_SCHEDULE_STEPS; step++) {
    if (cursor > horizon) return null;
    const result = evaluatePolicySchedule(policy, cursor);
    if (result.ok) return cursor;
    const candidate = nextCandidate(policy, cursor, result.reason);
    if (candidate === null || candidate <= cursor || candidate > horizon) return null;
    cursor = candidate;
  }
  return null;
}

// Next boundary after `fromMs` where `ok` may flip. Conservative candidates
// (local midnight) are allowed; the value is always deterministic and future.
function findNextChange(policy, fromMs) {
  const timeZone = policy.timezone;
  let best = null;
  const consider = (candidate) => {
    if (!Number.isFinite(candidate) || candidate <= fromMs) return;
    if (best === null || candidate < best) best = candidate;
  };
  if (policy.startsAt) consider(Date.parse(policy.startsAt));
  if (policy.expiresAt) consider(Date.parse(policy.expiresAt));
  for (const range of Array.isArray(policy.dateRanges) ? policy.dateRanges : []) {
    if (!range) continue;
    consider(resolveLocal(timeZone, range.from, "00:00"));
    consider(resolveLocal(timeZone, shiftDate(range.to, 1), "00:00"));
  }
  if (weeklyIsActive(policy)) {
    const local = localParts(fromMs, timeZone);
    for (let offset = 0; offset <= 7; offset++) {
      const date = shiftDate(local.date, offset);
      consider(resolveLocal(timeZone, date, "00:00"));
      for (const [start, end] of sortByStart(intervalsOf(policy.weekly, weekdayOfDate(date)))) {
        consider(resolveLocal(timeZone, date, start));
        if (typeof end === "string") consider(resolveLocal(timeZone, date, end));
      }
    }
  }
  return best;
}

export function nextTransition(policy, fromMs) {
  const expiresAt = policy.expiresAt ? Date.parse(policy.expiresAt) : null;
  if (expiresAt !== null && !(fromMs < expiresAt)) {
    return { nextChangeAt: null, nextAllowedAt: null };
  }
  return {
    nextChangeAt: findNextChange(policy, fromMs),
    nextAllowedAt: findNextAllowed(policy, fromMs, expiresAt),
  };
}
