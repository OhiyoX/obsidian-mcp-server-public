// 定时授权 — the per-Vault constraint editor (design §6.3, §6.7; plan Task 6).
//
// The prototype's editor shape, with one new control: the Vault scope. `.ped` / `.ped-form` /
// `.ped-side` and the labels, the weekday grid (`wrow`), the date-range rows (`drow`) and the
// timezone list are the prototype's own vocabulary (`docs/admin-ui-proto/src/5-render.js`,
// `renderPolicyEditor`); what the operator can pick is the new model's vocabulary:
//
//   * Vault scope: 全部 Vault (`vaultIds=all`) or one or more Vaults, in ONE `<select multiple>`;
//   * the capability picker speaks OPERATIONS, not legacy atoms (design §6.3): a constraint stores
//     catalog operation ids and cannot store `tool:write_note`, so the picker offers the catalog's
//     operations grouped by surface, and an imported constraint shows the atom it came from as a
//     read-only chip (the atom is read from the legacy store by the constraint's own id);
//   * the master switch stays on the list page (§6.7); here it is only reported, because a window
//     created while the plane is off is inert and the operator must know that before saving.
//
// No script (CSP `default-src 'none'`): the form is a real POST, every add/remove is a real control
// in it — a chosen operation is a checkbox, an unchosen one is an option in the picker, and the
// picker's value joins the checked set server-side on save (`decodeConstraintDraft` reads both).
// The draft travels in the form, so nothing typed here needs a round trip to survive.
//
// The verdict on the right is the SERVER's: `policyNowState` over the draft's own schedule. The
// browser never computes it (the same rule as the list page), and the card carries no form at all —
// a read-only preview cannot promise a save.
import { pageBar, banner, field, kv, esc, ic, checkRow } from "../ui.js";
import { idc } from "../presentation/format.js";
import { t } from "../../i18n/context.js";
import { presentAccessPolicyWindow, WINDOW_SCOPE_DISCLAIMER, WINDOW_DAY_LABELS, WINDOW_DAY_KEYS } from "../access-policy-window-presentation.js";
import { zonedParts } from "../presentation/model.js";
import { MODE } from "../presentation/vocab.js";
import { policyNowLabel, policyNowState, policyTimelineHtml } from "./authz.js";
import { DEFAULT_BASE, atomChips, capabilitiesOf, decidesFor, decidingBanner, scopeOf, surfacesOf, windowOf } from "./authz-constraints.js";

/** The prototype's timezone list (`docs/admin-ui-proto/src/4-data.js`: `TIMEZONES`). */
export const TIMEZONES = Object.freeze([
  "Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore", "Europe/London", "Europe/Berlin",
  "America/New_York", "America/Los_Angeles", "UTC",
]);

/** ISO instant -> the wall clock `datetime-local` shows, in the constraint's own zone. */
function wallClock(iso, zone) {
  if (!iso) return "";
  const parts = zone ? zonedParts(iso, zone) : null;
  return parts ? `${parts.date}T${parts.hm}` : "";
}

/**
 * The draft the form renders. A stored constraint is `windowOf`-flattened so the schedule fields sit
 * where the prototype puts them; a new one starts with the service's own defaults (`enabled`, one
 * empty slot per day) rather than with a window nobody chose.
 *
 * A stored value is carried WHOLE, never filtered down to what this page can rewrite: `capabilities`
 * stays `null` for "every operation", the scope keeps an unadmitted Vault id, and `surfaces` is the
 * stored set. Dropping either is the silent rewrite this page must not do — `unexpressible` names
 * the states the controls cannot express instead.
 */
export function draftOf(constraint = null) {
  const flat = constraint ? windowOf(constraint) : { timezone: "Asia/Shanghai", weekly: {}, dateRanges: [], startsAt: null, expiresAt: null };
  const scope = constraint ? scopeOf(constraint) : { all: true, ids: [] };
  return {
    id: constraint?.id ?? null,
    label: constraint?.label ?? "",
    enabled: constraint?.enabled !== false,
    mode: constraint?.mode ?? "suspend",
    subjects: Array.isArray(constraint?.subjects) ? constraint.subjects : [],
    capabilities: constraint ? capabilitiesOf(constraint) : [],
    scope: scope.all ? ["all"] : scope.ids,
    surfaces: constraint ? surfacesOf(constraint) : null,
    timezone: typeof flat.timezone === "string" ? flat.timezone : "Asia/Shanghai",
    weekly: flat.weekly && typeof flat.weekly === "object" ? flat.weekly : {},
    dateRanges: Array.isArray(flat.dateRanges) ? flat.dateRanges : [],
    startsAt: flat.startsAt ?? null,
    expiresAt: flat.expiresAt ?? null,
  };
}

/** One row per stored slot plus one spare: an empty slot is dropped by the route's decoder. */
function weeklyRows(draft) {
  const most = Math.max(1, ...WINDOW_DAY_KEYS.map((day) => (Array.isArray(draft.weekly?.[day]) ? draft.weekly[day].length : 0) + 1));
  const rows = [];
  for (const day of WINDOW_DAY_KEYS) {
    const stored = Array.isArray(draft.weekly?.[day]) ? draft.weekly[day] : [];
    for (let index = 0; index < most; index += 1) {
      const slot = stored[index] ?? ["", ""];
      rows.push(`<div class="wrow"><span class="lab">${index === 0 ? esc(WINDOW_DAY_LABELS[day]) : ""}</span><input class="inp" type="time" name="w_${day}_from_${index}" value="${esc(slot[0] ?? "")}" aria-label="${esc(`${WINDOW_DAY_LABELS[day]} ${t("adm.authz2.editor.from")}`)}"><span class="muted" style="text-align:center">–</span><input class="inp" type="time" name="w_${day}_to_${index}" value="${esc(slot[1] ?? "")}" aria-label="${esc(`${WINDOW_DAY_LABELS[day]} ${t("adm.authz2.editor.to")}`)}"></div>`);
    }
  }
  return rows.join("");
}

/** The stored date ranges plus one spare pair. */
function rangeRows(draft) {
  const rows = [];
  for (let index = 0; index <= draft.dateRanges.length; index += 1) {
    const range = draft.dateRanges[index] ?? { from: "", to: "" };
    rows.push(`<div class="drow"><input class="inp" type="date" name="range_from_${index}" value="${esc(range.from ?? "")}" aria-label="${esc(t("adm.authz2.editor.rangeFrom"))}"><span class="muted" style="text-align:center">–</span><input class="inp" type="date" name="range_to_${index}" value="${esc(range.to ?? "")}" aria-label="${esc(t("adm.authz2.editor.rangeTo"))}"></div>`);
  }
  return rows.join("");
}

/** The operation picker: one option per catalog operation, grouped under the surface it runs on. */
export function operationPicker(operations = [], { chosen = [] } = {}) {
  const taken = new Set(chosen ?? []);
  const groups = new Map();
  for (const operation of operations) {
    if (taken.has(operation.id)) continue;
    const list = groups.get(operation.surface) ?? [];
    list.push(operation);
    groups.set(operation.surface, list);
  }
  const options = [...groups.entries()].map(([surface, list]) => `<optgroup label="${esc(t("adm.authz2.surface", { surface }))}">${list.map((operation) => `<option value="${esc(operation.id)}">${esc(operation.label)}</option>`).join("")}</optgroup>`).join("");
  return `<select class="sel" name="addOperation" data-operation-picker aria-label="${esc(t("adm.authz2.editor.pickOp"))}"><option value="">${esc(t("adm.authz2.editor.pickOp"))}</option>${options}</select>`;
}

/** Every surface the catalog's operations run on: the whole list, so the choice is not a guess. */
function surfaceChoices(model, form) {
  const offered = [...new Set((model?.operations ?? []).flatMap((operation) => operation.surfaces ?? []))].sort();
  const ticked = new Set(Array.isArray(form.surfaces) ? form.surfaces : []);
  const rows = offered.map((surface) => checkRow({ name: "surfaces", value: surface, checked: ticked.has(surface), title: t("adm.authz2.surface", { surface }) })).join("");
  return `<div class="fld" style="margin-top:8px"><span class="l">${esc(t("adm.authz2.editor.surfaces"))} <span class="muted">${esc(t("adm.authz2.editor.surfacesHint"))}</span></span><div class="pick-list" data-surface-scope>${rows}</div></div>`;
}

/**
 * The stored states this editor cannot write (design §6.3): every operation (`capabilities: null`,
 * what the `all` / `surface:*` atoms import to), an instance target, a Vault the registry no longer
 * admits, and more than one selector branch. One save from a form that cannot express them would
 * rewrite them into something else, so the page names each reason and offers delete only.
 */
function unexpressible(model, constraint) {
  if (!constraint?.id) return [];
  const reasons = [];
  if (capabilitiesOf(constraint) === null) reasons.push(t("adm.authz2.locked.everyOperation"));
  const scope = scopeOf(constraint);
  if (scope.instance) reasons.push(t("adm.authz2.locked.instance"));
  const admitted = new Set((model?.vaults ?? []).map((vault) => vault.id));
  const gone = scope.ids.filter((id) => !admitted.has(id));
  if (gone.length) reasons.push(t("adm.authz2.locked.vaultGone", { ids: esc(gone.join(" · ")) }));
  if (scope.branches > 1) reasons.push(t("adm.authz2.locked.branches", { count: esc(String(scope.branches)) }));
  return reasons;
}

/**
 * The subject picker: every subject the snapshot offers, the chosen ones ticked — plus a stored
 * subject the snapshot no longer lists (a deleted account, a changed id), ticked, marked with the
 * danger tag and the reason. That row is the whole of C1: without it the field posts nothing, the
 * route stores `[]`, and a constraint that matched one subject matches nobody.
 */
function subjectPicker(model, draft) {
  const subjects = Array.isArray(model?.subjects) ? model.subjects : [];
  const stored = Array.isArray(draft.subjects) ? draft.subjects : [];
  const orphans = stored.filter((subject) => !subjects.includes(subject));
  if (!subjects.length && !orphans.length) return `<p class="help" style="margin:0">${esc(t("adm.authz2.editor.noSubjects"))}</p>`;
  const list = subjects.map((subject) => {
    const view = model.presentation.subjectView(subject);
    return checkRow({ name: "subjects", value: subject, checked: stored.includes(subject), title: view.name, detail: view.kindLabel, mono: view.shortId });
  }).join("") + orphans.map((subject) => checkRow({
    name: "subjects",
    value: subject,
    checked: true,
    title: subject,
    detail: `<span class="tag danger">${esc(t("adm.authz.orphanTag"))}</span> ${esc(t("adm.authz2.editor.orphanSubject"))}`,
  })).join("");
  return `<div class="pick-list scroll" data-subject-picker>${list}</div>`;
}

/** The chosen operations as removable checkboxes plus any id the catalog does not know. */
function chosenOperations(model, draft) {
  if (draft.mode === "revoke") return `<p class="help" style="margin:0">${esc(t("adm.authz2.editor.revokeNote"))}</p>`;
  // `null` is every operation (an imported `all` / `surface:*` atom), not "none chosen": saying
  // 「还没有选择操作」 here would be the exact opposite of the stored constraint.
  if (draft.capabilities === null) return `<p class="help" style="margin:0" data-every-operation><b>${esc(t("adm.authz2.caps.all"))}</b> · ${esc(t("adm.authz2.editor.everyOperation"))}</p>`;
  const chosen = Array.isArray(draft.capabilities) ? draft.capabilities : [];
  if (!chosen.length) return `<p class="help" style="margin:0">${esc(t("adm.authz2.editor.noOps"))}</p>`;
  const name = (id) => model?.presentation?.capName?.(id) || id;
  const rows = chosen.map((id) => checkRow({ name: "capabilities", value: id, checked: true, title: name(id), detail: "", mono: id })).join("");
  return `<div class="pick-list scroll" data-chosen-operations>${rows}</div>`;
}

/**
 * The preview card (Q11's payback, ruling R9): read-only, server-computed, and it says which backend
 * decides. It carries no form, no `<button>` and no input — a preview that could be submitted would
 * be a save the page cannot perform.
 */
function previewCard(model, draft, { authorizationMode, now }) {
  const flat = windowOf({ schedule: { timezone: draft.timezone, weekly: draft.weekly, dateRanges: draft.dateRanges, startsAt: draft.startsAt, expiresAt: draft.expiresAt } });
  const win = presentAccessPolicyWindow(flat);
  const state = policyNowState(flat, now);
  const mode = MODE[draft.mode] ?? MODE.suspend;
  const caps = draft.mode === "revoke" || draft.capabilities === null
    ? t("adm.authz2.caps.all")
    : (draft.capabilities ?? []).map((id) => model?.presentation?.capName?.(id) || id).join(esc(t("adm.ui.listSeparator"))) || t("adm.authz2.editor.noOps");
  const marks = win.summary.markers.map((marker) => `<span class="tag" style="margin:4px 4px 0 0">${esc(marker)}</span>`).join("");
  return `<aside class="ped-side" data-preview="constraints"><div class="stick">
<div class="sect-h"><h2>${esc(t("adm.authz2.editor.preview"))}</h2><span class="muted">${esc(draft.timezone)}</span></div>
<div class="sumbox"><b>${esc(win.summary.text)}</b>${marks ? `<div>${marks}</div>` : ""}<div style="margin-top:4px">${esc(t("adm.authz.editor.outsideWindowLabel"))} <b>${esc(mode.n)}</b> ${esc(caps)}</div></div>
<div class="muted" style="margin-top:4px">${esc(WINDOW_SCOPE_DISCLAIMER)}</div>
<div style="margin-top:16px" data-preview-timeline>${policyTimelineHtml(flat, now)}</div>
<div class="verdict ${state.ok === true ? "ok" : state.ok === false ? "no" : ""}" style="margin-top:12px">${ic(state.ok === false ? "ban" : "checkc")}<span>${esc(t("adm.authz.drawer.now"))} ${esc(policyNowLabel(flat, now))} <b>${esc(state.ok === true ? t("adm.authz.drawer.allowedAccess") : state.ok === false ? mode.n : t("adm.authz.undetermined"))}</b> · ${esc(state.why)}</span></div>
<p class="help" data-preview-decides="${esc(decidesFor(authorizationMode))}" style="margin:12px 0 0">${esc(t("adm.authz2.preview.readonly"))} ${esc(t("adm.authz2.preview.stored"))}</p>
</div></aside>`;
}

/**
 * `renderAuthzConstraintsEditor(model, { base, draft, constraint, now, authorizationMode, csrf, failure })`.
 *
 * `draft` is the current state of the form (a stored constraint or a new one); `constraint` is the
 * stored record when one is open, so the form can post to `/update` with its id and the page can
 * offer delete. The form submits to the route module, which owns every validity rule.
 */
export function renderAuthzConstraintsEditor(model, {
  base = DEFAULT_BASE, draft = null, constraint = null, now = Date.now(), authorizationMode = null, csrf = "", failure = "",
} = {}) {
  const pageBase = String(base || DEFAULT_BASE).replace(/\/+$/, "");
  const form = draft ?? draftOf(constraint);
  const editing = Boolean(constraint?.id);
  const revision = model?.revision === null || model?.revision === undefined ? "" : String(model.revision);
  const writable = model?.status === "ready";
  const revoke = form.mode === "revoke";
  const vaults = Array.isArray(model?.vaults) ? model.vaults : [];
  const operations = Array.isArray(model?.operations) ? model.operations : [];
  const scopeAll = (form.scope ?? []).includes("all");
  // A stored state the controls cannot express is named, and the save stays off: the three writes
  // that are left (toggle on the page, delete here) do not rewrite the selector at all.
  const reasons = unexpressible(model, constraint);
  const lockedHtml = reasons.length ? banner(`${t("adm.authz2.locked.lead")} ${reasons.join(" ")} ${t("adm.authz2.locked.deleteOnly")}`, { tone: "danger" }) : "";
  const planes = model?.timeConstraintsEnabled === true ? "" : banner(t("adm.authz2.editor.planeOff"), { tone: "amber" });
  const notice = failure ? banner(esc(String(failure)), { tone: "danger" }) : "";
  const timezoneOptions = [...new Set([...TIMEZONES, ...(typeof form.timezone === "string" && form.timezone && !TIMEZONES.includes(form.timezone) ? [form.timezone] : [])])]
    .map((zone) => `<option value="${esc(zone)}"${zone === form.timezone ? " selected" : ""}>${esc(zone)}</option>`).join("");
  const vaultOptions = `<option value="all"${scopeAll ? " selected" : ""}>${esc(t("adm.authz2.scope.all"))}</option>${vaults.map((vault) => `<option value="${esc(vault.id)}"${!scopeAll && (form.scope ?? []).includes(vault.id) ? " selected" : ""}>${esc(vault.name)} · ${esc(vault.id)}</option>`).join("")}`;
  const action = editing ? `${pageBase}/update` : `${pageBase}/create`;
  const post = (endpoint, fields, label, cls = "btn danger-o") => `<form class="inline-form" method="post" action="${esc(`${pageBase}/${endpoint}`)}"><input type="hidden" name="csrf" value="${esc(csrf || "")}"><input type="hidden" name="expectedRevision" value="${esc(revision)}"><input type="hidden" name="id" value="${esc(constraint?.id ?? "")}">${fields}<button class="${esc(cls)}" type="submit">${esc(label)}</button></form>`;

  const content = `${pageBar({
    crumb: { href: pageBase, label: t("adm.nav.accessPolicy") },
    title: editing ? String(constraint.label || t("adm.authz2.editor.untitled")) : t("adm.authz2.new"),
    actions: editing ? idc(constraint.id) : "",
  })}<div class="content scroll">
${notice}
${decidingBanner(authorizationMode)}
${lockedHtml}
${planes}
<div class="ped"><form class="ped-form" id="authz-constraint" method="post" action="${esc(action)}">
<input type="hidden" name="csrf" value="${esc(csrf || "")}">
<input type="hidden" name="expectedRevision" value="${esc(revision)}">
${editing ? `<input type="hidden" name="id" value="${esc(constraint.id)}">` : ""}
<fieldset class="fs"><legend>${esc(t("adm.authz2.editor.fs.basic"))}</legend>
<div class="grid2">
${field(t("adm.authz2.editor.label"), `<input class="inp" name="label" value="${esc(form.label)}" placeholder="${esc(t("adm.authz2.editor.labelPh"))}" maxlength="120" required>`)}
${field(t("adm.authz2.editor.status"), `<label class="switch${form.enabled ? " on" : ""}" title="${esc(t("adm.authz2.editor.enabled"))}"><input type="hidden" name="enabled" value="false"><input type="checkbox" name="enabled" value="true"${form.enabled ? " checked" : ""} aria-label="${esc(t("adm.authz2.editor.enabled"))}"></label>`)}
</div>
${field(t("adm.authz2.editor.mode"), `<select class="sel" name="mode" aria-label="${esc(t("adm.authz2.editor.mode"))}">${["suspend", "revoke"].map((mode) => `<option value="${esc(mode)}"${form.mode === mode ? " selected" : ""}>${esc(`${MODE[mode].n} · ${mode}`)}</option>`).join("")}</select>`, { hint: revoke ? t("adm.authz2.editor.revokeNote") : t("adm.authz2.editor.modeHint") })}
</fieldset>
<fieldset class="fs"><legend>${esc(t("adm.authz2.editor.fs.scope"))} <span class="muted">${esc(t("adm.authz2.editor.scopeHint"))}</span></legend>
${revoke ? banner(t("adm.authz2.editor.revokeScope"), { tone: "amber" }) : `<select class="inp" name="vaultIds" multiple size="${Math.min(8, Math.max(3, vaults.length + 1))}" aria-label="${esc(t("adm.authz2.editor.fs.scope"))}" data-vault-scope>${vaultOptions}</select><p class="help">${esc(t("adm.authz2.editor.scopeNote"))}</p>`}
</fieldset>
<fieldset class="fs"><legend>${esc(t("adm.authz.drawer.sectionSubjects"))} <span class="muted">${esc(t("adm.authz2.editor.subjectsHint", { count: form.subjects.length }))}</span></legend>
${subjectPicker(model, form)}
</fieldset>
<fieldset class="fs"><legend>${esc(t("adm.authz2.col.caps"))} <span class="muted">${esc(t("adm.authz2.editor.capsHint"))}</span></legend>
${chosenOperations(model, form)}
${atomChips(model, { id: constraint?.id ?? "" })}
${revoke ? "" : `<div class="picker" style="margin-top:8px"><label class="search">${ic("search")}${operationPicker(operations, { chosen: form.capabilities ?? [] })}</label><p class="help">${esc(t("adm.authz2.editor.pickHint"))}</p></div>${surfaceChoices(model, form)}`}
</fieldset>
<fieldset class="fs"><legend>${esc(t("adm.authz.editor.fs.window"))}</legend>
<div class="grid2">
${field(t("adm.authz.drawer.kv.timezone"), `<select class="sel" name="timezone" aria-label="${esc(t("adm.authz.drawer.kv.timezone"))}">${timezoneOptions}</select>`, { hint: t("adm.authz2.editor.tzHint") })}
${field(t("adm.authz.win.startsAt"), `<input class="inp" type="datetime-local" name="startsAt" value="${esc(wallClock(form.startsAt, form.timezone))}">`, { hint: form.startsAt ? esc(String(form.startsAt)) : t("adm.authz2.editor.unset") })}
${field(t("adm.authz.win.expiresAt"), `<input class="inp" type="datetime-local" name="expiresAt" value="${esc(wallClock(form.expiresAt, form.timezone))}">`, { hint: form.expiresAt ? esc(String(form.expiresAt)) : t("adm.authz2.editor.unset") })}
</div>
<div class="fld" style="margin-top:20px"><span class="l">${esc(t("adm.authz2.editor.days"))} <span class="muted">${esc(t("adm.authz2.editor.daysHint"))}</span></span>${weeklyRows(form)}</div>
<div class="fld" style="margin-top:20px"><span class="l">${esc(t("adm.authz.win.dates"))} <span class="muted">${esc(t("adm.authz2.editor.rangesHint"))}</span></span>${rangeRows(form)}</div>
</fieldset>
</form>${previewCard(model, form, { authorizationMode, now })}</div>
<div class="ped-foot"><button class="btn primary" type="submit" form="authz-constraint"${writable && !reasons.length ? "" : " disabled"}${reasons.length ? ` title="${esc(t("adm.authz2.locked.save"))}"` : ""}>${esc(editing ? t("adm.authz2.editor.save") : t("adm.authz2.editor.create"))}</button><a class="btn ghost" href="${esc(pageBase)}">${esc(t("adm.ui.cancel"))}</a><span class="grow"></span>${editing && writable ? post("delete", "", t("adm.authz2.action.delete")) : ""}</div>
</div>`;
  return { content, detailPanel: "" };
}
