// Presentation primitives shared by every Admin page — a direct port of the prototype's
// `5-render.js` helper block (esc / rel / fmt / short / idc / fut), with one deliberate change:
// absolute times are formatted in the server's configured `OBSIDIAN_TIMEZONE` (contract D6) and
// the zone is labelled wherever an absolute time is shown, instead of the prototype's hard-coded
// Asia/Shanghai.
//
// No-JS deviation: the prototype's short-ID chip copies to the clipboard with script. Here the
// chip is a selectable `<code>` carrying the full id in `title` (and the full id is always visible
// in the detail panel), so nothing offers a copy affordance that cannot work without script.

const ZONE = process.env.OBSIDIAN_TIMEZONE || "UTC";

const PARTS = new Map();
function partsFormatter(zone) {
  if (!PARTS.has(zone)) {
    PARTS.set(zone, new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }));
  }
  return PARTS.get(zone);
}

export function timeZone() {
  return ZONE;
}

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Prototype `pad`. */
export function pad(n) {
  return String(n).padStart(2, "0");
}

function zoneParts(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const bag = {};
  for (const part of partsFormatter(ZONE).formatToParts(date)) bag[part.type] = part.value;
  return { y: bag.year, m: bag.month, d: bag.day, h: bag.hour === "24" ? "00" : bag.hour, mi: bag.minute, s: bag.second, ms: date.getTime() };
}

/** `YYYY-MM-DD` in the configured zone. */
export function fmtDate(iso) {
  const p = zoneParts(iso);
  return p ? `${p.y}-${p.m}-${p.d}` : "—";
}

/** `MM-DD HH:mm` in the configured zone (prototype `fmt`). */
export function fmt(iso) {
  const p = zoneParts(iso);
  return p ? `${p.m}-${p.d} ${p.h}:${p.mi}` : "—";
}

/** `YYYY-MM-DD HH:mm:ss` in the configured zone. */
export function fmtFull(iso) {
  const p = zoneParts(iso);
  return p ? `${p.y}-${p.m}-${p.d} ${p.h}:${p.mi}:${p.s}` : "—";
}

const MINUTE = 60e3;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Prototype `rel`: just-now / N minutes / N hours / N days / date. */
export function rel(iso, now = Date.now()) {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  const diff = now - at;
  if (diff < 0) return "刚刚";
  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return `${Math.round(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.round(diff / HOUR)} 小时前`;
  if (diff < 30 * DAY) return `${Math.round(diff / DAY)} 天前`;
  return fmtDate(iso);
}

/** Relative time with the absolute value in `title` — the honest SSR form of the prototype tooltip. */
export function relTitle(iso, now = Date.now()) {
  if (!iso) return "—";
  return `<span title="${esc(fmtFull(iso))}">${esc(rel(iso, now))}</span>`;
}

/** Prototype `short`: 8 chars + ellipsis. */
export function shortId(id) {
  const value = String(id ?? "");
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

/** Short-ID chip. No script ⇒ selectable text with the full id in `title` (see the module note). */
export function idc(id, label = null) {
  const full = String(id ?? "");
  if (!full) return '<span class="muted">—</span>';
  return `<code class="idc" title="完整 ID：${esc(full)}">${esc(label ?? shortId(full))}</code>`;
}

/** Prototype `fut`: the dashed "planned, not implemented" marker. */
export function fut(src) {
  return `<span class="fut" title="规划中，尚未实现">规划中${src ? ` · ${esc(src)}` : ""}</span>`;
}

/** Dashed box for a planned feature block (prototype `.futbox`). */
export function futBox(title, bodyHtml) {
  return `<div class="futbox futonly"><div class="rowline"><b>${esc(title)}</b>${fut()}</div><p class="help" style="margin:6px 0 0">${bodyHtml}</p></div>`;
}

/** Absolute-time cell with the zone named once per table (contract D6). */
export function zoneNote() {
  return ZONE === "UTC" ? "" : ZONE;
}
