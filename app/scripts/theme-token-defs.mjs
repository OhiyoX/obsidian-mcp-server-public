// CSS lexing helpers shared by the community-theme subset extractor and the
// render-parity theme gates.
//
// They are DOM-free and process-free on purpose: the extractor runs in Node, and
// the gates need the same token truth to reason about what a theme declares.
// Extracted from `extract-theme-subset.mjs` when the dark-side sampling (#360)
// needed an option here and pushed that file past the line budget.

export const TOKEN_PROP = /^--[a-zA-Z0-9_-]+$/;

/** Split on a top-level separator, ignoring separators inside `()`/`[]`/quotes. */
export function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      current += char;
      if (char === "\\") { current += text[i + 1] ?? ""; i += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === separator && depth === 0) { parts.push(current); current = ""; continue; }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Declarations of one rule body, with `!important` split off. */
export function parseDeclarations(block) {
  const decls = [];
  for (const chunk of splitTopLevel(block, ";")) {
    const text = chunk.trim();
    const colon = text.indexOf(":");
    if (colon <= 0) continue;
    const prop = text.slice(0, colon).trim();
    let value = text.slice(colon + 1).trim();
    const important = /!\s*important$/i.test(value);
    if (important) value = value.replace(/!\s*important$/i, "").trim();
    if (prop && value) decls.push({ prop, value, important });
  }
  return decls;
}

/**
 * Token definitions from a rule list, keyed by property and ordered by source.
 *
 * `includeDark` defaults to FALSE on purpose: the subset extractor derives a
 * LIGHT-mode-only fixture, so a `.theme-dark`-scoped declaration can never match
 * there and keeping it would only inflate the committed subset. A caller that
 * samples the dark side (issue #360) must pass `{ includeDark: true }`, otherwise
 * the table would be missing the very declarations the dark cascade uses and the
 * gate would compare the computed value against the theme's light definition.
 *
 * With `includeDark`, a declaration inside a CONDITIONAL at-rule (`@media`,
 * `@supports`) is skipped: it cannot be attributed without evaluating that
 * condition. The light table deliberately keeps its historical behaviour (the
 * frozen pre-#360 baseline), which is why the skip is scoped to the dark table
 * (measured: Things declares `--h1-color: var(--color-base-00)` inside
 * `@media print`, which the 1440px screen cascade never applies).
 */
export function collectTokenDefs(rules, { includeDark = false } = {}) {
  const table = {};
  for (const rule of rules) {
    if (includeDark && rule.context && /@(media|supports)\b/i.test(rule.context)) continue;
    const selectors = splitTopLevel(rule.selector, ",").map((entry) => entry.trim()).filter(Boolean);
    for (const decl of rule.decls) {
      if (!TOKEN_PROP.test(decl.prop)) continue;
      const defs = table[decl.prop] || [];
      for (const selector of selectors) {
        if (!includeDark && /\B\.theme-dark\b/.test(selector)) continue;
        if (defs.some(([existing]) => existing === selector)) continue;
        defs.push([selector, decl.value, decl.important ? 1 : 0]);
      }
      if (defs.length) table[decl.prop] = defs;
    }
  }
  return table;
}
