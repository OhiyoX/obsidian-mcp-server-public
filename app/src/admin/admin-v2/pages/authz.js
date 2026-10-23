// Admin UI v2 W5: AuthZ policy list proto helpers (SSR, no JS).
// Proto columns, Chinese mode labels, copy-as-new, Stage 5 FUT surface.
// Forms/preview/repair stay in access-policy-view.js. D0 HOLD.

import { statusPill, rowMenu } from "../components.js";
import { futBadge } from "../icons.js";
import { futBox } from "../detail-panel.js";
import { relativeLabel } from "../presentation/time.js";

const SUBJECT_KIND_SHORT = Object.freeze({
  "oauth-user": "账户",
  "oauth-client": "客户端",
  "api-key": "Key",
  other: "主体",
});

export function escapeAuthz(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function subjectParts(value) {
  const text = String(value ?? "");
  const index = text.indexOf(":");
  if (index <= 0) return { kind: "other", local: text, full: text };
  return { kind: text.slice(0, index), local: text.slice(index + 1), full: text };
}

function shortLocal(local) {
  const s = String(local ?? "");
  if (s.length <= 12) return s;
  return `${s.slice(0, 8)}…`;
}

/** #455 chip: display name (local) + type short + short id; full id in title. */
export function subjectChip(subject, { orphaned = false } = {}) {
  const { kind, local, full } = subjectParts(subject);
  const typeLabel = SUBJECT_KIND_SHORT[kind] || SUBJECT_KIND_SHORT.other;
  const name = local || full || "—";
  const shortId = shortLocal(local || full);
  const orphan = orphaned ? " · 孤立" : "";
  return `<span class="tag subj" title="${escapeAuthz(full)}"><b>${escapeAuthz(name)}</b><span class="muted"> ${escapeAuthz(typeLabel)}</span><span class="idc">${escapeAuthz(shortId)}</span>${orphan}</span>`;
}

const CAPABILITY_SHORT = Object.freeze({
  "scope:obsidian.read": "读取",
  "scope:obsidian.write": "写入笔记",
  "scope:obsidian.files": "文件",
  all: "全部",
  notes: "笔记读写",
  files: "文件与上传",
  history: "历史版本",
  retrieval: "检索",
  publish: "发布",
  git: "Git",
});
export function capabilityShortLabel(value) {
  const raw = String(value ?? "");
  if (CAPABILITY_SHORT[raw]) return CAPABILITY_SHORT[raw];
  if (raw.startsWith("scope:obsidian.")) return raw.slice("scope:obsidian.".length);
  if (raw.startsWith("tool:")) return raw.slice(5);
  return raw;
}
export function capabilityChips(capabilities = []) {
  const list = Array.isArray(capabilities) ? capabilities : [];
  if (!list.length) return `<span class="muted">—</span>`;
  if (list.length === 1 && list[0] === "all") {
    return `<div class="tags"><span class="tag amber">全部</span></div>`;
  }
  return `<div class="tags">${list.map((item) => `<span class="tag keep" title="${escapeAuthz(item)}">${escapeAuthz(capabilityShortLabel(item))}</span>`).join("")}</div>`;
}

export function policyStatus(enabled) {
  return statusPill({ ok: Boolean(enabled), okLabel: "启用", offLabel: "停用" });
}

export function policyMode(mode) {
  const m = String(mode || "");
  if (m === "revoke") return `<span class="st danger"><span class="dot"></span>窗口外撤销</span>`;
  if (m === "suspend") return `<span class="st amber"><span class="dot"></span>窗口外暂停</span>`;
  return `<span class="badge">${escapeAuthz(m || "—")}</span>`;
}

/** Combined 状态 · 模式 cell. */
export function policyStatusMode(policy) {
  return `<div>${policyStatus(policy?.enabled)}</div><div style="margin-top:4px">${policyMode(policy?.mode)}</div>`;
}

export const POLICY_LIST_HEADERS = Object.freeze([
  "策略", "状态 · 模式", "主体", "限制的能力", "允许时间窗口", "操作",
]);

/**
 * Build the ⋯ menu: edit · toggle · copy-as-new · delete.
 * Edit stays a GET link to ?edit=#authz-edit.
 */
export function policyRowMenu({ policy, csrf, actions, revision, editingId, editHref }) {
  const base = String(actions?.base || "/admin/auth/access-policy");
  const editLink = `<a class="btn secondary" href="${escapeAuthz(editHref)}"${editingId === policy.id ? ' aria-current="true"' : ""}>编辑</a>`;
  const toggle = `<form class="inline" method="post" action="${escapeAuthz(actions.toggle)}">${csrf}<input type="hidden" name="id" value="${escapeAuthz(policy.id)}"><input type="hidden" name="enabled" value="${policy.enabled ? "false" : "true"}"><input type="hidden" name="expectedRevision" value="${escapeAuthz(revision)}"><button class="btn secondary" type="submit">${policy.enabled ? "停用" : "启用"}</button></form>`;
  const copy = `<a class="btn secondary" href="${escapeAuthz(`${base}?new=1&copy=${encodeURIComponent(policy.id)}`)}">复制为新策略</a>`;
  const remove = `<a class="btn danger-o" href="${escapeAuthz(`${base}?confirm=delete&id=${encodeURIComponent(policy.id)}`)}">删除…</a>`;
  return rowMenu(`${editLink}${toggle}${copy}${remove}`);
}

export function policyNameCell(policy, escapeHtml, shortSubject) {
  const updated = policy.updatedAt || policy.modifiedAt || "";
  const updatedLine = updated ? `<div class="muted">修改于 ${escapeHtml(relativeLabel(updated) || String(updated))}</div>` : "";
  return `<strong class="label-keep">${escapeHtml(policy.label)}</strong><br><code class="breakable idc" title="${escapeHtml(policy.id)}">${escapeHtml(shortSubject(policy.id))}</code>${updatedLine}`;
}

export function subjectsCell(subjects, orphanedSet) {
  const list = Array.isArray(subjects) ? subjects : [];
  if (!list.length) return `<span class="muted">—</span>`;
  return `<div class="tags">${list.map((subject) => subjectChip(subject, { orphaned: orphanedSet.has(subject) })).join("")}</div>`;
}

/** Stage 5 master switch — muted FUT only (non-effecting). */
export function stage5MasterFut() {
  return futBox(`<label class="mode-card" style="opacity:.7;pointer-events:none"><input type="checkbox" disabled> <b>AuthZ 总开关</b><span class="help">关闭后全部策略不生效</span> ${futBadge("Stage 5")}</label>`);
}
