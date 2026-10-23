// The Admin plane's HTML-escape primitive, split out of `vault-git-view.js` so the
// per-Vault Git form module can escape without importing the view module (issue #404).
// Behaviour is byte-identical to the former local helper; `vault-git-view.js` re-exports
// it so existing importers and tests keep their import path.

/** Escape every HTML-significant character; `null`/`undefined` render as an empty string. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
