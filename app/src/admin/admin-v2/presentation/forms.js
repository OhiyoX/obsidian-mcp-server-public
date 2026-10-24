// Admin UI v2 W2: typed HTML escape + authorized hidden-field mapping for SSR forms.
// Pure. Does not invent endpoints; callers pass an allowlisted action + field map.

const ALLOWED_HIDDEN = new Set([
  "csrf",
  "id",
  "expectedRevision",
  "expected_revision",
  "confirm",
  "confirmName",
  "confirm_name",
  "target",
  "tab",
]);

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeAttr(value) {
  return escapeHtml(value);
}

/**
 * Render hidden inputs for an allowlisted field map.
 * Unknown keys are dropped (fail closed) — never echoed into HTML.
 */
export function renderHiddenFields(fields = {}) {
  const parts = [];
  for (const [name, value] of Object.entries(fields || {})) {
    if (!ALLOWED_HIDDEN.has(name)) continue;
    if (value == null) continue;
    parts.push(
      `<input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(value)}">`,
    );
  }
  return parts.join("");
}

/**
 * Build a POST form opening tag. Action must be an absolute-path string starting with /.
 * Rejects javascript: / protocol-relative / empty actions.
 */
export function formOpen({ action, method = "post", className = "" } = {}) {
  const act = String(action || "");
  if (!act.startsWith("/") || act.startsWith("//") || /[\s<>"']/.test(act)) {
    throw new Error("forms.formOpen: action must be a same-origin absolute path");
  }
  const m = String(method || "post").toLowerCase() === "get" ? "get" : "post";
  const cls = className ? ` class="${escapeAttr(className)}"` : "";
  return `<form method="${m}" action="${escapeAttr(act)}"${cls}>`;
}

export function formClose() {
  return "</form>";
}

/** Convenience: open + csrf/hidden + close wrapper pieces for callers assembling SSR. */
export function authorizedFormParts({ action, className = "", csrf, fields = {} } = {}) {
  const hidden = {
    ...(csrf != null && csrf !== "" ? { csrf } : {}),
    ...fields,
  };
  return Object.freeze({
    open: formOpen({ action, className }),
    hidden: renderHiddenFields(hidden),
    close: formClose(),
  });
}

export const FORMS_ALLOWED_HIDDEN = ALLOWED_HIDDEN;
