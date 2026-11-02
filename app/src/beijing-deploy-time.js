// Deploy-time rendering for the human-facing surfaces, in ONE place.
//
// WHY HERE (`src/`, not `frontend/`): production mounts only `app/server.js` and
// `app/src` into the container — `app/frontend` is a BUILD-TIME tree that esbuild
// bundles into `app/src/app/assets/app.js`. A runtime import from `src/` into
// `frontend/` therefore works on a full checkout (CI) but dies inside the
// container with `ERR_MODULE_NOT_FOUND`; window #22 (#523) failed exactly that
// way. `frontend/…/settings/deploy-time.js` imports this module instead, which is
// fine because that import is resolved at build time and inlined into the bundle.
//
// The timestamps themselves: the server keeps the raw UTC ISO (`iso`) as the
// source of truth and never rewrites it; only the visible label is rendered as
// Beijing time (fixed +08:00 — China has had no DST since 1991).
const BEIJING_TIME_ZONE = "Asia/Shanghai";
const BEIJING_OFFSET = "+08:00";

/** `2026-09-25T04:40:00Z` -> `北京时间 · 2026-09-25 12:40:00 +08:00` (null input ⇒ null). */
export function formatBeijingDeployLabel(isoString) {
  if (!isoString || typeof isoString !== "string") return null;
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return null;
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: BEIJING_TIME_ZONE,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(date);
  } catch {
    return null;
  }
  const part = (type) => parts.find((item) => item.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  const hour = part("hour");
  const minute = part("minute");
  const second = part("second");
  if (!year || !month || !day || hour == null || !minute || !second) return null;
  return `北京时间 · ${year}-${month}-${day} ${hour}:${minute}:${second} ${BEIJING_OFFSET}`;
}
