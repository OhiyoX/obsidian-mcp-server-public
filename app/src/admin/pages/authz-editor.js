// 定时授权 — the legacy policy page, read-only.
//
// The legacy `access-policy` document is frozen (design §7 step 2 + step 5): this module is its
// history view. It keeps the prototype editor's markup — `.ped` + `.ped-form` + `.ped-side`, the
// window summary, the 7-day timeline and the 现在（…）判定 — and renders every stored value as text:
// no `<form>`, no submit control, no draft round trip (`?day=` / `?addSlot=` / `?weeklyPreset=` are
// gone with the form). Editing moved to the per-Vault constraint page (`LEGACY_POLICY_REPLACEMENT`).
//
// Why a view and not a disabled form: a disabled form is still a promise that submitting does
// something. The route module answers `access_policy_frozen` to every write, so the page must not
// render a control that can only fail.
import { pageBar, banner, esc, ic, kv } from "../ui.js";
import { idc } from "../presentation/format.js";
import { t } from "../../i18n/context.js";
import { presentAccessPolicyWindow, WINDOW_SCOPE_DISCLAIMER, WINDOW_DAY_LABELS } from "../access-policy-window-presentation.js";
import { zonedParts } from "../presentation/model.js";
import { MODE } from "../presentation/vocab.js";
import { frozenBanner, legacyPoliciesDecide, policyNowLabel, policyNowState, policyTimelineHtml } from "./authz.js";

/** ISO instant -> `datetime-local` wall clock in the policy's timezone (prototype `utc()` inverse). */
function localClock(iso, zone) {
  if (!iso) return null;
  const parts = zone ? zonedParts(iso, zone) : null;
  return parts ? `${parts.date} ${parts.hm}` : null;
}

/** One bound: the wall clock the operator typed, plus the UTC instant the schema really stores. */
function boundValue(iso, zone) {
  if (!iso) return `<span class="muted">${esc(t("adm.authz.notProvided"))}</span>`;
  const local = localClock(iso, zone);
  return `${local ? `<span class="mono">${esc(local)}</span> ` : ""}<span class="muted mono">${esc(iso)}</span>`;
}

function fieldset(legend, bodyHtml, aside = "") {
  return `<fieldset class="fs"><legend>${esc(legend)}${aside ? ` <span class="muted">${aside}</span>` : ""}</legend>${bodyHtml}</fieldset>`;
}

/**
 * Preview pane (prototype `.ped-side`): summary, timeline, now verdict, per-subject impact.
 *
 * Read-only by design — it carries no form, because no draft can be saved any more. The now verdict
 * and the per-subject impact are the stored legacy policies' verdicts, so they are rendered only
 * where those policies decide (`legacyPoliciesDecide`); in `enforce` the pane keeps the stored
 * window and the frozen banner above it states that the constraints decide instead.
 */
export function previewPane(ctx) {
  const { draft, model, authz, now = Date.now() } = ctx;
  const decide = legacyPoliciesDecide(ctx.authorizationMode);
  const win = presentAccessPolicyWindow(draft);
  const zone = typeof draft?.timezone === "string" ? draft.timezone : "—";
  const mode = MODE[draft?.mode] ?? MODE.suspend;
  const caps = (Array.isArray(draft?.capabilities) ? draft.capabilities : []).map((key) => model.capName(key)).join(esc(t("adm.ui.listSeparator"))) || t("adm.authz.editor.noCapsPicked");
  const marks = win.summary.markers.map((marker) => `<span class="tag" style="margin:4px 4px 0 0">${esc(marker)}</span>`).join("");
  const state = policyNowState(draft, now);
  const subjects = Array.isArray(draft?.subjects) ? draft.subjects : [];
  const policies = (Array.isArray(authz?.policies) ? authz.policies : []).filter((policy) => policy.id !== draft?.id);
  const impact = !decide
    ? ""
    : subjects.length
    ? subjects.map((subject) => {
      const view = model.subjectView(subject);
      const matching = [
        ...(draft.enabled !== false ? [draft] : []),
        ...policies.filter((policy) => policy.enabled !== false && Array.isArray(policy.subjects) && policy.subjects.includes(subject)),
      ];
      const lines = matching.length
        ? matching.map((policy) => {
          const item = policy === draft ? state : policyNowState(policy, now);
          const label = item.ok === true ? t("adm.authz.preview.allowedNow") : item.ok === false ? t("adm.authz.preview.modeNow", { mode: model.mode(policy.mode).n }) : t("adm.authz.preview.notDecidable");
          const policyCaps = (Array.isArray(policy.capabilities) ? policy.capabilities : []).map((key) => model.capName(key)).join("、") || "—";
          const tag = policy === draft ? ` <span class="tag acc">${esc(t("adm.authz.editor.editing"))}</span>` : "";
          return `<div class="verdict ${item.ok === true ? "ok" : item.ok === false ? "no" : ""}">${ic(item.ok === false ? "ban" : "checkc")}<span><b>${esc(policy.label)}</b>${tag} · ${esc(label)}（${esc(item.why)}）· ${esc(t("adm.authz.preview.impact"))} ${esc(policyCaps)}</span></div>`;
        }).join("")
        : `<div class="verdict ok">${ic("checkc")}<span>${esc(t("adm.authz.editor.unrestricted"))}</span></div>`;
      return `<div style="margin-top:8px"><div style="font-size:13px;color:var(--tx2)">${esc(view.name)} <span class="muted">${esc(view.kindLabel)}</span></div>${lines}</div>`;
    }).join("")
    : `<p class="help">${esc(t("adm.authz.editor.pickSubjectHint"))}</p>`;
  return `<aside class="ped-side"><div class="stick">
<div class="sect-h"><h2>${esc(t("adm.authz.editor.previewTitle"))}</h2><span class="muted">${esc(zone)}</span></div>
<div class="sumbox"><b>${esc(win.summary.text)}</b>${marks ? `<div>${marks}</div>` : ""}<div style="margin-top:4px">${esc(t("adm.authz.editor.outsideWindowLabel"))} <b>${esc(mode.n)}</b> ${esc(caps)}</div></div>
<div style="margin-top:16px">${policyTimelineHtml(draft, now)}</div>
${decide ? `<div class="verdict ${state.ok === true ? "ok" : state.ok === false ? "no" : ""}" style="margin-top:12px">${ic(state.ok === false ? "ban" : "checkc")}<span>${esc(t("adm.authz.drawer.now"))}${esc(policyNowLabel(draft, now))}）<b>${esc(state.ok === true ? t("adm.authz.drawer.allowedAccess") : state.ok === false ? mode.n : t("adm.authz.undetermined"))}</b> · ${esc(state.why)}</span></div>
<div class="sect-h" style="margin-top:24px"><h2>${esc(t("adm.authz.editor.subjectImpact"))}</h2></div>
${impact}` : ""}
</div></aside>`;
}

/**
 * The stored policy, read-only: `.ped` with the same fieldsets the editor used, every value text.
 * `policyId` names the policy being shown; `draft` is the stored record (or, at the fragment
 * endpoint, the decoded draft of the request) — nothing here is submitted anywhere.
 */
export function renderAuthzEditorPage(ctx) {
  const { draft, model, accessPolicyBase: base, authz, now = Date.now(), policyId = null } = ctx;
  const enabled = draft?.enabled !== false;
  const mode = MODE[draft?.mode] ?? MODE.suspend;
  const win = presentAccessPolicyWindow(draft);
  const zone = typeof draft?.timezone === "string" ? draft.timezone : null;
  const subjects = Array.isArray(draft?.subjects) ? draft.subjects : [];
  const picked = Array.isArray(draft?.capabilities) ? draft.capabilities : [];
  const revision = authz?.revision ?? null;

  const subjectHtml = subjects.length
    ? `<div class="selrow">${subjects.map((subject) => {
      const view = model.subjectView(subject);
      const orphan = view.missing ? ` <span class="tag danger">${esc(t("adm.authz.orphanTag"))}</span>` : "";
      return `<span class="pill" title="${esc(subject)}"><span class="kind">${esc(view.kindLabel)}</span>${esc(view.name)} <span class="mono muted">${esc(view.shortId)}</span>${orphan}</span>`;
    }).join("")}</div>`
    : `<p class="help" style="margin:0">${esc(t("adm.authz.noSubjects"))}</p>`;
  const capsHtml = picked.length
    ? `<div class="tags">${picked.map((key) => `<span class="tag ${key === "all" ? "amber" : ""}" title="${esc(key)}">${esc(model.capName(key))}</span>`).join("")}</div>`
    : `<p class="help" style="margin:0">${esc(t("adm.authz.editor.noCapsPicked"))}</p>`;
  const dayRows = win.details.days
    .filter((day) => day.state === "intervals" || day.state === "all-day" || day.state === "unparsable")
    .map((day) => [WINDOW_DAY_LABELS[day.key], `<span class="mono">${esc(day.text)}</span>`]);
  const ranges = win.details.dateRanges;
  const windowHtml = `<div class="sumbox"><b>${esc(win.summary.text)}</b>${win.summary.markers.length ? `<div>${win.summary.markers.map((marker) => `<span class="tag" style="margin:4px 4px 0 0">${esc(marker)}</span>`).join("")}</div>` : ""}<div class="muted" style="margin-top:4px">${esc(WINDOW_SCOPE_DISCLAIMER)}</div></div>
${dayRows.length ? `<div style="margin-top:12px">${kv(dayRows)}</div>` : ""}
<div style="margin-top:12px">${kv([
    [t("adm.authz.win.dates"), ranges.present ? esc(ranges.valid ? ranges.items.map((item) => item.text).join("、") : t("adm.authz.win.badRanges")) : `<span class="muted">${esc(t("adm.authz.win.unset"))}</span>`],
    [t("adm.authz.win.startsAt"), boundValue(draft?.startsAt, zone)],
    [t("adm.authz.win.expiresAt"), boundValue(draft?.expiresAt, zone)],
  ])}</div>
<div style="margin-top:16px">${policyTimelineHtml(draft, now)}</div>`;

  const content = `${pageBar({
    crumb: { href: base, label: t("adm.nav.accessPolicy") },
    title: String(draft?.label || t("adm.authz.editor.untitled")),
    actions: policyId ? idc(policyId) : "",
  })}<div class="content scroll">
${frozenBanner(ctx.authorizationMode)}
<div class="ped"><div class="ped-form" id="authz-view">
${fieldset(t("adm.authz.editor.fs.basic"), `<div style="display:flex;align-items:center;gap:8px;height:32px"><span class="st ${enabled ? "ok" : "off"}"><span class="dot"></span>${esc(enabled ? t("adm.authz.status.enabled") : t("adm.authz.status.disabled"))}</span></div>${kv([
    [t("adm.authz.drawer.kv.label"), esc(draft?.label ?? "")],
    [t("adm.authz.drawer.kv.mode"), `${esc(mode.n)} <span class="mono muted">${esc(String(draft?.mode ?? ""))}</span>`],
    [t("adm.authz.drawer.kv.timezone"), `<span class="mono">${esc(zone ?? "—")}</span>`],
    [t("adm.authz.drawer.kv.revision"), revision === null ? `<span class="muted">${esc(t("adm.authz.notProvided"))}</span>` : `<span class="mono">${esc(String(revision))}</span>`],
  ])}`)}
${fieldset(t("adm.authz.drawer.sectionSubjects"), subjectHtml, t("adm.authz.editor.fs.subjectsHint", { count: subjects.length }))}
${fieldset(t("adm.authz.drawer.sectionCaps"), `${draft?.mode === "revoke" ? banner(t("adm.authz.editor.revokeCapsNote"), { tone: "amber" }) : ""}${capsHtml}`)}
${fieldset(t("adm.authz.editor.fs.window"), windowHtml)}
</div>${previewPane(ctx)}</div>
<p class="help">${esc(t("adm.authz.frozen.readOnlyHint"))} <a href="${esc(base)}">${esc(t("adm.authz.backToList"))}</a></p>
</div>`;
  return { content, detailPanel: "" };
}
