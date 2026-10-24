// Admin-plane presentation for the canonical per-Vault capability keys (issue #402).
//
// The upstream reason text is an *implementer* decision record: `src/vault-runtime/capabilities.js`
// `UNWIRED_CAPABILITY_DECISIONS` is consumed by the MCP/契约 surface and must keep its wording and
// structure (contract §3.4 `available:false + reason`). The Admin plane therefore owns a *display*
// mapping here instead of rendering that English prose as a badge:
//
//  - the badge shows `<中文名> · 可用/不可用` (bounded, single line, the §3 badge rule);
//  - the operator-facing one-liner names the plane that owns the capability;
//  - the untouched upstream reason stays in the DOM behind a closed `<details>技术细节</details>`,
//    which is what the prototype keeps manageable: long engine text stays behind <details>.
//  - an unknown key falls back to `<key> · 可用/不可用` — never to the raw reason, so a new
//    unwired capability can never re-introduce a 907px badge.
//
// Pure data + two pure functions: no I/O, no framework import, no DOM.

/** Chinese display names for every `CAPABILITY_KEYS` entry (`vault-runtime/descriptor.js`). */
export const CAPABILITY_LABELS = Object.freeze({
  notes: "笔记读写",
  files: "文件与上传",
  history: "历史版本",
  trash: "回收站",
  plans: "变更方案",
  retrieval: "检索索引",
  semantic: "语义检索",
  webCatalog: "Web 目录",
  publish: "发布",
  git: "Git",
  events: "实时事件",
  memory: "记忆",
  skills: "技能",
});

/**
 * One Chinese sentence explaining *why* the capability is unavailable and which plane owns it —
 * the answer to the operator's "我该怎么办". Keys without an entry fall back to a neutral line.
 */
export const UNWIRED_CAPABILITY_HINTS = Object.freeze({
  semantic: "本机未配置向量服务，未启用；检索仍按关键词工作",
  webCatalog: "属于 Web 平面能力，MCP 不消费该键",
  events: "属于 Web / SSE 平面能力，MCP 不消费该键",
});

/** The neutral fallback for an unwired key without a recorded hint. */
export const UNWIRED_FALLBACK_HINT = "该能力尚未接线，当前不生效";

/** Chinese display name, or `null` when the key has no mapping. */
export function capabilityLabel(key) {
  const value = typeof key === "string" ? key.trim() : "";
  return Object.prototype.hasOwnProperty.call(CAPABILITY_LABELS, value) ? CAPABILITY_LABELS[value] : null;
}

/** `<中文名> · 可用` / `<中文名> · 不可用`; falls back to the raw key. */
export function capabilityStateLabel(key, available) {
  const name = capabilityLabel(key) ?? (typeof key === "string" ? key.trim() : "");
  return `${name} · ${available ? "可用" : "不可用"}`;
}

/** The short Chinese hint for an unavailable capability. */
export function capabilityHint(key) {
  const value = typeof key === "string" ? key.trim() : "";
  return Object.prototype.hasOwnProperty.call(UNWIRED_CAPABILITY_HINTS, value)
    ? UNWIRED_CAPABILITY_HINTS[value]
    : UNWIRED_FALLBACK_HINT;
}
