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

import { PUBLISH_LIFECYCLE } from "../publish/lifecycle.js";

// Presentation only: label + tone + one-line operator hint. `public` decides
// whether the opaque id renders as a live <a> or as dead text.
const PRESENTATION = Object.freeze({
  [PUBLISH_LIFECYCLE.ACTIVE]: Object.freeze({ label: "已公开", tone: "ok", public: true, hint: "匿名链接可访问" }),
  [PUBLISH_LIFECYCLE.ORPHANED]: Object.freeze({ label: "目标缺失", tone: "bad", public: false, hint: "目标文件已缺失，匿名链接 404；可撤销清理" }),
  [PUBLISH_LIFECYCLE.INVALID]: Object.freeze({ label: "不符合公开契约", tone: "bad", public: false, hint: "目标当前不是 Markdown，匿名链接 404；可撤销清理" }),
  [PUBLISH_LIFECYCLE.UNKNOWN]: Object.freeze({ label: "待确认", tone: "bad", public: false, hint: "尚未观测到目标状态，不作为公开候选" }),
});

// An unrecognized/absent lifecycle is a rendering fallback for a foreign state
// file, not a sixth product state: it fails closed and is never a public candidate.
const UNRECOGNIZED = Object.freeze({ label: "状态未知", tone: "bad", public: false, hint: "记录状态无法识别，不作为公开候选" });

export const PUBLISH_PANEL_HEADERS = Object.freeze([
  "状态", "公开 ID", "Vault", "文档路径", "公开链接", "创建 / 更新时间", "发布者", "操作",
]);

export function describePublishLifecycle(lifecycle) {
  return PRESENTATION[lifecycle] || UNRECOGNIZED;
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
      : `<code class="breakable">${html(publishPath)}</code> <span class="badge">已失效</span>`;
    const stateCell = `<span class="${html(state.tone)}">${html(state.label)}</span><br><span class="muted">${html(state.hint)}</span>`;
    const stamp = timestamp(item?.createdAt) + (item?.updatedAt ? `<br><span class="muted">${timestamp(item.updatedAt)}</span>` : "");
    return `<tr>${cell("状态", stateCell)}${cell("公开 ID", `<code class="breakable">${html(item?.id)}</code>`)}${cell("Vault", `<strong>${html(item?.vaultId)}</strong>`)}${cell("文档路径", `<code class="breakable">${html(item?.path)}</code>`)}${cell("公开链接", link)}${cell("创建 / 更新时间", stamp)}${cell("发布者", html(item?.createdBy || "—"))}${cell("操作", revokeForm(item), 'class="col-actions"')}</tr>`;
  }).join("");
  return table(PUBLISH_PANEL_HEADERS, rows, "暂无 Publish 文档");
}
