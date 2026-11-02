// 主体详情抽屉里的「定时授权」侧栏 — configure a subject's time window from the subject's own page.
//
// Why this exists (owner request, 2026-10-31): until now the only way to put a credential under a
// time window was to open 定时授权, create or edit a policy there, and re-type the subject. The
// subject's own drawer already *showed* which policies mention it (the 定时授权 row of the `.kv`
// block) but could not change anything. This section closes that loop on the subject side:
//
//   * every policy that already references the subject, with its window summary and its honest
//     now verdict (the same `presentAccessPolicyWindow` / `policyNowState` the 定时授权 page uses, so
//     the two surfaces cannot disagree);
//   * 「应用已有规则」 — a real POST that adds this subject to one existing policy and touches nothing
//     else: window, capabilities, mode, timezone and `enabled` all stay exactly as stored (the
//     server derives the draft from the stored policy inside the same CAS read);
//   * 「新建规则」 — the policy editor, opened with the subject already picked (`?new=1&subject=…`).
//
// Ground rules this module keeps:
//   * no script (CSP `default-src 'none'`): the picker is a `<select>` inside a real POST form that
//     carries the session CSRF, and the outcome is a server-rendered line driven by a query flag the
//     route set itself — never by the browser;
//   * no widening: 定时授权 only subtracts. This section can add a restriction, never remove one —
//     detaching a subject is an edit of the policy itself and stays in the editor, where the
//     operator is looking at the policy they are about to change;
//   * nothing secret is echoed: labels, window text and policy ids are already on the 定时授权 page.
import { esc, ic } from "./ui.js";
import { presentAccessPolicyWindow } from "./access-policy-window-presentation.js";
import { policyNowState } from "./pages/authz.js";
import { t } from "../i18n/context.js";

/** Outcome codes the attach route can hand back in the query string → catalog keys. */
const ERROR_KEYS = Object.freeze({
  unknown_access_policy_id: "adm.subjectAuthz.errUnknownPolicy",
  stale_policy_revision: "adm.subjectAuthz.errStale",
  unknown_access_policy_subject: "adm.subjectAuthz.errUnknownSubject",
  access_policy_store_unavailable: "adm.subjectAuthz.errUnavailable",
  invalid_access_policy_record: "adm.subjectAuthz.errInvalid",
});

/** One applied-rule row: label (+ link to the editor), window, and the honest now verdict. */
function appliedRow(policy, base, now) {
  const win = presentAccessPolicyWindow(policy);
  const enabled = policy.enabled !== false;
  const state = policyNowState(policy, now);
  const verdict = enabled
    ? (state.ok === true
      ? `<b style="color:var(--ok)">${esc(t("adm.subjectAuthz.stateAllowed"))}</b>`
      : state.ok === false
        ? `<b style="color:var(--amber)">${esc(t("adm.subjectAuthz.stateRestricted"))}</b>`
        : `<b>${esc(t("adm.authz.undetermined"))}</b>`)
    : `<b>${esc(t("adm.subjectAuthz.stateDisabled"))}</b>`;
  const href = `${base}?edit=${encodeURIComponent(policy.id)}`;
  return `<div class="verdict ${enabled && state.ok === false ? "no" : "ok"}">${ic(enabled && state.ok === false ? "ban" : "checkc")}<span><b><a href="${esc(href)}">${esc(policy.label || policy.id)}</a></b> · ${esc(win.summary.text)} · ${verdict}${state.ok === null ? `（${esc(state.why)}）` : ""} <a href="${esc(href)}">${esc(t("adm.subjectAuthz.edit"))}</a></span></div>`;
}

/**
 * The section itself. `ctx` is a normal Admin page context (`authz.policies`, `csrf`,
 * `accessPolicyBase`, `query`); `subject` is the schema subject id (`api-key:…` / `oauth-client:…` /
 * `oauth-user:…`), and `tab`/`subjectId` are what the POST needs to come back to this drawer.
 */
export function renderSubjectAuthzSection(ctx, { subject, tab, subjectId }) {
  const policies = Array.isArray(ctx.authz?.policies) ? ctx.authz.policies : [];
  const base = ctx.accessPolicyBase || "/admin/auth/access-policy";
  const now = typeof ctx.now === "number" ? ctx.now : Date.now();
  const revision = ctx.authz?.revision ?? "";
  const query = ctx.query ?? {};
  const applied = policies.filter((policy) => Array.isArray(policy?.subjects) && policy.subjects.includes(subject));
  // Only policies that do not already carry the subject: re-applying is a no-op the server reports
  // as `unchanged`, so offering it would be a dead control.
  const candidates = policies.filter((policy) => !(Array.isArray(policy?.subjects) && policy.subjects.includes(subject)));

  const result = query.done === "authz-attach"
    ? `<div class="verdict ok">${ic("checkc")}<span>${esc(t("adm.subjectAuthz.done"))}</span></div>`
    : "";
  const errorKey = query.authzError ? ERROR_KEYS[String(query.authzError)] ?? "adm.subjectAuthz.errGeneric" : null;
  const error = errorKey
    ? `<div class="banner amber">${ic("alert")}<div>${esc(t(errorKey))}</div></div>`
    : "";

  const appliedHtml = applied.length
    ? applied.map((policy) => appliedRow(policy, base, now)).join("")
    : `<div class="verdict ok">${ic("checkc")}<span>${esc(t("adm.subjectAuthz.unrestricted"))}</span></div>`;

  const form = candidates.length
    ? `<form class="inline-form form-block" method="post" action="${esc(`${base}/subjects`)}">
    <input type="hidden" name="csrf" value="${esc(ctx.csrf || "")}">
    <input type="hidden" name="subject" value="${esc(subject)}">
    <input type="hidden" name="tab" value="${esc(tab)}">
    <input type="hidden" name="subjectId" value="${esc(subjectId)}">
    <input type="hidden" name="expectedRevision" value="${esc(String(revision))}">
    <div style="display:flex;gap:8px;align-items:center"><select class="sel grow" style="min-width:0" name="id" aria-label="${esc(t("adm.subjectAuthz.applyLabel"))}"><option value="">${esc(t("adm.subjectAuthz.applyChoose"))}</option>${candidates.map((policy) => `<option value="${esc(policy.id)}">${esc(`${policy.label || policy.id} · ${presentAccessPolicyWindow(policy).summary.text}`)}</option>`).join("")}</select><button class="btn primary" type="submit">${esc(t("adm.subjectAuthz.apply"))}</button></div>
    <span class="help">${esc(t("adm.subjectAuthz.applyHelp"))}</span>
  </form>`
    : `<p class="help" style="margin:0">${esc(t("adm.subjectAuthz.applyEmpty"))}</p>`;

  return `<div class="dsec" id="authz"><h3>${esc(t("adm.subjectAuthz.title"))}</h3>
  <span class="help">${esc(t("adm.subjectAuthz.help"))}</span>
  ${result}${error}
  <div style="margin-top:8px">${appliedHtml}</div>
  ${form}
  <div style="margin-top:12px"><a class="btn ghost sm" href="${esc(`${base}?new=1&subject=${encodeURIComponent(subject)}`)}">${ic("plus")}${esc(t("adm.subjectAuthz.newRule"))}</a></div>
</div>`;
}
