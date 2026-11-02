// Admin UI v2 W2: status / action / credential / Git / Publish labels.
// Pure data + pure functions. Unknown raw values stay visible as technical secondary text;
// this module never invents a health state from a missing field.
//
// i18n: the tables hold **catalog keys**, not copy. `zh-CN` renders byte-identical to
// the historic literals (the parity gate pins that face), and the copy is resolved
// per request through `src/i18n/context.js` — see that module for why the Admin plane
// uses request scope instead of a `t` parameter on every lookup.
import { t } from "../../i18n/context.js";

const ACTION_KEYS = Object.freeze({
  login: "adm.label.action.login",
  logout: "adm.label.action.logout",
  create: "adm.label.action.create",
  update: "adm.label.action.update",
  delete: "adm.label.action.delete",
  revoke: "adm.label.action.revoke",
  clear: "adm.label.action.clear",
  save: "adm.label.action.save",
  verify: "adm.label.action.verify",
  refresh: "adm.label.action.refresh",
  repair: "adm.label.action.repair",
  preview: "adm.label.action.preview",
  transfer_begin: "adm.label.action.transfer_begin",
  transfer_cancel: "adm.label.action.transfer_cancel",
  "admin.login": "adm.label.action.admin.login",
  "admin.logout": "adm.label.action.admin.logout",
  "audit.clear": "adm.label.action.audit.clear",
  "oauth.authorize": "adm.label.action.oauth.authorize",
  "oauth.token": "adm.label.action.oauth.token",
  "oauth.refresh": "adm.label.action.oauth.refresh",
  "oauth.register": "adm.label.action.oauth.register",
  "oauth.client.transfer.begin": "adm.label.action.oauth.client.transfer.begin",
  "oauth.client.transfer.cancel": "adm.label.action.oauth.client.transfer.cancel",
  "oauth.user.password": "adm.label.action.oauth.user.password",
  "oauth.user.create": "adm.label.action.oauth.user.create",
  "oauth.user.disable": "adm.label.action.oauth.user.disable",
  "oauth.user.enable": "adm.label.action.oauth.user.enable",
  "oauth.user.delete": "adm.label.action.oauth.user.delete",
  "oauth.user.update": "adm.label.action.oauth.user.update",
  "apikey.create": "adm.label.action.apikey.create",
  "apikey.revoke": "adm.label.action.apikey.revoke",
  "apikey.update": "adm.label.action.apikey.update",
  "authz.policy.update": "adm.label.action.authz.policy.update",
  "authz.policy.create": "adm.label.action.authz.policy.create",
  "authz.policy.delete": "adm.label.action.authz.policy.delete",
  "authz.denied": "adm.label.action.authz.denied",
  "auth.reject": "adm.label.action.auth.reject",
  "mcp.initialize": "adm.label.action.mcp.initialize",
  "mcp.tools/call": "adm.label.action.mcp.tools/call",
  "mcp.tool.manage_publish": "adm.label.action.mcp.tool.manage_publish",
  "mcp.notifications/initialized": "adm.label.action.mcp.notifications/initialized",
  "mcp.resources/read": "adm.label.action.mcp.resources/read",
  "web.login": "adm.label.action.web.login",
  "publish.create": "adm.label.action.publish.create",
  "publish.revoke": "adm.label.action.publish.revoke",
});

const CREDENTIAL_KIND_KEYS = Object.freeze({
  "api-key": "adm.label.credential.api-key",
  "oauth-user": "adm.label.credential.oauth-user",
  "oauth-client": "adm.label.credential.oauth-client",
  "oauth-access": "adm.label.credential.oauth-access",
  "oauth-refresh": "adm.label.credential.oauth-refresh",
  "oauth-code": "adm.label.credential.oauth-code",
  "admin-session": "adm.label.credential.admin-session",
  "web-session": "adm.label.credential.web-session",
  "configured-env": "adm.label.credential.configured-env",
  none: "adm.label.credential.none",
  admin: "adm.label.credential.admin",
});

const AUDIT_RESULT_KEYS = Object.freeze({
  ok: "adm.label.result.ok",
  success: "adm.label.result.success",
  allow: "adm.label.result.allow",
  deny: "adm.label.result.deny",
  error: "adm.label.result.error",
  fail: "adm.label.result.fail",
  failed: "adm.label.result.failed",
  failure: "adm.label.result.failure",
});

const PUBLISH_LIFECYCLE_KEYS = Object.freeze({
  active: "adm.label.publish.active",
  orphaned: "adm.label.publish.orphaned",
  invalid: "adm.label.publish.invalid",
  unknown: "adm.label.publish.unknown",
});

const GIT_RUNTIME_KEYS = Object.freeze({
  disabled: "adm.label.gitRuntime.disabled",
  ready: "adm.label.gitRuntime.ready",
  "repository-missing": "adm.label.gitRuntime.repository-missing",
  "config-invalid": "adm.label.gitRuntime.config-invalid",
  "push-failing": "adm.label.gitRuntime.push-failing",
  unknown: "adm.label.gitRuntime.unknown",
});

const GIT_CONFIG_SOURCE_KEYS = Object.freeze({
  "env-default": "adm.label.gitSource.env-default",
  persisted: "adm.label.gitSource.persisted",
  "default-disabled": "adm.label.gitSource.default-disabled",
});

const AUTHZ_MODE_KEYS = Object.freeze({
  allow: "adm.label.authzMode.allow",
  deny: "adm.label.authzMode.deny",
  revoke: "adm.label.authzMode.revoke",
});

function normalize(value) {
  if (value == null) return "";
  return String(value).trim();
}

function labeled(keys, value, unknownKey) {
  const raw = normalize(value);
  if (!raw) return Object.freeze({ label: "—", raw: null, known: false });
  if (Object.prototype.hasOwnProperty.call(keys, raw)) {
    return Object.freeze({ label: t(keys[raw]), raw, known: true });
  }
  // The raw value stays visible: a technical identifier must not be hidden just
  // because this build has no copy for it.
  return Object.freeze({ label: `${t(unknownKey)}${t("adm.label.withRawTail", { raw })}`, raw, known: false });
}

export function actionLabel(value) {
  const raw = normalize(value);
  if (!raw) return Object.freeze({ label: "—", raw: null, known: false });
  if (Object.prototype.hasOwnProperty.call(ACTION_KEYS, raw)) {
    return Object.freeze({ label: t(ACTION_KEYS[raw]), raw, known: true });
  }
  // mcp.tool.<name> → MCP 工具调用 / name
  if (raw.startsWith("mcp.tool.")) {
    const tool = raw.slice("mcp.tool.".length);
    return Object.freeze({ label: tool ? t("adm.label.mcpToolNamed", { tool }) : t("adm.label.mcpTool"), raw, known: true });
  }
  if (raw.startsWith("mcp.tools/")) {
    return Object.freeze({ label: t("adm.label.mcpTool"), raw, known: true });
  }
  if (raw.includes("access-policy") || raw.includes("authz")) {
    return Object.freeze({ label: t("adm.label.authz"), raw, known: true });
  }
  return Object.freeze({ label: raw, raw, known: false });
}

export function actionCategory(value) {
  const raw = normalize(value);
  if (!raw) return "";
  if (raw.startsWith("admin.") || raw.startsWith("apikey.") || raw.startsWith("oauth.user.") || raw === "audit.clear") return t("adm.label.category.admin");
  if (raw.startsWith("oauth.")) return t("adm.label.category.oauth");
  if (raw.startsWith("mcp.") || raw === "authz.denied" || raw === "auth.reject") return t("adm.label.category.mcp");
  if (raw.startsWith("web.") || raw.startsWith("publish.")) return t("adm.label.category.web");
  if (raw.startsWith("authz.")) return t("adm.label.category.admin");
  return "";
}

export function credentialKindLabel(value) {
  return labeled(CREDENTIAL_KIND_KEYS, value, "adm.label.unknownCredential");
}

export function auditResultLabel(value) {
  return labeled(AUDIT_RESULT_KEYS, value, "adm.label.unknownResult");
}

export function publishLifecycleLabel(value) {
  return labeled(PUBLISH_LIFECYCLE_KEYS, value, "adm.label.unknownPublish");
}

export function gitRuntimeLabel(value) {
  return labeled(GIT_RUNTIME_KEYS, value, "adm.label.unknownGitRuntime");
}

export function gitConfigSourceLabel(value) {
  return labeled(GIT_CONFIG_SOURCE_KEYS, value, "adm.label.unknownGitSource");
}

export function authzModeLabel(value) {
  return labeled(AUTHZ_MODE_KEYS, value, "adm.label.unknownAuthzMode");
}

export const LABEL_CATALOGS = Object.freeze({
  action: ACTION_KEYS,
  credentialKind: CREDENTIAL_KIND_KEYS,
  auditResult: AUDIT_RESULT_KEYS,
  publishLifecycle: PUBLISH_LIFECYCLE_KEYS,
  gitRuntime: GIT_RUNTIME_KEYS,
  gitConfigSource: GIT_CONFIG_SOURCE_KEYS,
  authzMode: AUTHZ_MODE_KEYS,
});
