// Admin UI v2 W2: typed presentation states (Audit / Git / Publish / AuthZ).
// Distinguishes proven types; never paints "healthy" from absence of data.

import {
  auditResultLabel,
  gitConfigSourceLabel,
  gitRuntimeLabel,
  publishLifecycleLabel,
} from "./labels.js";

function freezeState(partial) {
  return Object.freeze({
    kind: partial.kind,
    label: partial.label,
    tone: partial.tone,
    raw: partial.raw ?? null,
    hint: partial.hint ?? null,
  });
}

export function presentAuditResult(result) {
  const view = auditResultLabel(result);
  const raw = view.raw;
  let tone = "neutral";
  if (raw && /^(ok|success|allow)$/i.test(raw)) tone = "ok";
  else if (raw && /^(error|fail|failed|deny)$/i.test(raw)) tone = "bad";
  else if (!view.known) tone = "muted";
  return freezeState({
    kind: "audit-result",
    label: view.label,
    tone,
    raw,
    hint: view.known ? null : "结果枚举未登记，保留原始值",
  });
}

export function presentPublishLifecycle(lifecycle) {
  const view = publishLifecycleLabel(lifecycle);
  const raw = view.raw;
  const publicOk = raw === "active";
  let tone = "bad";
  let hint = null;
  if (raw === "active") {
    tone = "ok";
    hint = "公开链接可访问";
  } else if (raw === "orphaned") {
    hint = "目标文件已缺失，公开页返回 404，可撤销清理";
  } else if (raw === "invalid") {
    hint = "目标当前不是 Markdown，公开页返回 404，可撤销清理";
  } else if (raw === "unknown") {
    hint = "尚未观察到目标状态，不作为公开候选";
  } else {
    hint = "记录状态无法识别，不作为公开候选";
  }
  return freezeState({
    kind: "publish-lifecycle",
    label: view.label,
    tone: publicOk ? "ok" : tone,
    raw,
    hint,
  });
}

export function presentGitRuntime(state) {
  const view = gitRuntimeLabel(state);
  const raw = view.raw;
  let tone = "bad";
  if (raw === "ready") tone = "ok";
  else if (raw === "disabled") tone = "muted";
  else if (!view.known) tone = "muted";
  return freezeState({
    kind: "git-runtime",
    label: view.label,
    tone,
    raw,
    hint:
      raw === "disabled"
        ? "未启用不是故障；启用后异常才标红"
        : view.known
          ? null
          : "运行时状态未登记，保留原始值",
  });
}

export function presentGitConfigSource(source) {
  const view = gitConfigSourceLabel(source);
  const raw = view.raw;
  const tone = raw === "default-disabled" ? "muted" : view.known ? "neutral" : "muted";
  return freezeState({
    kind: "git-config-source",
    label: view.label,
    tone,
    raw,
    hint:
      raw === "default-disabled"
        ? "默认关闭，与运行时故障区分"
        : view.known
          ? null
          : "配置来源未登记，保留原始值",
  });
}

/**
 * AuthZ applicability vs draft.
 * status: ready | broken | unavailable | draft | active | inactive
 */
export function presentAuthzStatus(status, { draft = false } = {}) {
  const raw = status == null ? "" : String(status).trim();
  if (draft) {
    return freezeState({
      kind: "authz-status",
      label: "草稿（未保存）",
      tone: "amber",
      raw: raw || "draft",
      hint: "草稿预览不是已生效策略",
    });
  }
  switch (raw) {
    case "ready":
    case "active":
      return freezeState({
        kind: "authz-status",
        label: raw === "active" ? "已生效" : "就绪",
        tone: "ok",
        raw,
        hint: null,
      });
    case "inactive":
    case "disabled":
      return freezeState({
        kind: "authz-status",
        label: "已停用",
        tone: "muted",
        raw,
        hint: null,
      });
    case "broken":
      return freezeState({
        kind: "authz-status",
        label: "存储损坏",
        tone: "bad",
        raw,
        hint: "管理员仍可进入修复面；勿把损坏显示成正常",
      });
    case "unavailable":
      return freezeState({
        kind: "authz-status",
        label: "不可用",
        tone: "bad",
        raw,
        hint: "策略服务不可用（fail closed）",
      });
    default:
      return freezeState({
        kind: "authz-status",
        label: raw ? `未知状态（${raw}）` : "未提供",
        tone: "muted",
        raw: raw || null,
        hint: "缺少权威状态字段时保持中性，不虚报运行正常",
      });
  }
}

/** Trust / cause source for audit attribution when only a raw token exists. */
export function presentTrustSource(source) {
  const raw = source == null ? "" : String(source).trim();
  if (!raw) {
    return freezeState({
      kind: "trust-source",
      label: "未知",
      tone: "muted",
      raw: null,
      hint: "无来源值时显示 unknown，不推断本机用户",
    });
  }
  const known = {
    direct: "直连",
    proxy: "代理",
    unknown: "未知",
    local: "连接对端本机",
  };
  const label = Object.prototype.hasOwnProperty.call(known, raw) ? known[raw] : `未登记（${raw}）`;
  return freezeState({
    kind: "trust-source",
    label,
    tone: raw === "unknown" ? "muted" : "neutral",
    raw,
    hint: raw === "local" ? "连接对端本机 ≠ 已证明来自真实本机用户" : null,
  });
}
