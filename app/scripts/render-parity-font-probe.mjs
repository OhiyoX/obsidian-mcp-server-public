// Browser-side measurement for the Phase 1-F font-token gate (issue #361).
//
// The gate's question is narrow and computed-style only: does the real Chromium
// compute the font FAMILY of the two document hosts from the theme's font token
// chain, or did the host merely inherit an already-resolved font from an
// ancestor (`body { font: ... var(--font-interface) }`)?
//
// This module installs nothing and asserts nothing. It reports, per host:
//   * the computed `font-family` / `font-size`,
//   * the winning `font-family` declaration ON the element itself (sheet,
//     selector, raw value, `!important`, specificity) — `null` when the host
//     has no declaration of its own and only inherits,
//   * the nearest ancestor that does declare it (distance + source),
//   * the live value of every font token the caller asked about.
//
// Keeping the declaration next to the computed value is what makes the two
// failure modes distinguishable: a host that stopped consuming the token shows
// the wrong computed family, and a host that stopped declaring it at all shows
// `own: null` with an inherited source instead.
//
// Both functions are serialized into the page by `page.evaluate`, so they must
// not close over module scope.

/** Runs in the page. Returns one record per host selector. */
export function FONT_SURVEY({ hosts, tokens }) {
  const sheetLabel = (sheet) => {
    const node = sheet && sheet.ownerNode;
    if (!node) return "inline";
    if (node.id) return node.id;
    const href = node.getAttribute && node.getAttribute("href");
    return href || node.tagName?.toLowerCase() || "style";
  };
  const flat = [];
  // Shorthands that can set an asserted longhand. Mirrors the community probe's
  // table for the one property this gate asserts.
  const SHORTHANDS = { "font-family": ["font"] };
  for (const sheet of [...document.styleSheets]) {
    let rules;
    try {
      rules = [...sheet.cssRules];
    } catch {
      continue; // cross-origin sheet: cannot be inspected, and none is expected here
    }
    const walk = (list) => {
      for (const rule of list) {
        if (rule.cssRules && !rule.selectorText) {
          walk([...rule.cssRules]);
          continue;
        }
        if (rule.selectorText && rule.style) {
          flat.push({ selectorText: rule.selectorText, style: rule.style, sheet: sheetLabel(sheet), order: flat.length });
        }
      }
    };
    walk(rules);
  }
  // Paren- and quote-aware top-level split: a selector list carries commas inside
  // `:is(a, b)` / `:where(a, b)` / `[attr="a,b"]`, and splitting on every comma
  // produces fragments (`:where(.preview`) that still parse and match, which
  // silently mis-attributes the winning declaration and its specificity.
  const splitTopLevel = (text) => {
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
      if (char === "(" || char === "[") depth += 1;
      if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
      if (char === "," && depth === 0) { parts.push(current); current = ""; continue; }
      current += char;
    }
    parts.push(current);
    return parts.map((part) => part.trim()).filter(Boolean);
  };
  const score = (selector) => {
    const text = selector.replace(/:where\([^)]*\)/g, " ");
    const ids = (text.match(/#[\w-]+/g) || []).length;
    const classes = (text.match(/\.[\w-]+/g) || []).length + (text.match(/\[[^\]]*\]/g) || []).length + (text.match(/:(?!:)[\w-]+(\([^)]*\))?/g) || []).length;
    const types = (text.replace(/[#.][\w-]+|\[[^\]]*\]|::?[\w-]+(\([^)]*\))?/g, " ").match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
    return ids * 10000 + classes * 100 + types;
  };
  /** Specificity of a selector list is the maximum over its top-level parts. */
  const listScore = (selectorText) => Math.max(...splitTopLevel(selectorText).map(score));
  const matches = (node, selector) => {
    try {
      return node.matches(selector);
    } catch {
      return false;
    }
  };
  /**
   * Every rule that sets `font-family` and whose selector list matches `node`.
   * The whole list is matched at once (never a hand-split fragment) and the
   * reported selector is the list as the browser serialized it.
   */
  const declarationsFor = (node, prop) => {
    const hits = [];
    for (const rule of flat) {
      // `font-family` can be set by the `font` shorthand. A shorthand whose value
      // contains `var()` is a pending-substitution value: the CSSOM keeps it on
      // the `font` property and reports an EMPTY `font-family` longhand, so
      // looking at the longhand alone would report "no declaration" for the very
      // host rule this gate exists to prove (.preview sets font via `font:`).
      let declared = null;
      for (const candidate of [prop, ...SHORTHANDS[prop]]) {
        const value = rule.style.getPropertyValue(candidate);
        if (value) { declared = { property: candidate, value, important: rule.style.getPropertyPriority(candidate) === "important" }; break; }
      }
      if (!declared) continue;
      if (!matches(node, rule.selectorText)) continue;
      hits.push({
        ...declared,
        selector: rule.selectorText,
        selectorCount: splitTopLevel(rule.selectorText).length,
        sheet: rule.sheet,
        score: listScore(rule.selectorText),
        order: rule.order,
      });
    }
    return hits.sort((a, b) => (b.important - a.important) || (b.score - a.score) || (b.order - a.order));
  };
  const out = {};
  for (const host of hosts) {
    const element = document.querySelector(host.selector);
    if (!element) {
      out[host.id] = { found: false, selector: host.selector };
      continue;
    }
    const style = getComputedStyle(element);
    const values = {};
    for (const name of tokens) values[name] = style.getPropertyValue(name).trim();
    let inherited = null;
    let distance = 1;
    for (let node = element.parentElement; node; node = node.parentElement, distance += 1) {
      const hit = declarationsFor(node, "font-family")[0];
      if (hit) {
        inherited = {
          distance,
          tag: node.tagName.toLowerCase(),
          classes: [...node.classList].sort(),
          selector: hit.selector,
          sheet: hit.sheet,
          value: hit.value,
          important: hit.important,
        };
        break;
      }
    }
    out[host.id] = {
      found: true,
      selector: host.selector,
      tag: element.tagName.toLowerCase(),
      classes: [...element.classList].sort(),
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      own: declarationsFor(element, "font-family")[0] ?? null,
      inherited,
      values,
    };
  }
  return out;
}

/**
 * Runs in the page. The browser's serialization of one `font-family` candidate,
 * measured on a throwaway element appended to `document.body`.
 *
 * The gate derives every expectation through this function rather than reading
 * the host's computed style, so the expected value comes from the theme's
 * declaration and only the *serialization* comes from the browser. A font list
 * is context-free, so the throwaway element reproduces exactly what a host that
 * consumed the same declaration would compute.
 */
export function FONT_NORMALIZE(value) {
  const probe = document.createElement("span");
  probe.setAttribute("data-font-family-probe", "");
  probe.style.fontFamily = String(value);
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).fontFamily;
  probe.remove();
  return computed;
}
