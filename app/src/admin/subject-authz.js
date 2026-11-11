// 主体详情抽屉里的「定时授权」侧栏 — the constraints that name this subject, read-only.
//
// Why this exists (owner request, 2026-10-31): the subject's own drawer must say whether a credential
// sits under a time window. It lists every per-Vault constraint that names the subject, with its
// window summary and its honest now verdict (the same `presentAccessPolicyWindow` / `policyNowState`
// the 定时授权 page uses, so the two surfaces cannot disagree), and every row links to that
// constraint's editor with 查看.
//
// Why the section carries no control (restored 2026-11-09, plan Task 7 item D): attaching a subject
// belongs to the constraint editor, whose subject picker (`subjectPicker` in
// `pages/authz-constraints-editor.js`) lists every subject in the snapshot with a tick — an operator
// adds a subject there, on the page that owns the write. The drawer therefore lists and links; it
// offers no form, no select and no button.
//
// Ground rules this module keeps:
//   * no script (CSP `default-src 'none'`): the section has no form and no control at all — every
//     value comes from the stored document and the request's own context;
//   * no widening, and no claim beyond the mode: 定时授权 only subtracts, and this section never
//     changes a rule — it spends one link to the page that does, and it states which backend decides
//     (the very banner the constraint page renders), because in `legacy` and `shadow` these
//     constraints are recorded and decide nothing (`authorization/runtime.js`);
//   * nothing secret is echoed: labels, window text and constraint ids are already on the 定时授权 page.
import { esc, ic } from "./ui.js";
import { presentAccessPolicyWindow } from "./access-policy-window-presentation.js";
import { decidingBanner, windowOf } from "./pages/authz-constraints.js";
import { policyNowState } from "./pages/authz.js";
import { t } from "../i18n/context.js";

/** One applied-rule row: label (+ link to its editor), window, and the honest now verdict. */
function appliedRow(constraint, base, now) {
  const win = presentAccessPolicyWindow(windowOf(constraint));
  const enabled = constraint.enabled !== false;
  const state = policyNowState(windowOf(constraint), now);
  const verdict = enabled
    ? (state.ok === true
      ? `<b style="color:var(--ok)">${esc(t("adm.subjectAuthz.stateAllowed"))}</b>`
      : state.ok === false
        ? `<b style="color:var(--amber)">${esc(t("adm.subjectAuthz.stateRestricted"))}</b>`
        : `<b>${esc(t("adm.authz.undetermined"))}</b>`)
    : `<b>${esc(t("adm.subjectAuthz.stateDisabled"))}</b>`;
  const href = `${base}?edit=${encodeURIComponent(constraint.id)}`;
  return `<div class="verdict ${enabled && state.ok === false ? "no" : "ok"}">${ic(enabled && state.ok === false ? "ban" : "checkc")}<span><b><a href="${esc(href)}">${esc(constraint.label || constraint.id)}</a></b> · ${esc(win.summary.text)} · ${verdict}${state.ok === null ? `（${esc(state.why)}）` : ""} <a href="${esc(href)}">${esc(t("adm.subjectAuthz.view"))}</a></span></div>`;
}

/**
 * The section itself. `ctx` is a normal Admin page context: `constraintPage` (the constraint document
 * and the presentation model), `constraintBase` (that page's base), `authorizationMode` (which
 * backend decides, so the verdicts below are not stated as fact in a mode where they decide nothing)
 * and `csrf`. `subject` is the schema subject id (`api-key:…` / `oauth-client:…` / `oauth-user:…`).
 */
export function renderSubjectAuthzSection(ctx, { subject }) {
  const page = ctx.constraintPage ?? null;
  const constraints = Array.isArray(page?.constraints) ? page.constraints : [];
  const base = ctx.constraintBase || "/admin/auth/authz";
  const ready = page?.status === "ready";
  const now = typeof ctx.now === "number" ? ctx.now : Date.now();
  const applied = constraints.filter((constraint) => Array.isArray(constraint?.subjects) && constraint.subjects.includes(subject));

  const appliedHtml = applied.length
    ? applied.map((constraint) => appliedRow(constraint, base, now)).join("")
    : `<div class="verdict ok">${ic("checkc")}<span>${esc(t("adm.subjectAuthz.unrestricted"))}</span></div>`;

  // The banner the freeze introduced, reworded for the per-Vault model: joining a subject to a
  // constraint is a write, and every write lives on that page. An unreadable document says so here
  // instead of the applied list, which would otherwise claim the subject is unrestricted.
  const link = `<a href="${esc(base)}">${esc(t("adm.authz.frozen.link"))}</a>`;
  const notice = `<div class="banner amber">${ic("info")}<div>${ready ? t("adm.subjectAuthz.frozen", { href: link }) : esc(t("adm.subjectAuthz.unavailable"))}</div></div>`;

  return `<div class="dsec" id="authz"><h3>${esc(t("adm.subjectAuthz.title"))}</h3>
  <span class="help">${esc(t("adm.subjectAuthz.help"))}</span>
  ${decidingBanner(ctx.authorizationMode)}
  ${ready ? `<div style="margin-top:8px">${appliedHtml}</div>` : ""}
  ${notice}
</div>`;
}
