// Auth Center "Vault 与 Git" tab renderer for the MCP multi-Vault track, Wave E / E1.
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//  - §17    Admin UX: the per-Vault display list, the page label and the module shape;
//  - §17.1  Admin action boundary: no repo creation, no credential editing, never a
//           credential-bearing remote URL in the markup;
//  - §17.2  reuse the existing Admin session + CSRF, add no lower-protected endpoint;
//  - §16.2  the five Git states (`GIT_RUNTIME_STATES`);
//  - §15.1/§15.2/§15.4  config fields, hard bounds and the `configSource` tokens;
//  - §3.4   capabilities are runtime facts and must show `available:false + reason`;
//  - §42 SEC-MV03 / SEC-MV04  metadata minimization and no secrets in the output.
//
// Pure renderer: a plain view-model in, an HTML fragment string out. No DOM, no
// runtime, no policy evaluation, no I/O, no framework import, no submit/fetch
// logic. The Admin plane is never gated here, so a broken policy cannot lock the
// operator out of the repair surface (same guarantee as `access-policy-view.js`).
//
// Whitelist rendering (SEC-MV04, §17.1): every value is read by an explicit field
// name and HTML-escaped. The model is never spread, `Object.keys`-walked, mapped
// over or serialized into the output, so an unknown field (an API key, an auth
// header, a connection string with embedded userinfo) has no render path and
// cannot reach the markup. Rendered strings additionally pass through
// `scrubCredentials` (the project's single credential scrubber, issue #255) plus a
// scheme-less `user:pass@` guard, so a 凭据-shaped value smuggled into a rendered
// name (remote/branch/root/summary) is masked instead of printed.
//
// Styling uses the existing Auth Center classes only; no external script, font or
// stylesheet is referenced.

import { GIT_CONFIG_SOURCES } from "../git-config/schema.js";
import { GIT_RUNTIME_STATES } from "../git-runtime/support.js";
import {
  VAULT_LIST_HEADERS,
  gitStatePill,
  syncTags,
  vaultRowMenu,
  vaultIdentityCell,
  capabilitySummary,
  vaultScanFut,
  vaultGithubAddFut,
} from "./admin-v2/pages/vaults.js";
import { renderDetailPanel, panelKv, panelSection, closeTabHref } from "./admin-v2/detail-panel.js";
import { scrubCredentials } from "../git-push-observability.js";
import { capabilityHint, capabilityStateLabel, capabilityLabel } from "./capability-labels.js";
import { configForm, verifyForm } from "./vault-git-config-form.js";
import { renderVaultAdmission } from "./vault-admission-view.js";
import { escapeHtml } from "./admin-html.js";

// The escape helper and the form renderers moved into their own modules (#404) so this
// view stays inside the line budget; the import path of `escapeHtml` is unchanged.
export { escapeHtml };

/**
 * POST endpoints rendered into the forms. Wave E / E2 owns the routes and passes
 * the authoritative URLs through `actions`; these defaults mirror the frozen route
 * names. An action left empty/null drops its form instead of rendering a dead
 * control.
 *
 * `repair` intentionally defaults to `null`: Wave E / E1 invents no recovery route
 * (it would be an unowned, lower-protected endpoint — §17.2).
 */
export const DEFAULT_ACTIONS = Object.freeze({
  base: "/admin/auth/vault-git",
  save: "/admin/vaults/git/save",
  refresh: "/admin/vaults/git/refresh",
  verify: "/admin/vaults/git/verify",
  repair: null,
});

/** Cap on rendered pending paths so one huge batch cannot blow up the fragment. */
export const MAX_RENDERED_PENDING_PATHS = 20;

/**
 * #401: "summary vs detail" split. The summary table carries only the columns an
 * operator scans; the pending batch (paths/authors/since), the last sweep and the
 * last push outcome live in the per-Vault detail card below, where they already had
 * their own rows. Nothing was dropped - the three long columns moved.
 */
export const SUMMARY_COLUMNS = VAULT_LIST_HEADERS;

const SCHEME_LESS_USERINFO = /(^|[^A-Za-z0-9._%+-])([A-Za-z0-9._%+-]{1,64}):([^/@\s]+)@/g;
// Diagnostic free text (a git stderr summary, a capability reason) can name the
// credential concept without carrying a value — "could not read password for".
// §17.1/SEC-MV04 want neither the value nor the field name in the markup, so the
// bare keyword is masked too. Only dynamic values pass through here; the static
// template deliberately contains none of these words.
const CREDENTIAL_KEYWORD = /\b(?:pass(?:word|wd|phrase)?|token|secret|authorization|bearer|api[_-]?key)\b/gi;

/** Credential-masked, whitespace-clipped plain text. */
function scrubbed(value) {
  return scrubCredentials(value)
    .replace(SCHEME_LESS_USERINFO, (match, lead, user) => `${lead}${user}:***@`)
    .replace(CREDENTIAL_KEYWORD, "***");
}

/** Escape + credential mask: the only path from a model string to the markup. */
function text(value) {
  return escapeHtml(scrubbed(value));
}

function shown(value) {
  return value !== null && value !== undefined && String(value) !== "";
}

function dash() {
  return '<span class="muted">—</span>';
}

function maybe(value, renderer) {
  return shown(value) ? renderer(value) : dash();
}

/** `true`/`false`/absent as an explicit on/off fact (never a bare blank cell). */
function booleanFact(value) {
  if (value === true) return '<span class="ok">开启</span>';
  if (value === false) return '<span class="muted">关闭</span>';
  return dash();
}

const GIT_STATE_LABELS = Object.freeze({
  [GIT_RUNTIME_STATES.DISABLED]: "未启用",
  [GIT_RUNTIME_STATES.READY]: "已就绪",
  [GIT_RUNTIME_STATES.REPOSITORY_MISSING]: "未初始化 Git 仓库",
  [GIT_RUNTIME_STATES.CONFIG_INVALID]: "配置无效",
  [GIT_RUNTIME_STATES.PUSH_FAILING]: "推送失败",
});

const GIT_STATE_TONES = Object.freeze({
  [GIT_RUNTIME_STATES.DISABLED]: "muted",
  [GIT_RUNTIME_STATES.READY]: "ok",
  [GIT_RUNTIME_STATES.REPOSITORY_MISSING]: "bad",
  [GIT_RUNTIME_STATES.CONFIG_INVALID]: "bad",
  [GIT_RUNTIME_STATES.PUSH_FAILING]: "bad",
});

/** Canonical §16.2 state token, or "" when the model has no usable state. */
export function gitStateToken(git) {
  const value = git?.state;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
}

function gitStateBadge(git) {
  const token = gitStateToken(git);
  const label = GIT_STATE_LABELS[token] ?? (token ? `未知状态（${token}）` : "未知状态");
  const tone = GIT_STATE_TONES[token] ?? "bad";
  // Chinese primary; raw §16.2 token kept for tests/search (technical secondary).
  const tokenHint = token ? ` <span class="mono muted">${text(token)}</span>` : "";
  return `<span class="badge ${tone}" data-git-state="${text(token)}" title="${text(label)}">${text(label)}${tokenHint}</span>`;
}

// #401: the long Chinese explanation used to be the badge *text*, inside a 66px
// column, which stacked it into six lines. The badge now shows the canonical token
// (one line, bounded) and the explanation that used to be the label moved into
// `title`, so no operator-facing wording was lost.
const CONFIG_SOURCE_LABELS = Object.freeze({
  [GIT_CONFIG_SOURCES.ENV_DEFAULT]: "env-default（继承 GIT_* 环境默认）",
  [GIT_CONFIG_SOURCES.PERSISTED]: "persisted（Admin 已保存）",
  [GIT_CONFIG_SOURCES.DEFAULT_DISABLED]: "default-disabled（默认关闭）",
});

function configSourceBadge(git) {
  const source = typeof git?.configSource === "string" ? git.configSource.trim() : "";
  if (source === "") return dash();
  const label = CONFIG_SOURCE_LABELS[source] ?? `未知来源（${source}）`;
  return `<span class="badge" data-config-source="${text(source)}" title="${text(label)}">${text(label)}</span>`;
}

function cell(label, content, attrs = "") {
  return `<td data-label="${escapeHtml(label)}"${attrs ? ` ${attrs}` : ""}>${content}</td>`;
}

function kvRow(label, content) {
  return `<tr><th scope="row" class="keep">${escapeHtml(label)}</th><td>${content}</td></tr>`;
}

function roleBadge(vault) {
  const primary = vault?.primary === true;
  const role = primary
    ? '<span class="badge ok" data-vault-role="primary">主库</span>'
    : '<span class="badge" data-vault-role="secondary">附加</span>';
  const writable = vault?.writable === true ? "可写" : "只读";
  return `${role} <span class="muted">${writable}</span>`;
}

/** `[{ key, available, reason }]`; a plain string entry means "available". */
function capabilityItems(vault) {
  const raw = vault?.capabilities;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    if (typeof entry === "string") return { key: entry, available: true, reason: null };
    if (!entry || typeof entry !== "object") return null;
    return {
      key: typeof entry.key === "string" ? entry.key : "",
      available: entry.available === true,
      reason: typeof entry.reason === "string" ? entry.reason : null,
    };
  }).filter((item) => item && item.key !== "");
}

/**
 * #402: a capability badge is `<中文名> · 可用/不可用` and stays one bounded line. The
 * upstream reason (an implementer decision record - `src/vault-runtime/capabilities.js`
 * `UNWIRED_CAPABILITY_DECISIONS`, which this view never edits) is *not* dropped: the
 * operator-facing Chinese hint is visible and the untouched reason stays in the DOM behind
 * a closed `<details>`. An unmapped key falls back to `<key> · 不可用`, never to the prose,
 * so a future unwired capability cannot re-introduce a 907px badge.
 */
function capabilityHtml(vault) {
  const items = capabilityItems(vault);
  if (items.length === 0) return dash();
  const badges = items.map((item) => `<span class="badge ${item.available ? "ok" : "bad"}" data-capability="${text(item.key)}" title="${text(`${item.key} · ${item.available ? "可用" : "不可用"}`)}">${text(capabilityStateLabel(item.key, item.available))}</span>`).join("");
  const unavailable = items.filter((item) => !item.available);
  const hints = unavailable.map((item) => {
    const name = capabilityLabel(item.key) ?? item.key;
    return `<p class="cap-hint">${text(name)}：${text(capabilityHint(item.key))}</p>`;
  }).join("");
  const details = unavailable.map((item) => `<details class="cap-detail"><summary>技术细节：<code>${text(item.key)}</code></summary><code>${shown(item.reason) ? text(item.reason) : "未说明原因"}</code></details>`).join("");
  return `<div class="checks">${badges}</div>${hints}${details}`;
}

function pendingCount(git) {
  const explicit = git?.pending?.count;
  if (Number.isInteger(explicit) && explicit >= 0) return explicit;
  const paths = git?.pending?.paths;
  return Array.isArray(paths) ? paths.length : null;
}

/**
 * #400: `pending.authors` is a list of structured facts (`{agent, model}` — see
 * `git-runtime/pending.js`), not display strings, so the former `text(author)`
 * path printed `[object Object]`. A legacy string element still renders verbatim
 * and an object without a usable field degrades to an explicit placeholder.
 */
function authorLabel(author) {
  if (typeof author === "string") return text(author);
  if (!author || typeof author !== "object" || Array.isArray(author)) return text("未知");
  const agent = typeof author.agent === "string" ? author.agent.trim() : "";
  const model = typeof author.model === "string" ? author.model.trim() : "";
  return text([agent, model].filter(Boolean).join(" / ") || "未知");
}

/**
 * #401/#404: the pending facts are plain text plus a bounded `<details>` path list.
 * The former `<div class="field">` made a zero-pending row look like an empty input
 * box, and the paths were space-joined `<code>` runs that read as one 13-line blob.
 * Both render sites (detail card; the summary used to reuse it too) share this.
 */
function pendingHtml(git) {
  const count = pendingCount(git);
  const paths = Array.isArray(git?.pending?.paths) ? git.pending.paths : [];
  const dirty = git?.dirty;
  const dirtyFact = dirty === true ? '<span class="bad">有未提交改动</span>' : dirty === false ? '<span class="ok">干净</span>' : dash();
  const parts = [`<span class="badge${count === 0 ? " ok" : ""}" data-pending-count="${text(count ?? "")}">${count === null ? "待提交 —" : `待提交 ${escapeHtml(String(count))}`}</span>`, dirtyFact];
  const since = git?.pending?.since;
  const authors = Array.isArray(git?.pending?.authors) ? git.pending.authors : [];
  if (shown(since)) parts.push(`<span class="muted">最早待提交 <code class="keep">${text(since)}</code></span>`);
  if (authors.length > 0) parts.push(`<span class="muted">作者 ${authors.map(authorLabel).join(" / ")}</span>`);
  if (paths.length === 0) return `<div class="facts">${parts.join(" ")}</div>`;
  const shownPaths = paths.slice(0, MAX_RENDERED_PENDING_PATHS);
  const more = paths.length > shownPaths.length ? ` <span class="muted">…（共 ${escapeHtml(String(paths.length))} 条）</span>` : "";
  return `<div class="facts">${parts.join(" ")}</div><details class="pending-paths"><summary>待提交路径（${escapeHtml(String(paths.length))}）</summary><ul>${shownPaths.map((item) => `<li><code class="breakable">${text(item)}</code></li>`).join("")}</ul>${more}</details>`;
}

function sweepHtml(git) {
  const sweep = git?.lastSweep;
  if (!sweep || typeof sweep !== "object") return dash();
  const facts = [maybe(sweep.at, (value) => `<code class="keep">${text(value)}</code>`)];
  facts.push(sweep.committed === true ? '<span class="ok">已提交</span>' : sweep.committed === false ? '<span class="muted">无改动</span>' : dash());
  if (shown(sweep.hash)) facts.push(`<code class="breakable">${text(sweep.hash)}</code>`);
  if (shown(sweep.pushed)) facts.push(sweep.pushed === true ? '<span class="ok">已推送</span>' : '<span class="bad">未推送</span>');
  if (shown(sweep.reason)) facts.push(`<span class="muted">${text(sweep.reason)}</span>`);
  return facts.join(" ");
}

/** Push observability (#255 / §16): last outcome plus the consecutive failure count. */
function pushHtml(git) {
  const failures = Number.isInteger(git?.push?.consecutiveFailures) ? git.push.consecutiveFailures : null;
  const outcome = git?.push?.lastOutcome;
  const countBadge = `<span class="badge ${failures && failures > 0 ? "bad" : ""}" data-consecutive-failures="${text(failures ?? "")}">连续失败 ${failures === null ? "—" : escapeHtml(String(failures))}</span>`;
  if (!outcome || typeof outcome !== "object") return `${countBadge} ${dash()}`;
  const facts = [outcome.pushed === true ? '<span class="ok">已推送</span>' : '<span class="bad">推送未成功</span>'];
  if (shown(outcome.failureClass)) facts.push(`<span class="badge bad">${text(outcome.failureClass)}</span>`);
  if (shown(outcome.remote)) facts.push(`<code class="keep">${text(outcome.remote)}</code>`);
  if (shown(outcome.branch)) facts.push(`<code class="keep">${text(outcome.branch)}</code>`);
  if (outcome.exitCode !== null && outcome.exitCode !== undefined) facts.push(`<span class="muted">exit ${text(outcome.exitCode)}</span>`);
  if (shown(outcome.at)) facts.push(`<span class="muted">${text(outcome.at)}</span>`);
  if (shown(outcome.summary)) facts.push(`<span class="breakable">${text(outcome.summary)}</span>`);
  return `${countBadge} ${facts.join(" ")}`;
}

function timersHtml(git) {
  const timers = git?.timers;
  if (!timers || typeof timers !== "object") return dash();
  const parts = [["commit", "提交防抖"], ["maxDelay", "最大延迟"], ["sweep", "周期 sweep"]]
    .map(([key, label]) => `<span class="badge ${timers[key] === true ? "ok" : ""}">${escapeHtml(label)}${timers[key] === true ? " · 已装载" : " · 未装载"}</span>`);
  return parts.join(" ");
}

function sweepToggleCell(config) {
  const enabled = booleanFact(config?.autoCommitSweep);
  const interval = config?.sweepIntervalSeconds;
  const seconds = Number.isInteger(interval) ? `${interval}s` : "—";
  return `${enabled} <span class="muted">${escapeHtml(seconds)}</span>`;
}

function remoteCell(config) {
  const remote = maybe(config?.remote, (value) => `<code class="keep">${text(value)}</code>`);
  const branch = maybe(config?.branch, (value) => `<code class="keep">${text(value)}</code>`);
  return `${remote} / ${branch}`;
}

function vaultRow(vault, { selectedId = null, base = DEFAULT_ACTIONS.base } = {}) {
  const git = vault?.git ?? {};
  const config = git.config ?? {};
  const id = vault?.id;
  const cur = selectedId && String(selectedId) === String(id) ? " cur" : "";
  const isPrimary = vault?.primary === true;
  return `<tr class="${cur.trim()}" data-vault-role="${isPrimary ? "primary" : "secondary"}">`
    + cell("Vault", vaultIdentityCell(vault, text), 'class="identity col-vault"')
    + cell("Git 状态", gitStateBadge(git), 'class="col-state"')
    + cell("同步方式", syncTags(config), 'class="keep col-config"')
    + cell("远端 / 分支", remoteCell(config), 'class="col-remote"')
    + cell("能力", capabilitySummary(vault), 'class="keep"')
    + cell("操作", vaultRowMenu({ vaultId: id, base }), 'class="col-actions"')
    + "</tr>";
}

function vaultTable(vaults, { selectedId = null, base = DEFAULT_ACTIONS.base } = {}) {
  const headers = SUMMARY_COLUMNS;
  const rows = vaults.map((vault) => vaultRow(vault, { selectedId, base })).join("");
  return `<div class="scroll"><table class="data-table"><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="muted">还没有 Vault</td></tr>`}</tbody></table></div>`;
}

function configErrorHtml(git) {
  const error = git?.configError;
  if (!error || typeof error !== "object") return dash();
  const name = shown(error.name) ? text(error.name) : "配置读取失败";
  const message = shown(error.message) ? `：${text(error.message)}` : "";
  return `<span class="bad">${name}${message}</span>`;
}

function vaultDetail({ vault, urls, csrf, revision, defaultVaultId, forceClosed = false }) {
  const git = vault?.git ?? {};
  const config = git.config ?? {};
  const isPrimary = vault?.primary === true;
  const open = forceClosed ? "" : (isPrimary || vault?.id === defaultVaultId ? " open" : "");
  return `<details class="card" id="vault-${text(vault?.id)}"${open} data-vault-id="${text(vault?.id)}" data-vault-role="${isPrimary ? "primary" : "secondary"}">
<summary>${roleBadge(vault)} <strong class="label-keep">${shown(vault?.name) ? text(vault.name) : text(vault?.id)}</strong> <code class="breakable">${text(vault?.id)}</code> ${gitStateBadge(git)} ${configSourceBadge(git)}</summary>
<div class="create-body">
<table class="data-table"><tbody>
${kvRow("id", `<code class="breakable">${text(vault?.id)}</code>`)}
${kvRow("name", shown(vault?.name) ? text(vault.name) : dash())}
${kvRow("角色", roleBadge(vault))}
${kvRow("root（仅 Admin 平面）", maybe(vault?.root, (value) => `<code class="breakable">${text(value)}</code>`))}
${kvRow("canonicalRoot", maybe(vault?.canonicalRoot, (value) => `<code class="breakable">${text(value)}</code>`))}
${kvRow("capability", capabilityHtml(vault))}
${kvRow("repository", maybe(git.repository, (value) => `<code class="keep">${text(value)}</code>`))}
${kvRow("configError", configErrorHtml(git))}
${kvRow("timers", timersHtml(git))}
${kvRow("待提交 / dirty", pendingHtml(git))}
${kvRow("最近 sweep", sweepHtml(git))}
${kvRow("最近 push", pushHtml(git))}
${kvRow("配置来源", configSourceBadge(git))}
${kvRow("updatedAt", maybe(config?.updatedAt, (value) => `<code class="keep">${text(value)}</code>`))}
</tbody></table>
<h3 class="section-sub">Git 同步设置</h3>
<p class="page-lede">保存走既有 CSRF + expectedRevision；本页不创建 repo，也不接受含凭据的远端地址。</p>
${configForm({ vault, config, urls, csrf, revision, text })}
${verifyForm({ vault, urls, csrf, text })}
</div>
</details>`;
}

function noticeHtml(notice) {
  if (!notice) return "";
  const message = typeof notice === "string" ? notice : notice?.message;
  if (!shown(message)) return "";
  const kind = typeof notice === "object" && notice.kind === "ok" ? " flash" : "";
  return `<div class="notice${kind}">${text(message)}</div>`;
}

function brokenHtml(broken, urls, csrf, revision, { confirmRepair = false } = {}) {
  if (!broken) return "";
  const code = typeof broken === "object" ? (broken.errorCode ?? broken.code ?? null) : null;
  if (!urls.repair) {
    return `<section class="card" id="vault-git-broken"><h2>Git 配置存储不可用</h2>
<p class="bad">当前按库 Git 配置无法可信读取${shown(code) ? `（${text(code)}）` : ""}。保存已 fail closed。ADM-092：无通用网页 repair；请按排查说明处理。</p>
<p class="muted">修复前只读展示 registry 与运行时事实。</p></section>`;
  }
  // Typed-confirm form when repair is wired (proto W6.7).
  void confirmRepair;
  return `<section class="card" id="vault-git-broken"><h2>Git 配置存储不可用</h2>
<p class="bad">当前按库 Git 配置无法可信读取${shown(code) ? `（${text(code)}）` : ""}。保存已 fail closed，避免覆盖他人修改；Vault 内容能力不受影响。</p>
<p>请输入 <code>重置</code> 确认后提交。</p>
<form class="form-grid" method="post" action="${escapeHtml(urls.repair)}">${csrf}
${revision === null || revision === undefined ? "" : `<input type="hidden" name="expectedRevision" value="${text(revision)}">`}
<label>确认词<input class="field" name="confirmName" placeholder="重置" required pattern="重置"></label>
<button class="btn danger" type="submit">确认重置</button></form>
<p class="muted">修复前只读展示 registry 与运行时事实。</p></section>`;
}

function refreshForm(urls, csrf) {
  if (!urls.refresh) return "";
  return `<form class="inline" method="post" action="${escapeHtml(urls.refresh)}">${csrf}<button class="btn secondary" type="submit">刷新 Vault 清单</button></form>`;
}

/**
 * Render the Auth Center "Vault 与 Git" tab fragment.
 *
 * View-model (frozen for Wave E / E2 — only these fields are read):
 *   vaults[]: id, name, primary, writable, root, canonicalRoot, editable,
 *             capabilities[] ({key, available, reason}), git:
 *             { state, repository, configSource, configError {name,message},
 *               config {enabled, autoCommit, autoPush, autoCommitSweep,
 *                       debounceSeconds, maxDelaySeconds, sweepIntervalSeconds,
 *                       remote, branch, updatedAt},
 *               pending {count, paths[], authors[], since}, dirty,
 *               timers {commit, maxDelay, sweep}, lastSweep {at, committed, hash,
 *               reason, pushed}, push {lastOutcome {at, pushed, failureClass,
 *               remote, branch, exitCode, summary, consecutiveFailures},
 *               consecutiveFailures} }
 *   revision, status, broken, defaultVaultId, notice, csrfToken, actions {save,
 *   refresh, verify, repair}.
 *
 * `csrfToken` is the one value rendered verbatim (escaped, but not keyword-masked):
 * it is the caller's hidden field and the form is only valid when it round-trips
 * unchanged. Same exception as `access-policy-view.js`.
 *
 * @param {object} model
 * @returns {string} HTML fragment
 */

function vaultTimersLine(git) {
  const config = git?.config ?? {};
  const sweepOn = config?.autoCommitSweep === true;
  const interval = Number(config?.sweepIntervalSeconds);
  if (!sweepOn) return `<span class="muted">定时任务兜底未启用</span>`;
  const mins = Number.isFinite(interval) && interval > 0 ? Math.round(interval / 60) : null;
  return mins ? `定时任务兜底：每 ${escapeHtml(String(mins))} 分钟` : "定时任务兜底：已启用";
}

function vaultOptionBPanel({ vault, urls, csrf, revision, closeHref }) {
  if (!vault) return "";
  const git = vault?.git ?? {};
  const config = git.config ?? {};
  const rootPath = shown(vault?.root) ? `<code class="breakable">${text(vault.root)}</code>` : dash();
  const statusKv = panelKv([
    ["Vault", vaultIdentityCell(vault, text)],
    ["Git 仓库", gitStateBadge(git)],
    ["目录", rootPath],
    ["配置来源", configSourceBadge(git)],
    ["定时任务", vaultTimersLine(git)],
    ["待提交", pendingHtml(git)],
    ["最近推送", pushHtml(git)],
  ]);
  const body = [
    panelSection("状态", statusKv),
    panelSection("Git 设置", `${configForm({ vault, config, urls, csrf, revision, text })}${verifyForm({ vault, urls, csrf, text })}`),
    panelSection("能力", capabilityHtml(vault)),
    panelSection("规划中", `<span class="muted">运行时能力扫描</span> ${vaultScanFut()}`),
  ].join("");
  return renderDetailPanel({
    title: shown(vault?.name) ? String(vault.name) : String(vault?.id || "Vault"),
    tagsHtml: roleBadge(vault),
    bodyHtml: body,
    closeHref,
  });
}

export function renderVaultGitTab({
  vaults = [],
  revision = null,
  status = "ready",
  broken = null,
  defaultVaultId = null,
  notice = null,
  csrfToken = "",
  actions = {},
  admission = null,
  selectedId = null,
  confirmRepair = false,
} = {}) {
  const urls = { ...DEFAULT_ACTIONS, ...(actions ?? {}) };
  const csrf = `<input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">`;
  const list = Array.isArray(vaults) ? vaults : [];
  const selected = selectedId ? list.find((vault) => String(vault?.id) === String(selectedId)) : null;
  const closeHref = `${urls.base || DEFAULT_ACTIONS.base}`;
  const header = `<div class="section-head"><h2>Vault 与 Git</h2><span class="muted">按库展示 registry 事实、Git 运行时状态与配置来源。root、canonicalRoot 与 remote/branch 名称仅在本 Admin 平面可见，不对 MCP / Web 暴露；本页不创建 repo，也不接受含凭据的远端地址。</span><div class="actions">${refreshForm(urls, csrf)}${vaultScanFut()}</div></div>`;
  const panel = selected
    ? vaultOptionBPanel({ vault: selected, urls, csrf, revision, closeHref })
    : "";
  // V2: do not default-expand registry cards; still emit collapsed <details> so save/verify
  // forms remain in the document for CSRF/revision CAS (tests + no-JS progressive disclosure).
  const details = selected
    ? ""
    : list.map((vault) => vaultDetail({ vault, urls, csrf, revision, defaultVaultId: null, forceClosed: true })).join("");
  return `<section class="card" id="vault-git">${header}
${noticeHtml(notice)}
${renderVaultAdmission({ vaults: list, admission, base: urls.base, csrf, text: escapeHtml })}
${brokenHtml(broken ?? (status === "broken"), urls, csrf, revision, { confirmRepair })}
<div class="split-list">${vaultTable(list, { selectedId, base: urls.base })}${panel}</div>
${details}
${vaultGithubAddFut()}
<p class="muted help">保存时携带版本号；若他人已先保存，本次会提示冲突而不覆盖。</p>
</section>`;
}
