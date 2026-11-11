// #622 — the two mutations a text-only nail cannot see.
//
// `reader-property-pills.test.js` reads `app.css` as text: it finds a rule by substring and matches
// its body. Both of these injections leave that text in the file, so the nail stays green while the
// rendered pill changes:
//
//   * comment the whole rule out            → the text is still there, inside `/* … */`;
//   * move the rule into `@media (max-width:720px)` → the text is still there, at wide widths it
//     no longer applies.
//
// This walker answers the question the nail actually needs: which rules are LIVE at top level.
// Comments are stripped before scanning, and a rule inside an at-rule block keeps that block as a
// `condition` instead of counting as a top-level rule.
//
// Deliberately small: no cascade, no specificity, no `@import`. It reports the rules a stylesheet
// states, which is enough to tell "applies everywhere" from "only inside this media query".

export function stripCssComments(text) {
  // A comment becomes spaces of the same length, so offsets on the stripped text match the source.
  return String(text).replace(/\/\*[\s\S]*?\*\//g, (comment) => " ".repeat(comment.length));
}

/** Index of the `}` that closes the `{` at `openIndex`, skipping quoted strings. */
function closingBrace(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      for (i += 1; i < text.length && text[i] !== ch; i += 1) if (text[i] === "\\") i += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function walk(text, conditions, offset, out) {
  let preludeStart = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      for (i += 1; i < text.length && text[i] !== ch; i += 1) if (text[i] === "\\") i += 1;
      continue;
    }
    if (ch === "}" || ch === ";") {
      // A `;` ends a statement at-rule (`@charset "utf-8";`, `@layer a, b;`) or a stray declaration.
      // Without this reset the statement's text becomes the prelude of the next rule and that rule is
      // read as an at-rule block (review 2026-11-05: `@charset` swallowed the rule after it).
      preludeStart = i + 1;
      continue;
    }
    if (ch !== "{") continue;
    const prelude = text.slice(preludeStart, i).trim();
    const close = closingBrace(text, i);
    if (close < 0) return out;
    const body = text.slice(i + 1, close);
    if (prelude.startsWith("@")) {
      walk(body, [...conditions, prelude], offset + i + 1, out);
    } else if (prelude) {
      // `start` is the first character of the selector, not the whitespace before it.
      const lead = text.slice(preludeStart, i).search(/\S/);
      const from = preludeStart + (lead < 0 ? 0 : lead);
      out.push({ selector: prelude, body, conditions, start: offset + from, end: offset + close + 1 });
    }
    i = close;
    preludeStart = close + 1;
  }
  return out;
}

/**
 * Every style rule in `css`, in source order.
 *
 * `conditions` is the chain of enclosing at-rule preludes and `start`/`end` are the offsets of the
 * rule's own text, so a caller can mutate exactly that rule.
 *
 * `gates` is the subset of `conditions` that can switch the rule off without changing the stylesheet
 * (`@media`, `@supports`, `@container`, `@scope`, `@document`). `@layer` is deliberately not a gate:
 * a layered rule still applies, and treating it as one would reject a legitimate refactor.
 */
const GATE_AT_RULE = /^@(media|supports|container|scope|document)\b/;

export function styleRules(css) {
  return walk(stripCssComments(css), [], 0, []).map((rule) => ({ ...rule, gates: rule.conditions.filter((condition) => GATE_AT_RULE.test(condition)) }));
}
