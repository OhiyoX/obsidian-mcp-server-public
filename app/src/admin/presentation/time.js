// Admin UI v2: Chinese relative time + Asia/Shanghai absolute (proto parity).
const TZ = process.env.OBSIDIAN_TIMEZONE || "Asia/Shanghai";

const FULL_FMT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const SHORT_FMT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

function esc(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function adminTimeZone() { return TZ; }

export function formatFull(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return FULL_FMT.format(date).replace("T", " ");
}

export function formatShort(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return SHORT_FMT.format(date).replace("T", " ");
}

export function relativeLabel(value, nowMs = Date.now()) {
  if (!value) return "";
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(t)) return "";
  const diff = Math.max(0, nowMs - t);
  const m = Math.round(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小时前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} 天前`;
  return formatShort(value).slice(0, 10);
}

export function timestampHtml(value, fallback = "—", opts = {}) {
  if (!value) return `<span class="muted">${esc(fallback)}</span>`;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return esc(String(value));
  const iso = date.toISOString();
  const full = formatFull(date);
  if (opts.absolute) {
    return `<time datetime="${esc(iso)}" title="${esc(full)}">${esc(formatShort(date))}</time>`;
  }
  const rel = relativeLabel(date, opts.nowMs ?? Date.now()) || formatShort(date);
  return `<time datetime="${esc(iso)}" title="${esc(full)}">${esc(rel)}</time>`;
}
