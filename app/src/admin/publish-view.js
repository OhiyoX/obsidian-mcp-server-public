// Admin Publish panel renderer — Wave C / C3 (issues #277/#278, dev doc §9/§17).
//
// One source of truth. The rows are exactly what `PublishService.list({
// includeInactive: true })` returned: the service owns the lifecycle state machine
// (B1), and this module only *formats* the `lifecycle` field it already publishes.
// There is no second status model here — no read of frontmatter `published`, no
// re-derivation from the file on disk, no cached copy.
//
// §9/§17: a retired record (observed missing → `orphaned`, non-Markdown →
// `invalid`) must stay visible here so an operator can revoke it, while the public
// `published:` candidate set stays active-only. §9 also forbids the two mismatches,
// so this renderer never draws a working public link for a record whose anonymous
// page is a 404, and never hides a row that needs cleanup.
//
// Read-only contract: the only action rendered is the pre-existing
// `POST /admin/auth/publish/revoke` (`PublishService.revokeById`). This module adds
// no write capability the service does not already have.

import { t } from "../i18n/context.js";
import { PUBLISH_LIFECYCLE } from "../publish/lifecycle.js";

// Presentation only: label + tone + one-line operator hint. `public` decides
// whether the opaque id renders as a live <a> or as dead text.
function presentation() {
  return {
    [PUBLISH_LIFECYCLE.ACTIVE]: { label: t("adm.pub.state.active"), tone: "ok", public: true, hint: t("adm.pub.hint.active") },
    [PUBLISH_LIFECYCLE.ORPHANED]: { label: t("adm.pub.state.orphaned"), tone: "bad", public: false, hint: t("adm.pub.hint.orphaned") },
    [PUBLISH_LIFECYCLE.INVALID]: { label: t("adm.pub.state.invalid"), tone: "bad", public: false, hint: t("adm.pub.hint.invalid") },
    [PUBLISH_LIFECYCLE.UNKNOWN]: { label: t("adm.pub.state.unknown"), tone: "bad", public: false, hint: t("adm.pub.hint.unknown") },
  };
}

// An unrecognized/absent lifecycle is a rendering fallback for a foreign state
// file, not a sixth product state: it fails closed and is never a public candidate.
function unrecognized() {
  return { label: t("adm.pub.state.unrecognized"), tone: "bad", public: false, hint: t("adm.pub.hint.unrecognized") };
}

export function publishPanelHeaders() {
  return [
    t("adm.pub.col.state"), t("adm.pub.col.publicId"), "Vault", t("adm.pub.col.path"), t("adm.pub.col.link"),
    t("adm.pub.col.times"), t("adm.pub.col.publisher"), t("adm.git.col.actions"),
  ];
}

export function describePublishLifecycle(lifecycle) {
  return presentation()[lifecycle] || unrecognized();
}

/** True only for the one lifecycle whose anonymous page may be reachable (§9). */
export function isPublishPubliclyReachable(lifecycle) {
  return describePublishLifecycle(lifecycle).public;
}

/** Registry tallies for the Admin overview; `retired` = orphaned + invalid + unknown. */
export function publishRecordCounts(records = []) {
  let active = 0;
  for (const record of records) {
    if (isPublishPubliclyReachable(record?.lifecycle)) active += 1;
  }
  return { total: records.length, active, retired: records.length - active };
}

// `helpers` are the router's own escaping/table primitives, so the panel renders in
// the exact same vocabulary (same `html`, same labelled cells) without exporting
// private formatting helpers from auth-center.js.
export function renderPublishPanel({ publications = [], origin = "", revokeForm, helpers }) {
  const { html, cell, table, timestamp } = helpers;
  const base = String(origin || "").replace(/\/+$/, "");
  const rows = publications.map((item) => {
    const state = describePublishLifecycle(item?.lifecycle);
    const publishPath = `/publish/${encodeURIComponent(String(item?.id ?? ""))}`;
    const link = state.public
      ? `<a class="breakable" href="${html(`${base}${publishPath}`)}" target="_blank" rel="noopener noreferrer">${html(`${base}${publishPath}`)}</a>`
      : `<code class="breakable">${html(publishPath)}</code> <span class="badge">${esc(t("adm.pub.revoked"))}</span>`;
    const stateCell = `<span class="${html(state.tone)}">${html(state.label)}</span><br><span class="muted">${html(state.hint)}</span>`;
    const stamp = timestamp(item?.createdAt) + (item?.updatedAt ? `<br><span class="muted">${timestamp(item.updatedAt)}</span>` : "");
    return `<tr>${cell(t("adm.pub.col.state"), stateCell)}${cell(t("adm.pub.col.publicId"), `<code class="breakable">${html(item?.id)}</code>`)}${cell("Vault", `<strong>${html(item?.vaultId)}</strong>`)}${cell("文档路径", `<code class="breakable">${html(item?.path)}</code>`)}${cell("公开链接", link)}${cell("创建 / 更新时间", stamp)}${cell("发布者", html(item?.createdBy || "—"))}${cell("操作", revokeForm(item), 'class="col-actions"')}</tr>`;
  }).join("");
  return table(publishPanelHeaders(), rows, t("adm.pub.empty"));
}
