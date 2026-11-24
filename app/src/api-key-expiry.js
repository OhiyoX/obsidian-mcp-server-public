const DAY_MS = 86400000;
// The form's choice list. Anything else is a forged value, not an option.
const CHOICE_DAYS = { "7": 7, "30": 30, "90": 90 };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isAbsent = (value) => value === undefined || value === null || value === "";

export function apiKeyExpired(record, now = Date.now()) {
  const at = record?.expiresAt;
  if (!at) return false;
  const parsed = Date.parse(at);
  // A corrupt value refuses the key instead of making it permanent: the table and the
  // authentication path must read the same record the same way.
  return !Number.isFinite(parsed) || parsed <= now;
}

// The store keeps expiresAt as given, so this is the only boundary that validates it: only
// timestamps built here get out. (apiKeyExpired fails closed on a value it cannot parse.)
export function resolveKeyExpiry(choice, date, now = Date.now()) {
  if (!isAbsent(date)) {
    const day = typeof date === "string" ? date.trim() : "";
    const at = DAY_RE.test(day) ? Date.parse(`${day}T23:59:59.999Z`) : NaN;
    // A day that does not exist (2026-02-30) rolls over; it must not become a date nobody picked.
    if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== day) throw new Error("expiry_invalid");
    if (at <= now) throw new Error("expiry_past");
    return new Date(at).toISOString();
  }
  if (isAbsent(choice) || choice === "never") return null;
  const days = typeof choice === "string" ? CHOICE_DAYS[choice] : undefined;
  if (!Number.isInteger(days)) throw new Error("expiry_invalid");
  return new Date(now + days * DAY_MS).toISOString();
}

// The Admin plane's view of the same fact: how much is left, said in one word. An unparsable value
// is treated as expired rather than never, so a corrupt record cannot read as permanent.
export function keyExpiryState(expiresAt, now = Date.now()) {
  if (!expiresAt) return { kind: "never", days: null };
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed) || parsed <= now) return { kind: "expired", days: null };
  const days = Math.ceil((parsed - now) / DAY_MS);
  // "Today" means the same UTC calendar day, not "within 24h": a key that dies tomorrow at 11:00
  // must not tell the operator it expires today.
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { kind: day(parsed) === day(now) ? "today" : "active", days };
}
