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
import { t } from "../../i18n/context.js";
import { readSort, sortRows } from "../table-sort.js";

/** Summary columns — `5-render.js:458`. `配置来源` moved into the drawer (#461/#401); the vault's role
 *  is the prototype's header badge (主库) plus the exception badge (只读), not a `角色` kv row:
 *  `scripts/proto-parity/compare.mjs` compares the drawer's kv set in *both* directions. */
export function vaultColumns() {
  return [
    ["Vault", "20%", "", "vault"],
    [t("adm.vaults.col.git"), "24%", "", "git"],
    [t("adm.vaults.col.sync"), "26%", "", "sync"],
    [t("adm.vaults.col.remote"), "14%", "", "remote"],
    [t("adm.vaults.col.caps"), "10%", "", "caps"],
    ["", "", "act"],
  ];
}

/** `6-app.js:219` drawer switches — label, record key, prototype help text, immediate-POST key. */
export function settingSwitches() {
  return [
    ["enabled", t("adm.vaults.set.enabled"), t("adm.vaults.set.enabledHelp")],
    ["autoCommit", t("adm.vaults.set.autoCommit"), t("adm.vaults.set.autoCommitHelp")],
    ["autoPush", t("adm.vaults.set.autoPush"), t("adm.vaults.set.autoPushHelp")],
    ["autoCommitSweep", t("adm.vaults.set.sweep"), t("adm.vaults.set.sweepHelp")],
  ];
}

/** Drawer number fields — label, record key, schema bounds (A5 §15.2, not the prototype's placeholders). */
export function settingNumbers() {
  return [
    ["debounceSeconds", t("adm.vaults.num.debounce"), GIT_CONFIG_LIMITS.debounceSecondsMin, GIT_CONFIG_LIMITS.debounceSecondsMax],
    ["maxDelaySeconds", t("adm.vaults.num.maxDelay"), GIT_CONFIG_LIMITS.maxDelaySecondsMin, GIT_CONFIG_LIMITS.maxDelaySecondsMax],
    ["sweepIntervalSeconds", t("adm.vaults.num.sweep"), GIT_CONFIG_LIMITS.sweepIntervalSecondsMin, GIT_CONFIG_LIMITS.sweepIntervalSecondsMax],
  ];
}

/** Drawer text fields — label, record key, sub-label, hint, maxlength. */
export function settingTexts() {
  return [
    ["remote", t("adm.vaults.text.remote"), "remote", t("adm.vaults.text.remoteHint"), GIT_CONFIG_LIMITS.remoteMaxLength],
    ["branch", t("adm.vaults.text.branch"), "branch", "", GIT_CONFIG_LIMITS.branchMaxLength],
  ];
}

/** `gitState()` (`5-render.js:169`) keyed by the canonical §16.2 runtime token. */
export function gitStateView() {
  return {
    ready: { label: t("adm.vaults.state.ready"), tone: "ok" },
    disabled: { label: t("adm.vaults.state.disabled"), tone: "off" },
    "repository-missing": { label: t("adm.vaults.state.noRepo"), tone: "off" },
    "config-invalid": { label: t("adm.vaults.state.configInvalid"), tone: "danger" },
    "push-failing": { label: t("adm.vaults.state.pushFailing"), tone: "amber" },
  };
}

/** `4-data.js:34` CAP_HINTS — the operator-facing reason, prototype wording. */
export function capHints() {
  return {
    semantic: t("adm.vaults.cap.semantic"),
    webCatalog: t("adm.vaults.cap.webCatalog"),
    events: t("adm.vaults.cap.events"),
    git: t("adm.vaults.cap.git"),
    skills: t("adm.vaults.cap.skills"),
  };
}

function gitConfigSourceView() {
  return {
    persisted: t("adm.vaults.source.persisted"),
    "env-default": t("adm.vaults.source.envDefault"),
    "default-disabled": t("adm.vaults.source.defaultDisabled"),
  };
}

const MISSING = '<span class="muted">—</span>';

/**
 * The type-to-confirm text of the repair page, in one place: the page renders it and the route
 * compares against the same constant, so the prompt and the server-side gate cannot drift.
 */
export const REPAIR_CONFIRM_TEXT = "重置";

/**
 * The confirmation word the page renders and the route compares against. Both sides read the
 * same catalog key, so an English operator can submit the English word instead of a Chinese one
 * they cannot type; `REPAIR_CONFIRM_TEXT` stays exported as the zh-CN literal for the tooling and
 * tests that assert the wording of the Chinese face.
 */
export function repairConfirmText() {
  return t("adm.vaults.repairConfirm");
}

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
  const view = gitStateView()[token] || { label: token ? t("adm.vaults.state.unknownWith", { token }) : t("adm.vaults.state.unknown"), tone: "off" };
  return `<span class="st ${view.tone}"><span class="dot"></span>${esc(view.label)}</span>${extra ? ` <span class="muted">· ${extra}</span>` : ""}`;
}

function capHint(key) {
  return capHints()[key] ?? capabilityHint(key);
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
  return t("adm.vaults.capsAvailable", { available: items.filter((item) => item.available).length, total: items.length });
}

/** `5-render.js:461` 同步方式 cell. */
function syncCell(config) {
  if (config?.enabled !== true) return `<span class="muted">${esc(t("adm.vaults.state.disabled"))}</span>`;
  const sweepOn = config.autoCommitSweep === true;
  const interval = Number(config.sweepIntervalSeconds);
  const mins = Number.isFinite(interval) && interval > 0 ? Math.max(1, Math.round(interval / 60)) : null;
  const sweep = sweepOn ? ` · ${t("adm.vaults.sync.sweepEvery", { mins: mins ?? "—" })}` : "";
  return `${config.autoCommit === true ? t("adm.vaults.sync.autoCommit") : t("adm.vaults.sync.manualCommit")} · ${config.autoPush === true ? t("adm.vaults.sync.autoPush") : t("adm.vaults.sync.noPush")}${sweep}`;
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
  return `<span class="st amber" data-pending-count="${esc(String(count))}"${title}><span class="dot"></span>${esc(t("adm.vaults.pending.count", { count }))}</span>`;
}

/** The pending facts as one raw line (the caller escapes once): author chain, oldest time, dirty. */
function pendingFacts(git) {
  const pending = git?.pending;
  const authors = (Array.isArray(pending?.authors) ? pending.authors : []).map(authorText);
  return [
    authors.length ? t("adm.vaults.pending.authors", { authors: authors.join(" / ") }) : "",
    shown(pending?.since) ? t("adm.vaults.pending.since", { since: String(pending.since) }) : "",
    git?.dirty === true ? t("adm.vaults.pending.dirty") : "",
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
    ? statePill(git.state, esc(t("adm.vaults.pending.count", { count })))
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
  const chip = vault?.primary === true ? `<span class="kind">${esc(t("adm.vaults.badge.primary"))}</span>` : "";
  return `<div class="nm"><b><a class="cell-link" href="${esc(href)}">${name}</a></b><span class="sub2"><span class="mono">${tx(vault?.id)}</span>${chip}</span></div>`;
}

function openHref(base, id) {
  return `${base}?id=${encodeURIComponent(String(id ?? ""))}`;
}

/** `6-app.js:134` vault row menu, rebuilt on the real routes (open / verify / open in Web). */
function rowMenu(vault, ctx) {
  const id = String(vault?.id ?? "");
  return moreMenu([
    { href: openHref(ctx.base, id), label: t("adm.vaults.menu.details"), icon: "edit" },
    { action: ctx.verify, label: t("adm.vaults.menu.verify"), icon: "checkc", csrf: ctx.csrf, fields: { vaultId: id } },
    { href: "/app/", label: t("adm.vaults.menu.openWeb"), icon: "ext" },
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
  const chip = vault?.primary === true ? ` · ${t("adm.vaults.badge.primary")}` : "";
  return `<div class="mc"><div class="b"><div class="nm"><b><a class="cell-link" href="${esc(href)}">${name}</a></b><span class="sub2">${tx(vault?.id)}${chip}</span></div><div class="meta">${stateCell(git)}</div></div>${rowMenu(vault, ctx)}</div>`;
}

// ------------------------------------------------------------------ drawer --

/**
 * Author label (#400): `{agent, model}` facts, never `[object Object]`. `authorText` is the raw form
 * for callers that must escape a whole line exactly once (e.g. a `title` attribute that also carries
 * a timestamp); `authorLabel` is the escaped form for HTML bodies.
 */
function authorText(author) {
  if (typeof author === "string") return author.trim() || t("adm.vaults.unknown");
  if (!author || typeof author !== "object" || Array.isArray(author)) return t("adm.vaults.unknown");
  const agent = typeof author.agent === "string" ? author.agent.trim() : "";
  const model = typeof author.model === "string" ? author.model.trim() : "";
  return [agent, model].filter(Boolean).join(" / ") || t("adm.vaults.unknown");
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
    ? `<div class="help">${t("adm.vaults.repo.noGit")}</div>`
    : `<div class="help mono">repository ${maybeText(git.repository)} · HEAD — · ${t("adm.vaults.repo.noSummary")}</div>`;
  const errorHelp = error && typeof error === "object"
    ? `<div class="help" style="color:var(--danger)">${tx(error.name || t("adm.vaults.error.readFailed"))}${shown(error.message) ? `：${tx(error.message)}` : ""}</div>`
    : "";

  const failures = Number.isInteger(push.consecutiveFailures) ? push.consecutiveFailures : null;
  const outcome = push.lastOutcome && typeof push.lastOutcome === "object" ? push.lastOutcome : null;
  const pushFacts = [
    outcome ? (outcome.pushed === true ? t("adm.vaults.push.pushed") : t("adm.vaults.push.failed")) : t("adm.vaults.push.none"),
    shown(outcome?.failureClass) ? tx(outcome.failureClass) : "",
    shown(outcome?.remote) ? tx(outcome.remote) : "",
    shown(outcome?.branch) ? tx(outcome.branch) : "",
    outcome && outcome.exitCode !== null && outcome.exitCode !== undefined ? `exit ${esc(String(outcome.exitCode))}` : "",
    shown(outcome?.summary) ? tx(outcome.summary) : "",
    failures === null ? t("adm.vaults.push.failuresNone") : t("adm.vaults.push.failures", { count: esc(String(failures)) }),
  ].filter(Boolean);

  const pending = git.pending ?? {};
  const count = pendingCount(git);
  const paths = Array.isArray(pending.paths) ? pending.paths : [];
  const authors = (Array.isArray(pending.authors) ? pending.authors : []).map(authorLabel);
  const dirtyFact = git.dirty === true ? `<span class="st amber"><span class="dot"></span>${esc(t("adm.vaults.pending.dirty"))}</span>`
    : git.dirty === false ? `<span class="st ok"><span class="dot"></span>${esc(t("adm.vaults.pending.clean"))}</span>` : "";
  const pendingMain = count === null ? MISSING : `<span class="muted">${esc(t("adm.vaults.pending.pathCount", { count }))}</span>`;
  const pendingHelp = [
    dirtyFact,
    shown(pending.since) ? t("adm.vaults.pending.since", { since: tx(pending.since) }) : "",
    authors.length ? t("adm.vaults.pending.authors", { authors: authors.join(" / ") }) : "",
  ].filter(Boolean).join(" · ");
  const pathsDetails = paths.length
    ? `<details style="margin-top:6px"><summary class="help" style="cursor:pointer">${esc(t("adm.vaults.pending.pathsTitle", { count: paths.length }))}</summary><pre class="mono" style="white-space:pre-wrap;color:var(--tx3);margin:8px 0 0">${paths.slice(0, 20).map((item) => tx(item)).join("\n")}${paths.length > 20 ? `\n${t("adm.vaults.pending.more", { count: paths.length })}` : ""}</pre></details>`
    : "";

  const timers = git.timers && typeof git.timers === "object" ? git.timers : null;
  const sweepOn = config.enabled === true && config.autoCommitSweep === true;
  const interval = Number(config.sweepIntervalSeconds);
  const mins = Number.isFinite(interval) && interval > 0 ? Math.max(1, Math.round(interval / 60)) : null;
  const sweepHead = sweepOn ? t("adm.vaults.timer.sweepEvery", { mins: esc(String(mins ?? "—")) }) : `<span class="muted">${esc(t("adm.vaults.timer.notRunning"))}</span>`;
  const timerFacts = timers
    ? [["commit", t("adm.vaults.num.debounce")], ["maxDelay", t("adm.vaults.num.maxDelay")], ["sweep", t("adm.vaults.timer.sweep")]]
      .map(([key, label]) => `${esc(label)} ${timers[key] === true ? t("adm.vaults.timer.armed") : t("adm.vaults.timer.notArmed")}`).join(" · ")
    : "";
  const sweepFacts = sweep && typeof sweep === "object"
    ? [
      shown(sweep.at) ? t("adm.vaults.timer.lastSweep", { at: tx(sweep.at) }) : "",
      sweep.committed === true ? t("adm.vaults.timer.committed") : sweep.committed === false ? t("adm.vaults.timer.noChanges") : "",
      shown(sweep.hash) ? tx(sweep.hash) : "",
      sweep.pushed === true ? t("adm.vaults.push.pushed") : sweep.pushed === false ? t("adm.vaults.push.notPushed") : "",
      shown(sweep.reason) ? tx(sweep.reason) : "",
    ].filter(Boolean).join(" · ")
    : "";

  const root = shown(vault?.root) ? `<span class="mono" style="word-break:break-all">${tx(vault.root)}</span>` : MISSING;
  const canonical = shown(vault?.canonicalRoot) && String(vault.canonicalRoot) !== String(vault?.root)
    ? `<div class="help mono">canonicalRoot ${tx(vault.canonicalRoot)}</div>` : "";

  const sourceToken = typeof git.configSource === "string" ? git.configSource.trim() : "";
  const sourceLabel = gitConfigSourceView()[sourceToken] ?? (sourceToken ? t("adm.vaults.source.unknownWith", { source: esc(sourceToken) }) : "");
  const source = sourceLabel
    ? `${esc(sourceLabel)}${sourceToken === "persisted" && shown(config.updatedAt) ? ` · ${relTitle(config.updatedAt)}` : ""}`
    : MISSING;

  return `<div class="kv">
<div class="k">${esc(t("adm.vaults.kv.repo"))}</div><div>${statePill(git.state)}${repoHelp}${errorHelp}</div>
<div class="k">${esc(t("adm.vaults.kv.lastPush"))}</div><div>${outcome && shown(outcome.at) ? relTitle(outcome.at) : MISSING} <span class="muted">· ${esc(t("adm.vaults.kv.aheadBehind"))}</span><div class="help">${pushFacts.join(" · ")}</div></div>
<div class="k">${esc(t("adm.vaults.kv.pending"))}</div><div>${pendingMain}${pendingHelp ? `<div class="help">${pendingHelp}</div>` : ""}${pathsDetails}</div>
<div class="k">${esc(t("adm.vaults.kv.directory"))}</div><div>${root}<div class="help" style="font-family:var(--font)">${esc(t("adm.vaults.kv.directoryHint"))}</div>${canonical}</div>
<div class="k">${esc(t("adm.vaults.kv.source"))}</div><div>${source}</div>
<div class="k">${esc(t("adm.vaults.kv.lastVerify"))}</div><div><span class="muted">—</span> <span class="help">${esc(t("adm.vaults.kv.lastVerifyHint"))}</span></div>
<div class="k">${esc(t("adm.vaults.kv.timers"))}</div><div>${sweepHead}${timerFacts ? `<div class="help">${timerFacts}</div>` : ""}${sweepFacts ? `<div class="help">${sweepFacts}</div>` : ""}</div>
</div>`;
}

/** `6-app.js` sw(): a `.li` row whose switch is a POST form (no JS ⇒ one field per submit). */
function switchRow(vault, ctx, key, label, help) {
  const on = vault?.git?.config?.[key] === true;
  const editable = vault?.editable === true && vault?.git?.config !== null && vault?.git?.config !== undefined;
  const title = editable
    ? t(on ? "adm.vaults.set.titleOn" : "adm.vaults.set.titleOff", { label })
    : t("adm.vaults.set.titleLocked", { label });
  const control = editable
    ? `<form class="inline-form" method="post" action="${esc(ctx.save)}"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}"><input type="hidden" name="vaultId" value="${esc(String(vault?.id ?? ""))}">${ctx.revision === null ? "" : `<input type="hidden" name="expectedRevision" value="${esc(String(ctx.revision))}">`}<input type="hidden" name="${esc(key)}" value="${on ? "false" : "true"}"><button class="switch${on ? " on" : ""}" type="submit" title="${esc(title)}" aria-label="${esc(title)}" aria-pressed="${on ? "true" : "false"}"></button></form>`
    : `<button class="switch${on ? " on" : ""}" type="button" disabled aria-pressed="${on ? "true" : "false"}" title="${esc(title)}"></button>`;
  return `<div class="li" style="min-height:52px"><div class="grow"><b>${esc(label)}</b> <span class="sub">${esc(key)}</span><div class="help">${esc(help)}</div></div>${control}</div>`;
}

function numberField(vault, key, label, min, max) {
  const config = vault?.git?.config ?? null;
  const value = config && Number.isInteger(config[key]) ? String(config[key]) : "";
  const disabled = vault?.editable !== true;
  const range = t("adm.vaults.num.range", { min, max });
  return `<div class="fld"><label>${esc(label)}</label><div style="display:flex;align-items:center;gap:6px"><input class="inp" type="number" name="${esc(key)}" min="${esc(String(min))}" max="${esc(String(max))}" value="${esc(value)}"${disabled ? " disabled" : ""}><span class="muted">${esc(t("adm.vaults.num.seconds"))}</span></div><span class="sub ell" title="${esc(`${key} · ${range}`)}">${esc(key)}</span></div>`;
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
    : `<p class="help" style="margin:0 0 8px">${esc(t("adm.vaults.set.locked"))}</p>`;
  const switches = settingSwitches().map(([key, label, help]) => switchRow(vault, ctx, key, label, help)).join("");
  const numbers = settingNumbers().map(([key, label, min, max]) => numberField(vault, key, label, min, max)).join("");
  const texts = settingTexts().map(([key, label, sub, hint, maxLength]) => textField(vault, key, label, sub, hint, maxLength)).join("");
  return `<div class="dsec"><h3>${esc(t("adm.vaults.set.title"))}</h3>${note}
<div class="list">${switches}</div>
<form method="post" action="${esc(ctx.save)}" id="git-settings-${esc(id)}"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}"><input type="hidden" name="vaultId" value="${esc(id)}">${revision}
<div class="grid3" style="margin-top:16px">${numbers}</div>
<div class="grid2" style="margin-top:12px">${texts}</div>
<div style="display:flex;gap:8px;margin-top:16px"><button class="btn primary" type="submit"${editable ? "" : " disabled"}>${esc(t("adm.vaults.set.save"))}</button><button class="btn" type="submit" form="git-verify-${esc(id)}"${editable ? "" : " disabled"}>${ic("checkc")}${esc(t("adm.vaults.menu.verify"))}</button></div></form>
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
    ? `<details style="margin-top:8px"><summary class="help" style="cursor:pointer">${esc(t("adm.authz.master.details"))}</summary><pre class="mono" style="white-space:pre-wrap;color:var(--tx3);margin:8px 0 0">${unwired.map((item) => esc(`${item.key}: available=false (${shown(item.reason) ? scrubCredentials(item.reason) : "unwired"})`)).join("\n")}</pre></details>`
    : "";
  return `<div class="dsec"><h3>${esc(t("adm.vaults.caps.title"))} <span class="muted" style="font-weight:400">${items.length ? esc(t("adm.vaults.caps.available", { available, total: items.length })) : esc(t("adm.authz.notProvided"))}</span></h3><div class="caps">${chips}</div>${hints ? `<div class="help" style="margin-top:8px">${hints}</div>` : ""}${details}</div>`;
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
  const action = postForm({ action: `${ctx.admission}/${operation}`, csrf: ctx.csrf, fields: { vaultId: vault.id }, label: operation === "revoke" ? t("adm.vaults.admission.revoke") : t("adm.vaults.admission.approve"), cls: "btn sm" });
  return `<div class="dsec"><h3>${esc(t("adm.vaults.admission.title"))}</h3><div class="kv"><div class="k">${esc(t("adm.vaults.admission.decision"))}</div><div>${maybeText(admission.admission)}</div><div class="k">${esc(t("adm.vaults.admission.status"))}</div><div>${maybeText(admission.status)}</div><div class="k">${esc(t("adm.vaults.admission.reason"))}</div><div>${maybeText(admission.reason)}</div><div class="k">${esc(t("adm.vaults.admission.servable"))}</div><div>${admission.servable === true ? esc(t("adm.vaults.yes")) : admission.servable === false ? esc(t("adm.vaults.no")) : MISSING}</div></div><div style="margin-top:12px">${action}</div></div>`;
}

/**
 * The managed reconciliation service (#437) is live, so the drawer states its facts instead of a
 * "planned" box: whether discovery runs, the last round and its outcome. Read-only by design — the
 * page never starts a round; the refresh action does that.
 */
function runtimeSection(vault, ctx) {
  const runtime = ctx.runtime;
  const heading = `<b style="font-weight:600">${esc(t("adm.vaults.section.runtime"))}</b>`;
  if (!runtime) {
    // Honest empty state: no managed service is wired in this deployment (discovery off, or the
    // legacy inventory path), so there is nothing to report and nothing to fake.
    return `<div class="dsec">${heading}<div class="help" style="margin-top:6px">${esc(t("adm.vaults.runtime.unmanaged"))}</div></div>`;
  }
  // The service publishes epoch milliseconds (`Date.now()`), never ISO strings: accept both, and
  // answer "never" only when there really is no timestamp.
  const iso = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
    if (typeof value === "string" && value) {
      const at = Date.parse(value);
      return Number.isFinite(at) ? new Date(at).toISOString() : null;
    }
    return null;
  };
  // relTitle() is markup (relative time + absolute in `title`), so it is inserted as-is; every
  // other value is escaped text.
  const when = (value) => {
    const at = iso(value);
    return at ? relTitle(at) : esc(t("adm.vaults.runtime.never"));
  };
  const seconds = Number.isFinite(runtime.periodicMs) && runtime.periodicMs > 0 ? Math.round(runtime.periodicMs / 1000) : null;
  const schedule = !runtime.periodic
    ? esc(t("adm.vaults.runtime.off"))
    : seconds === null ? esc(t("adm.vaults.runtime.on")) : esc(t("adm.vaults.runtime.scheduleOn", { seconds }));
  // `lastError` is `{stage, code, message}` from the service; a string is tolerated for older shapes.
  const errorText = (value) => {
    if (!value) return "";
    if (typeof value === "string") return esc(value);
    const parts = [value.code, value.message].filter((part) => typeof part === "string" && part);
    return esc(parts.length ? parts.join(" · ") : JSON.stringify(value));
  };
  const lines = [
    `${esc(t("adm.vaults.runtime.discovery"))}：<b>${esc(runtime.enabled ? t("adm.vaults.runtime.on") : t("adm.vaults.runtime.off"))}</b> · ${esc(t("adm.vaults.runtime.scheduleLabel"))} ${schedule}`,
    `${esc(t("adm.vaults.runtime.lastRound"))}：${esc(runtime.lastStatus || t("adm.vaults.runtime.none"))}${runtime.lastTrigger ? ` · ${esc(runtime.lastTrigger)}` : ""} · ${when(runtime.lastRunAt)} · ${esc(t("adm.vaults.runtime.lastRoundHelp", { runs: runtime.runs, failures: runtime.failures }))}`,
    `${esc(t("adm.vaults.runtime.lastSuccess"))}：${when(runtime.lastSuccessAt)}`,
  ];
  if (runtime.lastError) lines.push(`${esc(t("adm.vaults.runtime.lastError"))}：${errorText(runtime.lastError)}`);
  return `<div class="dsec">${heading}<div class="help" style="margin-top:6px">${lines.join("<br>")}</div></div>`;
}

/** The `?id=` drawer: 状态 / Git 同步设置 / 能力 / 准入 / 运行时. */
function detailPanel(vault, ctx) {
  const id = String(vault?.id ?? "");
  const heading = shown(vault?.name) ? vault.name : id;
  const body = [
    `<div class="dsec"><h3>${esc(t("adm.vaults.section.status"))}</h3>${statusKv(vault)}</div>`,
    settingsSection(vault, ctx),
    capabilitySection(vault),
    vaultAdmissionSection(vault, ctx),
    runtimeSection(vault, ctx),
  ];
  // Identity badges stay in the header where the prototype keeps them (`6-app.js:265` dhead): the
  // primary marker, plus the exception marker a read-only descriptor needs. The redundant half of
  // the old `角色` kv row is gone - the drawer's kv inventory is compared in both directions, and the
  // prototype has no `角色` row.
  const badges = `${vault?.primary === true ? `<span class="kind">${esc(t("adm.vaults.badge.primary"))}</span>` : ""}${vault?.writable === false ? `<span class="kind">${esc(t("adm.vaults.badge.readonly"))}</span>` : ""}`;
  return `<div class="scrim on" data-scrim></div><aside class="drawer on" id="vault-drawer-${esc(id)}" role="dialog" aria-modal="true" aria-label="${esc(heading)}"><header class="bar"><h1 class="ell">${tx(heading)}</h1><span class="mono muted">${tx(id)}</span>${badges}<span class="grow"></span><a class="ibtn" href="${esc(ctx.base)}" aria-label="${esc(t("adm.ui.close"))}">${ic("x")}</a></header><div class="dbody scroll">${body.join("")}</div></aside>`;
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
    runtime: ctx.runtime ?? null,
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
  const codeNote = shown(code) ? t("adm.vaults.repair.codeNote", { code: tx(code) }) : "";
  if (!view.repairWired) {
    const body = t("adm.vaults.repair.readonly", { code: codeNote });
    return banner(body, { tone: "danger" });
  }
  const body = t("adm.vaults.repair.banner", { href: esc(`${view.base}?confirm=repair`), code: codeNote });
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
    title: t("adm.vaults.repair.title"),
    bodyHtml: t("adm.vaults.repair.body"),
    listItems: [
      t("adm.vaults.repair.step.quarantine"),
      t("adm.vaults.repair.step.reset"),
      t("adm.vaults.repair.step.failure"),
    ],
    typed: repairConfirmText(),
    ok: t("adm.vaults.repairConfirm"),
    tone: "danger",
    backHref: view.base,
    action: view.repair,
    method: "post",
    csrf: view.csrf,
    footnote: t("adm.u.confirmFootnote"),
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
      ? postForm({ action: `${ctx.admission}/${operation}`, csrf: ctx.csrf, fields: { vaultId: vault.id }, label: operation === "revoke" ? t("adm.vaults.admission.revoke") : t("adm.vaults.admission.approve"), cls: "btn sm" })
      : `<span class="muted">${esc(t("adm.vaults.admission.waiting"))}</span>`;
    return `<tr><td class="mono">${tx(vault.id)}</td><td>${maybeText(state.admission)}</td><td>${maybeText(state.status)}</td><td>${maybeText(state.reason)}</td><td class="act">${action}</td></tr>`;
  });
  if (!admission.initialized) return "";
  return `<div class="sect" id="vault-admission"><div class="sect-h"><h2>${esc(t("adm.vaults.admission.section"))}</h2><span class="muted">${esc(t("adm.vaults.admission.initialized"))}</span></div>${table([["Vault", "24%"], [t("adm.vaults.admission.decision"), "16%"], [t("adm.vaults.admission.status"), "14%"], [t("adm.vaults.admission.reason"), "30%"], ["", "16%", "act"]], rows, "")}</div>`;
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
    title: t("adm.vaults.admissionInit.title"),
    bodyHtml: t("adm.vaults.admissionInit.body"),
    ok: t("adm.vaults.admissionInit.ok"),
    // Turning the gate ON is not destructive (the repair dialog's danger tone is for discarding a
    // broken store); the review asked for the honest tone, the geometry/cancel/Esc stay shared.
    tone: "primary",
    backHref: view.base,
    action: `${view.base}/admission/initialize`,
    method: "post",
    csrf: view.csrf,
    formHtml: `<div class="fld">${admissionConfirmChoices({ vaults: view.model?.vaults ?? [], text: esc })}</div>`,
    footnote: t("adm.vaults.admissionInit.footnote"),
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
  // Sorting is server state (`table-sort.js`); the list defaults to the Vault name.
  const sort = readSort(view.query ?? {}, ["vault", "git", "sync", "remote", "caps"], "vault");
  const sorted = sortRows(list, sort, {
    vault: (vault) => vault?.label || vault?.id || null,
    git: (vault) => (vault?.git?.enabled ? 1 : 0),
    sync: (vault) => (vault?.git?.autoCommit ? 1 : 0),
    remote: (vault) => vault?.git?.remote ?? null,
    caps: (vault) => (vault?.caps ? Object.values(vault.caps).filter(Boolean).length : 0),
  });
  const selectedId = typeof view.query.id === "string" ? view.query.id.trim() : "";
  const selected = selectedId ? list.find((vault) => String(vault?.id) === selectedId) ?? null : null;
  const detail = selectedId
    ? selected
      ? detailPanel(selected, view)
      : `<div class="scrim on" data-scrim></div><aside class="drawer on" id="vault-drawer-missing" role="dialog" aria-modal="true" aria-label="${esc(t("adm.vaults.missing.title"))}"><header class="bar"><h1>${esc(t("adm.vaults.missing.title"))}</h1><span class="grow"></span><a class="ibtn" href="${esc(view.base)}" aria-label="${esc(t("adm.ui.close"))}">${ic("x")}</a></header><div class="dbody">${emptyState("db", t("adm.vaults.missing.emptyTitle"), t("adm.vaults.missing.emptyBody"))}</div></aside>`
    : "";

  const refresh = `<form class="inline-form" method="post" action="${esc(view.refresh)}"><input type="hidden" name="csrf" value="${esc(view.csrf)}"><button class="btn" type="submit">${ic("refresh")}<span class="hide-m">${esc(t("adm.vaults.action.refresh"))}</span></button></form>`;
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
    ? `<a class="btn" href="${esc(`${view.base}?confirm=admission`)}">${ic("shield")}<span class="hide-m">${esc(t("adm.vaults.admissionInit.ok"))}</span></a>`
    : "";

  const unavailable = !model
    ? result(false, `${esc(t("adm.vaults.unavailable"))}${view.error ? `：${tx(view.error)}` : `：${esc(t("adm.vaults.unavailable.noModel"))}`}`)
    : "";

  const content = `${pageBar({ title: t("adm.nav.vaultGit"), count: model ? list.length : null, actions: `${refresh}${admissionEntry}` })}<div class="content scroll"><div class="page">
<p class="lede">${esc(t("adm.vaults.lede"))}</p>
${noticeLine(view.notice)}
${unavailable}
${model && broken ? brokenBanner(model, view) : ""}
${askRepair ? repairConfirmPage(view) : ""}
${askAdmission ? admissionConfirmPage(view) : ""}
${model ? table(vaultColumns(), sorted.map((vault) => row(vault, view)), emptyState("db", t("adm.vaults.empty.title"), t("adm.vaults.empty.body")), { ...sort, base: view.base }) : ""}
${model ? mcards(sorted.map((vault) => card(vault, view))) : ""}
${admissionListSection(list, model, view)}
<div class="sect futonly"><div class="futbox" style="display:flex;gap:12px;align-items:center"><div class="grow"><b style="font-weight:600">${esc(t("adm.vaults.github.title"))}</b> ${fut("Architecture TODO")}<div class="help">${esc(t("adm.vaults.github.body"))}</div></div><button class="btn" disabled>${esc(t("adm.vaults.github.add"))}</button></div></div>
</div></div>`;
  return { content, detailPanel: detail };
}

export { detailPanel as renderVaultDetailPanel };
