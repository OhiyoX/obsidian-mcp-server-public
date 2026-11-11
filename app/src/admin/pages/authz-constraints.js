// 定时授权 — the per-Vault constraint list and its `?id=` drawer (design §6.3, plan Task 6).
//
// One page, three facts the operator needs and nothing else:
//   * WHICH BACKEND DECIDES (ruling R8). `enforce` answers from these constraints, `legacy` and
//     `shadow` still answer from the legacy backend, and a mode that cannot be read is stated as
//     unreadable instead of guessed. The clause is a banner, driven by `authorizationMode` alone;
//   * the constraints of the live document, each with its Vault scope, its operations and the honest
//     now-verdict for its window. The verdict is computed HERE, on the server, from the stored
//     schedule (`policyNowState`, the frozen #434 presentation model). The browser computes nothing;
//   * the master switch (§6.7), as a real POST, with a warning banner while it is off — otherwise no
//     screen can say why every window the editor creates is inert.
//
// No script: CSP `default-src 'none'` on Admin pages. Every control is a link or a form; the drawer is
// reached by `?id=`, the editor by `?edit=` / `?new=1`.
//
// The window machinery is the frozen one, imported rather than copied: `presentAccessPolicyWindow`
// owns the summary text and the markers, `policyTimelineHtml` the 7-day grid, `policyNowState` the
// verdict. A constraint keeps its window under `schedule`, so `windowOf()` flattens it into the shape
// that model reads — one presentation, two documents.
import { pageBar, table, mcards, emptyState, banner, moreMenu, result, drawer, kv, esc, ic } from "../ui.js";
import { fmtFull, idc, relTitle } from "../presentation/format.js";
import { presentAccessPolicyWindow, WINDOW_SCOPE_DISCLAIMER } from "../access-policy-window-presentation.js";
import { t } from "../../i18n/context.js";
import { AUTHORIZATION_MODES, policyNowLabel, policyNowState, policyTimelineHtml } from "./authz.js";

/** Where this page lives (Task 5's `DEFAULT_BASE`); the frozen page links here. */
export const DEFAULT_BASE = "/admin/auth/authz";

/** The constraint field the drawer shows as the timezone: `schedule.timezone`, never a second copy. */
export function windowOf(constraint) {
  const schedule = constraint?.schedule ?? {};
  return {
    timezone: schedule.timezone,
    weekly: schedule.weekly,
    dateRanges: schedule.dateRanges,
    startsAt: schedule.startsAt,
    expiresAt: schedule.expiresAt,
  };
}

/**
 * The Vault scope of one constraint: `targets: null` is every Vault (§6.1, `constraintFromDraft`).
 * The page reads the FIRST branch, because that is the branch the editor writes and the branch the
 * importer builds for a Vault-scoped selector; extra branches keep their own targets and are counted,
 * never merged silently.
 */
export function scopeOf(constraint) {
  const branches = constraint?.selector?.anyOf ?? [];
  const targets = branches[0]?.targets ?? null;
  const ids = Array.isArray(targets) ? targets.filter((target) => target?.kind === "vault").map((target) => target.vaultId) : [];
  return {
    all: targets === null,
    ids,
    instance: Array.isArray(targets) && ids.length === 0,
    branches: branches.length,
  };
}

/** The operations one constraint restricts, across its branches; `null` = every operation. */
export function capabilitiesOf(constraint) {
  const branches = constraint?.selector?.anyOf ?? [];
  if (branches.some((branch) => branch?.capabilities === null)) return null;
  const seen = new Set();
  for (const branch of branches) for (const id of branch?.capabilities ?? []) seen.add(id);
  return [...seen].sort();
}

/** The surfaces the constraint is limited to; `null` = every surface. */
export function surfacesOf(constraint) {
  const branches = constraint?.selector?.anyOf ?? [];
  if (branches.some((branch) => branch?.surfaces === null)) return null;
  const seen = new Set();
  for (const branch of branches) for (const surface of branch?.surfaces ?? []) seen.add(surface);
  return [...seen].sort();
}

function vaultLabels(model) {
  return new Map((model?.vaults ?? []).map((vault) => [vault.id, vault.name]));
}

/** 全部 Vault / the Vault ids (with their names, when the registry knows them). */
export function scopeCell(model, constraint) {
  const scope = scopeOf(constraint);
  if (scope.all) return `<span class="tag amber">${esc(t("adm.authz2.scope.all"))}</span>`;
  if (scope.instance) return `<span class="tag">${esc(t("adm.authz2.scope.instance"))}</span>`;
  const names = vaultLabels(model);
  const chips = scope.ids.map((id) => {
    const name = names.get(id);
    return `<span class="tag" title="${esc(id)}"><span class="mono">${esc(id)}</span>${name ? ` <span class="muted">${esc(name)}</span>` : ""}</span>`;
  }).join("");
  const more = scope.branches > 1 ? ` <span class="muted">${esc(t("adm.authz2.scope.branches", { count: scope.branches }))}</span>` : "";
  return `<div class="tags">${chips}${more}</div>`;
}

/** 限制的操作: the operation ids, or the one fact that none is restricted. */
export function capabilitiesCell(model, constraint) {
  const operations = capabilitiesOf(constraint);
  const name = (id) => model?.presentation?.capName?.(id) || id;
  if (operations === null) return `<span class="tag amber">${esc(t("adm.authz2.caps.all"))}</span>`;
  if (!operations.length) return `<span class="muted">${esc(t("adm.authz2.caps.none"))}</span>`;
  const surfaces = surfacesOf(constraint);
  const marks = surfaces === null ? "" : surfaces.map((surface) => `<span class="tag">${esc(surface)}</span>`).join("");
  return `<div class="tags">${operations.map((id) => `<span class="tag mono" title="${esc(id)}">${esc(name(id))}</span>`).join("")}${marks}</div>`;
}

/** 全部操作 / 未选择 was already said in the editor; the atoms an imported constraint came from. */
export function atomChips(model, constraint) {
  const atoms = model?.importedAtoms?.[constraint.id] ?? [];
  if (!atoms.length) return "";
  return `<div class="tags" data-imported-atoms>${atoms.map((atom) => `<span class="tag acc readonly" title="${esc(atom)}">${esc(t("adm.authz2.atoms.label"))} <span class="mono">${esc(atom)}</span></span>`).join("")}</div>`;
}

/** 状态 · 模式 cell: enabled/disabled, and what an outside-the-window hit does. */
export function statusCell(model, constraint) {
  const enabled = constraint.enabled !== false;
  const mode = model.presentation.mode(constraint.mode);
  const status = enabled
    ? `<span class="st ok"><span class="dot"></span>${esc(t("adm.authz.status.enabled"))}</span>`
    : `<span class="st off"><span class="dot"></span>${esc(t("adm.authz.status.disabled"))}</span>`;
  return `${status}<div class="muted" style="font-size:13px" title="${esc(String(constraint.mode ?? ""))}">${esc(t("adm.authz.outsideWindow", { mode: mode.n }))}</div>`;
}

/** 主体 cell — name first, kind and short id second, an orphan marked, exactly as the frozen list. */
export function subjectsCell(model, constraint) {
  const subjects = Array.isArray(constraint.subjects) ? constraint.subjects : [];
  if (!subjects.length) return `<div class="nm" style="gap:2px"><span class="muted">${esc(t("adm.authz.noSubjects"))}</span></div>`;
  const rows = subjects.map((subject) => {
    const view = model.presentation.subjectView(subject);
    const orphan = view.missing ? ` <span class="tag danger">${esc(t("adm.authz.orphanTag"))}</span>` : "";
    return `<span class="ell" title="${esc(subject)}"><span class="${view.missing ? "muted" : ""}">${esc(view.name)}</span> <span class="muted">${esc(view.kindLabel)}</span>${orphan}</span>`;
  }).join("");
  return `<div class="nm" style="gap:2px">${rows}</div>`;
}

/** 允许时间窗口 cell: the frozen summary plus the server's now-verdict for this window. */
export function windowCell(constraint, now = Date.now()) {
  const flat = windowOf(constraint);
  const win = presentAccessPolicyWindow(flat);
  const marks = win.summary.markers.map((marker) => `<span class="tag">${esc(marker)}</span>`).join("");
  const state = policyNowState(flat, now);
  const colour = state.ok === true ? "var(--ok)" : state.ok === false ? "var(--amber)" : "var(--tx3)";
  const verdict = constraint.enabled === false
    ? ""
    : `<span style="color:${colour}" title="${esc(state.why)}">${esc(state.ok === true ? t("adm.authz.nowAllowed") : state.ok === false ? t("adm.authz.nowRestricted") : t("adm.authz.undetermined"))}</span>`;
  return `<div class="nm"><span class="ell">${esc(win.summary.text)}</span><span class="sub2">${marks}${verdict}</span></div>`;
}

/** Row ⋯ menu: the drawer and the editor, both plain links. */
export function rowMenu({ base, constraint }) {
  const id = encodeURIComponent(constraint.id);
  return moreMenu([
    { href: `${base}?id=${id}`, label: t("adm.authz.menu.view"), icon: "eye" },
    { href: `${base}?edit=${id}`, label: t("adm.authz2.menu.edit"), icon: "pencil" },
  ]);
}

/**
 * WHICH BACKEND DECIDES (ruling R8): the one sentence a reader must be able to trust.
 *
 * `data-authorization-mode` names the mode the request was served in and `data-decides` names the
 * backend the copy claims, so a test can pin both instead of matching prose. `enforce` is the only
 * mode where these constraints decide (`src/authorization/runtime.js`); `legacy` and `shadow` record
 * them and answer from the legacy backend, and a mode that cannot be read claims nothing.
 */
export function decidingBanner(authorizationMode = null) {
  const served = AUTHORIZATION_MODES.includes(String(authorizationMode ?? "")) ? String(authorizationMode) : null;
  const decides = decidesFor(authorizationMode);
  const tone = served === "enforce" ? "acc" : "amber";
  const key = served === null
    ? "adm.authz2.mode.unknown"
    : served === "enforce" ? "adm.authz2.mode.enforce" : "adm.authz2.mode.pending";
  return `<div class="banner ${tone}" data-authorization-mode="${esc(served ?? "unknown")}" data-decides="${esc(decides)}">${ic(served === "enforce" ? "shield" : "info")}<div>${t(key, { mode: esc(served ?? "—") })}</div></div>`;
}

/** The backend the page CLAIMS decides, from the mode it was served in (ruling R8). */
export function decidesFor(authorizationMode = null) {
  const served = AUTHORIZATION_MODES.includes(String(authorizationMode ?? "")) ? String(authorizationMode) : null;
  return served === "enforce" ? "constraints" : served === null ? "unknown" : "legacy";
}

/**
 * The master switch (§6.7) as a real POST, plus the warning banner while it is off.
 *
 * `timeConstraintsEnabled: null` means the service did not answer (unavailable or broken store): the
 * page then renders no switch at all, because a switch whose position is unknown would be a lie.
 */
export function planeBanner(model, { base, csrf }) {
  if (model?.timeConstraintsEnabled === null || model?.timeConstraintsEnabled === undefined) return "";
  const on = model.timeConstraintsEnabled === true;
  const revision = model.revision === null ? "" : String(model.revision);
  const form = `<form class="inline-form" method="post" action="${esc(`${base}/plane`)}">
<input type="hidden" name="csrf" value="${esc(csrf || "")}">
<input type="hidden" name="expectedRevision" value="${esc(revision)}">
<input type="hidden" name="enabled" value="${on ? "false" : "true"}">
<button class="btn sm ${on ? "" : "primary"}" type="submit">${esc(on ? t("adm.authz2.plane.disable") : t("adm.authz2.plane.enable"))}</button>
</form>`;
  const warning = on ? "" : `<div class="banner amber" data-plane-off>${ic("alert")}<div>${t("adm.authz2.plane.offBanner")}</div></div>`;
  return `<div class="banner ${on ? "acc" : ""}" data-plane="${on ? "on" : "off"}">${ic("shield")}<div style="flex:1">${t("adm.authz2.plane.banner", { state: esc(on ? t("adm.authz2.plane.on") : t("adm.authz2.plane.off")), revision: esc(revision || t("adm.authz.notProvided")) })}</div>${form}</div>${warning}`;
}

/** The store could not be read, or this deployment wired no service: say which, and offer nothing. */
function serviceBanner(model) {
  if (model.available === false) {
    return banner(t("adm.authz2.unavailable"), { tone: "amber" });
  }
  if (model.status === "broken") {
    const detail = model.error ? `（${esc(String(model.error).slice(0, 200))}）` : "";
    return banner(`${t("adm.authz2.broken")}${detail}`, { tone: "danger" });
  }
  return "";
}

/** The `?id=` drawer: the stored constraint, read-only facts plus the three writes. */
function constraintDrawer(ctx, constraint) {
  const { model, base, csrf, now = Date.now(), authorizationMode = null } = ctx;
  const flat = windowOf(constraint);
  const win = presentAccessPolicyWindow(flat);
  const state = policyNowState(flat, now);
  const enabled = constraint.enabled !== false;
  const mode = model.presentation.mode(constraint.mode);
  const revision = model.revision === null ? "" : String(model.revision);
  const subjects = Array.isArray(constraint.subjects) ? constraint.subjects : [];
  const subjectHtml = subjects.length
    ? `<div class="selrow">${subjects.map((subject) => {
      const view = model.presentation.subjectView(subject);
      const orphan = view.missing ? ` <span class="tag danger">${esc(t("adm.authz.orphanTag"))}</span>` : "";
      return `<span class="pill" title="${esc(subject)}"><span class="kind">${esc(view.kindLabel)}</span>${esc(view.name)} <span class="mono muted">${esc(view.shortId)}</span>${orphan}</span>`;
    }).join("")}</div>`
    : `<p class="help" style="margin:0">${esc(t("adm.authz.noSubjects"))}</p>`;
  const marks = win.summary.markers.map((marker) => `<span class="tag" style="margin:4px 4px 0 0">${esc(marker)}</span>`).join("");
  const post = (endpoint, fields, label, cls = "btn", extra = "") => `<form class="inline-form" method="post" action="${esc(`${base}/${endpoint}`)}"><input type="hidden" name="csrf" value="${esc(csrf || "")}"><input type="hidden" name="expectedRevision" value="${esc(revision)}">${fields}<button class="${esc(cls)}" type="submit">${esc(label)}</button>${extra}</form>`;
  const bodyHtml = `${decidingBanner(authorizationMode)}
<div class="dsec"><h3>${esc(t("adm.authz.drawer.sectionPolicy"))}</h3>${kv([
    [t("adm.authz.drawer.kv.id"), idc(constraint.id, constraint.id)],
    [t("adm.authz.drawer.kv.label"), esc(constraint.label)],
    [t("adm.authz.drawer.kv.status"), enabled ? `<span class="st ok"><span class="dot"></span>${esc(t("adm.authz.status.enabled"))}</span>` : `<span class="st off"><span class="dot"></span>${esc(t("adm.authz.status.disabled"))}</span>`],
    [t("adm.authz.drawer.kv.mode"), `${esc(mode.n)} <span class="mono muted">${esc(String(constraint.mode ?? ""))}</span>`],
    [t("adm.authz2.drawer.kv.scope"), scopeCell(model, constraint)],
    [t("adm.authz.drawer.kv.revision"), model.revision === null ? `<span class="muted">${esc(t("adm.authz.notProvided"))}</span>` : `<span class="mono">${esc(String(model.revision))}</span>`],
    [t("adm.authz.drawer.kv.created"), esc(fmtFull(constraint.createdAt))],
    [t("adm.authz.drawer.kv.updated"), `${relTitle(constraint.updatedAt, now)} <span class="muted mono">${esc(fmtFull(constraint.updatedAt))}</span>`],
  ])}</div>
<div class="dsec"><h3>${esc(t("adm.authz.drawer.sectionSubjects"))} <span class="muted" style="font-weight:400">${subjects.length}</span></h3>${subjectHtml}</div>
<div class="dsec"><h3>${esc(t("adm.authz2.col.caps"))}</h3>${capabilitiesCell(model, constraint)}
${atomChips(model, constraint)}${model.importedAtoms?.[constraint.id]?.length ? `<p class="help">${esc(t("adm.authz2.atoms.hint"))}</p>` : ""}</div>
<div class="dsec"><h3>${esc(t("adm.authz.drawer.sectionWindow"))}</h3><div class="sumbox"><b>${esc(win.summary.text)}</b>${marks ? `<div>${marks}</div>` : ""}<div class="muted" style="margin-top:4px">${esc(WINDOW_SCOPE_DISCLAIMER)}</div></div><div style="margin-top:16px">${policyTimelineHtml(flat, now)}</div>
<div class="verdict ${state.ok === true ? "ok" : state.ok === false ? "no" : ""}" style="margin-top:12px">${ic(state.ok === false ? "ban" : "checkc")}<span>${esc(t("adm.authz.drawer.now"))} ${esc(policyNowLabel(flat, now))} <span class="mono">${esc(String(flat.timezone ?? ""))}</span> <b>${esc(state.ok === true ? t("adm.authz.drawer.allowedAccess") : state.ok === false ? mode.n : t("adm.authz.undetermined"))}</b> · ${esc(state.why)}</span></div></div>`;
  const footHtml = `<a class="btn ghost" href="${esc(base)}">${esc(t("adm.ui.close"))}</a><span class="grow"></span>
<a class="btn" href="${esc(`${base}?edit=${encodeURIComponent(constraint.id)}`)}">${esc(t("adm.authz2.menu.edit"))}</a>
${post("toggle", `<input type="hidden" name="id" value="${esc(constraint.id)}"><input type="hidden" name="enabled" value="${enabled ? "false" : "true"}">`, enabled ? t("adm.authz2.action.disable") : t("adm.authz2.action.enable"))}
${post("delete", `<input type="hidden" name="id" value="${esc(constraint.id)}">`, t("adm.authz2.action.delete"), "btn danger-o")}`;
  return drawer({
    title: constraint.label,
    subtitle: `${enabled ? t("adm.authz.status.enabled") : t("adm.authz.status.disabled")} · ${mode.n}`,
    closeHref: base,
    bodyHtml,
    footHtml,
  });
}

/**
 * `renderAuthzPage(model, { base, query, now, authorizationMode, csrf, failure })`.
 *
 * `model` is `catalog.constraintPage`: the constraint document, the admitted Vaults, the operation
 * catalog and the shared presentation model. Nothing here reads a store.
 */
export function renderAuthzPage(model, {
  base = DEFAULT_BASE, query = {}, now = Date.now(), authorizationMode = null, csrf = "", legacyBase = null, failure = "",
} = {}) {
  const constraints = Array.isArray(model?.constraints) ? model.constraints : [];
  const pageBase = String(base || DEFAULT_BASE).replace(/\/+$/, "");
  const rows = constraints.map((constraint) => `<tr class="click ${constraint.enabled !== false ? "" : "dim"}">
<td><a class="cell-link block" href="${esc(`${pageBase}?id=${encodeURIComponent(constraint.id)}`)}"><div class="nm"><b>${esc(constraint.label)}</b><span class="sub2">${idc(constraint.id)}<span>${t("adm.authz.row.updatedAt", { time: relTitle(constraint.updatedAt, now) })}</span></span></div></a></td>
<td>${statusCell(model, constraint)}</td>
<td>${subjectsCell(model, constraint)}</td>
<td>${scopeCell(model, constraint)}</td>
<td>${capabilitiesCell(model, constraint)}${atomChips(model, constraint)}</td>
<td>${windowCell(constraint, now)}</td>
<td class="act">${rowMenu({ base: pageBase, constraint })}</td></tr>`);
  const cards = constraints.map((constraint) => `<div class="mc"><div class="b"><div class="nm"><a class="cell-link block" href="${esc(`${pageBase}?id=${encodeURIComponent(constraint.id)}`)}"><b>${esc(constraint.label)}</b></a><span class="sub2">${esc(t("adm.authz.drawer.subtitle", { status: constraint.enabled !== false ? t("adm.authz.status.enabled") : t("adm.authz.status.disabled"), mode: model.presentation.mode(constraint.mode).n }))}</span></div>${scopeCell(model, constraint)}<div class="meta">${(Array.isArray(constraint.subjects) ? constraint.subjects : []).map((subject) => `<span>${esc(model.presentation.subjectView(subject).name)}</span>`).join("")}</div></div>${rowMenu({ base: pageBase, constraint })}</div>`);
  const writable = model?.status === "ready";
  const empty = emptyState(
    "cal",
    constraints.length ? t("adm.authz2.empty.noMatch") : t("adm.authz2.empty.none"),
    t("adm.authz2.empty.hint"),
    writable ? `<a class="btn primary" href="${esc(`${pageBase}?new=1`)}">${esc(t("adm.authz2.new"))}</a>` : "",
  );
  const columns = [
    [t("adm.authz2.col.constraint"), "20%", "", ""],
    [t("adm.authz.col.status"), "12%", "", ""],
    [t("adm.authz.col.subjects"), "18%", "", ""],
    [t("adm.authz2.col.scope"), "14%", "", ""],
    [t("adm.authz2.col.caps"), "16%", "", ""],
    [t("adm.authz.col.window"), "20%", "", ""],
    ["", "", "act", ""],
  ];
  const notice = failure ? result(false, esc(String(failure))) : "";
  const newAction = writable
    ? `<a class="btn primary" href="${esc(`${pageBase}?new=1`)}">${ic("plus")}<span class="hide-m">${esc(t("adm.authz2.new"))}</span></a>`
    : "";
  // The frozen legacy page, as a plain read-only link (Task 7 item B): the sidebar leads here, so the
  // history must stay reachable from here instead of from a nav entry that looks editable.
  const legacyAction = legacyBase
    ? `<a class="btn ghost" href="${esc(legacyBase)}">${esc(t("adm.authz2.legacyLink"))}</a>`
    : "";

  // The drawer, or a missing-constraint drawer: the editor is `?edit=`, and it belongs to the editor
  // module, so this list page never renders a form for a constraint.
  const wanted = typeof query.id === "string" && query.id.trim() ? query.id.trim() : "";
  const selected = wanted ? constraints.find((constraint) => constraint.id === wanted) ?? null : null;
  const detailPanel = selected
    ? constraintDrawer({ model, base: pageBase, csrf, now, authorizationMode }, selected)
    : wanted
      ? drawer({
        title: t("adm.authz.missingTitle"),
        closeHref: pageBase,
        bodyHtml: `<div class="dsec">${emptyState("cal", t("adm.authz.missingEmptyTitle"), t("adm.authz.missingBody"), `<a class="btn" href="${esc(pageBase)}">${esc(t("adm.authz.backToList"))}</a>`)}</div>`,
      })
      : "";

  const content = `${pageBar({ title: t("adm.nav.accessPolicy"), count: constraints.length, actions: `${legacyAction}${newAction}` })}<div class="content scroll"><div class="page wide">
${notice}
${decidingBanner(authorizationMode)}
${planeBanner(model, { base: pageBase, csrf })}
${serviceBanner(model)}
${table(columns, rows, empty)}${mcards(cards)}
</div></div>`;
  return { content, detailPanel };
}
