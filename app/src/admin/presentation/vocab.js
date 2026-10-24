// Admin UI vocabulary ported from the prototype (`docs/admin-ui-proto/src/4-data.js` + `5-render.js`):
// scope names, token status words, policy modes, weekday names, subject kinds. Pure data — the
// prototype's wording is the UI source of truth, and every lookup keeps the raw technical value
// available for the secondary line.

export const SCOPES = Object.freeze([
  Object.freeze({ key: "obsidian.read", name: "读取", desc: "读取笔记、搜索、查看历史" }),
  Object.freeze({ key: "obsidian.write", name: "写入", desc: "创建、修改、移动笔记" }),
  Object.freeze({ key: "obsidian.files", name: "文件", desc: "上传与管理附件文件" }),
]);

export function scopeName(key) {
  return SCOPES.find((scope) => scope.key === key)?.name ?? String(key ?? "");
}

/** Prototype `TOKEN_ST`: label + status colour class. */
export const TOKEN_ST = Object.freeze({
  active: Object.freeze(["有效", "ok"]),
  rotated: Object.freeze(["已轮换", "off"]),
  revoked: Object.freeze(["已撤销", "danger"]),
  expired: Object.freeze(["已过期", "off"]),
});

/** Prototype `MODE` for time-window policies. */
export const MODE = Object.freeze({
  suspend: Object.freeze({ n: "暂停", d: "窗口外暂停访问，已有会话与授权保留，回到窗口内自动恢复" }),
  revoke: Object.freeze({ n: "撤销", d: "窗口外撤销该主体的全部授权与会话，需重新授权；能力必须为「全部」" }),
  // The runtime's own vocabulary (access-policy/capabilities.js) also knows allow/deny; the editor
  // only offers suspend/revoke, but a stored policy may carry an older mode — keep it readable.
  allow: Object.freeze({ n: "允许", d: "窗口内放行；窗口外由基线权限决定" }),
  deny: Object.freeze({ n: "拒绝", d: "窗口内拒绝访问" }),
});

export const DAYS = Object.freeze(["周日", "周一", "周二", "周三", "周四", "周五", "周六"]);

export const KIND_LABEL = Object.freeze({
  "api-key": "API Key",
  "oauth-client": "OAuth 客户端",
  "oauth-user": "OAuth 账户",
});

/** Prototype `stTag`-style status span (dot + word). */
export function st(label, cls = "off", title = "") {
  const titleAttr = title ? ` title="${title}"` : "";
  return `<span class="st ${cls}"${titleAttr}><span class="dot"></span>${label}</span>`;
}

export function statusOfToken(status) {
  const [label, cls] = TOKEN_ST[status] || [String(status ?? "未知"), "off"];
  return st(label, cls, String(status ?? ""));
}

/** Prototype capability-group order, mapped onto the runtime catalog's real group labels. */
export const CAP_GROUP_ORDER = Object.freeze(["all", "surface", "scope", "toolset", "tool", "resource"]);
export const CAP_GROUP_LABEL = Object.freeze({
  all: "全部能力",
  surface: "访问面",
  scope: "权限范围",
  toolset: "工具集",
  tool: "单个工具",
  resource: "资源",
});
