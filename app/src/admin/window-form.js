// Form decoding for one time window, shared by the constraint routes.
//
// Moved out of the retired legacy policy route module (`src/admin/routes/access-policy.js`) with no
// behaviour change: `/admin/auth/authz` accepts both the structured grids (`w_mon_from_1` …
// `range_from_1`) and the legacy text encoding (`mon 09:00-18:00`, `2026-10-01..2026-10-07`), and a
// `datetime-local` bound is read in the window's own timezone. The service owns every default and
// every validity rule; this module only translates what the browser cannot express.
import { clean } from "./http.js";
import { zonedParts } from "./presentation/model.js";

const WEEK_DAYS = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

/** The last value of a repeated field (a checkbox following its hidden `false` partner). */
function lastValue(value) {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

/** `mon 09:00-18:00` lines -> the schema's `{ mon: [["09:00","18:00"]] }` (the service's own grammar). */
export function parseWeeklyText(text) {
  const weekly = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([A-Za-z]{3})\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/.exec(line);
    if (!match) return null; // malformed: never guessed, the service fails closed on the raw value
    const day = match[1].toLowerCase();
    if (!WEEK_DAYS.includes(day)) return null;
    (weekly[day] ??= []).push([match[2], match[3]]);
  }
  return weekly;
}

/** `2026-10-01..2026-10-07` lines -> `[{ from, to }]` (the service's own grammar). */
export function parseDateRangesText(text) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => {
    const parts = line.split(/\s*\.\.\s*/);
    return { from: parts[0], to: parts[1] ?? parts[0] };
  });
}

/** Structured per-weekday fields (`w_mon_from_1` …) -> the `weekly` record. */
export function weeklyFromFields(body) {
  const weekly = {};
  for (const day of WEEK_DAYS) {
    const slots = new Map();
    for (const [key, value] of Object.entries(body ?? {})) {
      const match = new RegExp(`^w_${day}_(from|to)_(\\d+)$`).exec(key);
      if (!match) continue;
      const slot = slots.get(match[2]) ?? { from: "", to: "" };
      slot[match[1]] = clean(lastValue(value), 8) ?? "";
      slots.set(match[2], slot);
    }
    const intervals = [...slots.keys()].sort((a, b) => Number(a) - Number(b))
      .map((index) => slots.get(index))
      .filter((slot) => slot.from || slot.to)
      .map((slot) => [slot.from, slot.to]);
    if (intervals.length) weekly[day] = intervals;
  }
  return weekly;
}

/** Structured date fields (`range_from_1` …) -> `[{ from, to }]`. */
export function dateRangesFromFields(body) {
  const slots = new Map();
  for (const [key, value] of Object.entries(body ?? {})) {
    const match = /^range_(from|to)_(\d+)$/.exec(key);
    if (!match) continue;
    const slot = slots.get(match[2]) ?? { from: "", to: "" };
    slot[match[1]] = clean(lastValue(value), 10) ?? "";
    slots.set(match[2], slot);
  }
  return [...slots.keys()].sort((a, b) => Number(a) - Number(b))
    .map((index) => slots.get(index))
    .filter((slot) => slot.from || slot.to)
    .map((slot) => ({ from: slot.from, to: slot.to }));
}

const LOCAL_INPUT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/**
 * `datetime-local` wall clock -> ISO instant, interpreted in the window's timezone (the prototype's
 * rule: "起止时间用 datetime-local，按策略时区解释，旁边显示存储的 UTC 值"). Anything that already
 * carries a zone/offset, or an unparsable value, is passed through untouched so the schema — not this
 * helper — decides validity.
 */
export function wallClockToInstant(value, zone) {
  const raw = String(value ?? "").trim();
  if (!raw || !LOCAL_INPUT.test(raw)) return raw;
  try {
    const wall = Date.parse(`${raw.length === 16 ? raw : raw.slice(0, 16)}:00Z`);
    if (!Number.isFinite(wall)) return raw;
    let guess = wall;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = zonedParts(new Date(guess).toISOString(), zone);
      if (!parts) return raw;
      const asUtc = Date.parse(`${parts.date}T${parts.hm}:00Z`);
      if (!Number.isFinite(asUtc)) return raw;
      const delta = wall - asUtc;
      if (delta === 0) break;
      guess += delta;
    }
    return new Date(guess).toISOString();
  } catch {
    return raw; // unknown timezone: the schema reports INVALID_TIMEZONE
  }
}
