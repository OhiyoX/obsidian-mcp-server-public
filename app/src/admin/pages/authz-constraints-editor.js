// 定时授权 — the per-Vault constraint editor (design §6.3, §6.7; plan Task 6).
//
// The form submits through the constraint routes. The client enhances the controls, while
// the read-only preview uses the server's saved schedule and never submits the draft.
import { TOOLSET_TOOLS } from "../../capability-catalog.js";
import { capabilityCatalog } from "../capabilities.js";
import { pageBar, banner, field, esc, ic, checkRow } from "../ui.js";
import { idc } from "../presentation/format.js";
import { t } from "../../i18n/context.js";
import { presentAccessPolicyWindow, WINDOW_SCOPE_DISCLAIMER, WINDOW_DAY_LABELS, WINDOW_DAY_KEYS } from "../access-policy-window-presentation.js";
import { zonedParts } from "../presentation/model.js";
import { KIND_LABEL, MODE } from "../presentation/vocab.js";
import { policyNowLabel, policyNowState, policyTimelineHtml } from "./authz-window.js";
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
 * stays `null` for "every operation" (the form carries it back as `capabilitiesAll`), the scope keeps
 * an unadmitted Vault id, and `surfaces` is the stored set. Dropping either is the silent rewrite this
 * page must not do — `unexpressible` names the states the controls still cannot express.
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

const copy = (key) => esc(t(`adm.authz2.editor.${key}`));
const timePattern = "(?:[01][0-9]|2[0-3]):[0-5][0-9]";
const timeInput = (label, value, name, end) =>
  `<input class="inp" type="text" placeholder="HH:MM" maxlength="5" name="${name}" pattern="${timePattern}${end ? "|24:00" : ""}" value="${esc(value)}" aria-label="${esc(label)}">`;

function scheduleRow({ day, index, from = "", to = "", spare = false }) {
  const fieldName = (bound) => day ? `w_${day}_${bound}_${index}` : `range_${bound}_${index}`;
  const label = (bound) => day ? `${WINDOW_DAY_LABELS[day]} ${t(`adm.authz2.editor.${bound}`)}` :
    t(bound === "from" ? "adm.authz2.editor.rangeFrom" : "adm.authz2.editor.rangeTo");
  const input = (bound, value) => day ? timeInput(label(bound), value, fieldName(bound), bound === "to") :
    `<input class="inp" type="date" name="${fieldName(bound)}" value="${esc(value)}" aria-label="${esc(label(bound))}">`;
  return `<div class="schedule-row" data-schedule-row${spare ? " data-spare" : ""}>
${input("from", from)}<span aria-hidden="true">–</span>${input("to", to)}
<button class="btn ghost" type="button" data-remove-row hidden aria-label="${copy("removeRow")}">${ic("x")}</button></div>`;
}

function scheduleGroup({ day, slots }) {
  return `<div class="schedule-group" data-schedule-group${day ? ` data-day="${day}" id="constraint-day-${day}"` : ""}>
${day ? `<b>${esc(WINDOW_DAY_LABELS[day])}</b>` : ""}
<div data-schedule-rows>${slots.map(([from, to], index) => scheduleRow({ day, index, from, to })).join("")}
${scheduleRow({ day, index: slots.length, spare: true })}</div>
<button class="btn ghost" type="button" data-add-row hidden>${ic("plus")}${copy(day ? "addSlot" : "addDates")}</button></div>`;
}

function weeklyRows(draft) {
  return WINDOW_DAY_KEYS.map((day) => scheduleGroup({ day, slots: draft.weekly[day] ?? [] })).join("");
}

function scheduleShortcuts() {
  const boundary = (bound, selected) => {
    const options = Array.from({ length: bound === "to" ? 49 : 48 }, (_, index) => {
      const value = `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`;
      return `<option value="${value}"${value === selected ? " selected" : ""}>${value}</option>`;
    }).join("");
    return `<select class="sel" data-popup-min-width="160" aria-label="${copy(bound)}">${options}</select>`;
  };
  return `<div class="schedule-shortcuts" data-schedule-shortcuts data-invalid-time="${copy("invalidTime")}" hidden>
<div class="schedule-shortcut-times">
${boundary("from", "09:00")}<span aria-hidden="true">–</span>${boundary("to", "18:00")}</div>
<div class="schedule-shortcut-actions">${["workdays", "weekend", "everyDay"].map((key) => `<button class="btn" type="button" data-add-days="${key}">${copy(key)}</button>`).join("")}</div>
<p class="help">${copy("quickHint")}</p><p class="help" data-schedule-feedback role="status" hidden></p></div>`;
}

function draftTimeline() {
  return `<div class="draft-timeline" data-draft-timeline data-all-day="${copy("allDay")}" data-no-slots="${copy("noSlots")}" hidden>
<h3>${copy("draftTimeline")}</h3>
<p class="help timeline-pointer-hint">${copy("drawHint")}</p>
<p class="help timeline-touch-hint">${copy("touchHint")}</p>
<div class="tl">${WINDOW_DAY_KEYS.map((day) => {
    const label = WINDOW_DAY_LABELS[day];
    return `<a href="#constraint-day-${day}" draggable="false" data-timeline-day="${day}" aria-label="${esc(label)}"><span>${esc(label)}</span><span class="tr"></span></a>`;
  }).join("")}<span></span><div class="ax" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div></div></div>`;
}

/** The operation picker: one option per catalog operation, grouped under the surface it runs on. */
export function operationPicker(operations = [], { chosen = [] } = {}) {
  const taken = new Set(chosen ?? []);
  const groups = new Map();
  const labels = new Map(capabilityCatalog().groups.find((group) => group.group === "toolset").items.map((item) => [item.key, item.name]));
  for (const operation of operations) {
    const toolset = Object.entries(TOOLSET_TOOLS).find(([, tools]) => tools.includes(operation.id))?.[0];
    const key = toolset ? `toolset:${toolset}` : operation.surface;
    const list = groups.get(key) ?? [];
    list.push(operation);
    groups.set(key, list);
  }
  return `<div class="operation-groups" data-operation-groups>
<input class="inp" type="search" data-operation-search aria-label="${copy("searchOperations")}" placeholder="${copy("searchOperations")}" hidden>
<p class="help" data-operation-count aria-live="polite" data-count-template="${copy("selectedOperations")}" hidden></p>
${[...groups].map(([surface, list], index) => `<details class="operation-group" data-operation-group${index === 0 || list.some((operation) => taken.has(operation.id)) ? " open" : ""}><summary>${esc(labels.get(surface) ?? t("adm.authz2.surface", { surface }))} <span class="muted">${list.length}</span></summary>
<label class="chk" data-operation-toggle hidden><input type="checkbox" data-operation-select-all><span>${copy("selectGroup")}</span></label>
<div class="operation-grid">${list.map((operation) => checkRow({ name: "capabilities", value: operation.id, checked: taken.has(operation.id), title: operation.label })).join("")}</div></details>`).join("")}
</div>`;
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
  const ordered = [...subjects.filter((subject) => stored.includes(subject)), ...orphans, ...subjects.filter((subject) => !stored.includes(subject))];
  const groupOf = (subject) => orphans.includes(subject) ? "missing" : model.presentation.subjectView(subject).kind;
  const groups = [...new Set(ordered.map(groupOf))];
  const list = ordered.map((subject) => {
    if (orphans.includes(subject)) return checkRow({
      name: "subjects", value: subject, checked: true, title: subject,
      detail: `<span class="tag danger">${esc(t("adm.authz.orphanTag"))}</span> ${copy("orphanSubject")}`,
    });
    const view = model.presentation.subjectView(subject);
    return checkRow({ name: "subjects", value: subject, checked: stored.includes(subject), title: view.name, detail: esc(`${view.kindLabel} · ${view.shortId}`) });
  }).join("");
  return `<div class="constraint-choices">
<div class="constraint-subject-tabs" data-subject-tabs role="group" aria-label="${esc(t("adm.authz.drawer.sectionSubjects"))}" hidden>
${[["", copy("allSubjects")], ...groups.map((kind) => [kind, esc(KIND_LABEL[kind] ?? t("adm.authz.orphanTag"))])].map(([kind, label]) =>
    `<button class="btn ghost" type="button" data-subject-kind="${esc(kind)}" aria-pressed="${kind === ""}">${label}</button>`).join("")}
</div>
<input class="inp" type="search" data-subject-search placeholder="${copy("findSubject")}" aria-label="${copy("findSubject")}" hidden>
<p class="help constraint-no-subjects" data-no-matches hidden>${copy("noMatches")}</p>
<div class="pick-list scroll" data-subject-picker>${list}</div></div>`;
}

/** The chosen operations as removable checkboxes plus any id the catalog does not know. */
function chosenOperations(model, draft) {
  // `null` is every operation (an imported `all` / `surface:*` atom), not "none chosen": saying
  // 「还没有选择操作」 here would be the exact opposite of the stored constraint.
  // `null` is every operation. It travels back as a marker so an untouched save keeps it: the
  // operator edits the window, subjects and scope without narrowing the operation set by accident.
  // Ticking any operation below replaces the marker with that explicit set.
  const chosen = Array.isArray(draft.capabilities) ? draft.capabilities : [];
  const name = (id) => model?.presentation?.capName?.(id) || id;
  const rows = chosen.filter((id) => !(model.operations ?? []).some((operation) => operation.id === id)).map((id) => checkRow({ name: "capabilities", value: id, checked: true, title: name(id), detail: "", mono: id })).join("");
  return `
${draft.capabilities === null ? `<input type="hidden" name="capabilitiesAll" value="1">` : ""}
<p class="help" data-every-operation${draft.capabilities === null ? "" : " hidden"}>${copy("everyOperationKept")}</p>
<p class="help" data-no-operations${!chosen.length && draft.capabilities !== null ? "" : " hidden"}>${copy("noOps")}</p>
<div class="pick-list scroll" data-chosen-operations>${rows}</div>`;
}

/**
 * The preview card (Q11's payback, ruling R9): read-only, server-computed, and it says which backend
 * decides. It carries no form, no `<button>` and no input — a preview that could be submitted would
 * be a save the page cannot perform.
 */
function previewCard(model, draft, { authorizationMode, now }) {
  const heading = `<h2>${copy("preview")}</h2>`;
  if (!draft) return `<aside class="ped-side" data-preview="constraints"><div class="stick">
<div class="sect-h">${heading}</div><p class="help" data-preview-decides="${esc(decidesFor(authorizationMode))}">${copy("previewAfterSave")}</p></div></aside>`;
  const flat = windowOf({ schedule: { timezone: draft.timezone, weekly: draft.weekly, dateRanges: draft.dateRanges, startsAt: draft.startsAt, expiresAt: draft.expiresAt } });
  const win = presentAccessPolicyWindow(flat);
  const state = policyNowState(flat, now);
  const mode = MODE[draft.mode] ?? MODE.suspend;
  const caps = draft.mode === "revoke" || draft.capabilities === null
    ? t("adm.authz2.caps.all")
    : (draft.capabilities ?? []).map((id) => model?.presentation?.capName?.(id) || id).join(esc(t("adm.ui.listSeparator"))) || t("adm.authz2.editor.noOps");
  const marks = win.summary.markers.map((marker) => `<span class="tag">${esc(marker)}</span>`).join("");
  const verdict = draft.enabled
    ? `<div class="verdict ${state.ok === true ? "ok" : state.ok === false ? "no" : ""}">${ic(state.ok === false ? "ban" : "checkc")}<span><b>${state.ok === true ? copy("windowOpen") : esc(state.ok === false ? mode.n : t("adm.authz.undetermined"))}</b> · ${esc(state.why)}<small>${copy("evaluatedAt")} ${esc(policyNowLabel(flat, now))}</small></span></div>`
    : `<div class="verdict">${ic("info")}${copy("previewDisabled")}</div>`;
  return `<aside class="ped-side" data-preview="constraints"><div class="stick">
<div class="sect-h">${heading}<span class="muted">${esc(draft.timezone)}</span></div>
<p class="constraint-preview-dirty" data-preview-dirty role="status" hidden>${copy("previewDirty")}</p>
<div class="sumbox"><b>${esc(win.summary.text)}</b>${marks ? `<div class="tags">${marks}</div>` : ""}<div>${esc(t("adm.authz.editor.outsideWindowLabel"))} <b>${esc(mode.n)}</b> ${esc(caps)}</div></div>
<div class="muted" style="margin-top:4px">${esc(WINDOW_SCOPE_DISCLAIMER)}</div>
<div style="margin-top:16px" data-preview-timeline>${policyTimelineHtml(flat, now)}</div>
${verdict}
<p class="help" data-preview-decides="${esc(decidesFor(authorizationMode))}">${esc(t("adm.authz2.preview.readonly"))} ${esc(t("adm.authz2.preview.stored"))}</p>
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
  const vaultOptions = vaults.map((vault) => checkRow({
    name: "vaultIds", value: vault.id, checked: !scopeAll && form.scope.includes(vault.id),
    title: vault.name, mono: vault.name === vault.id ? null : vault.id,
  })).join("");
  const action = editing ? `${pageBase}/update` : `${pageBase}/create`;
  const post = (endpoint, fields, label, cls = "btn danger-o") => `<form class="inline-form" method="post" action="${esc(`${pageBase}/${endpoint}`)}"><input type="hidden" name="csrf" value="${esc(csrf || "")}"><input type="hidden" name="expectedRevision" value="${esc(revision)}"><input type="hidden" name="id" value="${esc(constraint?.id ?? "")}">${fields}<button class="${esc(cls)}" type="submit">${esc(label)}</button></form>`;

  const content = `${pageBar({
    crumb: { href: pageBase, label: t("adm.nav.accessPolicy") },
    title: editing ? String(constraint.label || t("adm.authz2.editor.untitled")) : t("adm.authz2.new"),
    actions: `<a class="btn ghost" href="#constraint-schedule">${ic("cal")}${copy("jumpToSchedule")}</a>${editing ? idc(constraint.id) : ""}`,
  })}<div class="content scroll constraint-editor">
${notice}
${decidingBanner(authorizationMode)}
${lockedHtml}
${planes}
<div class="ped"><form class="ped-form" id="authz-constraint" method="post" action="${esc(action)}"${failure ? " data-draft-refused=1" : ""}>
<input type="hidden" name="csrf" value="${esc(csrf || "")}">
<input type="hidden" name="expectedRevision" value="${esc(revision)}">
${editing ? `<input type="hidden" name="id" value="${esc(constraint.id)}">` : ""}
<fieldset class="fs constraint-details"><legend>${copy("fs.basic")}</legend>
<div class="constraint-basic">
${field(t("adm.authz2.editor.label"), `<input class="inp" name="label" value="${esc(form.label)}" placeholder="${copy("labelPh")}" aria-label="${copy("label")}" maxlength="120" required>`)}
${field(t("adm.authz2.editor.status"), `<label class="chk"><input type="hidden" name="enabled" value="false"><input type="checkbox" name="enabled" value="true"${form.enabled ? " checked" : ""}>${copy("enabled")}</label>`)}
</div>
${field(t("adm.authz2.editor.mode"), `<select class="sel" name="mode" aria-label="${copy("mode")}" aria-describedby="constraint-mode-help">${["suspend", "revoke"].map((mode) => `<option value="${mode}"${form.mode === mode ? " selected" : ""}>${esc(MODE[mode].n)}</option>`).join("")}</select>`)}
<p class="help" id="constraint-mode-help"><span data-suspend-help${revoke ? " hidden" : ""}>${copy("modeHint")}</span><span data-revoke-help${revoke ? "" : " hidden"}>${copy("revokeNote")}</span></p>
</fieldset>
<fieldset class="fs constraint-vault" data-suspend-only><legend>${copy("fs.scope")}</legend>
<div class="constraint-scope" data-vault-scope>
${checkRow({ name: "vaultScope", value: "all", checked: scopeAll, multi: false, title: t("adm.authz2.scope.all") })}
${checkRow({ name: "vaultScope", value: "selected", checked: !scopeAll, multi: false, title: t("adm.authz2.editor.selectedVaults") })}
</div>
<div class="constraint-choices" data-vault-choices>${vaultOptions || `<p class="help">${copy("noVaults")}</p>`}</div>
</fieldset>
<fieldset class="fs constraint-subjects"><legend>${esc(t("adm.authz.drawer.sectionSubjects"))} <span class="muted" data-subject-count="${esc(t("adm.authz2.editor.subjectsHint", { count: "%s" }))}" aria-live="polite">${esc(t("adm.authz2.editor.subjectsHint", { count: form.subjects.length }))}</span></legend>
${subjectPicker(model, form)}
</fieldset>
<fieldset class="fs constraint-operations" data-suspend-only><legend>${esc(t("adm.authz2.col.caps"))} <span class="muted">${copy("capsHint")}</span></legend>
${chosenOperations(model, form)}
${atomChips(model, { id: constraint?.id ?? "" })}
${operationPicker(operations, { chosen: form.capabilities ?? [] })}
${surfaceChoices(model, form)}
</fieldset>
<fieldset class="fs" id="constraint-schedule" tabindex="-1"><legend>${esc(t("adm.authz.editor.fs.window"))}</legend>
<div class="schedule-header">
<div class="schedule-heading"><h2>${copy("days")}</h2><p class="help">${copy("daysHint")}</p></div>
${field(t("adm.authz.drawer.kv.timezone"), `<select class="sel" name="timezone" aria-label="${esc(t("adm.authz.drawer.kv.timezone"))}">${timezoneOptions}</select>`)}
</div>
${scheduleShortcuts()}
<div class="schedule-workspace">
${draftTimeline()}
<div class="weekly-schedule">${weeklyRows(form)}</div>
</div>
<p class="help">${copy("overMidnight")}</p>
<details class="schedule-dates"${form.dateRanges.length || form.startsAt || form.expiresAt ? " open" : ""}>
<summary>${copy("dateLimits")}</summary>
<div class="grid2">
${["startsAt", "expiresAt"].map((key) => {
    const title = t(`adm.authz.win.${key}`);
    return field(title, `<input class="inp" type="datetime-local" name="${key}" value="${esc(wallClock(form[key], form.timezone))}" aria-label="${esc(title)}">`);
  }).join("")}
</div>
<p class="help">${copy("tzHint")}</p>
<div class="schedule-heading"><h2>${esc(t("adm.authz.win.dates"))}</h2><p class="help">${copy("rangesHint")}</p></div>
${scheduleGroup({ slots: form.dateRanges.map(({ from, to }) => [from, to]) })}
</details>
</fieldset>
</form>${previewCard(model, constraint?.schedule ? draftOf(constraint) : null, { authorizationMode, now })}</div></div>
<div class="ped-foot"><button class="btn primary" type="submit" form="authz-constraint"${writable && !reasons.length ? "" : " disabled"}${reasons.length ? ` title="${esc(t("adm.authz2.locked.save"))}"` : ""}>${copy(editing ? "save" : "create")}</button><a class="btn ghost" href="${esc(pageBase)}">${esc(t("adm.ui.cancel"))}</a><span class="grow"></span>${editing && writable ? `<details class="constraint-delete"><summary class="btn danger-o">${esc(t("adm.authz2.action.delete"))}</summary><div><p>${copy("deleteWarning")}</p>${post("delete", "", t("adm.authz2.action.delete"))}</div></details>` : ""}</div>
`;
  return { content, detailPanel: "" };
}
