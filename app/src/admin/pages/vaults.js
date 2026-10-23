// Vault 与 Git page — SSR port of the prototype page for lane W4-vaults.
//
// Authority (docs/admin/README.md truth-source order):
//   * UI/markup — `docs/admin-ui-proto/src/5-render.js:456-473` (list + page header + empty state +
//     GitHub-backed futbox) and `docs/admin-ui-proto/src/6-app.js:219-362` (the Vault drawer:
//     状态 kv / Git 同步设置 / 能力 / 规划中「运行时」), class names taken verbatim from
//     `src/1-head.html`; `src/4-data.js` supplies the vocabulary (CAP_LABELS / gitState).
//   * Behaviour — the real services: `vault-git-routes.js` `createVaultGitAdmin().model()` (registry
//     descriptor × GitConfig store × GitRuntime), the A5 record schema and the A6 runtime states.
//   * `docs/admin-ui-proto/README.md`「功能对照表 → Vault 与 Git」: every existing capability is
//     kept, in the prototype's own positions (see the mapping comment above each render helper).
//
// Hard rules kept here:
//   * No script (CSP `default-src 'none'`): the drawer is opened by `?id=`, the row menu is a
//     `<details>`, every switch/danger action is a real POST form, and results render as `.result`.
//   * Data comes from the model only; a fact the service does not provide renders as `—` / 未提供,
//     never as `0` / `正常`. A vault whose runtime threw renders without runtime facts.
//   * Planned features keep the dashed marker (`fut()`) and get no fake CTA.
//   * The Admin plane never creates a repo, never edits credentials and never accepts a
//     credential-bearing remote URL; `root`/`remote`/`branch` stay Admin-plane facts.
//   * `状态` (list row + mobile card + drawer) is the prototype's `gitState()`: a non-empty pending
//     batch replaces the clean pill with `<N> 个待提交` (`5-render.js:169`), i.e. the pending reading
//     is visible on the list surface and not only inside the drawer (#400/#435: the browser gate
//     reads the count off the list page). The batch's author chain stays a real fact
//     (`authorText`), never a stringified object.
//   * The `?confirm=repair` page is `ui.confirmPage` again: the type-to-confirm input must live
//     inside the `<form>` and the submit must stay enabled, so a scriptless POST carries the text
//     the server compares. The check itself stays server-side.
import { banner, confirmPage, emptyState, esc, fut, ic, mcards, moreMenu, pageBar, postForm, result, table } from "../ui.js";
import { relTitle } from "../presentation/format.js";
import { admissionConfirmChoices } from "../vault-admission-view.js";
import { capabilityHint, capabilityLabel } from "../capability-labels.js";
import { GIT_CONFIG_LIMITS } from "../../git-config/schema.js";
import { scrubCredentials } from "../../git-push-observability.js";

/** Summary columns — `5-render.js:458`. `配置来源` moved into the drawer (#461/#401); the vault's role
 *  is the prototype's header badge (主库) plus the exception badge (只读), not a `角色` kv row:
 *  `scripts/proto-parity/compare.mjs` compares the drawer's kv set in *both* directions. */
export const VAULT_COLUMNS = Object.freeze([
  ["Vault", "20%"],
  ["Git 状态", "24%"],
  ["同步方式", "26%"],
  ["远端 / 分支", "14%"],
  ["能力", "10%"],
  ["", "", "act"],
]);

/** `6-app.js:219` drawer switches — label, record key, prototype help text, immediate-POST key. */
export const SETTING_SWITCHES = Object.freeze([
  ["enabled", "为此 Vault 启用 Git", "关闭后不再自动提交或推送"],
  ["autoCommit", "自动提交", "笔记变更后按防抖时间自动提交"],
  ["autoPush", "自动推送", "提交后推送到远端"],
  ["autoCommitSweep", "周期兜底提交", "定期提交遗漏的变更"],
]);

/** Drawer number fields — label, record key, schema bounds (A5 §15.2, not the prototype's placeholders). */
export const SETTING_NUMBERS = Object.freeze([
  ["debounceSeconds", "提交防抖", GIT_CONFIG_LIMITS.debounceSecondsMin, GIT_CONFIG_LIMITS.debounceSecondsMax],
  ["maxDelaySeconds", "最大延迟", GIT_CONFIG_LIMITS.maxDelaySecondsMin, GIT_CONFIG_LIMITS.maxDelaySecondsMax],
  ["sweepIntervalSeconds", "兜底间隔", GIT_CONFIG_LIMITS.sweepIntervalSecondsMin, GIT_CONFIG_LIMITS.sweepIntervalSecondsMax],
]);

/** Drawer text fields — label, record key, sub-label, hint, maxlength. */
export const SETTING_TEXTS = Object.freeze([
  ["remote", "远端名称", "remote", "填写名称（如 origin），不是 URL", GIT_CONFIG_LIMITS.remoteMaxLength],
  ["branch", "分支", "branch", "", GIT_CONFIG_LIMITS.branchMaxLength],
]);

/** `gitState()` (`5-render.js:169`) keyed by the canonical §16.2 runtime token. */
export const GIT_STATE_VIEW = Object.freeze({
  ready: { label: "已同步", tone: "ok" },
  disabled: { label: "未启用", tone: "off" },
  "repository-missing": { label: "未初始化 Git 仓库", tone: "off" },
  "config-invalid": { label: "配置错误", tone: "danger" },
  "push-failing": { label: "推送失败", tone: "amber" },
});

/** `4-data.js:34` CAP_HINTS — the operator-facing reason, prototype wording. */
export const CAP_HINTS = Object.freeze({
  semantic: "本机未配置向量服务，检索仍按关键词工作",
  webCatalog: "属于 Web 端能力，MCP 不使用",
  events: "属于 Web 端实时推送，MCP 不使用",
  git: "该库尚未初始化 Git 仓库",
  skills: "该库没有 skills 目录",
});

const GIT_CONFIG_SOURCE_VIEW = Object.freeze({
  persisted: "管理端保存",
  "env-default": "部署环境默认（GIT_*）",
  "default-disabled": "默认关闭（尚未保存过）",
});

const MISSING = '<span class="muted">—</span>';

/**
 * The type-to-confirm text of the repair page, in one place: the page renders it and the route
 * compares against the same constant, so the prompt and the server-side gate cannot drift.
 */
export const REPAIR_CONFIRM_TEXT = "重置";

// ------------------------------------------------------------------ helpers --

/** Escape + credential mask for free text (paths, remote names, reasons, notices). */
function tx(value) {
  return esc(scrubCredentials(value));
}

function shown(value) {
  return value !== null && value !== undefined && String(value) !== "";
}

function maybeText(value) {
  return shown(value) ? tx(value) : MISSING;
}

/** `st` pill (`1-head.html` `.st`): `<span class="st ok"><span class="dot"></span>已同步</span>`. */
function statePill(token, extra = "") {
  const view = GIT_STATE_VIEW[token] || { label: token ? `未知状态（${token}）` : "状态未知", tone: "off" };
  return `<span class="st ${view.tone}"><span class="dot"></span>${esc(view.label)}</span>${extra ? ` <span class="muted">· ${extra}</span>` : ""}`;
}

function capHint(key) {
  return CAP_HINTS[key] ?? capabilityHint(key);
}

function capLabel(key) {
  return capabilityLabel(key) ?? String(key ?? "");
}

function capabilityItems(vault) {
  const raw = vault?.capabilities;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === "string") return { key: entry, available: true, reason: null };
      if (!entry || typeof entry !== "object") return null;
      return {
        key: typeof entry.key === "string" ? entry.key : "",
        available: entry.available === true,
        reason: typeof entry.reason === "string" ? entry.reason : null,
      };
    })
    .filter((item) => item && item.key !== "");
}

function capabilityCountCell(vault) {
  const items = capabilityItems(vault);
  if (!items.length) return MISSING;
  return `${items.filter((item) => item.available).length} / ${items.length} 可用`;
}

/** `5-render.js:461` 同步方式 cell. */
function syncCell(config) {
  if (config?.enabled !== true) return '<span class="muted">未启用</span>';
  const sweepOn = config.autoCommitSweep === true;
  const interval = Number(config.sweepIntervalSeconds);
  const mins = Number.isFinite(interval) && interval > 0 ? Math.max(1, Math.round(interval / 60)) : null;
  const sweep = sweepOn ? ` · 每 ${mins ?? "—"} 分钟兜底` : "";
  return `${config.autoCommit === true ? "自动提交" : "手动提交"} · ${config.autoPush === true ? "自动推送" : "不推送"}${sweep}`;
}

/**
 * The pending batch (`git.pending`) as an integer, or `null` when the runtime is silent about it
 * (a missing runtime reports no count at all - never `0`). One resolution for both surfaces, so the
 * list reading and the drawer can never disagree.
 */
function pendingCount(git) {
  const pending = git?.pending;
  if (Number.isInteger(pending?.count)) return pending.count;
  if (Array.isArray(pending?.paths)) return pending.paths.length;
  return null;
}

/**
 * `5-render.js:169` `gitState()`: a non-empty pending batch *is* the status the prototype shows
 * (`<span class="st amber"><span class="dot"></span>N 个待提交</span>`), not a 已同步 pill followed
 * by an aside. The count is the prototype's own reading and the browser gate (#400/#435) reads it
 * off the list page; `data-pending-count` keeps the same fact machine-readable, and `title` carries
 * the pending facts (author chain, oldest pending time) that do not fit the pill.
 */
function pendingStatePill(count, facts) {
  const title = facts ? ` title="${esc(scrubCredentials(facts))}"` : "";
  return `<span class="st amber" data-pending-count="${esc(String(count))}"${title}><span class="dot"></span>${esc(String(count))} 个待提交</span>`;
}

/** The pending facts as one raw line (the caller escapes once): author chain, oldest time, dirty. */
function pendingFacts(git) {
  const pending = git?.pending;
  const authors = (Array.isArray(pending?.authors) ? pending.authors : []).map(authorText);
  return [
    authors.length ? `作者 ${authors.join(" / ")}` : "",
    shown(pending?.since) ? `最早待提交 ${String(pending.since)}` : "",
    git?.dirty === true ? "有未提交改动" : "",
  ].filter(Boolean).join(" · ");
}

/**
 * The Git 状态 cell of both list surfaces (table row and mobile card). A degraded §16.2 runtime
 * token is never hidden by the pending count: the prototype has no state that combines the two, so
 * the state pill stays and takes the pending reading as its suffix.
 */
function stateCell(git) {
  const count = pendingCount(git);
  if (count === null || count <= 0) return statePill(git?.state);
  const facts = pendingFacts(git);
  return git?.state && git.state !== "ready"
    ? statePill(git.state, `${esc(String(count))} 个待提交`)
    : pendingStatePill(count, facts);
}

/** `5-render.js:465` 远端 / 分支 cell — plain git names only, never a credential-bearing URL. */
function remoteCell(config) {
  if (config?.enabled !== true) return MISSING;
  const remote = shown(config.remote) ? tx(config.remote) : "—";
  const branch = shown(config.branch) ? tx(config.branch) : "—";
  return `${remote}/${branch}`;
}

/** Row identity cell: name + id + 主库 chip, linked to the `?id=` drawer (no-JS replacement of the row click). */
function identityCell(vault, href) {
  const name = shown(vault?.name) ? tx(vault.name) : tx(vault?.id);
  const chip = vault?.primary === true ? '<span class="kind">主库</span>' : "";
  return `<div class="nm"><b><a class="cell-link" href="${esc(href)}">${name}</a></b><span class="sub2"><span class="mono">${tx(vault?.id)}</span>${chip}</span></div>`;
}

function openHref(base, id) {
  return `${base}?id=${encodeURIComponent(String(id ?? ""))}`;
}

/** `6-app.js:134` vault row menu, rebuilt on the real routes (open / verify / open in Web). */
function rowMenu(vault, ctx) {
  const id = String(vault?.id ?? "");
  return moreMenu([
    { href: openHref(ctx.base, id), label: "详情与 Git 设置", icon: "edit" },
    { action: ctx.verify, label: "验证 Git 仓库与配置", icon: "checkc", csrf: ctx.csrf, fields: { vaultId: id } },
    { href: "/app/", label: "在 Web 中打开", icon: "ext" },
  ]);
}

function row(vault, ctx) {
  const git = vault?.git ?? {};
  const href = openHref(ctx.base, vault?.id);
  return `<tr><td>${identityCell(vault, href)}</td><td>${stateCell(git)}</td><td class="cellt">${syncCell(git.config)}</td><td class="cellt mono">${remoteCell(git.config)}</td><td class="cellt">${capabilityCountCell(vault)}</td><td class="act">${rowMenu(vault, ctx)}</td></tr>`;
}

function card(vault, ctx) {
  const git = vault?.git ?? {};
  const href = openHref(ctx.base, vault?.id);
  const name = shown(vault?.name) ? tx(vault.name) : tx(vault?.id);
  const chip = vault?.primary === true ? " · 主库" : "";
  return `<div class="mc"><div class="b"><div class="nm"><b><a class="cell-link" href="${esc(href)}">${name}</a></b><span class="sub2">${tx(vault?.id)}${chip}</span></div><div class="meta">${stateCell(git)}</div></div>${rowMenu(vault, ctx)}</div>`;
}

// ------------------------------------------------------------------ drawer --

/**
 * Author label (#400): `{agent, model}` facts, never `[object Object]`. `authorText` is the raw form
 * for callers that must escape a whole line exactly once (e.g. a `title` attribute that also carries
 * a timestamp); `authorLabel` is the escaped form for HTML bodies.
 */
function authorText(author) {
  if (typeof author === "string") return author.trim() || "未知";
  if (!author || typeof author !== "object" || Array.isArray(author)) return "未知";
  const agent = typeof author.agent === "string" ? author.agent.trim() : "";
  const model = typeof author.model === "string" ? author.model.trim() : "";
  return [agent, model].filter(Boolean).join(" / ") || "未知";
}

function authorLabel(author) {
  return tx(authorText(author));
}

/** `6-app.js:219` 状态 kv rows: runtime facts first, `—` where the service is silent. */
function statusKv(vault) {
  const git = vault?.git ?? {};
  const config = git.config ?? {};
  const push = git.push ?? {};
  const sweep = git.lastSweep ?? null;
  const error = git.configError;

  const repoHelp = git.state === "repository-missing"
    ? '<div class="help">目录中没有 .git。在服务器上执行 <span class="mono">git init</span> 后点「验证」，即可启用自动提交。</div>'
    : `<div class="help mono">repository ${maybeText(git.repository)} · HEAD — · 提交摘要由服务未提供</div>`;
  const errorHelp = error && typeof error === "object"
    ? `<div class="help" style="color:var(--danger)">${tx(error.name || "配置读取失败")}${shown(error.message) ? `：${tx(error.message)}` : ""}</div>`
    : "";

  const failures = Number.isInteger(push.consecutiveFailures) ? push.consecutiveFailures : null;
  const outcome = push.lastOutcome && typeof push.lastOutcome === "object" ? push.lastOutcome : null;
  const pushFacts = [
    outcome ? (outcome.pushed === true ? "已推送" : "推送未成功") : "尚无推送记录",
    shown(outcome?.failureClass) ? tx(outcome.failureClass) : "",
    shown(outcome?.remote) ? tx(outcome.remote) : "",
    shown(outcome?.branch) ? tx(outcome.branch) : "",
    outcome && outcome.exitCode !== null && outcome.exitCode !== undefined ? `exit ${esc(String(outcome.exitCode))}` : "",
    shown(outcome?.summary) ? tx(outcome.summary) : "",
    failures === null ? "连续失败 —" : `连续失败 ${esc(String(failures))}`,
  ].filter(Boolean);

  const pending = git.pending ?? {};
  const count = pendingCount(git);
  const paths = Array.isArray(pending.paths) ? pending.paths : [];
  const authors = (Array.isArray(pending.authors) ? pending.authors : []).map(authorLabel);
  const dirtyFact = git.dirty === true ? '<span class="st amber"><span class="dot"></span>有未提交改动</span>'
    : git.dirty === false ? '<span class="st ok"><span class="dot"></span>干净</span>' : "";
  const pendingMain = count === null ? MISSING : `<span class="muted">${esc(String(count))} 个待提交路径</span>`;
  const pendingHelp = [
    dirtyFact,
    shown(pending.since) ? `最早待提交 ${tx(pending.since)}` : "",
    authors.length ? `作者 ${authors.join(" / ")}` : "",
  ].filter(Boolean).join(" · ");
  const pathsDetails = paths.length
    ? `<details style="margin-top:6px"><summary class="help" style="cursor:pointer">待提交路径（${esc(String(paths.length))}）</summary><pre class="mono" style="white-space:pre-wrap;color:var(--tx3);margin:8px 0 0">${paths.slice(0, 20).map((item) => tx(item)).join("\n")}${paths.length > 20 ? `\n…（共 ${paths.length} 条）` : ""}</pre></details>`
    : "";

  const timers = git.timers && typeof git.timers === "object" ? git.timers : null;
  const sweepOn = config.enabled === true && config.autoCommitSweep === true;
  const interval = Number(config.sweepIntervalSeconds);
  const mins = Number.isFinite(interval) && interval > 0 ? Math.max(1, Math.round(interval / 60)) : null;
  const sweepHead = sweepOn ? `兜底提交：每 ${esc(String(mins ?? "—"))} 分钟` : '<span class="muted">未运行</span>';
  const timerFacts = timers
    ? [["commit", "提交防抖"], ["maxDelay", "最大延迟"], ["sweep", "兜底"]]
      .map(([key, label]) => `${esc(label)} ${timers[key] === true ? "已装载" : "未装载"}`).join(" · ")
    : "";
  const sweepFacts = sweep && typeof sweep === "object"
    ? [
      shown(sweep.at) ? `最近兜底 ${tx(sweep.at)}` : "",
      sweep.committed === true ? "已提交" : sweep.committed === false ? "无改动" : "",
      shown(sweep.hash) ? tx(sweep.hash) : "",
      sweep.pushed === true ? "已推送" : sweep.pushed === false ? "未推送" : "",
      shown(sweep.reason) ? tx(sweep.reason) : "",
    ].filter(Boolean).join(" · ")
    : "";

  const root = shown(vault?.root) ? `<span class="mono" style="word-break:break-all">${tx(vault.root)}</span>` : MISSING;
  const canonical = shown(vault?.canonicalRoot) && String(vault.canonicalRoot) !== String(vault?.root)
    ? `<div class="help mono">canonicalRoot ${tx(vault.canonicalRoot)}</div>` : "";

  const sourceToken = typeof git.configSource === "string" ? git.configSource.trim() : "";
  const sourceLabel = GIT_CONFIG_SOURCE_VIEW[sourceToken] ?? (sourceToken ? `未知来源（${esc(sourceToken)}）` : "");
  const source = sourceLabel
    ? `${esc(sourceLabel)}${sourceToken === "persisted" && shown(config.updatedAt) ? ` · ${relTitle(config.updatedAt)}` : ""}`
    : MISSING;

  return `<div class="kv">
<div class="k">Git 仓库</div><div>${statePill(git.state)}${repoHelp}${errorHelp}</div>
<div class="k">最近推送</div><div>${outcome && shown(outcome.at) ? relTitle(outcome.at) : MISSING} <span class="muted">· 领先 — / 落后 —</span><div class="help">${pushFacts.join(" · ")}</div></div>
<div class="k">待提交</div><div>${pendingMain}${pendingHelp ? `<div class="help">${pendingHelp}</div>` : ""}${pathsDetails}</div>
<div class="k">目录</div><div>${root}<div class="help" style="font-family:var(--font)">实际路径与此一致</div>${canonical}</div>
<div class="k">配置来源</div><div>${source}</div>
<div class="k">上次验证</div><div><span class="muted">—</span> <span class="help">（服务不保存验证时间；点「验证仓库与配置」的结果显示在页面顶部）</span></div>
<div class="k">定时任务</div><div>${sweepHead}${timerFacts ? `<div class="help">${timerFacts}</div>` : ""}${sweepFacts ? `<div class="help">${sweepFacts}</div>` : ""}</div>
</div>`;
}

/** `6-app.js` sw(): a `.li` row whose switch is a POST form (no JS ⇒ one field per submit). */
function switchRow(vault, ctx, key, label, help) {
  const on = vault?.git?.config?.[key] === true;
  const editable = vault?.editable === true && vault?.git?.config !== null && vault?.git?.config !== undefined;
  const title = editable ? `${on ? "已开启" : "已关闭"}：点击${on ? "关闭" : "开启"} ${label}` : `${label}：不可编辑`;
  const control = editable
    ? `<form class="inline-form" method="post" action="${esc(ctx.save)}"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}"><input type="hidden" name="vaultId" value="${esc(String(vault?.id ?? ""))}">${ctx.revision === null ? "" : `<input type="hidden" name="expectedRevision" value="${esc(String(ctx.revision))}">`}<input type="hidden" name="${esc(key)}" value="${on ? "false" : "true"}"><button class="switch${on ? " on" : ""}" type="submit" title="${esc(title)}" aria-label="${esc(title)}" aria-pressed="${on ? "true" : "false"}"></button></form>`
    : `<button class="switch${on ? " on" : ""}" type="button" disabled aria-pressed="${on ? "true" : "false"}" title="${esc(title)}"></button>`;
  return `<div class="li" style="min-height:52px"><div class="grow"><b>${esc(label)}</b> <span class="sub">${esc(key)}</span><div class="help">${esc(help)}</div></div>${control}</div>`;
}

function numberField(vault, key, label, min, max) {
  const config = vault?.git?.config ?? null;
  const value = config && Number.isInteger(config[key]) ? String(config[key]) : "";
  const disabled = vault?.editable !== true;
  const range = `范围 ${min}–${max}`;
  return `<div class="fld"><label>${esc(label)}</label><div style="display:flex;align-items:center;gap:6px"><input class="inp" type="number" name="${esc(key)}" min="${esc(String(min))}" max="${esc(String(max))}" value="${esc(value)}"${disabled ? " disabled" : ""}><span class="muted">秒</span></div><span class="sub ell" title="${esc(`${key} · ${range}`)}">${esc(key)}</span></div>`;
}

function textField(vault, key, label, sub, hint, maxLength) {
  const config = vault?.git?.config ?? null;
  const disabled = vault?.editable !== true;
  return `<div class="fld"><label>${esc(label)} <small>${esc(sub)}</small></label><input class="inp mono" name="${esc(key)}" maxlength="${esc(String(maxLength))}" value="${maybeText(config?.[key])}"${disabled ? " disabled" : ""}>${hint ? `<span class="help">${esc(hint)}</span>` : ""}</div>`;
}

/** `6-app.js` Git 同步设置: 4 switches + 3 numbers + 2 texts + 保存设置 / 验证仓库与配置. */
function settingsSection(vault, ctx) {
  const id = String(vault?.id ?? "");
  const editable = vault?.editable === true;
  const revision = ctx.revision === null || ctx.revision === undefined ? "" : `<input type="hidden" name="expectedRevision" value="${esc(String(ctx.revision))}">`;
  const note = editable
    ? ""
    : `<p class="help" style="margin:0 0 8px">该 Vault 的 Git 设置当前不可编辑（Git 配置存储不可读，或该 Vault 尚未通过准入）。控件已禁用，不会提交无法生效的写入。</p>`;
  const switches = SETTING_SWITCHES.map(([key, label, help]) => switchRow(vault, ctx, key, label, help)).join("");
  const numbers = SETTING_NUMBERS.map(([key, label, min, max]) => numberField(vault, key, label, min, max)).join("");
  const texts = SETTING_TEXTS.map(([key, label, sub, hint, maxLength]) => textField(vault, key, label, sub, hint, maxLength)).join("");
  return `<div class="dsec"><h3>Git 同步设置</h3>${note}
<div class="list">${switches}</div>
<form method="post" action="${esc(ctx.save)}" id="git-settings-${esc(id)}"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}"><input type="hidden" name="vaultId" value="${esc(id)}">${revision}
<div class="grid3" style="margin-top:16px">${numbers}</div>
<div class="grid2" style="margin-top:12px">${texts}</div>
<div style="display:flex;gap:8px;margin-top:16px"><button class="btn primary" type="submit"${editable ? "" : " disabled"}>保存设置</button><button class="btn" type="submit" form="git-verify-${esc(id)}"${editable ? "" : " disabled"}>${ic("checkc")}验证仓库与配置</button></div></form>
<form method="post" action="${esc(ctx.verify)}" id="git-verify-${esc(id)}"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}"><input type="hidden" name="vaultId" value="${esc(id)}"></form>
</div>`;
}

/** `6-app.js` 能力 section: 13 chips, the Chinese reason for each unwired key, raw reason folded away. */
function capabilitySection(vault) {
  const items = capabilityItems(vault);
  const available = items.filter((item) => item.available).length;
  const chips = items.length
    ? items.map((item) => `<span class="cap ${item.available ? "" : "off"}" title="${esc(`${item.key}${item.available ? "" : ` · ${capHint(item.key)}`}`)}"><span class="dot ${item.available ? "ok" : ""}"></span>${esc(capLabel(item.key))}</span>`).join("")
    : MISSING;
  const unwired = items.filter((item) => !item.available);
  const hints = unwired.map((item) => `<div>· ${esc(capLabel(item.key))}：${esc(capHint(item.key))}</div>`).join("");
  const details = unwired.length
    ? `<details style="margin-top:8px"><summary class="help" style="cursor:pointer">技术细节</summary><pre class="mono" style="white-space:pre-wrap;color:var(--tx3);margin:8px 0 0">${unwired.map((item) => esc(`${item.key}: available=false (${shown(item.reason) ? scrubCredentials(item.reason) : "unwired"})`)).join("\n")}</pre></details>`
    : "";
  return `<div class="dsec"><h3>能力 <span class="muted" style="font-weight:400">${items.length ? `${available} / ${items.length} 项可用` : "未提供"}</span></h3><div class="caps">${chips}</div>${hints ? `<div class="help" style="margin-top:8px">${hints}</div>` : ""}${details}</div>`;
}

/**
 * A5/W2 admission surface (existing capability, no prototype position): read + approve/revoke.
 * Before the first initialise no vault has an admission descriptor at all, so this block is absent —
 * the bootstrap entry point is the page-bar link to `?confirm=admission` (`admissionConfirmPage`).
 * 2026-10-22: it used to show a dead「等待显式初始化」hint, so the operator had no way in.
 */
function vaultAdmissionSection(vault, ctx) {
  const admission = vault?.admission;
  if (!ctx.admission || !admission || typeof admission !== "object") return "";
  const operation = admission.admission === "approved" ? "revoke" : "approve";
  const action = postForm({ action: `${ctx.admission}/${operation}`, csrf: ctx.csrf, fields: { vaultId: vault.id }, label: operation === "revoke" ? "撤销批准" : "批准", cls: "btn sm" });
  return `<div class="dsec"><h3>准入</h3><div class="kv"><div class="k">准入决定</div><div>${maybeText(admission.admission)}</div><div class="k">运行状态</div><div>${maybeText(admission.status)}</div><div class="k">原因</div><div>${maybeText(admission.reason)}</div><div class="k">可服务</div><div>${admission.servable === true ? "是" : admission.servable === false ? "否" : MISSING}</div></div><div style="margin-top:12px">${action}</div></div>`;
}

/** The `?id=` drawer: 状态 / Git 同步设置 / 能力 / 准入 / 规划中「运行时」. */
function detailPanel(vault, ctx) {
  const id = String(vault?.id ?? "");
  const heading = shown(vault?.name) ? vault.name : id;
  const body = [
    `<div class="dsec"><h3>状态</h3>${statusKv(vault)}</div>`,
    settingsSection(vault, ctx),
    capabilitySection(vault),
    vaultAdmissionSection(vault, ctx),
    `<div class="dsec futonly"><div class="futbox"><b style="font-weight:600">运行时</b> ${fut("#437")}<div class="help">扫描新 Vault / 热刷新（新增目录无需重启容器）尚未接线；本页不会创建或移动任何目录。</div></div></div>`,
  ];
  // Identity badges stay in the header where the prototype keeps them (`6-app.js:265` dhead): the
  // primary marker, plus the exception marker a read-only descriptor needs. The redundant half of
  // the old `角色` kv row is gone - the drawer's kv inventory is compared in both directions, and the
  // prototype has no `角色` row.
  const badges = `${vault?.primary === true ? '<span class="kind">主库</span>' : ""}${vault?.writable === false ? '<span class="kind">只读</span>' : ""}`;
  return `<div class="scrim on" data-scrim></div><aside class="drawer on" id="vault-drawer-${esc(id)}" role="dialog" aria-modal="true" aria-label="${esc(heading)}"><header class="bar"><h1 class="ell">${tx(heading)}</h1><span class="mono muted">${tx(id)}</span>${badges}<span class="grow"></span><a class="ibtn" href="${esc(ctx.base)}" aria-label="关闭">${ic("x")}</a></header><div class="dbody scroll">${body.join("")}</div></aside>`;
}

// ------------------------------------------------------------------- page ---

function normalizeCtx(ctx = {}) {
  const base = ctx.actions?.base || ctx.vaultGitBase || "/admin/auth/vault-git";
  const model = ctx.vaultGit?.model ?? null;
  return {
    model,
    csrf: ctx.csrf || "",
    base,
    save: ctx.actions?.save || `${base}/save`,
    refresh: ctx.actions?.refresh || `${base}/refresh`,
    verify: ctx.actions?.verify || `${base}/verify`,
    repair: ctx.actions?.repair || `${base}/repair`,
    // Only a deployment that wired a store with `repair()` may offer the CTA; without it the page
    // keeps the honest read-only copy instead of a button that cannot act.
    repairWired: ctx.repairWired === true,
    admission: ctx.actions?.admission || null,
    admissionInitialized: model?.admission?.initialized === true,
    revision: ctx.revision ?? model?.revision ?? null,
    query: ctx.query || {},
    error: ctx.vaultGit?.error ?? null,
    notice: ctx.notice ?? model?.notice ?? null,
  };
}

/**
 * Repaired by `POST <base>/repair`: the broken store's own honest banner. Prototype position and
 * copy `5-render.js:468`; the button is a GET link to the `?confirm=repair` page because the page
 * carries no script and no `data-act`.
 */
function brokenBanner(model, view) {
  const code = model?.broken?.errorCode ?? null;
  const codeNote = shown(code) ? `，错误码 <span class="mono">${tx(code)}</span>` : "";
  if (!view.repairWired) {
    const body = `<b>Git 配置存储不可用</b>：配置文件损坏，各 Vault 回退为默认设置（不自动提交）。<div class="help" style="margin-top:8px">本部署没有网页「重置」修复入口（重置会丢弃全部 Vault 的已保存设置，必须由运维按部署排查说明处理存储文件）${codeNote}。修复前这里只读展示 registry 与运行时事实，保存继续 fail closed。</div>`;
    return banner(body, { tone: "danger" });
  }
  const body = `<b>Git 配置存储不可用</b>：配置文件损坏，各 Vault 回退为默认设置（不自动提交）。<div style="margin-top:8px"><a class="btn danger" href="${esc(`${view.base}?confirm=repair`)}">重置为默认并修复…</a></div><div class="help" style="margin-top:8px">修复会把损坏文件隔离（同目录改名保留，不删除），再把配置重置为默认；隔离失败时不会写入任何内容${codeNote}。修复前这里只读展示 registry 与运行时事实，保存继续 fail closed。</div>`;
  return banner(body, { tone: "danger" });
}

/**
 * `?confirm=repair` — the prototype's danger modal (`6-app.js:351`), now through `ui.confirmPage`.
 *
 * The primitive carries both fixes this page needs (`ui.js` `confirmPage`, owner ruling on lane
 * W4's bug report): the type-to-confirm input lives INSIDE the `<form>` and the submit button is not
 * disabled, so a scriptless browser submits a real `confirm` value. The server still decides
 * (`routes/vault-git.js`: `VAULT_GIT_REPAIR_CODES.CONFIRM_MISMATCH`); the markup only has to make
 * the honest POST possible, and a client-side `disabled` was never a gate.
 */
function repairConfirmPage(view) {
  return confirmPage({
    title: "重置 Git 配置存储？",
    bodyHtml: "所有 Vault 的 Git 设置将恢复默认（不自动提交），损坏文件会先被隔离（改名保留，不删除）。",
    listItems: [
      '隔离：同目录下 <span class="mono">git-vaults.json.&lt;ISO 时间戳&gt;.broken</span>，内容是原来的损坏文件',
      '重置：<span class="mono">git-vaults.json</span> 写回一份空的 A5 文档（schema 1 / revision 0 / 无记录）',
      "失败：隔离不成功就什么也不写（fail closed）；成功与拒绝都会记一条审计",
    ],
    typed: REPAIR_CONFIRM_TEXT,
    ok: "重置",
    tone: "danger",
    backHref: view.base,
    action: view.repair,
    method: "post",
    csrf: view.csrf,
    footnote: "确认文本由服务端校验；按钮的可用状态不作为门禁。",
  });
}

function noticeLine(notice) {
  if (!notice) return "";
  const text = typeof notice === "string" ? notice : notice?.message;
  if (!shown(text)) return "";
  const tone = typeof notice === "object" && notice.tone === "err" ? "err" : "ok";
  return result(tone !== "err", tx(text));
}

/**
 * The decision table, once decisions exist. Before the first initialise this renders NOTHING: the
 * prototype has no admission section at all (`grep 准入 docs/admin-ui-proto` → 0), so the list
 * projection stays byte-comparable. The bootstrap entry point is the page-bar link to
 * `<base>?confirm=admission` (`admissionConfirmPage`); the drawer cannot host it — the prototype's
 * drawer inventory (sections, choice values) is compared exactly, and before the first initialise no
 * vault even has an admission descriptor.
 * 2026-10-22: the previous revision of this comment claimed the form was owned by
 * `vault-admission-view.js`, but that module is only reachable from the retired legacy view — the live
 * `vault-git` route renders THIS module. Following it left every fresh deployment with no way in.
 */
function admissionListSection(list, model, ctx) {
  const admission = model?.admission;
  if (!ctx.admission || !admission || typeof admission !== "object") return "";
  const rows = list.map((vault) => {
    const state = vault?.admission ?? {};
    const operation = state.admission === "approved" ? "revoke" : "approve";
    const action = admission.initialized
      ? postForm({ action: `${ctx.admission}/${operation}`, csrf: ctx.csrf, fields: { vaultId: vault.id }, label: operation === "revoke" ? "撤销批准" : "批准", cls: "btn sm" })
      : '<span class="muted">等待显式初始化</span>';
    return `<tr><td class="mono">${tx(vault.id)}</td><td>${maybeText(state.admission)}</td><td>${maybeText(state.status)}</td><td>${maybeText(state.reason)}</td><td class="act">${action}</td></tr>`;
  });
  if (!admission.initialized) return "";
  return `<div class="sect" id="vault-admission"><div class="sect-h"><h2>Vault 准入</h2><span class="muted">已初始化</span></div>${table([["Vault", "24%"], ["准入决定", "16%"], ["运行状态", "14%"], ["原因", "30%"], ["", "16%", "act"]], rows, "")}</div>`;
}

/**
 * `<base>?confirm=admission` — the bootstrap confirm state, built with the SAME helper as the Git repair
 * dialog (`confirmPage`), so cancel / back / modal semantics cannot drift between the two `?confirm=`
 * entries. The per-vault confirm choices come from `admissionConfirmChoices`, the same source the legacy
 * inline form uses. Scriptless: a plain GET renders it, the cancel link is a real href, the submit is a
 * real POST with CSRF.
 */
function admissionConfirmPage(view) {
  return confirmPage({
    title: "初始化 Vault 准入？",
    bodyHtml: "显式确认准入清单：配置里的 primary 立即获准，其余 Vault 保持 pending。初始化成功后准入闸立即生效，不需要重启容器。",
    ok: "初始化准入",
    // Turning the gate ON is not destructive (the repair dialog's danger tone is for discarding a
    // broken store); the review asked for the honest tone, the geometry/cancel/Esc stay shared.
    tone: "primary",
    backHref: view.base,
    action: `${view.base}/admission/initialize`,
    method: "post",
    csrf: view.csrf,
    formHtml: `<div class="fld">${admissionConfirmChoices({ vaults: view.model?.vaults ?? [], text: esc })}</div>`,
    footnote: "与 Git 修复对话框同一个 ?confirm= 惯例：取消/返回是同一条真实链接；服务端只认 POST + CSRF。",
  });
}

/** Row menu / mobile-card / drawer context: `renderVaultsPage(ctx) -> { content, detailPanel }`. */
export function renderVaultsPage(ctx) {
  const view = normalizeCtx(ctx);
  const model = view.model;
  const list = Array.isArray(model?.vaults) ? model.vaults : [];
  const broken = Boolean(model?.broken) || (model?.status !== undefined && model.status !== "ready");
  // The confirm page is a GET state of the same page and only exists while there is something to
  // repair: a healthy store never renders the reset dialog.
  const askRepair = broken && view.repairWired && String(view.query.confirm ?? "").trim() === "repair";
  // The bootstrap confirm state (`<base>?confirm=admission`): the same idiom as the repair dialog —
  // a GET state of the same page that carries the real (scriptless) form. The shape gate only pairs
  // the pages in its own state registry, so this extra state is not a parity claim.
  const askAdmission = Boolean(view.admission) && !view.admissionInitialized
    && String(view.query.confirm ?? "").trim() === "admission";
  const selectedId = typeof view.query.id === "string" ? view.query.id.trim() : "";
  const selected = selectedId ? list.find((vault) => String(vault?.id) === selectedId) ?? null : null;
  const detail = selectedId
    ? selected
      ? detailPanel(selected, view)
      : `<div class="scrim on" data-scrim></div><aside class="drawer on" id="vault-drawer-missing" role="dialog" aria-modal="true" aria-label="Vault 不存在"><header class="bar"><h1>Vault 不存在</h1><span class="grow"></span><a class="ibtn" href="${esc(view.base)}" aria-label="关闭">${ic("x")}</a></header><div class="dbody">${emptyState("db", "Vault 不存在或已移除", "可能已被取消准入，或清单尚未刷新")}</div></aside>`
    : "";

  const refresh = `<form class="inline-form" method="post" action="${esc(view.refresh)}"><input type="hidden" name="csrf" value="${esc(view.csrf)}"><button class="btn" type="submit">${ic("refresh")}<span class="hide-m">刷新 Vault 清单</span></button></form>`;
  // The bootstrap entry point (no admissions record yet, discovery off): ONE real GET link to the
  // confirm state, which carries the initialise form. It is the only way an operator can turn the
  // admission gate on from the UI. It lives here rather than in the drawer because the prototype's
  // drawer inventory (sections / choice values) is compared exactly, and rather than as a list-level
  // section because the list projection stays byte-comparable with the prototype — so this single
  // control is the smallest honest divergence (declared in the shape waivers).
  // 2026-10-22: without it, a fresh deployment had no way in at all (the list section was hidden and
  // the drawer, which has no admission descriptor before the first initialise, rendered nothing).
  const admissionEntry = view.admission && !view.admissionInitialized
    && String(view.query.confirm ?? "").trim() !== "admission"
    ? `<a class="btn" href="${esc(`${view.base}?confirm=admission`)}">${ic("shield")}<span class="hide-m">初始化准入</span></a>`
    : "";
  const scan = `<span class="btn futonly" aria-disabled="true">${ic("search")}<span class="hide-m">扫描新 Vault</span> ${fut("#437")}</span>`;

  const unavailable = !model
    ? result(false, `${esc("Vault 与 Git 数据不可用")}${view.error ? `：${tx(view.error)}` : "：Git 管理服务未提供模型"}`)
    : "";

  const content = `${pageBar({ title: "Vault 与 Git", count: model ? list.length : null, actions: `${refresh}${admissionEntry}${scan}` })}<div class="content scroll"><div class="page">
<p class="lede">每个 Vault 的 Git 状态与同步设置。目录路径与远端名称只在管理端可见；这里不创建仓库，也不接受含凭据的远端地址。</p>
${noticeLine(view.notice)}
${unavailable}
${model && broken ? brokenBanner(model, view) : ""}
${askRepair ? repairConfirmPage(view) : ""}
${askAdmission ? admissionConfirmPage(view) : ""}
${model ? table(VAULT_COLUMNS, list.map((vault) => row(vault, view)), emptyState("db", "没有可用的 Vault", "检查部署配置中的 Vault 列表")) : ""}
${model ? mcards(list.map((vault) => card(vault, view))) : ""}
${admissionListSection(list, model, view)}
<div class="sect futonly"><div class="futbox" style="display:flex;gap:12px;align-items:center"><div class="grow"><b style="font-weight:600">从 GitHub 仓库添加 Vault</b> ${fut("Architecture TODO")}<div class="help">以远端仓库为存储后端的 Vault（GitHub-backed Vault），只读克隆或双向同步。</div></div><button class="btn" disabled>添加…</button></div></div>
</div></div>`;
  return { content, detailPanel: detail };
}

export { detailPanel as renderVaultDetailPanel };
