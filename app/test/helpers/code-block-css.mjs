/* ===================================================================== *
 * #586 — stylesheet-wide scan of the code-block scroll geometry.
 *
 * The two nails in `reader-copy-code-button.test.js` read ONE rule each. Independent
 * review (GO `32bab495`) showed exactly what that misses:
 *
 *   | injection                                        | old nails      |
 *   |--------------------------------------------------|----------------|
 *   | change a declaration inside an existing rule      | red  (caught)  |
 *   | APPEND a second rule (`.preview pre code { width: max-content }`) | green |
 *   | append `pre { padding: 26px 15px }` (block height) | green          |
 *
 * while real Chromium put the button back on the scroll content (-502px after
 * a horizontal scroll, `HANDOFF.md` §cross-validation) and changed the block's
 * height. A nail that reads "the rule we wrote" cannot see a second rule, so
 * this scanner parses the whole stylesheet, walk EVERY rule (however it is
 * spelled and at whatever nesting depth), and assert the invariants on each rule
 * whose subject element is a `<pre>` or a `<pre > code>`.
 *
 * Scope of the scan (`codeBlockRules`):
 *   * selector lists are split on top-level commas, combinators are walked, and
 *     a rule counts when its SUBJECT compound is `pre` (or `code` with a `pre`
 *     ancestor part), either directly or through an `:is()`/`:where()` argument
 *     (`.preview :is(pre) { … }` is the same rule for this purpose). `:not(pre)`
 *     is deliberately NOT a match — `:not(pre) > code` is inline code;
 *   * `@media`, `@supports`, `@layer`, `@container`, `@scope`, `@document` bodies
 *     are descended into, so a media-query or layered override is seen too;
 *   * pseudo-element rules (`pre::before`) are scanned for the scroll-range
 *     declarations only: their element box is not the `<pre>`/`<code>` box whose
 *     geometry was measured, and the stylesheet's own `content: none !important`
 *     rule (below the code-block rules) is legitimate.
 *
 * Deliberately NOT covered (see `HANDOFF.md` §unverified): `white-space`,
 * `word-break`, `font-family`, and a pseudo-element box that a later rule could
 * give real content. Each of those can change the rendered size, but none of
 * them moves the button off its anchor, and pinning them would forbid legitimate
 * typography work.
 *
 * The `@layer` case is deliberately strict: a layered override of `width` is a
 * cascade no-op while the matching unlayered rule stays where it is, but the
 * layer boundary is one `@layer` reorder away from taking effect, so the nail
 * reports it and a human decides. Every other assertion here is semantic: a
 * refactor that merges two rules, reorders selectors, re-spells a value through
 * the same token, or reformats whitespace stays green (proved by the
 * "not vacuous" test below, which runs the same scanner over refactored
 * canonical pairs).
 * ===================================================================== */


export const PRE_TARGET = "pre";
export const PRE_CODE_TARGET = "pre > code";

export function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Text between the brackets at `openIndex`, plus the index just past the close. */
function readDelimited(text, openIndex, open, close) {
  let depth = 0;
  let quote = null;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote && text[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return { text: text.slice(openIndex + 1, index), end: index + 1 };
    }
  }
  throw new Error(`unbalanced \`${open}\` at offset ${openIndex}`);
}

/** Split on `separator` at nesting depth 0, so `:where(.a, .b)` stays one part. */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let buffer = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      buffer += char;
      if (char === quote && text[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      buffer += char;
      continue;
    }
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(buffer);
      buffer = "";
      continue;
    }
    buffer += char;
  }
  parts.push(buffer);
  return parts;
}

/** At-rules whose body holds style rules rather than declarations. */
const RULE_CONTAINER = /^@(media|supports|layer|container|scope|document)\b/i;

/** Every style rule in `text`, carrying the at-rule preludes it sits inside. */
function collectStyleRules(text, context = [], rules = []) {
  let index = 0;
  let prelude = "";
  while (index < text.length) {
    const char = text[index];
    if (char === "{") {
      const body = readDelimited(text, index, "{", "}");
      const head = prelude.trim();
      prelude = "";
      index = body.end;
      if (!head) continue;
      if (head.startsWith("@")) {
        // `@font-face` / `@keyframes` / `@property` bodies carry declarations, not rules.
        if (RULE_CONTAINER.test(head)) collectStyleRules(body.text, [...context, head], rules);
        continue;
      }
      rules.push({ selectorText: head, declarations: body.text, context });
      continue;
    }
    if (char === ";" || char === "}") {
      prelude = "";
      index += 1;
      continue;
    }
    prelude += char;
    index += 1;
  }
  return rules;
}

function parseDeclarations(block) {
  const declarations = [];
  for (const chunk of splitTopLevel(block, ";")) {
    const colon = chunk.indexOf(":");
    if (colon === -1) continue;
    const property = chunk.slice(0, colon).trim().toLowerCase();
    if (!property || property.startsWith("--")) continue;
    const raw = chunk.slice(colon + 1).trim();
    declarations.push({
      property,
      value: raw.replace(/!\s*important\s*$/i, "").trim(),
      important: /!\s*important\s*$/i.test(raw),
    });
  }
  return declarations;
}

/** Split a complex selector into compound selectors; combinators disappear. */
function compoundsOf(selector) {
  const compounds = [];
  let depth = 0;
  let quote = null;
  let buffer = "";
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (quote) {
      buffer += char;
      if (char === quote && selector[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      buffer += char;
      continue;
    }
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    if (depth === 0 && (char === ">" || char === "+" || char === "~" || /\s/.test(char))) {
      if (buffer) compounds.push(buffer);
      buffer = "";
      continue;
    }
    buffer += char;
  }
  if (buffer) compounds.push(buffer);
  return compounds;
}

/** A compound selector with its pseudo-classes/elements and attributes removed. */
function stripPseudo(compound) {
  let out = "";
  let index = 0;
  while (index < compound.length) {
    if (compound[index] !== ":") {
      out += compound[index];
      index += 1;
      continue;
    }
    index += 1;
    if (compound[index] === ":") index += 1;
    while (index < compound.length && /[a-zA-Z0-9-]/.test(compound[index])) index += 1;
    if (compound[index] === "(") index = readDelimited(compound, index, "(", ")").end;
  }
  return out;
}

function elementNameOf(compound) {
  const bare = stripPseudo(compound).replace(/\[[^\]]*\]/g, "").replace(/\.[-\w]+/g, "").replace(/#[-\w]+/g, "").trim();
  const first = bare.split(/\s+/)[0] ?? "";
  return /^[a-zA-Z][a-zA-Z0-9-]*$/.test(first) ? first.toLowerCase() : null;
}

const LEGACY_PSEUDO_ELEMENT = /:(?:before|after|first-line|first-letter)\b/;

function pseudoElementsOf(compound) {
  return [...(compound.match(/::[-\w]+/g) ?? []), ...(compound.match(LEGACY_PSEUDO_ELEMENT) ?? [])];
}

/** Arguments of the named functional pseudo-classes (`:is(...)`, `:where(...)`). */
function pseudoArgumentsOf(compound, names) {
  const args = [];
  for (let index = 0; index < compound.length; index += 1) {
    if (compound[index] !== ":") continue;
    let cursor = index + 1;
    if (compound[cursor] === ":") continue;
    let name = "";
    while (cursor < compound.length && /[a-zA-Z0-9-]/.test(compound[cursor])) {
      name += compound[cursor];
      cursor += 1;
    }
    if (compound[cursor] !== "(" || !names.includes(name.toLowerCase())) continue;
    const body = readDelimited(compound, cursor, "(", ")");
    args.push(body.text);
    index = body.end - 1;
  }
  return args;
}

/**
 * The element types a compound selector can match. `:is()`/`:where()` match
 * positively, so `.preview :is(pre) { … }` is a `<pre>` rule; `:not(pre)` must
 * NOT make `:not(pre) > code` look like a code-block rule — it is inline code.
 */
function elementNamesOf(compound) {
  const names = new Set();
  const direct = elementNameOf(compound);
  if (direct) names.add(direct);
  for (const argument of pseudoArgumentsOf(compound, ["is", "where"])) {
    for (const alternative of splitTopLevel(argument, ",")) {
      const parts = compoundsOf(alternative.trim());
      if (!parts.length) continue;
      for (const name of elementNamesOf(parts[parts.length - 1])) names.add(name);
    }
  }
  return names;
}

/** `pre`, `pre > code`, their `::pseudo` forms, or null for anything else. */
function targetOf(selector) {
  const parts = compoundsOf(selector.trim());
  if (!parts.length) return null;
  const subject = parts[parts.length - 1];
  const pseudo = pseudoElementsOf(subject).length > 0;
  const names = elementNamesOf(subject);
  if (names.has("pre")) return pseudo ? "pre::pseudo" : PRE_TARGET;
  const underPre = parts.slice(0, -1).some((compound) => elementNamesOf(compound).has("pre"));
  if (names.has("code") && underPre) return pseudo ? "pre > code::pseudo" : PRE_CODE_TARGET;
  return null;
}

/** Every rule of `text` (with its context and declarations) that targets one of the boxes. */
export function codeBlockRules(text) {
  const found = [];
  for (const rule of collectStyleRules(text, [], [])) {
    for (const raw of splitTopLevel(rule.selectorText, ",")) {
      const selector = raw.replace(/\s+/g, " ").trim();
      const target = targetOf(selector);
      if (!target) continue;
      found.push({
        target,
        selector,
        context: rule.context[rule.context.length - 1] ?? null,
        declarations: parseDeclarations(rule.declarations),
      });
    }
  }
  return found;
}

const NEUTRAL_VALUE = new Set(["auto", "none", "initial", "unset", "inherit", "revert", "revert-layer"]);

/**
 * Declarations that break one of the two measured invariants. The `why` text is
 * the necessary-invariant argument, kept next to the check so a future edit sees
 * it before relaxing the rule.
 */
const SCROLL_RANGE_DECLARATIONS = [
  {
    properties: ["width", "max-width", "min-width", "inline-size", "max-inline-size", "min-inline-size"],
    neutral: NEUTRAL_VALUE,
    why:
      "an inline-size constraint makes the box stop filling its parent (shrink-to-fit), so the `<pre>` gets " +
      "the block's horizontal scroll range back and carries the absolutely positioned button with the content",
  },
  {
    properties: ["float"],
    neutral: NEUTRAL_VALUE,
    why: "a floated box shrink-to-fits and leaves normal flow, so the `<pre>` has no in-flow child to size against",
  },
  {
    properties: ["position"],
    neutral: new Set(["static", "relative", "sticky", ...NEUTRAL_VALUE]),
    why: "`absolute`/`fixed` takes the box out of flow; the `<pre>` keeps a scroll range over the parent's content instead",
  },
  {
    properties: ["display"],
    forbidden: /(^|\s)(inline|none|contents|table|ruby)/,
    why:
      "only a block-level, in-flow box fills the parent's content box — an inline-level, `none`, `contents` or " +
      "table-ish box either shrink-to-fits (restoring the `<pre>`'s scroll range) or stops laying the code out in the block",
  },
  {
    properties: ["scrollbar-gutter"],
    all: true,
    why:
      "a reserved gutter band is a second scrollbar band: the block's height is content + padding + exactly one " +
      "scrollbar (probe: identical 86.375px on all five trees)",
  },
  {
    properties: ["height", "min-height", "max-height"],
    neutral: NEUTRAL_VALUE,
    why: "a block-axis size replaces the content height the geometry was measured with, and a shorter box can scroll again",
  },
];

/** Pseudo-element rules: their element box is not the box whose geometry was measured. */
const PSEUDO_ELEMENT_DECLARATIONS = [
  SCROLL_RANGE_DECLARATIONS[0],
  SCROLL_RANGE_DECLARATIONS[1],
  SCROLL_RANGE_DECLARATIONS[2],
  {
    properties: ["display"],
    forbidden: /(^|\s)inline/,
    why: "an inline-level pseudo box joins the block's line box; `content: none !important` is the stylesheet's own legitimate use of this property",
  },
];

const PHYSICAL_AXIS = { top: "block-start", right: "inline-end", bottom: "block-end", left: "inline-start" };

function fourAxisSpelling(value) {
  const tokens = value.split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 4) return null;
  const [blockStart, inlineEnd = blockStart, blockEnd = blockStart, inlineStart = inlineEnd] = tokens;
  return { "block-start": blockStart, "inline-end": inlineEnd, "block-end": blockEnd, "inline-start": inlineStart };
}

function paddingAxes(property, value) {
  if (property === "padding") return fourAxisSpelling(value);
  if (property === "padding-block" || property === "padding-inline") {
    const tokens = value.split(/\s+/).filter(Boolean);
    if (!tokens.length || tokens.length > 2) return null;
    const [first, second = first] = tokens;
    return property === "padding-block"
      ? { "block-start": first, "block-end": second }
      : { "inline-start": first, "inline-end": second };
  }
  const physical = /^padding-(top|right|bottom|left)$/.exec(property);
  if (physical) return { [PHYSICAL_AXIS[physical[1]]]: value.split(/\s+/)[0] };
  const logical = /^padding-(block-start|block-end|inline-start|inline-end)$/.exec(property);
  if (logical) return { [logical[1]]: value.split(/\s+/)[0] };
  return null;
}

const BORDER_WIDTH_TOKEN = /^(thin|medium|thick|0|[0-9]*\.?[0-9]+(px|em|rem|%|pt|ch|ex)?|var\(|calc\(|min\(|max\(|clamp\()/;

/** The width component of a `border`/`border-*-width` declaration, or null. */
function borderWidthOfShorthand(value) {
  const token = (value.split(/\s+/)[0] ?? "").toLowerCase();
  if (!token) return null;
  if (/^(none|hidden)$/.test(token)) return "0";
  if (BORDER_WIDTH_TOKEN.test(token)) return token;
  // `border: solid var(--line)` — the width component is the initial `medium`.
  return /^(solid|dashed|dotted|double|groove|ridge|inset|outset)$/.test(token) || token.startsWith("var(") ? "medium" : "medium";
}

function borderWidthAxes(property, value) {
  if (property === "border" || property === "border-block" || property === "border-inline") {
    const width = borderWidthOfShorthand(value);
    if (width === null) return null;
    return { "block-start": width, "inline-end": width, "block-end": width, "inline-start": width };
  }
  if (property === "border-width") return fourAxisSpelling(value);
  if (property === "border-block-width" || property === "border-inline-width") {
    const tokens = value.split(/\s+/).filter(Boolean);
    if (!tokens.length || tokens.length > 2) return null;
    const [first, second = first] = tokens;
    return property === "border-block-width"
      ? { "block-start": first, "block-end": second }
      : { "inline-start": first, "inline-end": second };
  }
  const physical = /^border-(top|right|bottom|left)(-width)?$/.exec(property);
  if (physical) {
    const width = physical[2] ? value.split(/\s+/)[0] : borderWidthOfShorthand(value);
    return width === null ? null : { [PHYSICAL_AXIS[physical[1]]]: width };
  }
  const logical = /^border-(block-start|block-end|inline-start|inline-end)(-width)?$/.exec(property);
  if (logical) {
    const width = logical[2] ? value.split(/\s+/)[0] : borderWidthOfShorthand(value);
    return width === null ? null : { [logical[1]]: width };
  }
  return null;
}

/**
 * The block-axis box profile a `pre`/`pre > code` rule declares: padding and
 * border-width resolved onto the four logical axes, plus the single-valued
 * properties that decide the height of a line box. Two rules may both speak
 * about the profile — a merge, a split, a re-spelling through the same token all
 * stay green — but they must agree, because the block's measured height is one
 * number (86.375px for the wide shape, 71.375px for the narrow one).
 */
const PROFILE_SINGLE_PROPERTIES = new Set(["line-height", "font-size", "font", "box-sizing"]);

function profileOf(declarations) {
  const profile = new Map();
  for (const { property, value } of declarations) {
    const lowered = value.replace(/\s+/g, " ").trim().toLowerCase();
    const axes = paddingAxes(property, lowered);
    if (axes) {
      for (const [axis, axisValue] of Object.entries(axes)) profile.set(`padding:${axis}`, { value: axisValue, property });
      continue;
    }
    const border = borderWidthAxes(property, lowered);
    if (border) {
      for (const [axis, axisValue] of Object.entries(border)) profile.set(`border-width:${axis}`, { value: axisValue, property });
      continue;
    }
    if (PROFILE_SINGLE_PROPERTIES.has(property)) profile.set(property, { value: lowered, property });
  }
  return profile;
}

/** Padding/border a `pre > code` rule may declare: exactly zero, nothing else. */
function zeroOnlyAxesVerdict(kind) {
  return (value) => (value === "0" || value === "0px" || (kind === "border-width" && value === "none"));
}

export function codeBlockGeometryViolations(text) {
  const violations = [];
  const rules = codeBlockRules(text);
  const profiles = new Map([[PRE_TARGET, new Map()], [PRE_CODE_TARGET, new Map()]]);
  const record = (target, axis, value, where) => {
    const profile = profiles.get(target);
    if (!profile.has(axis)) profile.set(axis, new Map());
    const seen = profile.get(axis);
    if (!seen.has(value)) seen.set(value, where);
  };

  for (const rule of rules) {
    const where = `${rule.selector}${rule.context ? ` (inside \`${rule.context}\`)` : ""}`;
    const isPseudo = rule.target.endsWith("::pseudo");
    const elementTarget = isPseudo ? rule.target.replace("::pseudo", "") : rule.target;
    const table = isPseudo ? PSEUDO_ELEMENT_DECLARATIONS : SCROLL_RANGE_DECLARATIONS;

    for (const { property, value } of rule.declarations) {
      const lowered = value.replace(/\s+/g, " ").trim().toLowerCase();
      for (const entry of table) {
        if (!entry.properties.includes(property)) continue;
        const bad = entry.all
          ? true
          : entry.forbidden
            ? entry.forbidden.test(lowered)
            : !entry.neutral.has(lowered);
        if (bad) violations.push(`${where} declares \`${property}: ${value}\` — ${entry.why}`);
      }
      if (isPseudo) continue;

      const profile = profileOf([{ property, value }]);
      for (const [axis, declared] of profile) record(elementTarget, axis, declared.value, where);

      if (elementTarget !== PRE_CODE_TARGET) continue;
      const axes = paddingAxes(property, lowered);
      if (axes) {
        for (const [axis, axisValue] of Object.entries(axes)) {
          if (!zeroOnlyAxesVerdict("padding")(axisValue)) {
            violations.push(
              `${where} declares \`${property}: ${value}\` — padding:${axis} — the \`<code>\` box is the scroll box that fills the \`<pre>\`, ` +
                "and its zero padding is what the block's height is measured with (content + padding + exactly one scrollbar)",
            );
          }
        }
      }
      const border = borderWidthAxes(property, lowered);
      if (border) {
        for (const [axis, axisValue] of Object.entries(border)) {
          if (!zeroOnlyAxesVerdict("border-width")(axisValue)) {
            violations.push(
              `${where} declares \`${property}: ${value}\` — border-width:${axis} — a border on the scroll box adds a band to the ` +
                "block's height that the measurement does not account for",
            );
          }
        }
      }
    }
  }

  for (const [target, profile] of profiles) {
    for (const [axis, values] of profile) {
      if (values.size < 2) continue;
      const spellings = [...values.entries()].map(([value, where]) => `\`${value}\` (${where})`).join(" vs ");
      violations.push(
        `the \`${target}\` box profile for \`${axis}\` is declared two different ways: ${spellings} — a second rule that re-states a ` +
          "box metric with another value changes the block's height (or its scroll box) without touching the rule the old nails read",
      );
    }
  }
  return violations;
}

