// 审计 — port of `docs/admin-ui-proto/src/5-render.js` `renderAudit()` (L311–L348) onto the real
// audit records from `provider.authorizationSnapshot().audit`.
//
// Seven fixed columns (时间 / 结果 / 动作 / 凭据 / Agent / 来源 / 展开), failed rows in the
// prototype's `.fail` tint, and the row detail as a native `<details>` disclosure — the prototype
// expands it with script (`S.uaOpen`), so the disclosure is the browser's, not ours. Filters are
// GET query parameters (`outcome/action/credential/origin/source/q/page/pageSize`) so a filtered
// view is linkable; the prototype applied them from memory.
//
// Field mapping (the prototype's mock vocabulary → the fields the services actually record):
//   `a.src`             → `source` (+ `sourceKind`/`sourcePeer`/`forwardedChain` from
//                         `request-attribution.js`, so 本机直连 / 内网 / 公网 / 反代（受信） is
//                         classified from the recorded value instead of from the prototype's guess);
//   `a.agent`           → `agent` + `agentSource` (clientInfo > meta > session > apiKeyLabel > ua);
//   `a.cred.kind`       → `credentialType` + `credentialId` / `clientId` / `userId`;
//   `a.reason`/`detail` → the same field names the routers write.
// A value the row does not carry renders as `—`, never as 成功 / 正常.
import { pageBar, emptyState, table, mcards, moreMenu, esc, fut, ic } from "../ui.js";
import { actionCategory, actionLabel, credentialKindLabel } from "../presentation/labels.js";
import { fmt, fmtFull } from "../presentation/format.js";

const TAB = "audit";
const AUDIT_BASE = "/admin/auth?tab=audit";
const PAGE_SIZES = Object.freeze([25, 50, 100]);
/** Prototype outcome segment (renderAudit L338 district) and its filter values. */
const OUTCOMES = Object.freeze([["", "全部"], ["success", "成功"], ["failure", "失败"]]);
/** Prototype action select: category filters + the one literal action it names. */
const ACTION_OPTIONS = Object.freeze([["", "所有动作"], ["MCP", "MCP 调用"], ["OAuth", "OAuth 授权"], ["Web", "Web"], ["管理", "管理操作"], ["admin.login", "管理员登录"]]);
/** Prototype `CRED_KIND` plus the credential types this deployment actually records. */
const CREDENTIAL_OPTIONS = Object.freeze([
  ["", "所有凭据"], ["api-key", "API Key"], ["oauth-access", "OAuth Token"], ["oauth-refresh", "刷新 Token"],
  ["oauth-client", "OAuth 客户端"], ["oauth-user", "OAuth 账户"], ["admin-session", "管理会话"], ["web-session", "Web 会话"], ["none", "匿名"],
]);
/** Prototype `CRED_KIND` wording for the secondary line; unknown kinds stay labelled as unknown. */
const CREDENTIAL_EXTRA = Object.freeze({ "admin-session": "管理会话", "web-session": "Web 会话", "oauth-code": "授权码", none: "匿名" });
/** `request-attribution.js` `AGENT_SOURCE_PRIORITY` → what the recorded Agent value actually is. */
const AGENT_SOURCE = Object.freeze({ clientInfo: "客户端自报", meta: "请求元数据自报", session: "会话作者", apiKeyLabel: "Key 备注", ua: "由 UA 推测" });

function text(value, max = 160) {
  return String(value ?? "").replace(/[\r\n\0]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Monospaced value inside the row-detail panel. The panel is the one place in the table that is
 * *supposed* to break a long value (`.uax{word-break:break-all}`), so its values must not carry the
 * `.mono` class: the layout gate's keep contract reads every `.tbl .mono` as an unbreakable token
 * (`.cellt` / `.nm b` / `.nm .sub2` / `.mono` must compute to `white-space:nowrap`), and the panel
 * lives inside `td.act`. The inline face paints identically — `.uax` already sets
 * `font:400 13px/18px var(--mono)` — without claiming a contract it would break.
 */
function monoValue(value) {
  return `<span style="font-family:var(--mono)">${esc(value)}</span>`;
}

function readFilters(query = {}) {
  const asked = Number(query.pageSize);
  return {
    outcome: OUTCOMES.some(([key]) => key === String(query.outcome || "")) ? String(query.outcome || "") : "",
    action: text(query.action, 80),
    credential: text(query.credential, 80),
    origin: text(query.origin, 160),
    source: text(query.source, 80),
    q: text(query.q, 120),
    pageSize: PAGE_SIZES.includes(asked) ? asked : 25,
  };
}

/** Filter links/pagination carry every other filter, so the URL always describes the view. */
function auditHref(filters, overrides = {}) {
  const merged = { ...filters, ...overrides };
  const search = new URLSearchParams({ tab: TAB });
  for (const key of ["outcome", "action", "credential", "origin", "source", "q"]) {
    if (merged[key]) search.set(key, merged[key]);
  }
  if (merged.pageSize !== 25) search.set("pageSize", String(merged.pageSize));
  if (Number(merged.page) > 1) search.set("page", String(Number(merged.page)));
  return `/admin/auth?${search.toString()}`;
}

/** Mirrors `catalog.js` `isFailure`, so the sidebar attention dot and this page never disagree. */
function isFailure(row) {
  return row?.ok === false || row?.outcome === "failure" || row?.success === false;
}

function credentialName(ctx, row) {
  const model = ctx.model;
  const kind = String(row?.credentialType || "");
  const id = String(row?.credentialId || "");
  if (kind === "api-key") return `API Key · ${model.keyName(model.keyOf(id))}`;
  if (kind === "oauth-access" || kind === "oauth-refresh") {
    const client = model.client(row?.clientId);
    const account = row?.userId ? model.acct(row.userId) : null;
    if (client) return `${model.clientName(client)}${account ? ` · ${model.acctName(account)}` : ""}`;
    if (account) return model.acctName(account);
    return "—";
  }
  if (kind === "oauth-client") {
    const client = model.client(row?.clientId || id);
    return client ? model.clientName(client) : "—";
  }
  if (kind === "oauth-user") {
    const account = model.acct(id || row?.userId);
    return account ? model.acctName(account) : "—";
  }
  if (kind === "admin-session") return "管理员会话";
  if (kind === "web-session") {
    const account = row?.userId ? model.acct(row.userId) : null;
    return account ? `Web · ${model.acctName(account)}` : "Web 会话";
  }
  if (kind === "none") return "匿名";
  return "—";
}

function credentialKind(row) {
  const kind = String(row?.credentialType || "");
  return CREDENTIAL_EXTRA[kind] || credentialKindLabel(kind).label;
}

function isLoopbackAddress(value) {
  const address = String(value || "");
  return address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127.");
}

function isPrivateAddress(value) {
  const address = String(value || "");
  if (!address) return false;
  if (isLoopbackAddress(address) || address.startsWith("10.") || address.startsWith("192.168.")) return true;
  const match = /^172\.(\d{1,3})\./.exec(address);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

/** 来源 column secondary line: the recorded trust/source class, else the address itself. */
function sourceKindText(row) {
  const kind = String(row?.sourceKind || "");
  if (kind === "loopback") return "本机直连";
  if (kind === "trusted-proxy") return "反代（受信）";
  if (kind === "untrusted-forwarded") return "经未受信转发";
  if (kind === "direct") return isPrivateAddress(row?.source) ? "内网" : "公网";
  if (!row?.source) return "未提供";
  // Records written without `requestSourceAttribution` (the admin routes) carry only the address.
  if (isLoopbackAddress(row.source)) return "本机直连";
  return isPrivateAddress(row.source) ? "内网" : "公网";
}

function toolOf(row) {
  return text(row?.tool || row?.method || "", 200);
}

function searchText(ctx, row) {
  const kind = credentialKind(row);
  return [
    row?.tool, row?.method, row?.userAgent, row?.detail, row?.reason, row?.source, row?.origin,
    actionLabel(row?.action).label, String(row?.action || ""), credentialName(ctx, row), kind,
  ].filter(Boolean).join(" ").toLowerCase();
}

function matches(ctx, row, filters) {
  if (filters.outcome === "success" && isFailure(row)) return false;
  if (filters.outcome === "failure" && !isFailure(row)) return false;
  if (filters.action) {
    const action = String(row?.action || "");
    if (action !== filters.action && actionCategory(action) !== filters.action && !action.startsWith(filters.action)) return false;
  }
  if (filters.credential && String(row?.credentialType || "") !== filters.credential) return false;
  if (filters.origin && !text(row?.origin, 240).toLowerCase().includes(filters.origin.toLowerCase())) return false;
  if (filters.source && !text(row?.source, 120).toLowerCase().includes(filters.source.toLowerCase())) return false;
  if (filters.q && !searchText(ctx, row).includes(filters.q.toLowerCase())) return false;
  return true;
}

/**
 * 转发链 line (`request-attribution.js` `requestSourceAttribution`): the adopted source, the trust
 * decision that produced it, and any raw `X-Forwarded-For` entries that did *not* change it
 * (untrusted input stays labelled as untrusted diagnostics).
 */
function forwardChainLine(row) {
  const source = row?.source || null;
  const peer = row?.sourcePeer && row.sourcePeer !== source ? row.sourcePeer : null;
  const chain = (Array.isArray(row?.forwardedChain) ? row.forwardedChain : []).filter((hop) => hop && hop !== source);
  if (!source && !peer && !chain.length) return "";
  const parts = [source ? monoValue(source) : "—"];
  if (row?.sourceTrusted) parts.push(`反代 ${esc(row.sourceTrustedEntry || "configured")}（受信）`);
  else if (peer) parts.push(monoValue(peer));
  const raw = chain.length
    ? `<span class="muted"> · X-Forwarded-For：${chain.map((hop) => monoValue(hop)).join("、")}${row?.forwardedChainTruncated ? "（已截断）" : ""}${row?.sourceTrusted ? "" : "（未受信，仅诊断）"}</span>`
    : "";
  return `<div style="font-family:var(--font)">转发链：${parts.join(" ← ")}${raw}</div>`;
}

/** The expanded disclosure body — the prototype's `.uax` lines, on the fields the rows carry. */
function detailLines(ctx, row) {
  const lines = [];
  if (row?.reason) lines.push(`<div style="color:var(--danger);font-family:var(--font)">失败原因：${esc(row.reason)}</div>`);
  if (row?.detail) lines.push(`<div style="color:var(--tx);font-family:var(--font)">${esc(row.detail)}</div>`);
  lines.push(`动作键 ${monoValue(row?.action || "—")} · 域名 ${esc(row?.origin || "—")} · 凭据 ${esc(credentialKind(row))}<br>User-Agent：${esc(row?.userAgent || "—")}`);
  const tool = toolOf(row);
  if (tool) lines.push(`<div style="font-family:var(--font)">MCP 调用：${monoValue(tool)}</div>`);
  const chain = forwardChainLine(row);
  // #285 (trusted-proxy origin chain) is still planned: the block keeps the prototype's planned
  // marker instead of reading as an existing feature.
  if (chain) lines.push(`<div class="futonly">${chain}<div class="help">${fut("#285")}</div></div>`);
  const agent = String(row?.agent || "");
  if (agent) {
    const why = AGENT_SOURCE[String(row?.agentSource || "")] || "";
    lines.push(`<div style="font-family:var(--font)">Agent 来源：${esc(why || "未说明")}</div>`);
  }
  return lines.join("");
}

function rowHtml(ctx, row) {
  const failed = isFailure(row);
  // Prototype `renderAudit`: a `?focus=<id>` link (the overview's 最近失败 rows) marks the row it
  // came from with `.cur`, so the record the operator clicked is the one they land on.
  const focused = Boolean(ctx.focus) && String(row?.id ?? "") === String(ctx.focus);
  const at = row?.time || row?.at || row?.timestamp || row?.createdAt || null;
  const action = actionLabel(row?.action);
  const category = actionCategory(row?.action);
  const tool = toolOf(row);
  const kind = credentialKind(row);
  return `<tr class="${[failed ? "fail" : "", focused ? "cur" : ""].filter(Boolean).join(" ")}" style="position:relative">
<td class="cellt num" title="${esc(fmtFull(at))}">${esc(fmt(at))}</td>
<td>${failed ? `<span class="st danger"><span class="dot"></span>失败</span>` : `<span class="st ok"><span class="dot"></span>成功</span>`}</td>
<td><div class="nm"><span class="ell" title="${esc(row?.action || "")}">${esc(action.label)}</span><span class="sub2">${esc(category)}${tool && !action.label.includes(tool) ? ` · <span class="mono ell">${esc(tool)}</span>` : ""}</span></div></td>
<td><div class="nm"><span class="ell">${esc(credentialName(ctx, row))}</span><span class="sub2">${esc(kind)}</span></div></td>
<td><div class="nm"><span class="ell">${esc(row?.agent || "—")}</span><span class="sub2">${esc(AGENT_SOURCE[String(row?.agentSource || "")] || "")}</span></div></td>
<td class="cellt"><span class="mono">${esc(row?.source || "—")}</span><div class="muted">${esc(sourceKindText(row))}</div></td>
<td class="act" style="overflow:visible"><details class="ua"><summary aria-label="展开详情" title="展开详情">${ic("chev")}</summary><div class="uax" style="position:absolute;left:var(--s3);right:var(--s3);top:100%;z-index:20;text-align:left;white-space:normal;border:1px solid var(--line2);border-radius:var(--r);box-shadow:var(--shadow)">${detailLines(ctx, row)}</div></details></td></tr>`;
}

function cardHtml(ctx, row) {
  const failed = isFailure(row);
  const at = row?.time || row?.at || row?.timestamp || row?.createdAt || null;
  const action = actionLabel(row?.action);
  const tool = toolOf(row);
  const reason = text(row?.reason || row?.detail || "", 160);
  return `<div class="mc ${failed ? "fail" : ""}"><div class="b"><div class="nm"><b>${esc(action.label)}</b><span class="sub2">${esc(credentialName(ctx, row))}</span></div><div class="meta">${failed ? `<span class="st danger"><span class="dot"></span>失败</span>` : `<span class="st ok"><span class="dot"></span>成功</span>`}<span>${esc(fmt(at))}</span><span class="mono">${esc(row?.source || "—")}</span>${tool ? `<span class="mono">${esc(tool)}</span>` : ""}</div>${reason ? `<span class="help" style="color:var(--danger)">${esc(reason)}</span>` : ""}</div></div>`;
}

function toolbar(filters) {
  const segItems = OUTCOMES.map(([key, label]) => ({ label, href: auditHref(filters, { outcome: key }), on: filters.outcome === key }));
  const nonDefault = Boolean(filters.action || filters.credential || filters.origin || filters.source || filters.q || filters.outcome || filters.pageSize !== 25);
  const selected = (value, current) => (value === current ? " selected" : "");
  // Prototype `renderAudit` filters row: seg + two selects + two inputs + the search box + 重置.
  // The page-size control belongs to the PAGER (that is where the prototype renders 每页), so it is
  // not repeated here. The one control the prototype does not have is the explicit 筛选 submit:
  // this form carries three text fields, and implicit submission only works with one, so without a
  // submit button the filters could not be applied at all without script.
  return `<form class="toolbar" method="get" action="/admin/auth">
<input type="hidden" name="tab" value="${TAB}">
${segItems.length ? `<div class="seg">${segItems.map((item) => `<a href="${esc(item.href)}"${item.on ? ' class="on" aria-current="page"' : ""}>${esc(item.label)}</a>`).join("")}</div>` : ""}
<select class="sel sm" name="action" aria-label="动作" title="动作">${ACTION_OPTIONS.map(([value, label]) => `<option value="${esc(value)}"${selected(value, filters.action)}>${esc(label)}</option>`).join("")}</select>
<select class="sel sm" name="credential" aria-label="凭据类型" title="凭据类型">${CREDENTIAL_OPTIONS.map(([value, label]) => `<option value="${esc(value)}"${selected(value, filters.credential)}>${esc(label)}</option>`).join("")}</select>
<input class="inp sm hide-m" name="origin" placeholder="域名" value="${esc(filters.origin)}" style="width:150px" aria-label="域名">
<input class="inp sm hide-m" name="source" placeholder="来源 IP" value="${esc(filters.source)}" style="width:120px" aria-label="来源 IP">
<label class="search">${ic("search")}<input name="q" placeholder="搜索调用、工具、User-Agent" value="${esc(filters.q)}" aria-label="搜索调用、工具、User-Agent"><kbd>/</kbd></label>
<button class="btn ghost sm" type="submit">筛选</button>
${nonDefault ? `<a class="btn ghost sm" href="${AUDIT_BASE}">重置</a>` : ""}</form>`;
}

/**
 * Pager — prototype `renderAudit`'s `.pager`: 共 N 条 (+ 失败数) · `.grow` · 每页 select · `.pg`.
 * The page-size select is scripted in the prototype (`data-act="pagesize"`); here it is a real GET
 * form carrying the current filters, with one 应用 button because a `<select>` alone cannot submit.
 */
/**
 * Bounded page window (#607). The prototype lists every page, but its fixtures never exceed a few
 * pages; with `AUTH_AUDIT_MAX_ENTRIES=2000` and pageSize 25 this page would emit 80 links (~1.5k px),
 * which is wider than a phone and also grows without bound if the retention cap is raised. The window
 * keeps first, last and `page ± 1` (plus ellipses), so the DOM stays ~9 links regardless of `pages`.
 */
function pageWindow(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1);
  const out = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(pages - 1, page + 1);
  if (start > 2) out.push("gap");
  for (let current = start; current <= end; current += 1) out.push(current);
  if (end < pages - 1) out.push("gap");
  out.push(pages);
  return out;
}

function pagerRow(total, failCount, page, pageSize, filters) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const link = (target, label, { on = false, disabled = false } = {}) => {
    if (disabled) return `<button type="button" disabled>${esc(label)}</button>`;
    if (on) return `<span class="on" aria-current="page">${esc(label)}</span>`;
    return `<a href="${esc(auditHref(filters, { page: target }))}">${esc(label)}</a>`;
  };
  const parts = [link(page - 1, "‹", { disabled: page <= 1 })];
  for (const current of pageWindow(page, pages)) {
    parts.push(current === "gap" ? `<span class="gap" aria-hidden="true">…</span>` : link(current, String(current), { on: current === page }));
  }
  parts.push(link(page + 1, "›", { disabled: page >= pages }));
  const fail = failCount ? ` · <span style="color:var(--danger)">${esc(String(failCount))} 条失败</span>` : "";
  // `filters` is the filter *set* (outcome/action/credential/origin/source/q/pageSize) and does not carry
  // the tab, so the page-size form used to submit `/admin/auth?pageSize=50` with no `tab` and the router
  // fell back to 概览 (#604). The tab is part of the route, so it is written here explicitly.
  const hidden = Object.entries(filters)
    .filter(([key, value]) => key !== "pageSize" && key !== "tab" && value !== "" && value !== null && value !== undefined)
    .map(([key, value]) => `<input type="hidden" name="${esc(key)}" value="${esc(String(value))}">`).join("");
  const hiddenTab = `<input type="hidden" name="tab" value="${esc(TAB)}">`;
  return `<div class="pager"><span>共 ${esc(String(total))} 条${fail}</span><span class="grow"></span><form class="inline-form" method="get" action="/admin/auth">${hiddenTab}${hidden}<label>每页 <select class="sel sm" name="pageSize" aria-label="每页条数" title="每页条数">${PAGE_SIZES.map((size) => `<option value="${size}"${Number(size) === Number(pageSize) ? " selected" : ""}>${size}</option>`).join("")}</select></label><button class="btn ghost sm" type="submit">应用</button></form><div class="pg">${parts.join("")}</div></div>`;
}

/**
 * 清空审计日志 (`POST /admin/auth/audit/clear`, type-to-confirm). `ui.confirmPage` renders
 * `extraHtml` outside its own form and disables the submit button whenever a typed confirmation is
 * present, which is a dead form without script; this is the same `.scrim on` / `.modal show` /
 * `.modal .tc` / `.acts` markup with the input inside the form and a live submit button. The
 * router's own CSRF check is what actually authorizes the write.
 */
function clearConfirm(ctx) {
  const audit = Array.isArray(ctx.snapshot?.audit) ? ctx.snapshot.audit : [];
  const failures = audit.filter(isFailure).length;
  return `<div class="scrim on"></div><div class="modal show" role="alertdialog" aria-modal="true" aria-label="清空全部审计日志？">
<h3>清空全部审计日志？</h3>
<p>将永久删除 <b>${esc(String(audit.length))}</b> 条记录（含 ${esc(String(failures))} 条失败记录）。清空动作本身会作为第一条新记录保留。</p>
<div class="tc">输入 <code>清空日志</code> 以确认</div>
<div class="acts"><a class="btn ghost" href="${AUDIT_BASE}">取消</a><form method="post" action="/admin/auth/audit/clear" style="display:flex;align-items:center;gap:var(--s2)"><input type="hidden" name="csrf" value="${esc(ctx.csrf || "")}"><input class="inp" name="confirm" autocomplete="off" aria-label="确认输入" placeholder="清空日志" required pattern="清空日志" title="请输入「清空日志」"><button class="btn danger" type="submit">清空日志</button></form></div>
</div>`;
}

export function renderAuditPage(ctx) {
  const query = ctx.query || {};
  const filters = readFilters(query);
  // Prototype `S.focus` (`6-app.js` `parseHash`): the record a 最近失败 link points at. It does not
  // filter the list, it marks the row (`rowHtml` adds `.cur`).
  const focus = query.focus ? String(query.focus) : null;
  const audit = Array.isArray(ctx.snapshot?.audit) ? ctx.snapshot.audit : [];
  const listed = audit.filter((row) => matches(ctx, row, filters));
  const failCount = listed.filter(isFailure).length;
  const pages = Math.max(1, Math.ceil(listed.length / filters.pageSize));
  const page = Math.min(pages, Math.max(1, Number.parseInt(query.page, 10) || 1));
  const slice = listed.slice((page - 1) * filters.pageSize, page * filters.pageSize);

  const exportMarker = `<span class="btn ghost sm futonly" aria-disabled="true" title="规划中，尚未实现">${ic("file")}<span class="hide-m">导出 CSV</span> ${fut("设想")}</span>`;
  const actions = `${exportMarker}${moreMenu([{ href: `${AUDIT_BASE}&confirm=clear`, label: "清空审计日志…", icon: "trash", danger: true }])}`;

  const content = `${pageBar({ title: "审计", actions })}<div class="content scroll"><div class="page wide">
${toolbar(filters)}
${table([["时间", "92px"], ["结果", "76px"], ["动作", "22%"], ["凭据", "22%"], ["Agent", "15%"], ["来源", "13%"], ["", "", "act"]], slice.map((row) => rowHtml({ ...ctx, focus }, row)), emptyState("filter", "没有匹配的审计记录", "调整或重置筛选条件", `<a class="btn" href="${AUDIT_BASE}">重置筛选</a>`))}${mcards(slice.map((row) => cardHtml(ctx, row)))}
${listed.length ? pagerRow(listed.length, failCount, page, filters.pageSize, filters) : ""}
</div></div>`;
  const detailPanel = String(query.confirm || "") === "clear" ? clearConfirm(ctx) : "";
  return { content, detailPanel };
}
