import { collectTokenDefs, isBaseContext, parseCss, specificity } from "./extract-theme-subset.mjs";

// Browser-side measurement for the Phase 1-C community theme gate.
//
// The DOM-side collector lives here (mirroring `render-parity-geometry-probe.mjs`)
// so the gate file stays a bounded harness: this module installs nothing and
// asserts nothing, it only reads what the real app computed for one installed
// theme -- per kind, per surface -- together with the theme declarations that
// could have produced it, the live token values and their owning sheet, and
// whether any dropped (out-of-subset) selector still matches the note surface.

/** `var()` substitution over an already-chosen winner per token. */
export function resolveTokenValue(value, winners, seen = new Set(), depth = 0) {
  if (depth > 12) return null;
  let out = "";
  let index = 0;
  while (index < value.length) {
    const at = value.indexOf("var(", index);
    if (at === -1) { out += value.slice(index); break; }
    out += value.slice(index, at);
    let depthCount = 1;
    let end = at + 4;
    for (; end < value.length && depthCount > 0; end += 1) {
      if (value[end] === "(") depthCount += 1;
      if (value[end] === ")") depthCount -= 1;
    }
    const inner = value.slice(at + 4, end - 1);
    const comma = inner.indexOf(",");
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? "" : inner.slice(comma + 1).trim();
    if (seen.has(name)) return null;
    const winner = winners.get(name);
    let replacement = winner ? resolveTokenValue(winner.value, winners, new Set([...seen, name]), depth + 1) : null;
    if (replacement == null && fallback) replacement = resolveTokenValue(fallback, winners, seen, depth + 1);
    if (replacement == null) return null;
    out += replacement;
    index = end;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Theme token truth: winner per token among the definitions that can match the
 * live DOM (cascade: !important -> specificity -> source order), then `var()`
 * chains resolved inside that winner set. `isApplicable` is backed by
 * `Element.matches` in the page, so a theme's optional colour-scheme block that
 * this host never renders cannot win.
 */
export function resolveThemeTokens(table, isApplicable) {
  const winners = new Map();
  for (const [name, defs] of Object.entries(table)) {
    const candidates = defs
      .map(([selector, value, important], index) => ({ selector, value, important: Boolean(important), index, score: specificity(selector).score }))
      .filter((candidate) => isApplicable(candidate.selector));
    if (!candidates.length) continue;
    candidates.sort((a, b) => (b.important - a.important) || (b.score - a.score) || (b.index - a.index));
    winners.set(name, candidates[0]);
  }
  const resolved = {};
  for (const [name, winner] of winners) {
    resolved[name] = {
      selector: winner.selector,
      value: winner.value,
      scope: isBaseContext(winner.selector) ? "root" : "element",
      resolved: resolveTokenValue(winner.value, winners, new Set([name])),
    };
  }
  return resolved;
}


// Shorthands that can set an asserted longhand: `border-top: 2px solid red` also
// declares border-top-color / border-top-width.

export const SHORTHANDS = {
  "background-color": ["background"],
  "border-top-color": ["border-color", "border-top", "border"],
  "border-right-color": ["border-color", "border-right", "border"],
  "border-top-width": ["border-width", "border-top", "border"],
  "border-top-left-radius": ["border-radius"],
  "text-decoration-line": ["text-decoration"],
};

export const kindProps = (kind, surface) => kind.props[surface] || [];

// Token truth of a theme body: its definitions, its token names, the selectors
// that define them, and every token it reads (host-provided ones included).
// `options.includeDark` must be set when the caller samples the dark side, so the
// `.theme-dark`-scoped definitions are part of the table (see collectTokenDefs).
export const tableOf = (body, options) => collectTokenDefs(parseCss(body).rules, options);
export const selectorsOf = (table) => [...new Set(Object.values(table).flat().map(([selector]) => selector))];
export const observedTokens = (table) => [...new Set([...Object.keys(table), ...Object.values(table).flat()
  .flatMap(([, value]) => [...String(value).matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)].map((match) => match[1]))])];

// Serialized by `page.evaluate`, so it must not close over module scope. It
// resolves each kind's element on one surface, the theme's winning declaration
// per asserted property (nearest declaring node, `!important` -> specificity ->
// source order, shorthands expanded), live token values with their owning sheet,
// which theme selectors can match the note container, and whether a dropped
// selector matches the note surface after all.
/**
 * Negative control transform: move declaration values so the paint must follow.
 * Covers the value shapes real themes use (hex, rgb(), px, hsl() hue, rem/em/%,
 * font-weight, text-decoration keywords).
 */
export function mutateSubsetCss(css) {
  let mutations = 0;
  const shift = (value) => (Number(value) + 64 <= 255 ? Number(value) + 64 : Number(value) - 64);  const count = (text) => { mutations += 1; return text; };
  const mutated = String(css).replace(/\r\n/g, "\n")
    .replace(/#([0-9a-fA-F]{6})\b/g, (all, hex) => count(`rgb(${shift(parseInt(hex.slice(0, 2), 16))}, ${shift(parseInt(hex.slice(2, 4), 16))}, ${shift(parseInt(hex.slice(4, 6), 16))})`))
    .replace(/rgba?\((\d+),\s*(\d+),\s*(\d+)(,\s*[\d.]+)?\)/g, (all, r, g, b, alpha = "") => count(`rgba(${shift(r)}, ${shift(g)}, ${shift(b)}${alpha || ""})`))
    // Bare RGB triplets, as several community themes store their palette
    // (`--ctp-text: 76, 79, 105`). Never matches inside a colour function.
    .replace(/(?<![\w(])(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})(?![\d,])/g, (all, r, g, b) => count(`${shift(r)}, ${shift(g)}, ${shift(b)}`))
    .replace(/(\d+(?:\.\d+)?)px/g, (all, n) => count(`${Number(n) + 2}px`))
    .replace(/hsl\(\s*(\d+(?:\.\d+)?)/g, (all, hue) => count(`hsl(${(Number(hue) + 40) % 360}`))
    .replace(/(\d+(?:\.\d+)?)(rem|em|%)/g, (all, n, unit) => count(`${Number(n) + 2}${unit}`))
    .replace(/font-weight:\s*(\d+)/g, (all, n) => count(`font-weight: ${Number(n) + 12}`))
    .replace(/\bline-through\b/g, () => count("underline"));
  return { css: mutated, mutations };
}

export function SURVEY(arg) {
  const { kinds, surface, tokens, selectors, dropped, shorthands } = arg;
  const INHERITED = ["color", "font-size", "font-weight", "font-family", "line-height"];
  const flat = [];
  for (const sheet of [...document.styleSheets]) {
    const id = sheet.ownerNode?.id || "style";
    if (id === "u16-sentinel") continue;
    let rules;
    try { rules = [...sheet.cssRules]; } catch { continue; }
    const walk = (list) => {
      for (const rule of list) {
        if (rule.cssRules && !rule.selectorText) { walk([...rule.cssRules]); continue; }
        if (rule.selectorText && rule.style) flat.push({ selectorText: rule.selectorText, style: rule.style, sheet: id, order: flat.length });
      }
    };
    walk(rules);
  }
  const score = (selector) => {
    const text = selector.replace(/:where\([^)]*\)/g, " ");
    const ids = (text.match(/#[\w-]+/g) || []).length;
    const classes = (text.match(/\.[\w-]+/g) || []).length + (text.match(/\[[^\]]*\]/g) || []).length + (text.match(/:(?!:)[\w-]+(\([^)]*\))?/g) || []).length;
    const types = (text.replace(/[#.][\w-]+|\[[^\]]*\]|::?[\w-]+(\([^)]*\))?/g, " ").match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
    return ids * 10000 + classes * 100 + types;
  };
  const matches = (node, selector) => { try { return node.matches(selector); } catch { return false; } };
  const declarationsFor = (node, prop) => {
    const hits = [];
    for (const rule of flat) {
      let declared = null;
      for (const candidate of [prop, ...(shorthands[prop] || [])]) {
        const value = rule.style.getPropertyValue(candidate);
        if (value) { declared = { value, important: rule.style.getPropertyPriority(candidate) === "important" }; break; }
      }
      if (!declared) continue;
      for (const entry of rule.selectorText.split(",")) {
        const selector = entry.trim();
        if (!matches(node, selector)) continue;
        hits.push({ selector, value: declared.value, important: declared.important, sheet: rule.sheet, score: score(selector), order: rule.order });
      }
    }
    return hits.sort((a, b) => (b.important - a.important) || (b.score - a.score) || (b.order - a.order));
  };
  // What a declaration would compute to on this element, with `var()` resolved by
  // the browser in the element's own cascade context.
  const normalized = (node, prop, value) => {
    const probe = document.createElement(node.tagName.toLowerCase());
    for (const cls of node.classList) probe.classList.add(cls);
    (node.parentElement || document.body).appendChild(probe);
    probe.style.setProperty(prop, value);
    const computed = getComputedStyle(probe)[prop];
    probe.remove();
    return computed;
  };
  const root = surface === "reader"
    ? (document.querySelector("#preview .markdown-preview-view") || document.querySelector("#preview"))
    : document.querySelector(".cm-content");
  const deepest = (scope, needle) => {
    if (!scope || !needle) return null;
    let best = null;
    const visit = (element) => {
      if (!(element.textContent || "").includes(needle)) return;
      best = element;
      for (const child of element.children) visit(child);
    };
    visit(scope);
    return best;
  };
  const container = root || document.body;
  const chain = [];
  for (let node = container; node; node = node.parentElement) chain.push(node);
  const tokenSource = getComputedStyle(container);
  const bodySource = getComputedStyle(document.body);
  const out = { kinds: {}, tokens: {}, tokenOwners: {}, applicable: {}, droppedMatches: [] };
  for (const name of tokens) out.tokens[name] = (tokenSource.getPropertyValue(name) || bodySource.getPropertyValue(name) || "").trim();
  // Which sheet owns each token on the container chain: a theme token the app
  // declares with higher priority is clobbered, not a theme/host value mix.
  const wanted = new Set(tokens);
  for (let node = container; node && Object.keys(out.tokenOwners).length < wanted.size; node = node.parentElement) {
    const hits = {};
    for (const rule of flat) {
      for (const prop of rule.style) {
        if (!wanted.has(prop) || out.tokenOwners[prop]) continue;
        for (const entry of rule.selectorText.split(",")) {
          const selector = entry.trim();
          if (!matches(node, selector)) continue;
          (hits[prop] = hits[prop] || []).push({ selector, important: rule.style.getPropertyPriority(prop) === "important", sheet: rule.sheet, score: score(selector), order: rule.order });
        }
      }
    }
    for (const [prop, list] of Object.entries(hits)) {
      list.sort((a, b) => (b.important - a.important) || (b.score - a.score) || (b.order - a.order));
      out.tokenOwners[prop] = { sheet: list[0].sheet, selector: list[0].selector };
    }
  }
  for (const selector of selectors) out.applicable[selector] = chain.some((node) => matches(node, selector));
  const kindChains = [];
  for (const kind of kinds) {
    const spec = surface === "reader" ? kind.reader : kind.live;
    const props = kind.props[surface] || [];
    if (!spec || !props.length) { out.kinds[kind.id] = { skipped: true }; continue; }
    let element = spec.selector ? document.querySelector(spec.selector) : null;
    if (!element && spec.needle) element = deepest(root, spec.needle);
    if (element && spec.climb) element = element.closest(spec.climb) || element;
    if (!element) { out.kinds[kind.id] = { found: false }; continue; }
    const elementChain = [];
    for (let node = element; node; node = node.parentElement) elementChain.push(node);
    kindChains.push({ kind: kind.id, props: props.map((prop) => prop.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)), chain: elementChain });
    const style = getComputedStyle(element);
    const entry = { found: true, tag: element.tagName.toLowerCase(), values: {}, declarations: {} };
    for (const prop of props) {
      const cssProp = prop.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
      entry.values[prop] = style[prop];
      for (let distance = 0; distance < elementChain.length; distance += 1) {
        const hits = declarationsFor(elementChain[distance], cssProp);
        if (!hits.length) { if (!INHERITED.includes(cssProp)) break; continue; }
        const themeHits = hits.filter((hit) => hit.sheet === "community-theme");
        if (!themeHits.length) break;
        entry.declarations[prop] = {
          distance,
          selector: themeHits[0].selector,
          value: themeHits[0].value,
          shadowedBy: hits[0].sheet === "community-theme" ? null : hits[0].selector,
          normalized: normalized(element, cssProp, themeHits[0].value),
        };
        break;
      }
    }
    out.kinds[kind.id] = entry;
  }
  // A dropped rule only matters when it can style one of the measured kind
  // elements (or an ancestor for an inherited property) and declares something
  // the gate asserts: that is a real hole in the subset.
  for (const entry of dropped) {
    const declared = new Set([...(entry.props || []), ...(entry.props || []).filter((prop) => prop.startsWith("--"))]);
    for (const { kind, props, chain: elementChain } of kindChains) {
      const relevant = entry.props?.filter((prop) => declared.has(prop) && (prop.startsWith("--") || props.includes(prop)));
      if (!relevant?.length) continue;
      for (const selector of entry.selector.split(",")) {
        const trimmed = selector.trim();
        if (!trimmed || !elementChain.some((node) => matches(node, trimmed))) continue;
        out.droppedMatches.push({ selector: entry.selector, kind, props: relevant, hits: [trimmed] });
        break;
      }
    }
  }
  return out;
}

// CodeMirror renders only the lines around the viewport, so one scroll position
// can miss a fixture line: probe Live at both ends and keep every kind either
// pass rendered (same approach as the Phase 1-A gate).
async function probeLive(page, arg, sleep) {
  const merged = { kinds: {}, tokens: {}, tokenOwners: {}, applicable: {}, droppedMatches: [] };
  for (const atEnd of [true, false]) {
    await page.evaluate((end) => {
      const view = window.__testEditor?._view;
      if (view) view.dispatch({ selection: { anchor: end ? view.state.doc.length : 0 } });
      const scroller = document.querySelector(".cm-scroller");
      if (scroller) scroller.scrollTop = end ? scroller.scrollHeight : 0;
    }, atEnd);
    await sleep(150);
    const pass = await page.evaluate(SURVEY, { ...arg, surface: "live" });
    for (const [id, entry] of Object.entries(pass.kinds)) if (!merged.kinds[id]?.found) merged.kinds[id] = entry;
    Object.assign(merged.tokens, pass.tokens);
    Object.assign(merged.tokenOwners, pass.tokenOwners);
    Object.assign(merged.applicable, pass.applicable);
    if (pass.droppedMatches.length) merged.droppedMatches = pass.droppedMatches;
  }
  return merged;
}

/**
 * Measures both surfaces of one installed theme, then re-measures with every
 * theme token overridden by a sentinel: a property that moves under the sentinel
 * must be fed by a theme token (that is how token-mediated paint is attributed).
 * `includeDark` selects the token table the caller's colour side needs.
 */
export async function surveyTheme(page, { kinds, body, dropped, sleep, setMode, includeDark = false }) {
  const table = tableOf(body, { includeDark });
  const arg = { kinds, tokens: observedTokens(table), selectors: selectorsOf(table), dropped, shorthands: SHORTHANDS };
  // Each surface needs its own host: the Reader markup only exists in preview mode,
  // and a hidden editor has no layout, so CodeMirror renders a fixed window of lines
  // and the document tail (footnote definitions, embeds) never reaches the DOM.
  if (setMode) await setMode("preview");
  const survey = { reader: await page.evaluate(SURVEY, { ...arg, surface: "reader" }) };
  if (setMode) await setMode("live");
  survey.live = await probeLive(page, arg, sleep);
  if (arg.tokens.length) {
    await page.evaluate((names) => {
      const style = document.createElement("style");
      style.id = "u16-sentinel";
      style.textContent = `* { ${names.map((name) => `${name}: rgb(1, 3, 5) !important;`).join(" ")} }`;
      document.head.appendChild(style);
    }, arg.tokens);
    await sleep(120);
    survey.sentinel = { reader: await page.evaluate(SURVEY, { ...arg, surface: "reader" }) };
    survey.sentinel.live = await probeLive(page, arg, sleep);
    await page.evaluate(() => document.querySelector("#u16-sentinel")?.remove());
    await sleep(60);
  }
  return survey;
}

/** One surface pass with no community theme installed (the Web fallback). */
export async function surveyFallback(page, { kinds, tokens, sleep, setMode }) {
  const arg = { kinds, tokens, selectors: [], dropped: [], shorthands: SHORTHANDS };
  if (setMode) await setMode("preview");
  const survey = { reader: await page.evaluate(SURVEY, { ...arg, surface: "reader" }) };
  if (setMode) await setMode("live");
  survey.live = await probeLive(page, arg, sleep);
  return survey;
}
