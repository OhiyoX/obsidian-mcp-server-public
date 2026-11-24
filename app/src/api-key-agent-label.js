// #285: the API Key Agent label is a **display purpose** an operator writes for a key
// (`pi-pocket`, `cursor`, `codex-cli`). It labels the Admin list and the audit attribution.
// It is never an authorization input: it does not enter Scope, a Vault allowlist or the
// AuthZ subject string (`api-key:<id>`), and changing it revokes nothing.
export const AGENT_LABEL_MAX = 40;

/**
 * Trims, then accepts 1–40 printable characters. `null`/`""` clears the label (unbound).
 * The length counts UTF-16 code units, so a character outside the BMP (one emoji, for
 * example) uses two of the 40 — the same unit the form's `maxlength="40"` counts.
 */
export function normalizeAgentLabel(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > AGENT_LABEL_MAX) throw new Error("agent_label_too_long");
  // `\p{Cc}` refuses every control character — C0, DEL and C1 (U+0085 NEL breaks the single line,
  // U+009F and the rest cannot be shown) — and `\p{Cf}` refuses format characters: the bidi
  // overrides (U+202E/U+2066…) and the zero-width ones, which would let a label masquerade as
  // different text in the list and the audit column. ZWJ emoji sequences (`\p{Cf}` U+200D) are
  // refused by design: this is a one-line identity label, not a place for composed emoji.
  if (/[\p{Cc}\p{Cf}]/u.test(text)) throw new Error("agent_label_invalid");
  return text;
}
