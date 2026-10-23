// Admin UI v2 W2: status / action / credential / Git / Publish Chinese labels.
// Pure data + pure functions. Unknown raw values stay visible as technical secondary text;
// this module never invents a health state from a missing field.

const ACTION_LABELS = Object.freeze({
  login: "登录",
  logout: "退出",
  create: "创建",
  update: "更新",
  delete: "删除",
  revoke: "撤销",
  clear: "清空",
  save: "保存",
  verify: "校验",
  refresh: "刷新",
  repair: "修复",
  preview: "预览",
  transfer_begin: "开始转移",
  transfer_cancel: "取消转移",
  "admin.login": "管理员登录",
  "admin.logout": "管理员退出",
  "audit.clear": "清空审计日志",
  "oauth.authorize": "OAuth 同意授权",
  "oauth.token": "签发 Token",
  "oauth.refresh": "刷新 Token",
  "oauth.register": "注册客户端",
  "oauth.client.transfer.begin": "发起授权转移",
  "oauth.client.transfer.cancel": "取消授权转移",
  "oauth.user.password": "重置账户密码",
  "oauth.user.create": "创建 OAuth 账户",
  "oauth.user.disable": "停用 OAuth 账户",
  "oauth.user.enable": "启用 OAuth 账户",
  "oauth.user.delete": "删除 OAuth 账户",
  "oauth.user.update": "更新 OAuth 账户",
  "apikey.create": "创建 API Key",
  "apikey.revoke": "撤销 API Key",
  "apikey.update": "更新 API Key",
  "authz.policy.update": "修改定时授权",
  "authz.policy.create": "创建定时授权",
  "authz.policy.delete": "删除定时授权",
  "authz.denied": "定时授权拒绝",
  "auth.reject": "定时授权拒绝",
  "mcp.initialize": "MCP 连接",
  "mcp.tools/call": "MCP 工具调用",
  "mcp.tool.manage_publish": "MCP 发布管理",
  "mcp.notifications/initialized": "MCP 初始化完成",
  "mcp.resources/read": "MCP 读取资源",
  "web.login": "Web 登录",
  "publish.create": "发布文档",
  "publish.revoke": "撤销发布",
});

const CREDENTIAL_KIND_LABELS = Object.freeze({
  "api-key": "API Key",
  "oauth-user": "OAuth 账户",
  "oauth-client": "OAuth 客户端",
  "oauth-access": "访问 Token",
  "oauth-refresh": "刷新 Token",
  "oauth-code": "授权码",
  "admin-session": "管理会话",
  "web-session": "Web 会话",
  "configured-env": "环境配置 API_KEY",
  none: "匿名",
  admin: "管理员会话",
});

const AUDIT_RESULT_LABELS = Object.freeze({
  ok: "成功",
  success: "成功",
  allow: "允许",
  deny: "拒绝",
  error: "失败",
  fail: "失败",
  failed: "失败",
  failure: "失败",
});

const PUBLISH_LIFECYCLE_LABELS = Object.freeze({
  active: "公开中",
  orphaned: "已失效",
  invalid: "无效",
  unknown: "未确认",
});

const GIT_RUNTIME_LABELS = Object.freeze({
  disabled: "未启用",
  ready: "已就绪",
  "repository-missing": "未初始化 Git 仓库",
  "config-invalid": "配置无效",
  "push-failing": "推送失败",
  unknown: "未知状态",
});

const GIT_CONFIG_SOURCE_LABELS = Object.freeze({
  "env-default": "环境默认",
  persisted: "管理端保存",
  "default-disabled": "默认关闭",
});

const AUTHZ_MODE_LABELS = Object.freeze({
  allow: "允许",
  deny: "拒绝",
  revoke: "撤销",
});

function normalize(value) {
  if (value == null) return "";
  return String(value).trim();
}

function labeled(map, value, unknownPrefix = "未知") {
  const raw = normalize(value);
  if (!raw) return Object.freeze({ label: "—", raw: null, known: false });
  if (Object.prototype.hasOwnProperty.call(map, raw)) {
    return Object.freeze({ label: map[raw], raw, known: true });
  }
  return Object.freeze({ label: `${unknownPrefix}（${raw}）`, raw, known: false });
}

export function actionLabel(value) {
  const raw = normalize(value);
  if (!raw) return Object.freeze({ label: "—", raw: null, known: false });
  if (Object.prototype.hasOwnProperty.call(ACTION_LABELS, raw)) {
    return Object.freeze({ label: ACTION_LABELS[raw], raw, known: true });
  }
  // mcp.tool.<name> → MCP 工具调用 / name
  if (raw.startsWith("mcp.tool.")) {
    const tool = raw.slice("mcp.tool.".length);
    return Object.freeze({ label: tool ? `MCP 工具调用 · ${tool}` : "MCP 工具调用", raw, known: true });
  }
  if (raw.startsWith("mcp.tools/")) {
    return Object.freeze({ label: "MCP 工具调用", raw, known: true });
  }
  if (raw.includes("access-policy") || raw.includes("authz")) {
    return Object.freeze({ label: "定时授权", raw, known: true });
  }
  return Object.freeze({ label: raw, raw, known: false });
}

export function actionCategory(value) {
  const raw = normalize(value);
  if (!raw) return "";
  if (raw.startsWith("admin.") || raw.startsWith("apikey.") || raw.startsWith("oauth.user.") || raw === "audit.clear") return "管理";
  if (raw.startsWith("oauth.")) return "OAuth";
  if (raw.startsWith("mcp.") || raw === "authz.denied" || raw === "auth.reject") return "MCP";
  if (raw.startsWith("web.") || raw.startsWith("publish.")) return "Web";
  if (raw.startsWith("authz.")) return "管理";
  return "";
}

export function credentialKindLabel(value) {
  return labeled(CREDENTIAL_KIND_LABELS, value, "未知凭据");
}

export function auditResultLabel(value) {
  return labeled(AUDIT_RESULT_LABELS, value, "未知结果");
}

export function publishLifecycleLabel(value) {
  return labeled(PUBLISH_LIFECYCLE_LABELS, value, "状态未知");
}

export function gitRuntimeLabel(value) {
  return labeled(GIT_RUNTIME_LABELS, value, "未知状态");
}

export function gitConfigSourceLabel(value) {
  return labeled(GIT_CONFIG_SOURCE_LABELS, value, "未知来源");
}

export function authzModeLabel(value) {
  return labeled(AUTHZ_MODE_LABELS, value, "未知模式");
}

export const LABEL_CATALOGS = Object.freeze({
  action: ACTION_LABELS,
  credentialKind: CREDENTIAL_KIND_LABELS,
  auditResult: AUDIT_RESULT_LABELS,
  publishLifecycle: PUBLISH_LIFECYCLE_LABELS,
  gitRuntime: GIT_RUNTIME_LABELS,
  gitConfigSource: GIT_CONFIG_SOURCE_LABELS,
  authzMode: AUTHZ_MODE_LABELS,
});
