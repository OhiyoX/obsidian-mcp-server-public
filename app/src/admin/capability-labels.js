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
import { t } from "../i18n/context.js";

/** Chinese display names for every `CAPABILITY_KEYS` entry (`vault-runtime/descriptor.js`). */
export function capabilityLabels() {
  return {
    notes: t("adm.cap.notes"),
    files: t("adm.cap.files"),
    history: t("adm.cap.history"),
    trash: t("adm.cap.trash"),
    plans: t("adm.cap.plans"),
    retrieval: t("adm.cap.retrieval"),
    semantic: t("adm.cap.semantic"),
    webCatalog: t("adm.cap.webCatalog"),
    publish: t("adm.cap.publish"),
    git: t("adm.cap.git"),
    events: t("adm.cap.events"),
    memory: t("adm.cap.memory"),
    skills: t("adm.cap.skills"),
  };
}

/**
 * One Chinese sentence explaining *why* the capability is unavailable and which plane owns it —
 * the answer to the operator's "我该怎么办". Keys without an entry fall back to a neutral line.
 */
export function unwiredCapabilityHints() {
  return {
    semantic: t("adm.cap.hint.semantic"),
    webCatalog: t("adm.cap.hint.webCatalog"),
    events: t("adm.cap.hint.events"),
  };
}

/** The neutral fallback for an unwired key without a recorded hint. */
export function unwiredFallbackHint() {
  return t("adm.cap.hint.fallback");
}

/** Chinese display name, or `null` when the key has no mapping. */
export function capabilityLabel(key) {
  const value = typeof key === "string" ? key.trim() : "";
  const labels = capabilityLabels();
  return Object.prototype.hasOwnProperty.call(labels, value) ? labels[value] : null;
}

/** `<中文名> · 可用` / `<中文名> · 不可用`; falls back to the raw key. */
export function capabilityStateLabel(key, available) {
  const name = capabilityLabel(key) ?? (typeof key === "string" ? key.trim() : "");
  return `${name} · ${available ? t("adm.git.capAvailable") : t("adm.git.capUnavailable")}`;
}

/** The short Chinese hint for an unavailable capability. */
export function capabilityHint(key) {
  const value = typeof key === "string" ? key.trim() : "";
  const hints = unwiredCapabilityHints();
  return Object.prototype.hasOwnProperty.call(hints, value) ? hints[value] : unwiredFallbackHint();
}
