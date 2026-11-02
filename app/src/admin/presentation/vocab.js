// Admin UI vocabulary ported from the prototype (`docs/admin-ui-proto/src/4-data.js` + `5-render.js`):
// scope names, token status words, policy modes, weekday names, subject kinds. Pure data — the
// prototype's wording is the UI source of truth, and every lookup keeps the raw technical value
// available for the secondary line.
//
// i18n: the tables keep their shape (`SCOPES[i].name`, `TOKEN_ST[status]`, `MODE[key].n`, `DAYS[day]`)
// but the copy is a **getter**, so it resolves in the current request's language at read time instead
// of being frozen at import time. Consumers therefore need no signature change and the `zh-CN`
// render stays byte-identical to the historic literals.
import { t } from "../../i18n/context.js";

export const SCOPES = Object.freeze([
  Object.freeze({
    key: "obsidian.read",
    get name() { return t("adm.scope.read.name"); },
    get desc() { return t("adm.scope.read.desc"); },
  }),
  Object.freeze({
    key: "obsidian.write",
    get name() { return t("adm.scope.write.name"); },
    get desc() { return t("adm.scope.write.desc"); },
  }),
  Object.freeze({
    key: "obsidian.files",
    get name() { return t("adm.scope.files.name"); },
    get desc() { return t("adm.scope.files.desc"); },
  }),
]);

export function scopeName(key) {
  return SCOPES.find((scope) => scope.key === key)?.name ?? String(key ?? "");
}

/** Prototype `TOKEN_ST`: label + status colour class. */
export const TOKEN_ST = Object.freeze({
  get active() { return [t("adm.token.active"), "ok"]; },
  get rotated() { return [t("adm.token.rotated"), "off"]; },
  get revoked() { return [t("adm.token.revoked"), "danger"]; },
  get expired() { return [t("adm.token.expired"), "off"]; },
});

/** Prototype `MODE` for time-window policies. */
export const MODE = Object.freeze({
  get suspend() {
    return { n: t("adm.label.mode.suspend"), d: t("adm.label.mode.suspendDesc") };
  },
  get revoke() {
    return { n: t("adm.label.mode.revoke"), d: t("adm.label.mode.revokeDesc") };
  },
  // The runtime's own vocabulary (access-policy/capabilities.js) also knows allow/deny; the editor
  // only offers suspend/revoke, but a stored policy may carry an older mode — keep it readable.
  get allow() {
    return { n: t("adm.label.mode.allow"), d: t("adm.label.mode.allowDesc") };
  },
  get deny() {
    return { n: t("adm.label.mode.deny"), d: t("adm.label.mode.denyDesc") };
  },
});

const DAYS_BASE = Array.from({ length: 7 });
for (let index = 0; index < 7; index += 1) {
  Object.defineProperty(DAYS_BASE, index, {
    get: () => t(`adm.day.${index}`),
    enumerable: true,
    configurable: false,
  });
}

/** Prototype `DAYS`: `DAYS[day]` (0 = Sunday), resolved in the request's language. */
export const DAYS = Object.freeze(DAYS_BASE);

/** One weekday name by index, for call sites that prefer a function to an index. */
export function dayLabel(day) {
  return DAYS[Number(day)] ?? "";
}

export const KIND_LABEL = Object.freeze({
  get "api-key"() { return t("adm.label.credential.api-key"); },
  get "oauth-client"() { return t("adm.label.credential.oauth-client"); },
  get "oauth-user"() { return t("adm.label.credential.oauth-user"); },
});

/** Prototype `stTag`-style status span (dot + word). */
export function st(label, cls = "off", title = "") {
  const titleAttr = title ? ` title="${title}"` : "";
  return `<span class="st ${cls}"${titleAttr}><span class="dot"></span>${label}</span>`;
}

export function statusOfToken(status) {
  const [label, cls] = TOKEN_ST[status] || [t("adm.label.unknown"), "off"];
  return st(label, cls, String(status ?? ""));
}

/** Prototype capability-group order, mapped onto the runtime catalog's real group labels. */
export const CAP_GROUP_ORDER = Object.freeze(["all", "surface", "scope", "toolset", "tool", "resource"]);
export const CAP_GROUP_LABEL = Object.freeze({
  get all() { return t("adm.cap.all"); },
  get surface() { return t("adm.cap.surface"); },
  get scope() { return t("adm.cap.scope"); },
  get toolset() { return t("adm.cap.toolset"); },
  get tool() { return t("adm.cap.tool"); },
  get resource() { return t("adm.cap.resource"); },
});
