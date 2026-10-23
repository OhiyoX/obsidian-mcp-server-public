// 定时授权 (timed authorization) — list page + `?id=` detail drawer.
//
// Prototype source of truth: `docs/admin-ui-proto/src/5-render.js` — `renderAuthz()` (list table,
// banners, 当前状态预览) and the shared drawer vocabulary of `6-app.js` (`dhead` / `.dsec` /
// `.kv` / `.danger-zone` / `.dz`); interaction rules in `docs/admin-ui-proto/README.md`
// ("定时授权" row of the 功能对照表, and 「Row operations / danger hierarchy」).
//
// No script (CSP `default-src 'none'`, D0 HOLD). Every prototype interaction is reproduced by
// server state:
//   * opening a row  -> `?id=<policyId>` renders the detail drawer (`?window=` is kept as an alias,
//     so the previous "window detail card" entry point still resolves);
//   * the ⋯ row menu -> `<details class="mn">` (never a scripted popover);
//   * switches       -> POST forms carrying the session CSRF;
//   * results        -> a `.result` line (the prototype shows a toast);
//   * danger actions -> a separate confirm page (`ui.confirmPage`, rendered by the route module).
// Nothing here renders an affordance that cannot work without script.
//
// Row/card primary link: the prototype row is `data-open="policy" data-id=…` and the click handler in
// `6-app.js` routes it to `#/authz/<id>` — the *editor* (`docs/admin-ui-proto/src/5-render.js:352`,
// `6-app.js:301`). The 查看详情 item in the ⋯ menu keeps the read-only detail drawer (`?id=`, the
// Admin-plane rule of `docs/admin/README.md`). The order matters beyond looks: an editor-discovery
// probe (the Admin layout browser gate) takes the page's *first* `?edit=`/`?id=` link, so the primary
// link has to be the editor and never a surface without the capability picker.
//
// Window data: the frozen #434 presentation model (`presentAccessPolicyWindow`) is the single
// source for the summary text, the constraint markers and the 7-day detail. `ctx.model`'s
// `windowSummary` / `timeline` / `inWindow` helpers still assume the prototype's *mock* shape
// (`weekly` as an array of `{ day, from, to }`), while a stored policy carries the schema's
// `{ mon: [["09:00", "18:00"]] }` record — reading them here would report every real policy as
// "每天全天", so this page derives the same markup from the presentation model instead.
import { pageBar, table, mcards, emptyState, banner, moreMenu, result, drawer, kv, esc, fut, ic } from "../ui.js";
import { fmtFull, idc, relTitle } from "../presentation/format.js";
import { presentAccessPolicyWindow, WINDOW_DAY_LABELS, WINDOW_SCOPE_DISCLAIMER } from "../access-policy-window-presentation.js";
import { zonedParts } from "../presentation/model.js";

/** Weekday keys in display order (prototype `[1,2,3,4,5,6,0]` = 一…日). */
export const WEEK_DAYS = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

const FULL_DAY = Object.freeze({ start: "00:00", end: "24:00" });

/** The one presentation model every window surface on this page reads. */
export function windowPresentation(policy) {
  return presentAccessPolicyWindow(policy);
}

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
 * Prototype `inWindow()` — "is this policy inside its window right now?" evaluated in the
 * policy's own timezone. Honest tri-state: `ok === null` means the policy cannot be judged
 * (invalid timezone / unparsable window), and the caller must render 无法判定 rather than 允许.
 *
 * The absolute bounds are compared as instants (`startsAt` / `expiresAt` are stored as ISO
 * instants by the schema), the date ranges and the weekly grid as local wall-clock values.
 */
export function policyNowState(policy, now = Date.now()) {
  const win = presentAccessPolicyWindow(policy);
  const zone = typeof policy?.timezone === "string" && win.timezoneValid ? policy.timezone : null;
  const local = zone ? zonedParts(now, zone) : null;
  if (!local) return { ok: null, why: "无法解析策略时区" };
  const starts = win.details.startsAt;
  const expires = win.details.expiresAt;
  if (starts.present && !starts.valid) return { ok: null, why: "无法解析生效起点" };
  if (starts.present && now < Date.parse(starts.value)) return { ok: false, why: "尚未到生效起点" };
  if (expires.present && !expires.valid) return { ok: null, why: "无法解析失效终点" };
  if (expires.present && now > Date.parse(expires.value)) return { ok: false, why: "已过失效终点" };
  const ranges = win.details.dateRanges;
  if (ranges.present && !ranges.valid) return { ok: null, why: "无法解析限定日期" };
  if (ranges.present && !ranges.items.some((range) => local.date >= range.from && local.date <= range.to)) {
    return { ok: false, why: "今天不在限定日期内" };
  }
  const day = win.details.days.find((item) => item.key === dayKeyOf(local)) ?? null;
  if (!day) return { ok: true, why: "未设置周约束（视为全天）" };
  if (day.state === "unparsable") return { ok: null, why: "时间窗口无法解析" };
  if (day.state === "unspecified") return { ok: true, why: "未设置周约束（视为全天）" };
  if (day.state === "empty") return { ok: false, why: "今日无生效时段" };
  if (day.state === "all-day") return { ok: true, why: "今日全天" };
  const inside = day.intervals.some((item) => local.hm >= item.start && local.hm < item.end);
  return { ok: inside, why: inside ? `落在 ${day.text}` : `不在今日时段（${day.text}）` };
}

/** Now (policy timezone) as `MM-DD HH:mm`, for the preview verdict line. */
export function policyNowLabel(policy, now = Date.now()) {
  const win = presentAccessPolicyWindow(policy);
  const zone = typeof policy?.timezone === "string" && win.timezoneValid ? policy.timezone : null;
  const local = zone ? zonedParts(now, zone) : null;
  return local ? `${local.date.slice(5)} ${local.hm}` : new Date(now).toISOString().slice(0, 16).replace("T", " ");
}

/** Verdict colour for a tri-state `ok`. */
function verdictClass(ok) {
  return ok === true ? "ok" : ok === false ? "no" : "";
}

/** Prototype `timeline()` — 7 day rows, window bars, "now" marker (see the module note). */
export function policyTimelineHtml(policy, now = Date.now()) {
  const win = presentAccessPolicyWindow(policy);
  const zone = typeof policy?.timezone === "string" && win.timezoneValid ? policy.timezone : null;
  const local = zone ? zonedParts(now, zone) : null;
  const nowPct = local ? ((Number(local.h) * 60 + Number(local.mi)) / 1440) * 100 : 0;
  const todayKey = dayKeyOf(local);
  // An unreadable weekly grid must never be drawn as "all day": a malformed `weekly` field
  // keeps the rows empty and the summary says 无法解析时间窗口.
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
    const marker = key === todayKey ? `<div class="now" style="left:${nowPct}%" title="现在"></div>` : "";
    return `<span class="${key === todayKey ? "today" : ""}">${esc(WINDOW_DAY_LABELS[key].slice(1))}</span><div class="tr">${barsHtml}${marker}</div>`;
  }).join("");
  return `<div class="tl">${rows}<span></span><div class="ax"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div></div>`;
}

/** 状态 · 模式 cell (prototype column 2). */
export function policyStatusCell(model, policy) {
  const enabled = policy.enabled !== false;
  const mode = model.mode(policy.mode);
  const status = enabled
    ? `<span class="st ok"><span class="dot"></span>启用</span>`
    : `<span class="st off"><span class="dot"></span>停用</span>`;
  return `${status}<div class="muted" style="font-size:13px" title="${esc(String(policy.mode ?? ""))}">窗口外${esc(mode.n)}</div>`;
}

/** 主体 cell — name first, kind + short id as the secondary line, orphan marked (prototype `subjectCell`). */
export function policySubjectsCell(model, policy) {
  const subjects = Array.isArray(policy.subjects) ? policy.subjects : [];
  if (!subjects.length) return `<div class="nm" style="gap:2px"><span class="muted">未选择主体</span></div>`;
  const rows = subjects.map((subject) => {
    const view = model.subjectView(subject);
    const orphan = view.missing ? ` <span class="tag danger">孤立</span>` : "";
    return `<span class="ell" title="${esc(subject)}"><span class="${view.missing ? "muted" : ""}">${esc(view.name)}</span> <span class="muted">${esc(view.kindLabel)}</span>${orphan}</span>`;
  }).join("");
  return `<div class="nm" style="gap:2px">${rows}</div>`;
}

/** 允许时间窗口 cell: summary, constraint markers, and the honest now verdict. */
export function policyWindowCell(policy, now = Date.now()) {
  const win = presentAccessPolicyWindow(policy);
  const marks = win.summary.markers.map((marker) => `<span class="tag">${esc(marker)}</span>`).join("");
  const state = policyNowState(policy, now);
  const verdict = policy.enabled === false
    ? ""
    : `<span style="color:${state.ok === true ? "var(--ok)" : state.ok === false ? "var(--amber)" : "var(--tx3)"}" title="${esc(state.why)}">${state.ok === true ? "现在允许" : state.ok === false ? "现在受限" : "无法判定"}</span>`;
  return `<div class="nm"><span class="ell">${esc(win.summary.text)}</span><span class="sub2">${marks}${verdict}</span></div>`;
}

/** Row ⋯ menu — prototype `menuItems("policy", id)`, danger items routed through a confirm page. */
export function policyRowMenu({ base, policy, csrf, revision }) {
  const id = encodeURIComponent(policy.id);
  const enabled = policy.enabled !== false;
  return moreMenu([
    { href: `${base}?id=${id}`, label: "查看详情", icon: "eye" },
    { href: `${base}?edit=${id}`, label: "编辑", icon: "edit" },
    {
      action: `${base}/toggle`,
      label: enabled ? "停用策略" : "启用策略",
      icon: enabled ? "pause" : "play",
      csrf,
      fields: { id: policy.id, enabled: enabled ? "false" : "true", expectedRevision: revision ?? "" },
    },
    { href: `${base}?copy=${id}`, label: "复制为新策略", icon: "copy" },
    { href: `${base}?window=${id}`, label: "窗口详情", icon: "cal" },
    { href: `${base}?confirm=delete&id=${id}`, label: "删除策略…", icon: "trash", danger: true },
  ]);
}

/** The 当前状态预览 section — a real POST form (no script) plus the verdict lines. */
function previewSection(ctx) {
  const { authz, model, csrf, query = {}, accessPolicyBase: base, now = Date.now(), preview = null } = ctx;
  const policies = Array.isArray(authz?.policies) ? authz.policies : [];
  const known = Array.isArray(ctx.subjects) ? ctx.subjects : [];
  const referenced = policies.flatMap((policy) => (Array.isArray(policy.subjects) ? policy.subjects : []));
  const options = [...new Set([...known, ...referenced])].sort();
  const selected = typeof preview?.subject === "string" ? preview.subject : String(query.subject ?? "");
  const option = (subject) => {
    const view = model.subjectView(subject);
    const on = subject === selected ? " selected" : "";
    return `<option value="${esc(subject)}"${on}>${esc(`${view.name} · ${view.kindLabel} · ${view.shortId}`)}</option>`;
  };
  // Prototype `renderAuthz` 当前状态预览: `<div class="card"><div style="display:flex;gap:8px;
  // flex-wrap:wrap"><select class="sel" …>…</select></div>…</div>`. The select must be submittable
  // without script, so it sits in a real `form.inline-form` around the same inner row; the 查看 button
  // is the no-JS submit a `<select>` cannot provide by itself and is marked `hide-when-scripted`: the
  // D0 client drops it once the select enhancement really ran, and `data-autosubmit` restores the
  // prototype's "pick and it submits" behaviour. Without script both stay and the form works.
  //
  // `form-block` is load-bearing (Q11): `form.inline-form` is `display:inline-flex` (shrink-to-fit), and
  // inside it a `width:100%` select has no definite width to resolve, so the row wrapped and the card
  // measured 132px where the prototype's is 92px. As a block, the inner flex row takes the card's own
  // width and stays one line — the button's 40px was a second LINE, not the button itself.
  const form = `<form class="inline-form form-block" method="post" action="${esc(`${base}/preview`)}" data-preview-form><input type="hidden" name="csrf" value="${esc(csrf || "")}"><input type="hidden" name="view" value="list"><div style="display:flex;gap:8px;flex-wrap:wrap"><select class="sel" name="subject" style="max-width:420px" aria-label="选择主体" data-autosubmit><option value="">请选择主体…</option>${options.map(option).join("")}</select><button class="btn" type="submit" data-enhance="hide-when-scripted">查看</button></div></form>`;
  const detail = preview && selected ? previewVerdicts(preview, policies, selected, model, now) : `<p class="help" style="margin:8px 0 0">选择主体后显示命中的策略及此刻的判定。</p>`;
  return `<div class="sect" id="preview"><div class="sect-h"><h2>当前状态预览</h2><span class="muted">查看某个主体此刻是否被策略限制</span></div><div class="card" style="padding:16px">${form}${detail}</div></div>`;
}

/** Verdicts for one subject: the runtime's own answer first, then the per-policy estimate. */
function previewVerdicts(preview, policies, subject, model, now) {
  const decision = preview?.decision ?? null;
  const lines = [];
  if (decision) {
    const allowed = decision.allowed === true;
    const reason = String(decision.reason ?? "");
    const mode = decision.mode ? ` · 模式 ${esc(model.mode(decision.mode).n)}` : "";
    const matched = Array.isArray(decision.matchedPolicyIds) ? decision.matchedPolicyIds.length : 0;
    lines.push(`<div class="verdict ${allowed ? "ok" : "no"}">${ic(allowed ? "checkc" : "ban")}<span>服务端判定：<b>${allowed ? "允许" : "拒绝"}</b>${mode} · 原因 <span class="mono">${esc(reason || "—")}</span> · 命中策略 ${esc(String(matched))}</span></div>`);
  }
  const matching = policies.filter((policy) => policy.enabled !== false && Array.isArray(policy.subjects) && policy.subjects.includes(subject));
  if (!matching.length) {
    lines.push(`<div class="verdict ok">${ic("checkc")}<span><b>不受定时授权限制</b> · 没有启用的策略引用该主体，按其原有权限访问</span></div>`);
  } else {
    for (const policy of matching) {
      const state = policyNowState(policy, now);
      const label = state.ok === true ? "此刻允许" : state.ok === false ? `此刻${model.mode(policy.mode).n}` : "暂无法判定";
      const caps = (Array.isArray(policy.capabilities) ? policy.capabilities : []).map((key) => model.capName(key)).join("、") || "—";
      lines.push(`<div class="verdict ${verdictClass(state.ok)}">${ic(state.ok === false ? "ban" : "checkc")}<span><b>${esc(policy.label)}</b> · ${esc(label)}（${esc(state.why)}）· 影响：${esc(caps)}</span></div>`);
    }
  }
  const meta = preview
    ? `<p class="help" style="margin:8px 0 0">当前 <span class="mono">${esc(preview.now ?? "—")}</span> · 时区 <span class="mono">${esc(preview.timezone ?? "—")}</span> · 下一次状态变化 <span class="mono">${esc(preview.nextChangeAt ?? "—")}</span> · 下一次允许 <span class="mono">${esc(preview.nextAllowedAt ?? "—")}</span></p>`
    : "";
  return `${lines.join("")}${meta}`;
}

/** The `?id=` detail drawer: fields, consequence banners, window detail, danger zone. */
function policyDrawer(ctx, policy) {
  const { model, csrf, accessPolicyBase: base, authz, now = Date.now() } = ctx;
  const mode = model.mode(policy.mode);
  const win = presentAccessPolicyWindow(policy);
  const state = policyNowState(policy, now);
  const enabled = policy.enabled !== false;
  const revision = authz?.revision ?? null;
  const subjects = Array.isArray(policy.subjects) ? policy.subjects : [];
  const orphans = subjects.filter((subject) => model.subjectView(subject).missing);
  const lastEnabledOrphanBanner = orphans.length
    ? banner(`<b>含 ${orphans.length} 个孤立主体</b>：策略引用了已删除的凭据（${orphans.map((subject) => `<span class="mono">${esc(model.subjectView(subject).shortId)}</span>`).join("、")}）。它们不会再匹配任何请求，建议在编辑器中移除；保存本身不会被拒绝。`, { tone: "amber" })
    : "";
  const revokeBanner = policy.mode === "revoke"
    ? banner(`<b>「撤销」模式</b>：窗口外会撤销该主体的<b>全部授权与会话</b>，需重新授权；能力固定为「全部」。`, { tone: "amber" })
    : "";
  const fields = kv([
    ["策略 ID", idc(policy.id, policy.id)],
    ["标签", esc(policy.label)],
    ["状态", `${enabled ? `<span class="st ok"><span class="dot"></span>启用` : `<span class="st off"><span class="dot"></span>停用`}</span>`],
    ["窗口外的处理方式", `${esc(mode.n)} <span class="mono muted">${esc(String(policy.mode ?? ""))}</span>`],
    ["时区", `<span class="mono">${esc(String(policy.timezone ?? "—"))}</span>`],
    ["策略修订号", revision === null ? `<span class="muted">未提供</span>` : `<span class="mono">${esc(String(revision))}</span>`],
    ["创建", esc(fmtFull(policy.createdAt))],
    ["最近修改", `${relTitle(policy.updatedAt, now)} <span class="muted mono">${esc(fmtFull(policy.updatedAt))}</span>`],
  ]);
  const subjectList = subjects.length
    ? `<div class="selrow">${subjects.map((subject) => {
      const view = model.subjectView(subject);
      const orphan = view.missing ? ` <span class="tag danger">孤立</span>` : "";
      return `<span class="pill" title="${esc(subject)}"><span class="kind">${esc(view.kindLabel)}</span>${esc(view.name)} <span class="mono muted">${esc(view.shortId)}</span>${orphan}</span>`;
    }).join("")}</div>`
    : `<p class="help" style="margin:0">未选择主体</p>`;
  const marks = win.summary.markers.map((marker) => `<span class="tag" style="margin:4px 4px 0 0">${esc(marker)}</span>`).join("");
  const caps = (Array.isArray(policy.capabilities) ? policy.capabilities : []).map((key) => `<span class="tag ${key === "all" ? "amber" : ""}" title="${esc(key)}">${esc(model.capName(key))}</span>`).join("");
  const verdict = `<div class="verdict ${verdictClass(state.ok)}" style="margin-top:12px">${ic(state.ok === false ? "ban" : "checkc")}<span>现在（${esc(policyNowLabel(policy, now))} <span class="mono">${esc(String(policy.timezone ?? ""))}</span>）<b>${state.ok === true ? "允许访问" : state.ok === false ? esc(mode.n) : "无法判定"}</b> · ${esc(state.why)}</span></div>`;
  const toggle = enabled
    ? `<form class="inline-form" method="post" action="${esc(`${base}/toggle`)}"><input type="hidden" name="csrf" value="${esc(csrf || "")}"><input type="hidden" name="id" value="${esc(policy.id)}"><input type="hidden" name="enabled" value="false"><input type="hidden" name="expectedRevision" value="${esc(revision ?? "")}"><button class="btn danger-o" type="submit">停用…</button></form>`
    : `<form class="inline-form" method="post" action="${esc(`${base}/toggle`)}"><input type="hidden" name="csrf" value="${esc(csrf || "")}"><input type="hidden" name="id" value="${esc(policy.id)}"><input type="hidden" name="enabled" value="true"><input type="hidden" name="expectedRevision" value="${esc(revision ?? "")}"><button class="btn" type="submit">启用</button></form>`;
  const dangerZone = `<div class="dsec"><h3>危险操作</h3><div class="danger-zone">
  <div class="dz"><div class="t"><b>${enabled ? "停用策略" : "启用策略"}</b>${enabled ? "停用后该策略不再限制任何主体，相关凭据按原有权限全天可用" : "启用后该策略立即开始限制对应主体"}</div>${toggle}</div>
  <div class="dz"><div class="t"><b>删除策略</b>删除后不可恢复；确认页需要输入策略名称</div><a class="btn danger-o" href="${esc(`${base}?confirm=delete&id=${encodeURIComponent(policy.id)}`)}">删除…</a></div>
</div></div>`;
  const bodyHtml = `${lastEnabledOrphanBanner}${revokeBanner}
<div class="dsec"><h3>策略</h3>${fields}</div>
<div class="dsec"><h3>主体 <span class="muted" style="font-weight:400">${subjects.length}</span></h3>${subjectList}</div>
<div class="dsec"><h3>限制的能力</h3><div class="tags">${caps || `<span class="muted">—</span>`}</div></div>
<div class="dsec"><h3>允许时间窗口</h3><div class="sumbox"><b>${esc(win.summary.text)}</b>${marks ? `<div>${marks}</div>` : ""}<div class="muted" style="margin-top:4px">${esc(WINDOW_SCOPE_DISCLAIMER)}</div></div><div style="margin-top:16px">${policyTimelineHtml(policy, now)}</div>${verdict}</div>
${dangerZone}`;
  const footHtml = `<a class="btn primary" href="${esc(`${base}?edit=${encodeURIComponent(policy.id)}`)}">编辑策略</a><a class="btn ghost" href="${esc(base)}">关闭</a>`;
  return drawer({
    title: policy.label,
    subtitle: `${enabled ? "启用" : "停用"} · 窗口外${mode.n}`,
    closeHref: base,
    bodyHtml,
    footHtml,
  });
}

/** Message for `?done=<action>` — a fixed map, so a crafted query can never echo text back. */
const DONE_MESSAGE = Object.freeze({
  create: "策略已创建。",
  update: "策略已保存。",
  toggle: "策略状态已更新。",
  delete: "策略已删除。",
  repair: "策略存储已修复。",
});

/** The 定时授权 tab: list + banners + 当前状态预览 (+ the `?id=` drawer). */
export function renderAuthzPage(ctx) {
  const { model, authz, csrf, query = {}, accessPolicyBase: base, now = Date.now(), preview = null } = ctx;
  const policies = Array.isArray(authz?.policies) ? authz.policies : [];
  const revision = authz?.revision ?? null;
  const broken = authz?.status === "broken";
  const orphans = Array.isArray(authz?.orphaned) ? authz.orphaned : [];
  const runtime = ctx.runtimeState ?? null;
  const masterOn = runtime ? runtime.enabled === true : authz?.enabled === true;

  const columns = [["策略", "22%"], ["状态 · 模式", "12%"], ["主体", "22%"], ["限制的能力", "16%"], ["允许时间窗口", "24%"], ["", "", "act"]];
  const rows = policies.map((policy) => `<tr class="click ${policy.enabled !== false ? "" : "dim"}">
<td><a class="cell-link block" href="${esc(`${base}?edit=${encodeURIComponent(policy.id)}`)}"><div class="nm"><b>${esc(policy.label)}</b><span class="sub2">${idc(policy.id)}<span>· 修改于 ${relTitle(policy.updatedAt, now)}</span></span></div></a></td>
<td>${policyStatusCell(model, policy)}</td>
<td>${policySubjectsCell(model, policy)}</td>
<td><div class="tags">${model.capTags(policy.capabilities)}</div></td>
<td>${policyWindowCell(policy, now)}</td>
<td class="act">${policyRowMenu({ base, policy, csrf, revision })}</td></tr>`);
  const cards = policies.map((policy) => {
    const win = presentAccessPolicyWindow(policy);
    const subjects = (Array.isArray(policy.subjects) ? policy.subjects : []).map((subject) => model.subjectView(subject).name);
    return `<div class="mc"><div class="b"><div class="nm"><a class="cell-link block" href="${esc(`${base}?edit=${encodeURIComponent(policy.id)}`)}"><b>${esc(policy.label)}</b></a><span class="sub2">${policy.enabled !== false ? "启用" : "停用"} · 窗口外${esc(model.mode(policy.mode).n)}</span></div><span class="tx2" style="font-size:13px">${esc(win.summary.text)}</span><div class="meta">${subjects.map((name) => `<span>${esc(name)}</span>`).join("")}</div></div>${policyRowMenu({ base, policy, csrf, revision })}</div>`;
  });
  const empty = emptyState(
    "cal",
    policies.length ? "没有匹配的策略" : "还没有定时授权策略",
    "为某个 Key、客户端或账户设置可访问的时间段",
    broken ? "" : `<a class="btn primary" href="${esc(`${base}?new=1`)}">${ic("plus")}新建策略</a>`,
  );

  const newCta = broken
    ? `<span class="btn primary" aria-disabled="true" title="策略存储不可用，修复后再新建">${ic("plus")}<span class="hide-m">新建策略</span></span>`
    : `<a class="btn primary" href="${esc(`${base}?new=1`)}">${ic("plus")}<span class="hide-m">新建策略</span></a>`;
  // The prototype's master switch is scripted and marked 规划中 (Stage 5): it is rendered as a
  // non-interactive state indicator with the planned marker — never as a fake CTA. Its *state* is
  // real (the runtime summary), so the banner tone and the label are honest. The banner is built
  // directly (not through `banner()`), because the prototype puts the switch next to the text as a
  // sibling of the flex-1 text block.
  const masterSwitch = `<div class="futonly bm" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="muted" style="font-size:13px">总开关</span><span class="switch ${masterOn ? "on" : ""}" role="img" aria-label="AuthZ 总开关" title="AuthZ 总开关（当前：${masterOn ? "已启用" : "未启用"}）· 开关本身规划中，实际状态由部署配置 AUTHZ_ENABLED 决定"></span>${fut("Stage 5")}</div>`;
  const masterBanner = `<div class="banner ${masterOn ? "acc" : ""}">${ic("shield")}<div style="flex:1">定时授权只会在既有权限基础上<b>再加限制</b>，不会放大权限；管理后台本身不受策略约束。时间窗口表示「允许访问的时间」，不代表永久有效。<details style="margin-top:4px"><summary class="muted" style="cursor:pointer">技术细节</summary><span class="muted">策略修订号 <span class="mono">${esc(revision === null ? "未提供" : String(revision))}</span>；保存时携带修订号，若他人已修改将提示冲突而不覆盖。suspend = 暂停（保留会话）；revoke = 撤销（作用于该主体全部授权）。</span></details></div>${masterSwitch}</div>`;
  const brokenBanner = broken
    ? banner(`<b>策略存储不可用</b>：策略文件无法可信读取${authz?.error ? `（${esc(String(authz.error).slice(0, 200))}）` : ""}，所有策略暂不生效，编辑已禁用。<form method="post" action="${esc(`${base}/repair`)}" style="margin-top:8px"><input type="hidden" name="csrf" value="${esc(csrf || "")}"><textarea class="inp mono" name="document" rows="5" style="height:auto;padding:8px" placeholder="粘贴修复用的策略文档（JSON）" required>${esc(ctx.repairDocument ?? "")}</textarea><div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn danger" type="submit">用此文档覆盖修复…</button><span class="help" style="align-self:center">覆盖前会备份当前损坏文件；下一步需输入「覆盖」确认</span></div></form>`, { tone: "danger" })
    : "";
  const orphanBanner = orphans.length
    ? banner(`<b>${orphans.length} 个孤立主体</b>：策略引用了已删除的凭据（${orphans.map((subject) => `<span class="mono" title="${esc(subject)}">${esc(model.subjectView(subject).shortId)}</span>`).join("、")}）。它们不会再匹配任何请求（服务端不会自动删除策略），建议编辑策略移除。`, { tone: "amber" })
    : "";
  const conflict = ctx.conflict
    ? banner(`<b>保存冲突</b>：该策略在你提交前已被修改（revision 冲突）。为避免覆盖他人的修改，本次提交未生效。`, { tone: "danger" })
    : "";
  const done = typeof query.done === "string" ? DONE_MESSAGE[query.done] : null;
  const notice = [done ? result(true, esc(done)) : "", ctx.failure ? result(false, esc(String(ctx.failure))) : ""].join("");

  const wanted = typeof query.id === "string" && query.id.trim()
    ? query.id.trim()
    : typeof query.window === "string" && query.window.trim() ? query.window.trim() : "";
  const selected = wanted ? policies.find((policy) => policy.id === wanted) ?? null : null;
  const missingDrawer = wanted && !selected
    ? drawer({
      title: "策略不存在",
      closeHref: base,
      bodyHtml: `<div class="dsec">${emptyState("cal", "策略不存在或已删除", "该 id 不在当前策略列表中；刷新后重试", `<a class="btn" href="${esc(base)}">返回列表</a>`)}</div>`,
    })
    : "";
  const detailPanel = selected ? policyDrawer(ctx, selected) : missingDrawer;

  const content = `${pageBar({ title: "定时授权", count: policies.length, actions: newCta })}<div class="content scroll"><div class="page wide">
${notice}
${masterBanner}
${conflict}
${brokenBanner}
${orphanBanner}
${table(columns, rows, empty)}${mcards(cards)}
${previewSection(ctx)}
</div></div>`;
  return { content, detailPanel };
}
