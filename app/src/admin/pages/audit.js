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
import { pageBar, emptyState, table, mcards, moreMenu, esc, ic } from "../ui.js";
import { actionCategory, actionLabel, credentialKindLabel } from "../presentation/labels.js";
import { fmt, fmtFull } from "../presentation/format.js";
import { t } from "../../i18n/context.js";
import { readSort, sortRows } from "../table-sort.js";

const TAB = "audit";
const AUDIT_BASE = "/admin/auth?tab=audit";
const PAGE_SIZES = Object.freeze([25, 50, 100]);
/** Prototype outcome segment (renderAudit L338 district) and its filter values. */
const OUTCOMES = Object.freeze([["", "adm.audit.outcome.all"], ["success", "adm.audit.outcome.success"], ["failure", "adm.audit.outcome.failure"]]);
/** Prototype action select: category filters + the one literal action it names. */
const ACTION_OPTIONS = Object.freeze([["", "adm.audit.action.all"], ["MCP", "adm.audit.action.mcp"], ["OAuth", "adm.audit.action.oauth"], ["Web", "adm.audit.action.web"], ["管理", "adm.audit.action.admin"], ["admin.login", "adm.audit.action.adminLogin"]]);
/** Prototype `CRED_KIND` plus the credential types this deployment actually records. */
const CREDENTIAL_OPTIONS = Object.freeze([
  ["", "adm.audit.cred.all"], ["api-key", "adm.label.credential.api-key"], ["oauth-access", "adm.audit.cred.oauthAccess"], ["oauth-refresh", "adm.label.credential.oauth-refresh"],
  ["oauth-client", "adm.label.credential.oauth-client"], ["oauth-user", "adm.label.credential.oauth-user"], ["admin-session", "adm.label.credential.admin-session"], ["web-session", "adm.label.credential.web-session"], ["none", "adm.label.credential.none"],
]);
/** Prototype `CRED_KIND` wording for the secondary line; unknown kinds stay labelled as unknown. */
const CREDENTIAL_EXTRA = Object.freeze({ "admin-session": "adm.label.credential.admin-session", "web-session": "adm.label.credential.web-session", "oauth-code": "adm.label.credential.oauth-code", none: "adm.label.credential.none" });
/** `request-attribution.js` `AGENT_SOURCE_PRIORITY` → what the recorded Agent value actually is. */
const AGENT_SOURCE = Object.freeze({ clientInfo: "adm.audit.agentSource.clientInfo", meta: "adm.audit.agentSource.meta", session: "adm.audit.agentSource.session", apiKeyLabel: "adm.audit.agentSource.apiKeyLabel", ua: "adm.audit.agentSource.ua" });

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
  if (kind === "admin-session") return t("adm.label.credential.admin-session");
  if (kind === "web-session") {
    const account = row?.userId ? model.acct(row.userId) : null;
    return account ? `Web · ${model.acctName(account)}` : t("adm.label.credential.web-session");
  }
  if (kind === "none") return t("adm.label.credential.none");
  return "—";
}

function credentialKind(row) {
  const kind = String(row?.credentialType || "");
  return CREDENTIAL_EXTRA[kind] ? t(CREDENTIAL_EXTRA[kind]) : credentialKindLabel(kind).label;
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
  if (kind === "loopback") return t("adm.audit.source.loopback");
  if (kind === "trusted-proxy") return t("adm.audit.source.trustedProxy");
  if (kind === "untrusted-forwarded") return t("adm.audit.source.untrustedForwarded");
  if (kind === "direct") return t(isPrivateAddress(row?.source) ? "adm.audit.source.private" : "adm.audit.source.public");
  if (!row?.source) return t("adm.audit.source.missing");
  // Records written without `requestSourceAttribution` (the admin routes) carry only the address.
  if (isLoopbackAddress(row.source)) return t("adm.audit.source.loopback");
  return t(isPrivateAddress(row.source) ? "adm.audit.source.private" : "adm.audit.source.public");
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
  if (row?.sourceTrusted) parts.push(t("adm.audit.forwardTrusted", { entry: esc(row.sourceTrustedEntry || "configured") }));
  else if (peer) parts.push(monoValue(peer));
  // The hop values are HTML (monoValue) and already escaped one by one, so only the labels are
  // escaped here — escaping the composed line would print the markup.
  const raw = chain.length
    ? `<span class="muted"> · ${esc(t("adm.audit.forwardRawLabel"))}${chain.map((hop) => monoValue(hop)).join(esc(t("adm.audit.listSeparator")))}${row?.forwardedChainTruncated ? esc(t("adm.audit.forwardTruncated")) : ""}${row?.sourceTrusted ? "" : esc(t("adm.audit.forwardUntrusted"))}</span>`
    : "";
  return `<div style="font-family:var(--font)">${esc(t("adm.audit.forwardChainLabel"))}${parts.join(" ← ")}${raw}</div>`;
}

/** The expanded disclosure body — the prototype's `.uax` lines, on the fields the rows carry. */
function detailLines(ctx, row) {
  const lines = [];
  if (row?.reason) lines.push(`<div style="color:var(--danger);font-family:var(--font)">${esc(t("adm.audit.reasonLabel"))}${esc(row.reason)}</div>`);
  if (row?.detail) lines.push(`<div style="color:var(--tx);font-family:var(--font)">${esc(row.detail)}</div>`);
  lines.push(`${esc(t("adm.audit.metaAction"))} ${monoValue(row?.action || "—")} · ${esc(t("adm.audit.metaOrigin"))} ${esc(row?.origin || "—")} · ${esc(t("adm.audit.metaCredential"))} ${esc(credentialKind(row))}<br>${esc(t("adm.audit.metaUserAgent"))} ${esc(row?.userAgent || "—")}`);
  const tool = toolOf(row);
  if (tool) lines.push(`<div style="font-family:var(--font)">${esc(t("adm.audit.mcpCallLabel"))} ${monoValue(tool)}</div>`);
  const chain = forwardChainLine(row);
  // #285 is no longer planned: `request-attribution.js` records the forwarded chain, the trust
  // decision that produced the adopted source, and the Agent's provenance, so the line renders as
  // what it is. It keeps its own `.uax` line (and the raw hops stay labelled untrusted).
  if (chain) lines.push(`<div>${chain}</div>`);
  const agent = String(row?.agent || "");
  if (agent) {
    const whyKey = AGENT_SOURCE[String(row?.agentSource || "")] || "";
    lines.push(`<div style="font-family:var(--font)">${esc(t("adm.audit.agentSourceLabel"))} ${esc(whyKey ? t(whyKey) : t("adm.audit.agentSourceUnknown"))}</div>`);
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
<td>${failed ? `<span class="st danger"><span class="dot"></span>${esc(t("adm.audit.status.failed"))}</span>` : `<span class="st ok"><span class="dot"></span>${esc(t("adm.audit.status.ok"))}</span>`}</td>
<td><div class="nm"><span class="ell" title="${esc(row?.action || "")}">${esc(action.label)}</span><span class="sub2">${esc(category)}${tool && !action.label.includes(tool) ? ` · <span class="mono ell">${esc(tool)}</span>` : ""}</span></div></td>
<td><div class="nm"><span class="ell">${esc(credentialName(ctx, row))}</span><span class="sub2">${esc(kind)}</span></div></td>
<td><div class="nm"><span class="ell">${esc(row?.agent || "—")}</span><span class="sub2">${esc(AGENT_SOURCE[String(row?.agentSource || "")] ? t(AGENT_SOURCE[String(row?.agentSource || "")]) : "")}</span></div></td>
<td class="cellt"><span class="mono">${esc(row?.source || "—")}</span><div class="muted">${esc(sourceKindText(row))}</div></td>
<td class="act" style="overflow:visible"><details class="ua"><summary aria-label="${esc(t("adm.audit.expand"))}" title="${esc(t("adm.audit.expand"))}">${ic("chev")}</summary><div class="uax" style="position:absolute;left:var(--s3);right:var(--s3);top:100%;z-index:20;text-align:left;white-space:normal;border:1px solid var(--line2);border-radius:var(--r);box-shadow:var(--shadow)">${detailLines(ctx, row)}</div></details></td></tr>`;
}

function cardHtml(ctx, row) {
  const failed = isFailure(row);
  const at = row?.time || row?.at || row?.timestamp || row?.createdAt || null;
  const action = actionLabel(row?.action);
  const tool = toolOf(row);
  const reason = text(row?.reason || row?.detail || "", 160);
  return `<div class="mc ${failed ? "fail" : ""}"><div class="b"><div class="nm"><b>${esc(action.label)}</b><span class="sub2">${esc(credentialName(ctx, row))}</span></div><div class="meta">${failed ? `<span class="st danger"><span class="dot"></span>${esc(t("adm.audit.status.failed"))}</span>` : `<span class="st ok"><span class="dot"></span>${esc(t("adm.audit.status.ok"))}</span>`}<span>${esc(fmt(at))}</span><span class="mono">${esc(row?.source || "—")}</span>${tool ? `<span class="mono">${esc(tool)}</span>` : ""}</div>${reason ? `<span class="help" style="color:var(--danger)">${esc(reason)}</span>` : ""}</div></div>`;
}

function toolbar(filters) {
  const segItems = OUTCOMES.map(([key, labelKey]) => ({ label: t(labelKey), href: auditHref(filters, { outcome: key }), on: filters.outcome === key }));
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
<select class="sel sm" name="action" aria-label="${esc(t("adm.audit.filter.action"))}" title="${esc(t("adm.audit.filter.action"))}">${ACTION_OPTIONS.map(([value, labelKey]) => `<option value="${esc(value)}"${selected(value, filters.action)}>${esc(t(labelKey))}</option>`).join("")}</select>
<select class="sel sm" name="credential" aria-label="${esc(t("adm.audit.filter.credential"))}" title="${esc(t("adm.audit.filter.credential"))}">${CREDENTIAL_OPTIONS.map(([value, labelKey]) => `<option value="${esc(value)}"${selected(value, filters.credential)}>${esc(t(labelKey))}</option>`).join("")}</select>
<input class="inp sm hide-m" name="origin" placeholder="${esc(t("adm.audit.filter.origin"))}" value="${esc(filters.origin)}" style="width:150px" aria-label="${esc(t("adm.audit.filter.origin"))}">
<input class="inp sm hide-m" name="source" placeholder="${esc(t("adm.audit.filter.sourceIp"))}" value="${esc(filters.source)}" style="width:120px" aria-label="${esc(t("adm.audit.filter.sourceIp"))}">
<label class="search">${ic("search")}<input name="q" placeholder="${esc(t("adm.audit.filter.query"))}" value="${esc(filters.q)}" aria-label="${esc(t("adm.audit.filter.query"))}"><kbd>/</kbd></label>
<button class="btn ghost sm" type="submit">${esc(t("adm.audit.filter.apply"))}</button>
${nonDefault ? `<a class="btn ghost sm" href="${AUDIT_BASE}">${esc(t("adm.audit.filter.reset"))}</a>` : ""}</form>`;
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
  const fail = failCount ? ` · <span style="color:var(--danger)">${esc(t("adm.audit.pagerFail", { count: failCount }))}</span>` : "";
  // `filters` is the filter *set* (outcome/action/credential/origin/source/q/pageSize) and does not carry
  // the tab, so the page-size form used to submit `/admin/auth?pageSize=50` with no `tab` and the router
  // fell back to 概览 (#604). The tab is part of the route, so it is written here explicitly.
  const hidden = Object.entries(filters)
    .filter(([key, value]) => key !== "pageSize" && key !== "tab" && value !== "" && value !== null && value !== undefined)
    .map(([key, value]) => `<input type="hidden" name="${esc(key)}" value="${esc(String(value))}">`).join("");
  const hiddenTab = `<input type="hidden" name="tab" value="${esc(TAB)}">`;
  return `<div class="pager"><span>${esc(t("adm.audit.pagerTotal", { count: total }))}${fail}</span><span class="grow"></span><form class="inline-form" method="get" action="/admin/auth">${hiddenTab}${hidden}<label>${esc(t("adm.ui.pagerPerPage"))} <select class="sel sm" name="pageSize" aria-label="${esc(t("adm.ui.pagerPerPageAria"))}" title="${esc(t("adm.ui.pagerPerPageAria"))}">${PAGE_SIZES.map((size) => `<option value="${size}"${Number(size) === Number(pageSize) ? " selected" : ""}>${size}</option>`).join("")}</select></label><button class="btn ghost sm" type="submit">${esc(t("adm.ui.pagerApply"))}</button></form><div class="pg">${parts.join("")}</div></div>`;
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
  // The typed token is a **capability check**, not prose: the page and the server compare the same
  // localized value (both read this request's catalog), so translating it cannot desync the two.
  const confirmToken = t("adm.audit.clearToken");
  const clearTitle = t("adm.audit.clearTitle");
  return `<div class="scrim on"></div><div class="modal show" role="alertdialog" aria-modal="true" aria-label="${esc(clearTitle)}">
<h3>${esc(clearTitle)}</h3>
<p>${t("adm.audit.clearBody", { count: esc(String(audit.length)), failures: esc(String(failures)) })}</p>
<div class="tc">${esc(t("adm.ui.typedConfirmPrefix"))} <code>${esc(confirmToken)}</code> ${esc(t("adm.ui.typedConfirmSuffix"))}</div>
<div class="acts"><a class="btn ghost" href="${AUDIT_BASE}">${esc(t("adm.ui.cancel"))}</a><form method="post" action="/admin/auth/audit/clear" style="display:flex;align-items:center;gap:var(--s2)"><input type="hidden" name="csrf" value="${esc(ctx.csrf || "")}"><input class="inp" name="confirm" autocomplete="off" aria-label="${esc(t("adm.ui.typedConfirmAria"))}" placeholder="${esc(confirmToken)}" required pattern="${esc(confirmToken)}" title="${esc(t("adm.audit.clearTokenTitle", { token: confirmToken }))}"><button class="btn danger" type="submit">${esc(confirmToken)}</button></form></div>
</div>`;
}

/**
 * CSV export (`GET /admin/auth/audit/export.csv`).
 *
 * The prototype draws 导出 CSV as a planned control; the data for it already exists, so it is a real
 * download now. Three things a CSV built from audit rows must get right:
 *   * RFC 4180 quoting — `"` doubles, and a field containing `,` `"` CR or LF is quoted;
 *   * spreadsheet formula injection — a value starting with `= + - @` (or a tab/CR) is prefixed with
 *     `'` so Excel/Sheets never evaluates an attacker-controlled user agent or path;
 *   * a UTF-8 BOM and CRLF endings, which is what the tool that opens it expects.
 * Filters are the *same* GET parameters the page uses (`readFilters` + `matches`), so an export is
 * exactly the view the operator is looking at — never a silent "everything".
 */
const CSV_FORMULA = /^[=+\-@\t\r]/;

function csvField(value) {
  let text = String(value ?? "");
  if (CSV_FORMULA.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvStamp(now = Date.now()) {
  const iso = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return iso;
}

/** The filtered audit rows as CSV text. `filename` is offered as the download name. */
export function auditCsv(ctx, query = {}) {
  const filters = readFilters(query);
  const audit = Array.isArray(ctx?.snapshot?.audit) ? ctx.snapshot.audit : [];
  const rows = audit.filter((row) => matches(ctx, row, filters));
  const header = [
    t("adm.audit.column.time"), "ISO", t("adm.audit.column.result"), t("adm.audit.column.action"),
    t("adm.audit.column.credential"), t("adm.audit.csv.credentialId"), t("adm.audit.column.agent"), t("adm.audit.column.source"),
    t("adm.audit.csv.reason"), t("adm.audit.csv.detail"), t("adm.audit.csv.origin"), t("adm.audit.csv.userAgent"),
  ];
  const lines = [header.map(csvField).join(",")];
  for (const row of rows) {
    lines.push([
      fmtFull(row?.at ?? row?.time ?? null),
      String(row?.at ?? row?.time ?? ""),
      isFailure(row) ? t("adm.audit.outcome.failure") : t("adm.audit.outcome.success"),
      `${actionLabel(row?.action).label} (${String(row?.action || "")})`,
      `${credentialKind(row)} (${String(row?.credentialType || "")})`,
      String(row?.credentialId || ""),
      String(row?.agent || ""),
      String(row?.source || ""),
      String(row?.reason || ""),
      String(row?.detail || ""),
      String(row?.origin || ""),
      String(row?.userAgent || ""),
    ].map(csvField).join(","));
  }
  // BOM + CRLF: what Excel and LibreOffice expect from a UTF-8 CSV.
  return { body: `\ufeff${lines.join("\r\n")}\r\n`, count: rows.length, filename: `audit-${csvStamp()}.csv` };
}

/** The list URL for the current filter view — the base every sort link is built from. */
function auditBaseQuery(filters) {
  const params = new URLSearchParams({ tab: "audit" });
  for (const key of ["outcome", "action", "credential", "origin", "source", "q"]) {
    const value = String(filters[key] ?? "");
    if (value) params.set(key, value);
  }
  return `/admin/auth?${params.toString()}`;
}

/** Export href for the current filter view (page/pageSize belong to the page, not the file). */
function exportHref(filters) {
  const params = new URLSearchParams();
  for (const key of ["outcome", "action", "credential", "origin", "source", "q"]) {
    const value = String(filters[key] ?? "");
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return `/admin/auth/audit/export.csv${query ? `?${query}` : ""}`;
}

export function renderAuditPage(ctx) {  const query = ctx.query || {};
  const filters = readFilters(query);
  // Prototype `S.focus` (`6-app.js` `parseHash`): the record a 最近失败 link points at. It does not
  // filter the list, it marks the row (`rowHtml` adds `.cur`).
  const focus = query.focus ? String(query.focus) : null;
  const audit = Array.isArray(ctx.snapshot?.audit) ? ctx.snapshot.audit : [];
  // Sorting is server state (`table-sort.js`). With no column chosen the page keeps its own order
  // (newest first), which is what an audit log is for; a header click takes over from there.
  const sort = readSort(query, ["time", "result", "action", "credential", "agent", "source"], null);
  const matched = audit.filter((row) => matches(ctx, row, filters));
  const listed = sort.key
    ? sortRows(matched, sort, {
      time: (row) => row?.at ?? row?.time ?? null,
      result: (row) => (isFailure(row) ? 1 : 0),
      action: (row) => (typeof row?.action === "string" ? row.action : null),
      credential: (row) => `${row?.credentialType || ""}:${row?.credentialId || ""}`,
      agent: (row) => row?.agent ?? null,
      source: (row) => row?.source ?? null,
    })
    : matched;
  const failCount = listed.filter(isFailure).length;
  const pages = Math.max(1, Math.ceil(listed.length / filters.pageSize));
  const page = Math.min(pages, Math.max(1, Number.parseInt(query.page, 10) || 1));
  const slice = listed.slice((page - 1) * filters.pageSize, page * filters.pageSize);

  // Prototype draws 导出 CSV as planned; the records are there, so this is a real download now.
  const exportLink = `<a class="btn ghost sm" href="${esc(exportHref(filters))}" title="${esc(t("adm.audit.exportTitle"))}" download>${ic("file")}<span class="hide-m">${esc(t("adm.audit.exportCsv"))}</span></a>`;
  const actions = `${exportLink}${moreMenu([{ href: `${AUDIT_BASE}&confirm=clear`, label: t("adm.audit.clearMenu"), icon: "trash", danger: true }])}`;

  const content = `${pageBar({ title: t("adm.nav.audit"), actions })}<div class="content scroll"><div class="page wide">
${toolbar(filters)}
${table([[t("adm.audit.column.time"), "92px", "", "time"], [t("adm.audit.column.result"), "76px", "", "result"], [t("adm.audit.column.action"), "22%", "", "action"], [t("adm.audit.column.credential"), "22%", "", "credential"], [t("adm.audit.column.agent"), "15%", "", "agent"], [t("adm.audit.column.source"), "13%", "", "source"], ["", "", "act"]], slice.map((row) => rowHtml({ ...ctx, focus }, row)), emptyState("filter", t("adm.audit.emptyTitle"), t("adm.audit.emptyHint"), `<a class="btn" href="${AUDIT_BASE}">${esc(t("adm.audit.emptyReset"))}</a>`), { ...sort, base: auditBaseQuery(filters) })}${mcards(slice.map((row) => cardHtml(ctx, row)))}
${listed.length ? pagerRow(listed.length, failCount, page, filters.pageSize, filters) : ""}
</div></div>`;
  const detailPanel = String(query.confirm || "") === "clear" ? clearConfirm(ctx) : "";
  return { content, detailPanel };
}
