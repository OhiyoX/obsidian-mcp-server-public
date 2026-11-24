// The window view model both 定时授权 surfaces read: the now-verdict, its wall-clock label and the
// 7-day timeline grid.
//
// Moved here unchanged from the deleted legacy `pages/authz.js` (design §7 step 2 + step 5 retired
// that page): the constraint list and its editor measure a constraint's `schedule` through
// `windowOf()` and then read exactly these three functions. The window summary and its markers stay
// in `../access-policy-window-presentation.js` (#434); this module only answers "is this window open
// now, and when is it open".
import { esc } from "../ui.js";
import { presentAccessPolicyWindow, WINDOW_DAY_LABELS } from "../access-policy-window-presentation.js";
import { t } from "../../i18n/context.js";
import { zonedParts } from "../presentation/model.js";

/** Weekday keys in display order (prototype `[1,2,3,4,5,6,0]` = 一…日). */
export const WEEK_DAYS = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

/** The three deployment modes (`src/authorization/runtime.js`), in the order the release uses them. */
export const AUTHORIZATION_MODES = Object.freeze(["legacy", "shadow", "enforce"]);

const FULL_DAY = Object.freeze({ start: "00:00", end: "24:00" });

/** `HH:MM` / `24:00` boundary as a percentage of a day (prototype `toPct`). */
function toPct(value) {
  const [hours, minutes] = String(value ?? "").split(":").map(Number);
  if (!Number.isFinite(hours)) return 0;
  if (hours >= 24) return 100;
  return ((hours * 60 + (Number.isFinite(minutes) ? minutes : 0)) / 1440) * 100;
}

/** `mon` -> `mon` day key for a wall-clock instant in `zone`. */
function dayKeyOf(parts) {
  if (!parts) return null;
  return WEEK_DAYS[(Number(parts.day) + 6) % 7] ?? null;
}

/**
 * Prototype `inWindow()` — "is this window open right now?" evaluated in the window's own timezone.
 * Honest tri-state: `ok === null` means the window cannot be judged (invalid timezone / unparsable
 * window), and the caller must render 无法判定 rather than 允许.
 *
 * The absolute bounds are compared as instants (`startsAt` / `expiresAt` are stored as ISO
 * instants by the schema), the date ranges and the weekly grid as local wall-clock values.
 */
export function policyNowState(policy, now = Date.now()) {
  const win = presentAccessPolicyWindow(policy);
  const zone = typeof policy?.timezone === "string" && win.timezoneValid ? policy.timezone : null;
  const local = zone ? zonedParts(now, zone) : null;
  if (!local) return { ok: null, why: t("adm.authz.why.badZone") };
  const starts = win.details.startsAt;
  const expires = win.details.expiresAt;
  if (starts.present && !starts.valid) return { ok: null, why: t("adm.authz.why.badStart") };
  if (starts.present && now < Date.parse(starts.value)) return { ok: false, why: t("adm.authz.why.beforeStart") };
  if (expires.present && !expires.valid) return { ok: null, why: t("adm.authz.why.badEnd") };
  if (expires.present && now > Date.parse(expires.value)) return { ok: false, why: t("adm.authz.why.afterEnd") };
  const ranges = win.details.dateRanges;
  if (ranges.present && !ranges.valid) return { ok: null, why: t("adm.authz.why.badRanges") };
  if (ranges.present && !ranges.items.some((range) => local.date >= range.from && local.date <= range.to)) {
    return { ok: false, why: t("adm.authz.why.notInRanges") };
  }
  const day = win.details.days.find((item) => item.key === dayKeyOf(local)) ?? null;
  if (!day) return { ok: true, why: t("adm.authz.why.noWeekly") };
  if (day.state === "unparsable") return { ok: null, why: t("adm.authz.why.windowUnparsable") };
  if (day.state === "unspecified") return { ok: true, why: t("adm.authz.why.noWeekly") };
  if (day.state === "empty") return { ok: false, why: t("adm.authz.why.noIntervalsToday") };
  if (day.state === "all-day") return { ok: true, why: t("adm.authz.why.allDayToday") };
  const inside = day.intervals.some((item) => local.hm >= item.start && local.hm < item.end);
  return { ok: inside, why: inside ? t("adm.authz.why.inside", { text: day.text }) : t("adm.authz.why.outside", { text: day.text }) };
}

/** Now (window timezone) as `MM-DD HH:mm`, for the verdict line. */
export function policyNowLabel(policy, now = Date.now()) {
  const win = presentAccessPolicyWindow(policy);
  const zone = typeof policy?.timezone === "string" && win.timezoneValid ? policy.timezone : null;
  const local = zone ? zonedParts(now, zone) : null;
  return local ? `${local.date.slice(5)} ${local.hm}` : new Date(now).toISOString().slice(0, 16).replace("T", " ");
}

/** Prototype `timeline()` — 7 day rows, window bars, "now" marker (see the module note). */
export function policyTimelineHtml(policy, now = Date.now()) {
  const win = presentAccessPolicyWindow(policy);
  const zone = typeof policy?.timezone === "string" && win.timezoneValid ? policy.timezone : null;
  const local = zone ? zonedParts(now, zone) : null;
  const nowPct = local ? ((Number(local.h) * 60 + Number(local.mi)) / 1440) * 100 : 0;
  const todayKey = dayKeyOf(local);
  // An unreadable weekly grid must never be drawn as "all day": a malformed `weekly` field keeps
  // the rows empty and the summary says 无法解析时间窗口.
  const weeklyUsable = !win.unparsable?.reasons?.some((reason) => reason.field === "weekly");
  const rows = WEEK_DAYS.map((key) => {
    const day = win.details.days.find((item) => item.key === key) ?? null;
    let bars = [];
    if (!win.hasWeeklyConstraint && weeklyUsable) bars = [FULL_DAY];
    else if (day?.state === "all-day") bars = [FULL_DAY];
    else if (day?.state === "intervals") bars = day.intervals;
    const barsHtml = bars
      .filter((item) => toPct(item.end) > toPct(item.start))
      .map((item) => `<div class="w" style="left:${toPct(item.start)}%;width:${toPct(item.end) - toPct(item.start)}%" title="${esc(`${item.start}–${item.end}`)}"></div>`)
      .join("");
    const marker = key === todayKey ? `<div class="now" style="left:${nowPct}%" title="${esc(t("adm.authz.timeline.now"))}"></div>` : "";
    return `<span class="${key === todayKey ? "today" : ""}">${esc(WINDOW_DAY_LABELS[key].slice(1))}</span><div class="tr">${barsHtml}${marker}</div>`;
  }).join("");
  return `<div class="tl">${rows}<span></span><div class="ax"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div></div>`;
}
