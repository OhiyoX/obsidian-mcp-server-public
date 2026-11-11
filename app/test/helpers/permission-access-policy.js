// P0 / Task 1 — store and remove the temporal policy a permission row needs.
//
// Task 3 froze the legacy write routes (design §7 step 2 + step 5), so the HTTP crate seam these rows
// used is gone. Two seams remain, both production code:
//   * `service`: the real `createAccessPolicyAdmin` over the plane's own store — same schema, same
//     CAS, same file. This is how the in-process plane (and the baseline collector that drives it)
//     stores a temporary policy now;
//   * `document`: a store the caller owns, for the *spawned* `server.js`, which has no service handle
//     in the test process. The policy is written by the same store code before that process boots, so
//     the file it reads is exactly what an operator's save would have produced.

import fs from "node:fs/promises";
import path from "node:path";

const WEEKDAY = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

/** The form body the Admin editor posts for one policy. `weekly` is `{mon:[["09:00","18:00"]]}`. */
export function policyForm({ csrf, ...fields }) {
  const body = new URLSearchParams();
  body.set("csrf", csrf);
  body.set("label", fields.label);
  for (const subject of fields.subjects ?? []) body.append("subjects", subject);
  body.set("mode", fields.mode ?? "suspend");
  for (const capability of fields.capabilities ?? []) body.append("capabilities", capability);
  body.set("timezone", fields.timezone ?? "UTC");
  body.set("enabled", fields.enabled === false ? "false" : "true");
  if (fields.startsAt) body.set("startsAt", fields.startsAt);
  if (fields.expiresAt) body.set("expiresAt", fields.expiresAt);
  let dayIndex = 0;
  for (const day of WEEKDAY) {
    const intervals = fields.weekly?.[day] ?? [];
    intervals.forEach(([from, to], slot) => {
      body.set(`w_${day}_from_${slot}`, from);
      body.set(`w_${day}_to_${slot}`, to);
      dayIndex += 1;
    });
  }
  (fields.dateRanges ?? []).forEach((range, index) => {
    body.set(`range_from_${index + 1}`, range.from);
    body.set(`range_to_${index + 1}`, range.to);
  });
  return body.toString();
}

const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

/** Store one policy through the real Admin service (the frozen routes' successor in tests). */
export async function storePolicyThroughService({ service, policy }) {
  const created = await service.createPolicy({ ...policy });
  if (!created?.ok) throw new Error(`the Admin service did not store the policy: ${JSON.stringify(created).slice(0, 300)}`);
  return created;
}

/** Remove the policy with this label through the same service (CAS on its current revision). */
export async function removePolicyThroughService({ service, label }) {
  const listed = await service.listPolicies();
  const found = (listed.policies ?? []).find((entry) => entry.label === label);
  if (!found) return null;
  return service.deletePolicy(found.id, listed.revision);
}

/** Create one policy the way the Admin editor does. Returns the redirect response. */
export async function createPolicyThroughAdmin({ request, cookie, csrf, policy }) {
  return request({
    method: "POST",
    urlPath: "/admin/auth/access-policy/create",
    headers: { Cookie: cookie, ...FORM },
    body: policyForm({ csrf, ...policy }),
  });
}

/** Read the committed policy document straight from disk (the Admin surface's own file). */
export async function readPolicyDocument(dataPath) {
  const text = await fs.readFile(path.join(dataPath, "access-policy.json"), "utf8");
  return JSON.parse(text);
}

/** Find the id and revision of the policy with this label. */
export async function findPolicyByLabel(dataPath, label) {
  const document = await readPolicyDocument(dataPath);
  const policy = document.policies.find((entry) => entry.label === label);
  return policy ? { id: policy.id, revision: document.revision, policy } : null;
}

/** Remove a policy with the typed confirmation the delete route requires. */
export async function deletePolicyThroughAdmin({ request, cookie, csrf, dataPath, label }) {
  const found = await findPolicyByLabel(dataPath, label);
  if (!found) return null;
  return request({
    method: "POST",
    urlPath: "/admin/auth/access-policy/delete",
    headers: { Cookie: cookie, ...FORM },
    body: new URLSearchParams({ csrf, id: found.id, expectedRevision: String(found.revision), confirm: label }).toString(),
  });
}

/**
 * Run `fn` with exactly one extra policy in the store, then remove it. Every time row is collected
 * this way, so a leftover policy can never explain a later answer.
 *
 * `service` is required: the legacy write routes that used to carry this are frozen (Task 3).
 */
export async function withTemporaryPolicy({ service, policy }, fn) {
  if (!service) throw new TypeError("withTemporaryPolicy needs the Admin service: the legacy write routes are frozen");
  const created = await storePolicyThroughService({ service, policy });
  try {
    return await fn();
  } finally {
    // A policy left behind would gate later rows, so a failed cleanup is a collection failure.
    const removed = await removePolicyThroughService({ service, label: policy.label });
    if (!removed?.ok) throw new Error(`the temporary policy ${policy.label} could not be removed: ${JSON.stringify(removed).slice(0, 200)} (created revision ${created.revision})`);
  }
}

/** "HH:MM" of `instant` in `timeZone`, plus its weekday key. */
export function wallClockIn(timeZone, instant) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, hour12: false, hour: "2-digit", minute: "2-digit", weekday: "short",
  }).formatToParts(instant);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const dayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { hm: `${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}`, day: WEEKDAY[(dayIndex + 6) % 7] };
}

/** "YYYY-MM-DD" of `instant` in `timeZone`. */
export function calendarDateIn(timeZone, instant) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

const minutes = (hm) => {
  const [hours, mins] = hm.split(":").map(Number);
  return hours * 60 + mins;
};
const clock = (value) => `${String(Math.floor(value / 60) % 24).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const clampMinutes = (value) => Math.max(0, Math.min(24 * 60, value));

/**
 * A one-day weekly window that CONTAINS `instant` in `timeZone` (clamped so it never crosses
 * midnight, which the schema forbids).
 */
export function weeklyWindowContaining(timeZone, instant) {
  const { hm, day } = wallClockIn(timeZone, instant);
  const now = minutes(hm);
  const from = clock(clampMinutes(now - 30));
  const to = now + 30 >= 24 * 60 ? "24:00" : clock(now + 30);
  return { day, weekly: { [day]: [[from, to]] } };
}

/**
 * A one-day weekly window that EXCLUDES `instant` in `timeZone`. It is built from "now" in that
 * zone, so the row means the same thing on every run without a frozen clock.
 */
export function weeklyWindowExcluding(timeZone, instant) {
  const { hm, day } = wallClockIn(timeZone, instant);
  const now = minutes(hm);
  const weekly = now >= 2
    ? { [day]: [["00:00", clock(now - 1)]] }
    : { [day]: [[clock(now + 1), "24:00"]] };
  return { day, weekly };
}
