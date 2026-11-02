// Property value display helpers.
//
// The desktop app infers a property's type from its value and renders date values
// through moment (`L` for a calendar date, `L LT` when a time is present); a
// date-only value is a calendar day, not an instant. This module owns that
// inference so the panel and its tests agree.
//
// Three inputs reach us, and all three must keep the *authored* calendar day no
// matter what timezone the browser runs in:
//   - a `YYYY-MM-DD` string (quoted frontmatter, or a string value);
//   - a `Date` instance — js-yaml turns an unquoted date-only YAML scalar into UTC
//     midnight, so its UTC components are the authored day;
//   - an ISO datetime string — the day is the string's own date part (desktop
//     normalizes date-only values to `T00:00:00`, i.e. never shifts the day).
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/;

const pad = (value, width = 2) => String(value).padStart(width, "0");

/** Calendar parts for an authored day, rejecting impossible dates (2026-02-31). */
function calendarParts(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return { iso: `${pad(year, 4)}-${pad(month)}-${pad(day)}`, date };
}

/**
 * `{ iso, date, time, datetime, instant? }` for a date-like value, else null.
 *
 * `iso` / `date` are the authored calendar day in local time (safe to render with
 * `toLocaleDateString`); `time` says whether the source carried a time of day;
 * `datetime` is the value for the `datetime` attribute.
 */
export function isoDateParts(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const year = value.getUTCFullYear();
    const month = value.getUTCMonth() + 1;
    const day = value.getUTCDate();
    const parts = calendarParts(year, month, day);
    if (!parts) return null;
    // YAML date-only values arrive as UTC midnight; anything else carries a time. `instant`
    // keeps the real instant so `L LT` renders the local time, not the local midnight.
    const time = value.getUTCHours() !== 0 || value.getUTCMinutes() !== 0 || value.getUTCSeconds() !== 0 || value.getUTCMilliseconds() !== 0;
    return { ...parts, time, datetime: value.toISOString(), instant: time ? value : undefined };
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  const dateOnly = ISO_DATE.exec(text);
  if (dateOnly) {
    const parts = calendarParts(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
    return parts ? { ...parts, time: false, datetime: parts.iso } : null;
  }
  const dateTime = ISO_DATETIME.exec(text);
  if (!dateTime) return null;
  const [, iso, clock, zone = ""] = dateTime;
  const parts = calendarParts(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10)));
  if (!parts) return null;
  const instant = new Date(`${iso}T${clock}${zone}`);
  if (Number.isNaN(instant.getTime())) return null;
  return { ...parts, time: true, datetime: text, instant };
}

// Locale short form with padded day/month, e.g. en-US "10/04/2026", zh-CN "2026/10/04";
// a value that carries a time appends the locale time, desktop's `L LT`.
//
// The day and the time must come from ONE zone: desktop renders a single instant in the
// local zone (asar app.js `t.prototype.renderTo`:
// `e.setText(window.moment(this.date).format(this.time?"L LT":"L"))`, with `this.date` built as
// `new Date(e)` for a time-bearing value and `new Date(e+"T00:00:00")` — local midnight, so the
// authored day can never shift — for a date-only one). Formatting the authored UTC day next to a
// local clock readout printed two different instants (a UTC-x day with a later local time).
export function formatDateValue(value) {
  const parsed = isoDateParts(value);
  if (!parsed) return null;
  const source = parsed.instant ?? parsed.date;
  const dateText = source.toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });
  if (!parsed.time) return dateText;
  const timeText = source.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${dateText} ${timeText}`;
}
