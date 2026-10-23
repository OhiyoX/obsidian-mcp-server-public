// Auth Center "定时授权" tab renderer for AuthZ Wave B / B4.
//
// Contract: `scratch/authz/INTERFACE.md` §10.4 and DEVELOPMENT §17 / §17.1.
// Pure functions: the input is a plain view-model, the output is an HTML
// fragment string. No DOM, no runtime, no policy evaluation, no I/O and no
// framework import.
//
// Guarantees:
//  - every dynamic value is HTML-escaped (`escapeHtml`);
//  - the Admin plane is never gated: this module never asks the runtime whether
//    the operator may open the tab, so a broken/deny policy cannot lock out the
//    repair surface;
//  - no credential secret, token or full policy JSON is rendered. The only
//    token-shaped value is the caller-supplied CSRF hidden field;
//  - capability choices come from the canonical catalog (`scopes.js`,
//    `capability-catalog.js`, `config.js`) and a `revoke` policy is rendered
//    locked to `all` (the service validates it again).
//
// Styling uses the existing Auth Center classes only; no external script,
// font or stylesheet is referenced.

import { TOOL_NAMES } from "../config.js";
import { MCP_RESOURCE_SCOPE_REQUIREMENTS, MCP_SCOPES } from "../scopes.js";
import { TOOLSET_TOOLS } from "../capability-catalog.js";
import { formatDateRangesText, formatWeeklyText } from "./access-policy.js";
import { presentAccessPolicyWindow } from "./access-policy-window-presentation.js";
import {
  POLICY_LIST_HEADERS,
  capabilityChips,
  capabilityShortLabel,
  policyMode,
  policyNameCell,
  policyRowMenu,
  policyStatus,
  policyStatusMode,
  subjectsCell,
  stage5MasterFut,
  subjectChip,
} from "./admin-v2/pages/authz.js";

/** Default POST endpoints; Wave C may override them through `actions`. */
export const DEFAULT_ACTIONS = Object.freeze({
  base: "/admin/auth/access-policy",
  create: "/admin/auth/access-policy/create",
  update: "/admin/auth/access-policy/update",
  toggle: "/admin/auth/access-policy/toggle",
  delete: "/admin/auth/access-policy/delete",
  repair: "/admin/auth/access-policy/repair",
  preview: "/admin/auth/access-policy/preview",
});

const COMMON_TIMEZONES = Object.freeze([
  "UTC", "Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore",
  "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles",
]);

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Canonical capability catalogue, grouped for a `<select>` / `<optgroup>`. */
export function capabilityGroups() {
  return [
    { label: "全部", values: ["all"] },
    { label: "Surface", values: ["surface:mcp", "surface:web", "surface:oauth"] },
    { label: "Scope", values: MCP_SCOPES.map((scope) => `scope:${scope}`) },
    { label: "Toolset", values: Object.keys(TOOLSET_TOOLS).map((toolset) => `toolset:${toolset}`) },
    { label: "Tool", values: [...TOOL_NAMES].map((tool) => `tool:${tool}`) },
    { label: "Resource", values: Object.keys(MCP_RESOURCE_SCOPE_REQUIREMENTS).map((uri) => `resource:${uri}`) },
  ];
}

/**
 * Raw schedule text built from the frozen editor formatters (`mon 09:00-18:00` lines plus the
 * date-range lines and the absolute bounds). It is the *raw* counterpart of the #434 merged
 * summary and is no longer the list cell's source (the cell renders `presentAccessPolicyWindow`
 * instead); it stays exported for callers that need the unmerged form.
 */
export function windowSummary(policy) {
  const parts = [];
  const weeklyLines = formatWeeklyText(policy?.weekly).split("\n").filter(Boolean);
  if (weeklyLines.length > 0) parts.push(weeklyLines.join(" · "));
  const rangeLines = formatDateRangesText(policy?.dateRanges).split("\n").filter(Boolean);
  if (rangeLines.length > 0) parts.push(rangeLines.join(" · "));
  if (policy?.startsAt) parts.push(`起 ${policy.startsAt}`);
  if (policy?.expiresAt) parts.push(`止 ${policy.expiresAt}`);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function stateLabel(decision) {
  if (!decision) return "未评估";
  if (decision.reason === "policy_unavailable") return "策略不可用（fail closed）";
  if (decision.allowed) return decision.reason === "allowed" ? "允许" : "允许（无匹配策略）";
  return decision.mode === "revoke" ? "已撤销（revoke）" : "暂停中（suspend）";
}

function stateClass(decision) {
  if (!decision) return "";
  if (decision.reason === "policy_unavailable" || !decision.allowed) return "bad";
  return "ok";
}

function cell(label, content, attrs = "") {
  return `<td data-label="${escapeHtml(label)}"${attrs ? ` ${attrs}` : ""}>${content}</td>`;
}

// ---------------------------------------------------------------------------
// #434 window presentation (timed-authorization column + standalone detail card)
// ---------------------------------------------------------------------------
//
// The list cell shows a *summary* of the parsed time window, every present date/start/expiry
// constraint as a visible chip, and the scope disclaimer. The full 7-day detail is a card
// **outside** the table (the #406 pattern), reached through `?window=<id>`.
//
// Why a read-only GET and not pure HTML (the seat ruling allows a minimal GET route only when the
// scriptless alternatives are shown to fail):
//   1. a native `<details>` inside the `<td>` keeps the whole panel in the cell and, when opened,
//      grows the row - exactly the #405/#406 "panel inside a cell squeezes the row" defect, and it
//      contradicts the ruling's 表外 requirement;
//   2. a `:target` element outside the table with a `display:none`/`:target` CSS toggle is not a
//      native `<details>/<summary>` disclosure (no built-in keyboard toggle or state), needs new
//      rules in the shared `admin-shell-css.js` (a #435-touching file), and renders every policy's
//      card at once;
//   3. a native `<details>` outside the table cannot be opened by an in-row anchor without script,
//      because the `open` attribute is not CSS-controllable.
// The minimal GET route (mirroring #406's `?edit=`) is therefore the only scriptless way to open a
// `details.card` outside the table from an in-row, keyboard-operable entry. One
// `presentAccessPolicyWindow` view-model per policy feeds both the cell and the card, which is why
// the headline and the detail can never disagree.

function windowMarkerChips(markers) {
  return (Array.isArray(markers) ? markers : [])
    .map((marker) => `<span class="badge" data-window-marker>${escapeHtml(marker)}</span>`)
    .join(" ");
}

/** The 窗口 list cell: visible summary + markers + disclaimer + a keyboard-operable entry. */
function windowCell(view, base, policyId, openId, policy = null) {
  const summary = escapeHtml(view?.summary?.text ?? "");
  const headline = view?.ok
    ? `<span class="breakable" data-window-summary="${summary}">${summary}</span>`
    : `<span class="bad" data-window-summary="${summary}">${summary}</span>`;
  const markers = windowMarkerChips(view?.summary?.markers);
  const href = `${base}?window=${encodeURIComponent(policyId)}#authz-window`;
  const current = openId === policyId ? ' aria-current="true"' : "";
  let nowBadge = "";
  if (policy?.enabled !== false && view) {
    const est = estimateNowInWindow(policy, view);
    if (est.ok === true) nowBadge = ` <span style="color:var(--ok)">现在允许</span>`;
    else if (est.ok === false) nowBadge = ` <span style="color:var(--amber)">现在受限</span>`;
  }
  return `<div class="nm" data-window-cell><span class="ell">${headline}</span><span class="sub2">${markers || ""}${nowBadge}</span></div>
<div class="muted" data-window-disclaimer>${escapeHtml(view?.summary?.disclaimer ?? "")}</div>
<div><a class="btn ghost sm" data-window-open href="${escapeHtml(href)}"${current}>窗口详情</a></div>`;
}

function instantValue(item) {
  if (!item?.present) return '<span class="muted">未设置</span>';
  if (!item.valid) return '<span class="bad">无法解析</span>';
  return `<code class="breakable">${escapeHtml(item.value)}</code>`;
}

/**
 * #434: the standalone window card (#406's table-external card pattern), rendered only for
 * `?window=<id>` from the same view-model as the cell. Lists all seven days (including
 * 「该日无生效时段」), the policy IANA timezone, the date ranges and the full startsAt/expiresAt
 * values, and - when the window cannot be parsed - `unparsable.message` plus every checkable
 * reason, so an unreadable window is never shown as all-day/unlimited/unset.
 */
function windowDetailCard({ policy, view }) {
  const days = view.details.days
    .map((day) => `<li data-window-day="${escapeHtml(day.key)}"><span class="keep">${escapeHtml(day.label)}</span> <span class="${day.state === "empty" || day.state === "unspecified" ? "muted" : ""}" data-window-day-state="${escapeHtml(day.state)}">${escapeHtml(day.text)}</span></li>`)
    .join("");
  const ranges = !view.details.dateRanges.present
    ? '<span class="muted">未设置</span>'
    : view.details.dateRanges.valid
      ? `<ul data-window-ranges>${view.details.dateRanges.items.map((item) => `<li><code>${escapeHtml(item.text)}</code></li>`).join("")}</ul>`
      : '<span class="bad">无法解析日期区间</span>';
  const timezone = view.details.timezoneValid
    ? `<code class="keep">${escapeHtml(view.details.timezone)}</code>`
    : `<span class="bad">无法解析时区${view.details.timezone === null ? "" : `（${escapeHtml(view.details.timezone)}）`}</span>`;
  const unparsable = view.ok ? "" : `<div class="notice" data-window-unparsable><p class="bad"><strong>${escapeHtml(view.unparsable.message)}</strong></p><ul data-window-reasons>${view.unparsable.reasons.map((reason) => `<li data-window-reason="${escapeHtml(reason.reason)}"><code>${escapeHtml(reason.path)}</code> · ${escapeHtml(reason.detail)}</li>`).join("")}</ul></div>`;
  const markers = windowMarkerChips(view.summary.markers);
  return `<details class="card" id="authz-window" open data-window-detail data-window-summary="${escapeHtml(view.summary.text)}"><summary>窗口详情：${escapeHtml(policy.label)} <code class="breakable">${escapeHtml(policy.id)}</code></summary><div class="create-body">
${unparsable}
<p class="muted" data-window-scope>${escapeHtml(view.summary.disclaimer)}</p>${markers ? `<div class="facts" data-window-markers>${markers}</div>` : ""}
<p><strong>时区</strong> ${timezone}</p>
<p><strong>日期区间</strong></p>${ranges}
<p><strong>生效起点 startsAt</strong> ${instantValue(view.details.startsAt)}</p>
<p><strong>失效终点 expiresAt</strong> ${instantValue(view.details.expiresAt)}</p>
<p><strong>每周窗口（周一 → 周日）</strong></p><ul data-window-days>${days}</ul>
</div></details>`;
}

function selectOptions(entries, selected) {
  return entries
    .map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

/** Prefix → operator-facing type label for the subject picker (#406 8.3). */
const SUBJECT_KIND_LABELS = Object.freeze({
  "oauth-user": "OAuth 账户",
  "oauth-client": "OAuth 客户端",
  "api-key": "API Key",
  other: "其他主体",
});

function subjectKind(value) {
  const index = value.indexOf(":");
  const prefix = index > 0 ? value.slice(0, index) : "";
  return Object.prototype.hasOwnProperty.call(SUBJECT_KIND_LABELS, prefix) && prefix !== "other" ? prefix : "other";
}

/**
 * #405/#406 8.3: a uuid-shaped subject is shown as `api-key:c74f039e…` with the full
 * value in `title` and in the checkbox `value`, so the row stays one line wide while
 * the operator can still recover the identity. Short ids (`oauth-user:u1`) are verbatim.
 */
function shortSubject(value) {
  const text = String(value ?? "");
  const index = text.indexOf(":");
  const local = index >= 0 ? text.slice(index + 1) : text;
  if (local.length <= 20) return text;
  const head = index >= 0 ? `${text.slice(0, index + 1)}` : "";
  return `${head}${local.slice(0, 8)}…`;
}

function subjectOptions(subjects, selected) {
  const picks = new Set((Array.isArray(selected) ? selected : []).filter((item) => typeof item === "string"));
  // Keep a selected-but-absent (orphaned) subject visible so editing a policy
  // does not silently drop it.
  const list = [...new Set([...(Array.isArray(subjects) ? subjects : []), ...picks])].sort();
  if (list.length === 0) {
    return `<input class="field" name="subjects" aria-label="主体" placeholder="oauth-user:… / oauth-client:… / api-key:…" value="${escapeHtml([...picks].join(" "))}">`;
  }
  const groups = new Map();
  for (const subject of list) {
    const kind = subjectKind(subject);
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(subject);
  }
  return [...groups.entries()].map(([kind, values]) => `<details class="subject-group" data-subject-group="${escapeHtml(kind)}" open><summary>${escapeHtml(SUBJECT_KIND_LABELS[kind] ?? kind)}（${values.length}）</summary><div class="checks">${values.map((subject) => {
    const short = shortSubject(subject);
    return `<label class="scope-option"><input type="checkbox" name="subjects" value="${escapeHtml(subject)}" ${picks.has(subject) ? "checked" : ""}><span title="${escapeHtml(subject)}">${escapeHtml(short)}</span></label>`;
  }).join("")}</div></details>`).join("");
}

/** Display labels for the canonical catalogue groups (the tokens stay authoritative). */
const CAPABILITY_GROUP_LABELS = Object.freeze({
  "全部": "全部",
  Surface: "Surface（接入平面）",
  Scope: "Scope（范围）",
  Toolset: "Toolset（工具集）",
  Tool: "Tool（单个工具）",
  Resource: "Resource（资源）",
});

/**
 * #406 8.2: the capability control is a grouped checkbox picker instead of a native
 * `<select multiple size=6>` with 109 bare tokens. Selected values sort first, every
 * group shows its own count, and the edit panel offers a server-side GET filter
 * (`?capq=`) because the Admin plane may not run script (CSP `default-src 'none'`).
 *
 * RETURN-3 P1: the filter narrows the *catalogue*, never the selection. Filtering the
 * stored selection away would render those tokens unchecked - i.e. unsubmitted - so the
 * next save would silently revoke capabilities the operator never touched. Every group
 * therefore renders `selected OR matching` values, each still individually uncheckable.
 */
function capabilityField(mode, selected, query = "") {
  if (mode === "revoke") {
    return `<div class="checks" data-capability-lock="all"><label class="scope-option"><input type="checkbox" checked disabled><span>all</span></label><input type="hidden" name="capabilities" value="all"><span class="muted">revoke 模式固定为 all（principal-wide），服务端二次校验。</span></div>`;
  }
  const picked = new Set(Array.isArray(selected) ? selected : []);
  const needle = String(query ?? "").trim().toLowerCase();
  const groups = capabilityGroups()
    .map((group) => {
      const values = group.values.filter((value) => picked.has(value) || value.toLowerCase().includes(needle) || capabilityShortLabel(value).toLowerCase().includes(needle));
      const ordered = [...values].sort((left, right) => Number(picked.has(right)) - Number(picked.has(left)) || left.localeCompare(right));
      return { label: group.label, values, ordered, selectedCount: values.filter((value) => picked.has(value)).length };
    })
    .filter((group) => group.values.length > 0);
  const visible = groups.reduce((total, group) => total + group.values.length, 0);
  const matches = capabilityGroups().reduce((total, group) => total + group.values.filter((value) => value.toLowerCase().includes(needle)).length, 0);
  const keptBySelection = groups.reduce((total, group) => total + group.values.filter((value) => picked.has(value) && !value.toLowerCase().includes(needle)).length, 0);
  const toolbar = `<p class="muted" data-capability-count="${picked.size}">已选 ${picked.size} 项${needle ? `；匹配 “${escapeHtml(String(query).trim())}” 的选项 ${matches} 个${keptBySelection > 0 ? `；其中 ${keptBySelection} 项已选但不匹配筛选，仍保留` : ""}` : `；共 ${visible} 个可选`}</p>`;
  if (groups.length === 0) {
    return `<div class="capability-picker" data-capability-picker>${toolbar}<p class="muted">没有匹配的能力；请清空关键词后重试。</p></div>`;
  }
  const body = groups.map((group) => `<details class="capability-group" data-capability-group="${escapeHtml(group.label)}"${group.selectedCount > 0 ? " open" : ""}><summary>${escapeHtml(CAPABILITY_GROUP_LABELS[group.label] ?? group.label)}（${group.values.length} 项，已选 ${group.selectedCount}）</summary><div class="checks">${group.ordered.map((value) => `<label class="scope-option${picked.has(value) ? " capability-selected" : ""}"><input type="checkbox" name="capabilities" value="${escapeHtml(value)}" ${picked.has(value) ? "checked" : ""}><span class="keep" title="${escapeHtml(value)}">${escapeHtml(capabilityShortLabel(value))}</span></label>`).join("")}</div></details>`).join("");
  return `<div class="capability-picker" data-capability-picker>${toolbar}${body}</div>`;
}


const WEEKDAY_CHIPS = Object.freeze([
  ["mon", "一"], ["tue", "二"], ["wed", "三"], ["thu", "四"], ["fri", "五"], ["sat", "六"], ["sun", "日"],
]);

const WEEKLY_PRESETS = Object.freeze({
  workdays: "mon 09:00-18:00\ntue 09:00-18:00\nwed 09:00-18:00\nthu 09:00-18:00\nfri 09:00-18:00",
  everyday: "mon 09:00-18:00\ntue 09:00-18:00\nwed 09:00-18:00\nthu 09:00-18:00\nfri 09:00-18:00\nsat 09:00-18:00\nsun 09:00-18:00",
  clear: "",
});

function daysPresentInWeekly(weekly) {
  // Accept object or already-formatted text (weeklyEditor passes a string).
  const text = (typeof weekly === "string" ? weekly : formatWeeklyText(weekly)).toLowerCase();
  return new Set(WEEKDAY_CHIPS.map(([d]) => d).filter((d) => text.includes(d)));
}

function weeklyEditor(policy, { base, editId = null, weeklyPreset = "" } = {}) {
  const presetWeekly = weeklyPreset && Object.prototype.hasOwnProperty.call(WEEKLY_PRESETS, weeklyPreset)
    ? WEEKLY_PRESETS[weeklyPreset]
    : null;
  const weeklyValue = presetWeekly !== null ? presetWeekly : formatWeeklyText(policy?.weekly);
  const present = daysPresentInWeekly(weeklyValue);
  const chips = WEEKDAY_CHIPS.map(([day, label]) => {
    const on = present.has(day) ? " on" : "";
    return `<span class="seg${on}" title="${escapeHtml(day)}">${escapeHtml(label)}</span>`;
  }).join("");
  const q = (preset) => {
    const params = new URLSearchParams();
    if (editId) params.set("edit", editId);
    else params.set("new", "1");
    params.set("weeklyPreset", preset);
    return `${escapeHtml(base)}?${params.toString()}${editId ? "#authz-edit" : ""}`;
  };
  const presets = `<div class="actions" style="margin:8px 0">
<a class="btn secondary" href="${q("workdays")}">工作日 9–18</a>
<a class="btn secondary" href="${q("everyday")}">每天 9–18</a>
<a class="btn secondary" href="${q("clear")}">清空窗口</a>
</div>`;
  return `<div class="field" data-weekly-editor>
<span class="muted">允许时间 · 星期</span>
<div class="day-chips segs" aria-label="星期概览">${chips}</div>
${presets}
<label>每周窗口<textarea class="field" name="weekly" rows="3" placeholder="mon 09:00-18:00">${escapeHtml(weeklyValue)}</textarea>
<span class="muted">每行一条；不支持跨午夜，跨午夜请拆两条。</span></label>
</div>`;
}

function modeCards(mode) {
  const suspendOn = mode === "suspend" ? " checked" : "";
  const revokeOn = mode === "revoke" ? " checked" : "";
  return `<div class="mode-cards" role="radiogroup" aria-label="窗口外行为">
<label class="mode-card"><input type="radio" name="mode" value="suspend"${suspendOn}>
<b>暂停 suspend</b><span class="help">窗口外暂停访问，已有会话与授权保留，回到窗口内自动恢复。</span></label>
<label class="mode-card"><input type="radio" name="mode" value="revoke"${revokeOn}>
<b>撤销 revoke</b><span class="help">窗口外硬撤销已有授权；能力固定为全部。</span></label>
</div>`;
}

function policyFields({ policy, subjects, revision = null, capabilityQuery = "", weeklyPreset = "", editorBase = "/admin/auth/access-policy", editId = null }) {
  const mode = policy?.mode ?? "suspend";
  return `<div class="ped-form">
<div class="form-grid">
<label>标签<input class="field" name="label" maxlength="120" value="${escapeHtml(policy?.label ?? "")}" required></label>
<label class="sw" title="启用 / 停用"><input type="hidden" name="enabled" value="false"><input type="checkbox" name="enabled" value="true"${(policy?.enabled ?? true) ? " checked" : ""}><span class="switch" aria-hidden="true"></span><span>启用</span></label>
<label>时区<input class="field" name="timezone" list="authz-timezones" value="${escapeHtml(policy?.timezone ?? "Asia/Shanghai")}" required></label>
<label>生效起点<input class="field" name="startsAt" placeholder="2026-10-05T09:00:00Z" value="${escapeHtml(policy?.startsAt ?? "")}"></label>
<label>失效终点<input class="field" name="expiresAt" placeholder="2026-10-06T09:00:00Z" value="${escapeHtml(policy?.expiresAt ?? "")}"></label>
</div>
<div class="field"><span class="muted">窗口外行为</span>${modeCards(mode)}</div>
<div class="field"><span class="muted">主体（来自当前凭据快照 / configured-env）· 已选 ${(Array.isArray(policy?.subjects) ? policy.subjects : []).length}</span><div class="checks">${subjectOptions(subjects, policy?.subjects)}</div></div>
<div class="field"><span class="muted">限制的能力</span>${capabilityField(mode, policy?.capabilities, capabilityQuery)}</div>
${weeklyEditor(policy, { base: editorBase, editId, weeklyPreset })}
<div class="form-grid">
<label>日期区间<textarea class="field" name="dateRanges" rows="2" placeholder="2026-10-01..2026-10-07">${escapeHtml(formatDateRangesText(policy?.dateRanges))}</textarea></label>
</div>${revision === null ? "" : `<input type="hidden" name="expectedRevision" value="${escapeHtml(revision)}">`}
</div>`;
}

function createForm({ subjects, csrf, actions, draft, weeklyPreset = "" }) {
  const base = actions.base ?? DEFAULT_ACTIONS.base;
  const crumb = `<p class="muted">定时授权 › <strong>新建策略</strong></p>`;
  return `<details class="card create-panel" id="authz-new" ${draft || weeklyPreset ? "open" : ""}><summary>新建定时授权策略 +</summary><div class="create-body">
${crumb}
<form method="post" action="${escapeHtml(actions.create)}">${csrf}
${policyFields({ policy: draft, subjects, revision: null, weeklyPreset, editorBase: base })}
<div style="margin-top:12px"><h3 class="muted" style="font-size:13px;font-weight:600;margin:0 0 8px">7 天时间窗</h3>${weeklyTimelineHtml(draft || { weekly: {}, timezone: "Asia/Shanghai" }, weeklyPreset)}</div>
<div class="ped-foot form-actions"><button class="btn" type="submit">创建策略</button><a class="btn secondary" href="${escapeHtml(base)}">取消</a></div>
</form></div></details>`;
}

/**
 * #406: the edit panel is a card of its own (`?edit=<id>#authz-edit`), never a `<td>`
 * child, so opening it cannot squeeze the policy row into vertical stacks. The body
 * carries the GET filter for the 109-entry capability catalogue: the Admin plane has
 * no script (CSP `default-src 'none'`), so filtering is a server round trip. The filter
 * only narrows the catalogue - unsubmitted *new* checks are dropped, while every stored
 * selection is re-rendered checked and re-submitted (RETURN-3 P1).
 */
function editForm({ policy, subjects, csrf, actions, revision, capabilityQuery = "", weeklyPreset = "" }) {
  const base = actions.base ?? DEFAULT_ACTIONS.base;
  // GET filter must not nest inside the POST save form.
  const search = `<form class="capability-search inline-capq" method="get" action="${escapeHtml(base)}">
<input type="hidden" name="edit" value="${escapeHtml(policy.id)}">
<label class="search"><span class="muted">能力</span><input class="field" name="capq" value="${escapeHtml(capabilityQuery)}" placeholder="搜索能力，例如 写入、git、write_note"></label>
<button class="btn ghost sm" type="submit">筛选</button><a class="btn ghost sm" href="${escapeHtml(base)}?edit=${encodeURIComponent(policy.id)}">清空</a></form>`;
  // E7: timeline only in ped-side. E8: ped-foot rendered by caller outside.
  return `${search}
<form method="post" action="${escapeHtml(actions.update)}" class="ped-form-inner" id="authz-edit">${csrf}
<input type="hidden" name="id" value="${escapeHtml(policy.id)}">
${policyFields({ policy, subjects, revision, capabilityQuery, weeklyPreset, editorBase: base, editId: policy.id })}
</form>`;
}

function editorFoot({ policy, actions, csrf, revision }) {
  const base = actions.base ?? DEFAULT_ACTIONS.base;
  const isNew = !policy?.id;
  return `<div class="ped-foot"><button class="btn primary" type="submit" form="authz-edit">${isNew ? "创建策略" : "保存策略"}</button><a class="btn ghost" href="${escapeHtml(base)}">取消</a><span class="grow"></span>${isNew ? "" : `<a class="btn danger-o" href="${escapeHtml(`${base}?confirm=delete&id=${encodeURIComponent(policy.id)}`)}">删除策略</a>`}<span class="help hide-m" style="margin-left:8px">保存后立即生效</span></div>`;
}

function row({ policy, subjects, csrf, actions, revision, orphaned, editingId = null, windowView, windowId = null }) {
  const orphanedSet = new Set(Array.isArray(orphaned) ? orphaned : []);
  const editHref = `${actions.base ?? DEFAULT_ACTIONS.base}?edit=${encodeURIComponent(policy.id)}#authz-edit`;
  const windowHtml = windowCell(windowView, actions.base ?? DEFAULT_ACTIONS.base, policy.id, windowId, policy);
  const tz = `<code class="keep">${escapeHtml(policy.timezone)}</code>`;
  const windowCombined = `<div class="facts">${tz}</div>${windowHtml}`;
  return `<tr>${cell("策略", policyNameCell(policy, escapeHtml, shortSubject), 'class="identity col-label"')}${cell("状态 · 模式", policyStatusMode(policy), 'class="keep"')}${cell("主体", subjectsCell(policy.subjects, orphanedSet), 'class="col-subject"')}${cell("限制的能力", capabilityChips(policy.capabilities))}${cell("允许时间窗口", windowCombined, 'class="col-wide"')}${cell("操作", policyRowMenu({ policy, csrf, actions, revision, editingId, editHref }), 'class="col-actions"')}</tr>`;
}

function policyTable({ policies, subjects, csrf, actions, revision, orphaned, editingId, windows, windowId }) {
  const headers = [...POLICY_LIST_HEADERS];
  const rows = (Array.isArray(policies) ? policies : [])
    .map((policy) => row({ policy, subjects, csrf, actions, revision, orphaned, editingId, windowView: windows?.get(policy.id) ?? presentAccessPolicyWindow(policy), windowId }))
    .join("");
  return `<div class="scroll"><table class="data-table"><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="muted">暂无定时授权策略</td></tr>`}</tbody></table></div>`;
}

function noticeHtml(notice) {
  if (!notice) return "";
  const message = typeof notice === "string" ? notice : notice?.message;
  if (!message) return "";
  const kind = typeof notice === "object" && notice.kind === "ok" ? " flash" : "";
  return `<div class="notice${kind}">${escapeHtml(message)}</div>`;
}

function brokenHtml(broken, csrf, actions, { confirmRepair = false } = {}) {
  if (!broken) return "";
  const code = typeof broken === "object" ? (broken.errorCode ?? broken.code ?? null) : null;
  void confirmRepair;
  // Typed-confirm「覆盖」on the repair form (proto W5.2). Fail-closed copy retained.
  return `<div class="notice bad" id="authz-broken" role="alert"><b>策略存储不可用</b>
<p class="bad">当前策略文件无法可信读取${code ? `（${escapeHtml(code)}）` : ""}。所有 Vault 内容能力已 fail closed；管理台修复面仍可用。</p>
<p>请输入 <code>覆盖</code> 确认后提交修复文档。</p>
<form class="form-grid" method="post" action="${escapeHtml(actions.repair)}">${csrf}
<label>确认词<input class="field" name="confirmName" placeholder="覆盖" required pattern="覆盖"></label>
<label>修复文档<textarea class="field" name="document" rows="6" placeholder="粘贴修复用策略文档（JSON）" required></textarea></label>
<button class="btn danger" type="submit">确认覆盖</button></form>
<p class="muted">仅接受完整 schema 文档；修复成功后 revision = 原 revision + 1。</p></section>`;
}


/** SSR 7-day weekly timeline + now line (proto W5.11; no JS). */
function weeklyFromPreset(preset) {
  const slot = [["09:00", "18:00"]];
  if (preset === "workdays") return { mon: slot, tue: slot, wed: slot, thu: slot, fri: slot };
  if (preset === "everyday") return { mon: slot, tue: slot, wed: slot, thu: slot, fri: slot, sat: slot, sun: slot };
  if (preset === "clear") return {};
  return null;
}

function weeklyTimelineHtml(policy, weeklyPreset = "") {
  const fromPreset = weeklyFromPreset(weeklyPreset);
  const weekly = fromPreset !== null
    ? fromPreset
    : (policy?.weekly && typeof policy.weekly === "object" ? policy.weekly : {});
  const tz = typeof policy?.timezone === "string" && policy.timezone ? policy.timezone : "Asia/Shanghai";
  const toPct = (hhmm) => {
    const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return 0;
    const mins = Number(m[1]) * 60 + Number(m[2]);
    return Math.max(0, Math.min(100, (mins / 1440) * 100));
  };
  let todayKey = "";
  let nowPct = 0;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const wd = parts.find((p) => p.type === "weekday")?.value || "";
    const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
    const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
    const map = { Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" };
    todayKey = map[wd] || "";
    nowPct = ((hour * 60 + minute) / 1440) * 100;
  } catch {
    todayKey = "";
  }
  const rows = WEEKDAY_CHIPS.map(([day, label]) => {
    const windows = Array.isArray(weekly[day]) ? weekly[day] : [];
    const bars = windows.map((pair) => {
      const from = Array.isArray(pair) ? pair[0] : pair?.from;
      const to = Array.isArray(pair) ? pair[1] : pair?.to;
      const left = toPct(from);
      const width = Math.max(0, toPct(to) - left);
      if (width <= 0) return "";
      return `<div class="w" style="left:${left}%;width:${width}%" title="${escapeHtml(String(from))}–${escapeHtml(String(to))}"></div>`;
    }).join("");
    const now = day === todayKey ? `<div class="now" style="left:${nowPct}%" title="现在"></div>` : "";
    const todayCls = day === todayKey ? " today" : "";
    return `<span class="${todayCls.trim()}">${escapeHtml(label)}</span><div class="tr" data-day="${escapeHtml(day)}">${bars}${now}</div>`;
  }).join("");
  return `<div class="tl" data-timeline="7-day" aria-label="7 天时间窗预览">${rows}<span></span><div class="ax"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div></div>`;
}

function modeOutsideCn(mode) {
  const m = String(mode || "");
  if (m === "revoke") return "撤销";
  if (m === "suspend") return "暂停";
  return m || "—";
}

/** SSR estimate: is "now" inside the weekly window (policy timezone). Best-effort for ped-side. */
function estimateNowInWindow(policy, win) {
  const tz = (typeof policy?.timezone === "string" && policy.timezone) || win?.timezone || "Asia/Shanghai";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date());
    const wd = parts.find((p) => p.type === "weekday")?.value || "";
    const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
    const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
    const map = { Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" };
    const dayKey = map[wd] || "";
    const hm = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    const dayView = (win?.details?.days || []).find((d) => d.key === dayKey);
    if (!dayView) return { ok: true, why: "未设置周约束（视为全天）", at: hm, tz };
    if (dayView.state === "unparsable") return { ok: null, why: "时间窗口无法解析", at: hm, tz };
    if (dayView.state === "unspecified") return { ok: true, why: "未设置周约束（视为全天）", at: hm, tz };
    if (dayView.state === "empty") return { ok: false, why: "今日无生效时段", at: hm, tz };
    if (dayView.state === "all-day") return { ok: true, why: "今日全天", at: hm, tz };
    const intervals = dayView.intervals || [];
    const inIt = intervals.some((it) => hm >= it.start && hm < it.end);
    return { ok: inIt, why: inIt ? `落在 ${dayView.text}` : `不在今日时段（${dayView.text}）`, at: hm, tz };
  } catch {
    return { ok: null, why: "无法判定当前时间", at: "—", tz };
  }
}

function formatNowLabel(tz) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: tz || "Asia/Shanghai",
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 16).replace("T", " ");
  }
}

/** E7 editor ped-side: 摘要 + 时间线 + 当前判定 + 对主体的影响. */
function editorPreviewHtml(preview, subjects, csrf, actions, policy, weeklyPreset) {
  const win = presentAccessPolicyWindow(policy);
  const tz = (typeof policy?.timezone === "string" && policy.timezone) || win.timezone || "Asia/Shanghai";
  const mode = String(policy?.mode || "suspend");
  const modeCn = modeOutsideCn(mode);
  const caps = Array.isArray(policy?.capabilities) ? policy.capabilities : [];
  const capText = caps.length
    ? caps.map((c) => capabilityShortLabel(c)).join("、")
    : "（未选择能力）";
  const summaryText = win.summary?.text || "—";
  const markers = Array.isArray(win.summary?.markers) ? win.summary.markers : [];
  const marksHtml = markers.length
    ? `<div>${markers.map((m) => `<span class="tag" style="margin:4px 4px 0 0">${escapeHtml(m)}</span>`).join("")}</div>`
    : "";
  const est = estimateNowInWindow(policy, win);
  let verdictOk = est.ok;
  let verdictWhy = est.why;
  let verdictLabel = verdictOk === true ? "允许访问" : (verdictOk === false ? modeCn : "未判定");
  if (preview?.decision) {
    const d = preview.decision;
    verdictOk = d.allowed === true;
    verdictLabel = stateLabel(d);
    verdictWhy = d.reason || verdictWhy;
  }
  const verdictCls = verdictOk === true ? "ok" : (verdictOk === false ? "no" : "");
  const nowStr = formatNowLabel(tz);
  const timeline = `<div style="margin-top:16px">${weeklyTimelineHtml(policy, weeklyPreset)}</div>`;
  const policySubjects = Array.isArray(policy?.subjects) ? policy.subjects : [];
  const impact = policySubjects.length
    ? policySubjects.map((s) => {
      const name = subjectChip(s, {});
      const line = verdictOk === true
        ? `<div class="verdict ok"><span><b>此刻允许</b> · 影响：${escapeHtml(capText)}</span></div>`
        : verdictOk === false
          ? `<div class="verdict no"><span><b>此刻${escapeHtml(modeCn)}</b> · 影响：${escapeHtml(capText)}</span></div>`
          : `<div class="verdict"><span class="muted">暂无法判定 · ${escapeHtml(capText)}</span></div>`;
      return `<div style="margin-top:8px"><div style="font-size:13px;color:var(--tx2)">${name}</div>${line}</div>`;
    }).join("")
    : `<p class="help">选择主体后显示</p>`;
  // Optional: keep preview POST for alternate subject inspect (collapsed).
  const inspect = actions.preview
    ? `<details style="margin-top:16px"><summary class="muted" style="cursor:pointer;font-size:13px">用其他主体试算</summary>
<form class="form-grid" method="post" action="${escapeHtml(actions.preview)}" style="margin-top:8px">${csrf}
<label>主体<select class="field" name="subject">${[...new Set([...(Array.isArray(subjects) ? subjects : []), ...policySubjects])].sort().map((subject) => `<option value="${escapeHtml(subject)}"${preview?.subject === subject ? " selected" : ""}>${escapeHtml(subject)}</option>`).join("")}</select></label>
<button class="btn ghost sm" type="submit">试算</button></form></details>`
    : "";
  return `<div class="stick" id="authz-preview">
<div class="sect-h"><h2>生效预览</h2><span class="muted">${escapeHtml(tz)}</span></div>
<div class="sumbox"><b>${escapeHtml(summaryText)}</b>${marksHtml}<div style="margin-top:4px">窗口外：<b>${escapeHtml(modeCn)}</b> ${escapeHtml(capText)}</div></div>
${timeline}
<div class="verdict ${verdictCls}" style="margin-top:12px"><span>现在（${escapeHtml(nowStr)}）<b>${escapeHtml(verdictLabel)}</b> · ${escapeHtml(verdictWhy)}</span></div>
<div class="sect-h" style="margin-top:24px"><h2>对主体的影响</h2></div>
${impact}
${inspect}
</div>`;
}

/** List-page compact preview (subject dropdown). */
function listPreviewHtml(preview, subjects, csrf, actions) {
  const detail = preview
    ? `<p>主体 <code class="breakable">${escapeHtml(preview.subject ?? "")}</code>：<span class="badge ${stateClass(preview.decision)}">${escapeHtml(stateLabel(preview.decision))}</span></p>
<p class="muted">当前 <code>${escapeHtml(preview.now ?? "—")}</code> · 时区 <code>${escapeHtml(preview.timezone ?? "—")}</code></p>
<p class="muted">下一次状态变化 <code>${escapeHtml(preview.nextChangeAt ?? "—")}</code> · 下一次允许 <code>${escapeHtml(preview.nextAllowedAt ?? "—")}</code></p>`
    : `<p class="muted">选择主体查看当前状态。</p>`;
  return `<section class="card" id="authz-preview"><h2>当前状态预览</h2>${detail}
<form class="form-grid" method="post" action="${escapeHtml(actions.preview)}">${csrf}<label>主体<select class="field" name="subject">${[...new Set(Array.isArray(subjects) ? subjects : [])].sort().map((subject) => `<option value="${escapeHtml(subject)}">${escapeHtml(subject)}</option>`).join("")}</select></label><button class="btn secondary" type="submit">查看</button></form></section>`;
}

function previewHtml(preview, subjects, csrf, actions, policy = null, weeklyPreset = "", { editor = false } = {}) {
  if (editor && policy) return editorPreviewHtml(preview, subjects, csrf, actions, policy, weeklyPreset);
  if (policy) {
    // Legacy: card with timeline (avoid duplicating editor chrome on list)
    return listPreviewHtml(preview, subjects, csrf, actions);
  }
  return listPreviewHtml(preview, subjects, csrf, actions);
}

function orphanedHtml(orphaned) {
  const list = (Array.isArray(orphaned) ? orphaned : []).filter(Boolean);
  if (list.length === 0) return "";
  return `<div class="notice" id="authz-orphaned" role="status"><b>孤立主体</b>
<span class="muted">以下主体仍写在策略里，但当前凭据快照里已经找不到；只提示，不会自动删策略。</span>
<div class="tags" style="margin-top:8px">${list.map((subject) => `<span class="tag danger" title="${escapeHtml(subject)}">${escapeHtml(shortSubject(subject))} · 孤立</span>`).join("")}</div></div>`;
}

/**
 * Render the Auth Center "定时授权" tab fragment.
 *
 * @param {object} model
 * @param {Array} model.policies   normalized policies from the store snapshot
 * @param {number|null} model.revision committed revision (CAS token for forms)
 * @param {string} model.status    store status ("ready" | "broken" | ...)
 * @param {object|null} model.preview  `previewForSubject` result
 * @param {object|boolean|null} model.broken  broken-store descriptor
 * @param {string[]} model.orphaned subjects present in policies but not in the snapshot
 * @param {string} model.csrfToken Auth Center CSRF token (hidden field only)
 * @param {object|string|null} model.notice flash/notice message
 * @param {string[]} model.subjects known subjects for the pickers
 * @param {object} model.actions   action URL overrides (including `base`)
 * @param {object|null} model.draft optional create-form prefill
 * @param {object|null} model.editing policy to show in the standalone edit panel
 * @param {object|null} model.windowPolicy policy whose #434 window detail card is open (`?window=`)
 * @param {string} model.capabilityQuery server-side `capq` filter for the edit panel
 */
export function renderAccessPolicyTab({
  policies = [],
  revision = null,
  status = "ready",
  preview = null,
  broken = null,
  orphaned = [],
  csrfToken = "",
  notice = null,
  subjects = [],
  actions = {},
  draft = null,
  editing = null,
  windowPolicy = null,
  capabilityQuery = "",
  weeklyPreset = "",
  confirm = "",
  deleteId = "",
} = {}) {
  const urls = { ...DEFAULT_ACTIONS, ...(actions ?? {}) };
  const policyList = Array.isArray(policies) ? policies : [];
  // #434: one view-model per policy, computed once and read by both the list cell and the
  // standalone detail card, so the headline and the expanded detail are always the same source.
  const windows = new Map(policyList.map((policy) => [policy.id, presentAccessPolicyWindow(policy)]));
  const windowView = windowPolicy ? windows.get(windowPolicy.id) ?? presentAccessPolicyWindow(windowPolicy) : null;
  const csrf = `<input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">`;
  const timezoneList = `<datalist id="authz-timezones">${COMMON_TIMEZONES.map((zone) => `<option value="${escapeHtml(zone)}"></option>`).join("")}</datalist>`;
  const brokenNow = Boolean(broken ?? (status === "broken"));
  const newCta = brokenNow
    ? `<span class="btn primary" aria-disabled="true" title="策略存储不可用，修复后再新建">+ 新建策略</span>`
    : `<a class="btn primary" href="${escapeHtml(urls.base)}?new=1">+ 新建策略</a>`;
  const header = `<div class="page-head"><h2>定时授权</h2><div class="actions">${newCta}</div></div><p class="page-lede">定时授权只会在既有权限基础上再加限制：暂停保留会话，撤销作用于主体全部授权；管理台本身不受策略约束。</p>${stage5MasterFut()}`;
  const confirmRepair = confirm === "repair";
  let deletePanel = "";
  if (confirm === "delete" && deleteId) {
    const target = policyList.find((policy) => policy.id === deleteId) || null;
    if (target) {
      deletePanel = `<section class="card" id="authz-delete-confirm"><h2>确认删除策略</h2>
<p class="bad">将删除 <strong>${escapeHtml(target.label)}</strong>（<code class="breakable">${escapeHtml(target.id)}</code>）。请输入策略标签 <code>${escapeHtml(target.label)}</code> 确认。</p>
<form class="form-grid" method="post" action="${escapeHtml(urls.delete)}">${csrf}
<input type="hidden" name="id" value="${escapeHtml(target.id)}">
<input type="hidden" name="expectedRevision" value="${escapeHtml(revision)}">
<label>确认标签<input class="field" name="confirmName" placeholder="${escapeHtml(target.label)}" required></label>
<button class="btn danger" type="submit">确认删除</button>
<a class="btn secondary" href="${escapeHtml(urls.base)}">取消</a></form></section>`;
    }
  }
  // E1: ?edit= is a full-page editor (proto ped), not nested inside the list chrome.
  if (editing) {
    const crumb = `<div class="page-head"><h2><a class="crumbp" href="${escapeHtml(urls.base)}">定时授权</a><span class="muted"> › </span><span>${escapeHtml(editing.label || "未命名策略")}</span></h2><div class="actions"><span class="idc hide-m" title="${escapeHtml(editing.id || "")}">${escapeHtml(String(editing.id || "").slice(0, 8))}…</span></div></div>`;
    return `<section class="authz-editor-page" id="authz-policy">${crumb}
${noticeHtml(notice)}
<div class="ped" data-authz-editor="1" aria-current="true">
<div class="split-editor"><div class="editor-pane ped-form">${editForm({ policy: editing, subjects, csrf, actions: urls, revision, capabilityQuery, weeklyPreset })}</div><aside class="preview-pane ped-side">${previewHtml(preview, subjects, csrf, urls, editing, weeklyPreset, { editor: true })}</aside></div>
${editorFoot({ policy: editing, actions: urls, csrf, revision })}
</div>
${timezoneList}
</section>`;
  }

  return `<section class="card" id="authz-policy">${header}
${noticeHtml(notice)}
${brokenHtml(broken ?? (status === "broken"), csrf, urls, { confirmRepair })}
${orphanedHtml(orphaned)}
${deletePanel}
${previewHtml(preview, subjects, csrf, urls, null, weeklyPreset)}
${windowView ? windowDetailCard({ policy: windowPolicy, view: windowView }) : ""}
${brokenNow ? "" : createForm({ subjects, csrf, actions: urls, draft, weeklyPreset })}
${policyTable({ policies: policyList, subjects, csrf, actions: urls, revision, orphaned, editingId: null, windows, windowId: windowPolicy?.id ?? null })}
${timezoneList}
</section>`;
}
