// Per-request Admin view model: the prototype's global lookup helpers (`acct`, `client`, `keyOf`,
// `scopeTags`, `subjectView`, `windowSummary`, `timeline`, …) rebuilt on top of the *real* service
// snapshot instead of mock data. Everything here is read-only projection: it never decrypts a Key,
// never infers an authorization, and never reports a state the service did not provide.
import { esc, fmt, fmtDate, fmtFull, idc, shortId, rel, relTitle, timeZone, pad } from "./format.js";
import { DAYS, KIND_LABEL, MODE, SCOPES, scopeName, st, statusOfToken } from "./vocab.js";
import { linkedOAuthAccountsForClient, linkedOAuthClientsForUser } from "../auth-center-oauth-linkage.js";

const MISSING = "已删除 / 未知";

/** Weekday keys of the access-policy schema, indexed by the JS weekday number. */
const DAY_KEYS = Object.freeze(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);

/**
 * Normalize a policy's weekly window to `[{ day, from, to }]`.
 *
 * The stored schema is `{ mon: [["09:00","18:00"]], … }` (access-policy/schema.js:126); the
 * prototype's mock used a flat `[{ day, from, to }]`. Both are accepted here, and anything else is
 * ignored rather than guessed — a policy that does not parse must never render as 每天全天.
 */
export function weeklyRanges(weekly) {
  const out = [];
  if (Array.isArray(weekly)) {
    for (const item of weekly) {
      const day = Number(item?.day);
      if (Number.isInteger(day) && day >= 0 && day <= 6 && item?.from && item?.to) out.push({ day, from: String(item.from), to: String(item.to) });
    }
    return out;
  }
  if (weekly && typeof weekly === "object") {
    for (const [key, intervals] of Object.entries(weekly)) {
      const day = DAY_KEYS.indexOf(String(key).toLowerCase());
      if (day < 0 || !Array.isArray(intervals)) continue;
      for (const interval of intervals) {
        if (Array.isArray(interval) && interval.length === 2 && interval[0] && interval[1]) out.push({ day, from: String(interval[0]), to: String(interval[1]) });
      }
    }
  }
  return out;
}

function indexBy(items, key) {
  const map = new Map();
  for (const item of items || []) {
    const id = item?.[key];
    if (id == null || id === "") continue;
    map.set(String(id), item);
  }
  return map;
}

/** Local wall-clock parts for `iso` in `zone` (policy timezone aware, contract D6). */
export function zonedParts(iso, zone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const bag = {};
  for (const part of new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  }).formatToParts(date)) bag[part.type] = part.value;
  const dayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(bag.weekday);
  return {
    y: bag.year, m: bag.month, d: bag.day,
    h: bag.hour === "24" ? "00" : bag.hour, mi: bag.minute,
    day: dayIndex < 0 ? 0 : dayIndex,
    date: `${bag.year}-${bag.month}-${bag.day}`,
    hm: `${(bag.hour === "24" ? "00" : bag.hour)}:${bag.minute}`,
  };
}

export function createModel({ now = Date.now(), snapshot = {}, keys = [], vaults = [], publications = [], publishCounts = {}, transfers = [], query = {}, labels = {} } = {}) {
  const clientsById = indexBy(snapshot.clients, "clientId");
  const accountsById = indexBy(snapshot.oauthUsers, "id");
  const keysById = indexBy(keys, "id");
  const vaultsById = indexBy(vaults, "id");
  const state = { now, snapshot, keys, clientsById, accountsById, keysById, vaults, vaultsById, publications, publishCounts, transfers, query, labels };

  const accounts = snapshot.oauthUsers || [];
  const clients = snapshot.clients || [];

  const acct = (id) => accountsById.get(String(id)) || null;
  const acctName = (account) => (account ? account.displayName || account.username : MISSING);
  const client = (id) => clientsById.get(String(id)) || null;
  const clientName = (item) => (item ? item.clientName || "未命名客户端" : MISSING);
  const keyOf = (id) => keysById.get(String(id)) || null;
  const keyName = (item) => (item ? item.label || "未命名 Key" : MISSING);
  const vaultLabel = (id) => vaultsById.get(String(id))?.name || vaultsById.get(String(id))?.label || String(id ?? "");

  /**
   * Active grants only, with the legacy username fallback: a grant row without `userId` still links
   * its client/account when the stored username matches a known account (the shared linkage rule —
   * not a second, local approximation of it).
   */
  const linkedAccounts = (clientId) => linkedOAuthAccountsForClient({ clientId }, snapshot);
  const linkedClients = (userId) => linkedOAuthClientsForUser(acct(userId) || { id: String(userId ?? ""), username: "" }, snapshot);

  const scopeTags = (list) => {
    const values = Array.isArray(list) ? list : [];
    if (values.length >= SCOPES.length) return '<span class="tag">全部权限</span>';
    if (!values.length) return '<span class="muted">无权限</span>';
    return values.map((key) => `<span class="tag" title="${esc(key)}">${esc(scopeName(key))}</span>`).join("");
  };
  const vaultTags = (list) => {
    const values = Array.isArray(list) ? list : [];
    if (!values.length) return '<span class="muted">—</span>';
    return values.map((id) => `<span class="tag acc" title="Vault id: ${esc(id)}">${esc(vaultLabel(id))}</span>`).join("");
  };
  const capName = (key) => labels.capabilityName?.(key) || String(key ?? "");
  const capTags = (list) => {
    const values = Array.isArray(list) ? list : [];
    if (!values.length) return '<span class="muted">—</span>';
    return values.map((key) => `<span class="tag ${key === "all" ? "amber" : ""}" title="${esc(key)}">${esc(capName(key))}</span>`).join("");
  };

  /** Prototype `subjectView` — name / kind / short id, with unnamed and deleted kept apart. */
  function subjectView(subject) {
    const raw = String(subject ?? "");
    const cut = raw.indexOf(":");
    const kind = cut < 0 ? "" : raw.slice(0, cut);
    const id = cut < 0 ? raw : raw.slice(cut + 1);
    let name = null;
    let missing = false;
    let sub = "";
    if (kind === "api-key") {
      if (id === "configured-env") {
        name = "环境配置 API_KEY";
        sub = "部署环境变量";
      } else {
        const key = keyOf(id);
        if (!key) missing = true;
        else { name = key.label || null; sub = key.prefix && key.prefix !== "不可显示" ? `${key.prefix}…` : ""; }
      }
    } else if (kind === "oauth-client") {
      const item = client(id);
      if (!item) missing = true;
      else { name = item.clientName || null; sub = linkedAccounts(id).map(acctName).join("、"); }
    } else if (kind === "oauth-user") {
      const account = acct(id);
      if (!account) missing = true;
      else { name = account.displayName || account.username; sub = account.displayName ? account.username : ""; }
    } else {
      missing = true;
    }
    return {
      raw, kind, id,
      kindLabel: KIND_LABEL[kind] ?? (kind || "未知主体"),
      name: missing ? MISSING : name ?? "未命名",
      unnamed: !missing && !name,
      missing,
      sub,
      shortId: id === "configured-env" ? id : shortId(id),
    };
  }

  function subjectCell(subject) {
    const view = subjectView(subject);
    const nameStyle = view.unnamed || view.missing ? ' style="font-style:italic;font-weight:400"' : "";
    const kindChip = `<span class="kind">${esc(view.kindLabel)}</span>`;
    return `<div class="nm"><b class="${view.missing ? "muted" : ""}"${nameStyle}>${esc(view.name)}</b><span class="sub2">${kindChip}${view.sub ? `<span class="ell">${esc(view.sub)}</span>` : ""}${idc(view.raw, view.shortId)}</span></div>`;
  }

  /** Prototype `windowSummary` — merged weekly ranges plus absolute bounds. */
  function windowSummary(policy) {
    const weekly = weeklyRanges(policy?.weekly);
    const ranges = Array.isArray(policy?.dateRanges) ? policy.dateRanges : [];
    const parts = [];
    if (weekly.length) {
      const byRange = new Map();
      for (const item of weekly) {
        const range = `${item.from}–${item.to}`;
        if (!byRange.has(range)) byRange.set(range, []);
        byRange.get(range).push(Number(item.day));
      }
      for (const [range, days] of byRange) {
        const sorted = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
        let label = sorted.map((day) => DAYS[day]).join("、");
        const key = sorted.join(",");
        if (key === "1,2,3,4,5") label = "工作日";
        else if (sorted.length === 7) label = "每天";
        else if (key === "0,6") label = "周末";
        parts.push(`${label} ${range}`);
      }
    } else {
      parts.push("每天全天");
    }
    const marks = [];
    if (policy?.startsAt) marks.push(`起 ${String(policy.startsAt).slice(5, 10).replace("-", "/")}`);
    if (policy?.expiresAt) marks.push(`至 ${String(policy.expiresAt).slice(5, 10).replace("-", "/")}`);
    for (const range of ranges) marks.push(`限 ${String(range.from).slice(5).replace("-", "/")}–${String(range.to).slice(5).replace("-", "/")}`);
    return { text: parts.join("；"), marks };
  }

  /** Is the policy inside its window right now? Evaluated in the policy's own timezone. */
  function inWindow(policy, at = now) {
    const zone = policy?.timezone || timeZone();
    const local = zonedParts(at, zone);
    if (!local) return { ok: false, why: "时间不可解析" };
    const localStamp = `${local.date}T${local.hm}`;
    if (policy?.startsAt && localStamp < String(policy.startsAt)) return { ok: false, why: "尚未到生效起点" };
    if (policy?.expiresAt && localStamp > String(policy.expiresAt)) return { ok: false, why: "已过失效终点" };
    const ranges = Array.isArray(policy?.dateRanges) ? policy.dateRanges : [];
    if (ranges.length && !ranges.some((range) => local.date >= range.from && local.date <= range.to)) {
      return { ok: false, why: "今天不在限定日期内" };
    }
    const weekly = weeklyRanges(policy?.weekly);
    if (weekly.length && !weekly.some((item) => item.day === local.day && local.hm >= item.from && local.hm < item.to)) {
      return { ok: false, why: `${DAYS[local.day]} ${local.hm} 不在每周窗口内` };
    }
    return { ok: true, why: "在允许窗口内" };
  }

  /** 7-day timeline rows (prototype `timeline`), windows as percentages of a day. */
  function timeline(policy) {
    const zone = policy?.timezone || timeZone();
    const local = zonedParts(now, zone);
    const nowPct = local ? ((Number(local.h) * 60 + Number(local.mi)) / 1440) * 100 : 0;
    const toPct = (value) => {
      const [hours, minutes] = String(value).split(":").map(Number);
      if (!Number.isFinite(hours)) return 0;
      return ((hours * 60 + (minutes || 0)) / 1440) * 100;
    };
    const weekly = weeklyRanges(policy?.weekly);
    let rows = "";
    for (const day of [1, 2, 3, 4, 5, 6, 0]) {
      const windows = weekly.length ? weekly.filter((item) => item.day === day && item.to > item.from) : [{ from: "00:00", to: "24:00" }];
      const bars = windows.map((item) => `<div class="w" style="left:${toPct(item.from)}%;width:${toPct(item.to) - toPct(item.from)}%" title="${esc(`${item.from}–${item.to}`)}"></div>`).join("");
      const marker = local && local.day === day ? `<div class="now" style="left:${nowPct}%" title="现在"></div>` : "";
      rows += `<span class="${local && local.day === day ? "today" : ""}">${DAYS[day].slice(1)}</span><div class="tr">${bars}${marker}</div>`;
    }
    return `<div class="tl">${rows}<span></span><div class="ax"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div></div>`;
  }

  const scopeOptions = (selected = []) => SCOPES.map((scope) => `<label class="chk"><input type="checkbox" name="allowedScope" value="${esc(scope.key)}"${selected.includes(scope.key) ? " checked" : ""}><span><b>${esc(scope.name)}</b><span class="d">${esc(scope.key)} · ${esc(scope.desc)}</span></span></label>`).join("");
  const vaultOptions = (selected = []) => vaults.map((vault) => `<label class="chk"><input type="checkbox" name="allowedVault" value="${esc(vault.id)}"${selected.includes(vault.id) ? " checked" : ""}><span><b>${esc(vault.name || vault.label || vault.id)}</b><span class="d">${esc(vault.id)}</span></span></label>`).join("");

  return {
    ...state,
    acct, acctName, client, clientName, keyOf, keyName, vaultLabel,
    linkedAccounts, linkedClients, scopeTags, vaultTags, capTags, capName,
    subjectView, subjectCell, windowSummary, inWindow, timeline, scopeOptions, vaultOptions,
    scopes: SCOPES,
    statusOfToken, st, mode: (value) => MODE[value] || { n: String(value ?? "未知"), d: "" },
    rel, relTitle, fmt, fmtDate, fmtFull, shortId, idc, esc, pad,
    activeGrants: () => (snapshot.tokenGrants || []).filter((grant) => grant.status === "active"),
  };
}

export { esc, fmt, fmtDate, fmtFull, idc, shortId, rel, relTitle };
