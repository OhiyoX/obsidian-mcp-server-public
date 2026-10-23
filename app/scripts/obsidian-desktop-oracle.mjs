// Desktop-Obsidian ground-truth primitives (reverse-engineering oracle).
//
// The Web app's fallback layer (`src/app/assets/app.css` `@layer
// web-theme-fallback`) is hand-maintained: somebody copied Obsidian's default
// token values into it once, and nothing has compared them against the desktop
// app since. This module derives the *effective* default of any token from the
// `app.css` that ships inside Obsidian's `obsidian.asar`, so the gate in
// `test/obsidian-desktop-base-tokens.test.js` can compare the two and fail on
// drift instead of trusting a copy.
//
// Cascade rules that matter (verified against Obsidian 1.13.7):
//   - Obsidian declares most tokens on `body` (~800 declarations), the rest on
//     `:root`, and the colour-mode overrides in `.theme-light` / `.theme-dark`
//     which sit on the same `body` element.
//   - Custom properties INHERIT, so for any element inside the document the
//     nearest declaring ancestor wins: `body` beats `:root` regardless of
//     specificity. Within one element, specificity then source order decide,
//     which is why `.theme-dark` (0,1,0) beats `body` (0,0,1).
//   - `@supports (font-variation-settings: normal)` is true in the Electron
//     Chromium the app ships, so its declarations are part of the effective
//     value; `@media print` / `forced-colors` are not.
//
// Everything here is DOM-free and process-free so tests, the extractor CLI and
// the browser harness can share one truth.

export const ORACLE_VERSION = "1.0.0";

export const TOKEN_PROP = /^--[a-zA-Z0-9_-]+$/;

/** Split on a top-level separator, ignoring separators inside ()/[]/quotes. */
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
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
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

const COMMENT = /\/\*[\s\S]*?\*\//g;
const CONDITIONAL_AT = /^@(media|supports|layer|container|scope|document)\b/i;

/**
 * Flatten a stylesheet into `{ selector, decls, context, line }` rules.
 *
 * `context` is the enclosing conditional at-rule prelude, joined with ` && `.
 * Opaque blocks (`@font-face`, `@keyframes`, `@property`) contribute nothing.
 * Nesting inside a style rule is not modelled — correct for the flat generated
 * sheet Obsidian ships, and asserted by the fixture's rule count.
 */
export function parseStylesheetRules(css) {
  const blanked = css.replace(COMMENT, (match) => match.replace(/[^\n]/g, " "));
  const rules = [];
  const stack = [];
  let buffer = "";
  let line = 1;
  let preludeLine = 1;

  for (let i = 0; i < blanked.length; i += 1) {
    const char = blanked[i];
    if (char === "\n") { line += 1; continue; }
    if (char === "{") {
      const prelude = buffer.trim();
      buffer = "";
      const isAt = prelude.startsWith("@");
      const conditional = isAt && CONDITIONAL_AT.test(prelude);
      stack.push({ prelude, conditional, opaque: isAt && !conditional, line: preludeLine });
      preludeLine = line;
      continue;
    }
    if (char === "}") {
      const block = stack.pop();
      const body = buffer;
      buffer = "";
      preludeLine = line;
      if (!block || block.opaque) continue;
      if (stack.some((entry) => entry.opaque)) continue;
      if (block.prelude.startsWith("@")) continue;
      const context = stack.filter((entry) => entry.conditional).map((entry) => entry.prelude).join(" && ");
      for (const selector of splitTopLevel(block.prelude, ",")) {
        const trimmed = selector.trim();
        if (trimmed) rules.push({ selector: trimmed, decls: parseDeclarations(body), context, line: block.line });
      }
      continue;
    }
    buffer += char;
  }
  return rules;
}

// Selectors Obsidian declares defaults on. Compound forms matter: the active
// mode class lives on `body`.
const ROOT_SELECTOR = /^(?::root|html)$/;
const BODY_SELECTOR = /^body$/;
const LIGHT_SELECTOR = /^(?:\.theme-light|body\.theme-light|html\.theme-light)$/;
const DARK_SELECTOR = /^(?:\.theme-dark|body\.theme-dark|html\.theme-dark)$/;

// Conditions that can never apply to the interactive note surface. `@supports
// (font-variation-settings: normal)` stays: the desktop Chromium satisfies it.
const INAPPLICABLE_CONTEXT = /print|speech|forced-colors|prefers-color-scheme\s*:\s*dark/i;

function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|:root|:(?!:)/g) ?? []).length;
  const types = (selector.match(/(^|[\s>+~])(?!\.|#|:)[a-zA-Z][\w-]*/g) ?? []).length;
  return ids * 10000 + classes * 100 + types;
}

/**
 * Effective default value per token per colour mode, on the note surface.
 *
 * `layerRank` encodes the inheritance rule: declarations on `html`/`:root` are
 * only reachable when nothing on `body` declares the token, so they lose to
 * every `body`-level declaration regardless of specificity.
 */
export function extractDefaultTokens(rules) {
  const table = new Map();
  for (const rule of rules) {
    if (INAPPLICABLE_CONTEXT.test(rule.context)) continue;
    const isRoot = ROOT_SELECTOR.test(rule.selector);
    const isBody = BODY_SELECTOR.test(rule.selector);
    const isLight = LIGHT_SELECTOR.test(rule.selector);
    const isDark = DARK_SELECTOR.test(rule.selector);
    if (!isRoot && !isBody && !isLight && !isDark) continue;
    const modes = [];
    if (isRoot || isBody) modes.push("light", "dark");
    if (isLight) modes.push("light");
    if (isDark) modes.push("dark");
    for (const decl of rule.decls) {
      if (!TOKEN_PROP.test(decl.prop)) continue;
      const entry = table.get(decl.prop) ?? { light: null, dark: null };
      const candidate = {
        value: decl.value,
        selector: rule.selector,
        line: rule.line,
        context: rule.context,
        layerRank: isRoot ? 0 : 1,
        specificity: specificity(rule.selector),
        order: rule.line,
      };
      for (const mode of modes) {
        const current = entry[mode];
        if (!current) { entry[mode] = candidate; continue; }
        const wins = candidate.layerRank > current.layerRank
          || (candidate.layerRank === current.layerRank && candidate.specificity > current.specificity)
          || (candidate.layerRank === current.layerRank
            && candidate.specificity === current.specificity
            && candidate.order >= current.order);
        if (wins) entry[mode] = candidate;
      }
      table.set(decl.prop, entry);
    }
  }
  const tokens = {};
  for (const [token, entry] of [...table.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    tokens[token] = entry;
  }
  return tokens;
}

/** Body of the first `@layer <name> { ... }` block, or null. */
export function extractLayerBody(css, layerName) {
  const marker = new RegExp(`@layer\\s+${layerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`);
  const match = marker.exec(css);
  if (!match) return null;
  const blanked = css.replace(COMMENT, (text) => text.replace(/[^\n]/g, " "));
  let depth = 1;
  const start = match.index + match[0].length;
  for (let i = start; i < blanked.length; i += 1) {
    if (blanked[i] === "{") depth += 1;
    else if (blanked[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, i);
    }
  }
  return null;
}

/**
 * Token declarations of a cascade layer, per colour mode.
 *
 * The Web fallback block is `:root, .theme-light { ... }` followed by
 * `.theme-dark { ... }`, both inside the layer. It is read as-is (no cascade
 * resolution): the layer IS the claim being checked, and re-deriving it would
 * hide a mis-scoped selector behind a resolved value.
 */
export function extractLayerTokenClaims(css, layerName) {
  const body = extractLayerBody(css, layerName);
  if (body === null) return null;
  const claims = new Map();
  for (const rule of parseStylesheetRules(body)) {
    // A selector without a mode class (`:root`, `body`) applies to BOTH modes —
    // that is exactly how the fallback block opens (`:root, .theme-light`), and
    // reading it as light-only would skip every dark-mode comparison.
    const hasDark = /\.theme-dark\b/.test(rule.selector);
    const hasLight = /\.theme-light\b/.test(rule.selector);
    const modes = hasDark || hasLight
      ? [hasLight && "light", hasDark && "dark"].filter(Boolean)
      : ["light", "dark"];
    for (const decl of rule.decls) {
      if (!TOKEN_PROP.test(decl.prop)) continue;
      const entry = claims.get(decl.prop) ?? { light: null, dark: null, selector: rule.selector, line: rule.line };
      for (const mode of modes) entry[mode] = decl.value;
      claims.set(decl.prop, entry);
    }
  }
  return claims;
}

const NAMED_COLORS = new Map([
  ["white", "#ffffff"],
  ["black", "#000000"],
]);

/**
 * Compare-ready form of a token value.
 *
 * Deliberately conservative: case, whitespace, trailing semicolons, 3-digit hex
 * and the two named colours that Obsidian actually uses. Functional-notation
 * equivalences (`rgb()` vs `color-mix()`) are NOT guessed — a gate that assumes
 * two different notations are equivalent can hide a real paint difference, so
 * those stay "drift" and get an explicit allowlist entry instead.
 */
export function normalizeTokenValue(value) {
  let out = String(value ?? "").trim().replace(/\s+/g, " ").replace(/;$/, "").trim().toLowerCase();
  out = out.replace(/#([0-9a-f]{3})(?![0-9a-f])/g, (_, digits) => `#${[...digits].map((char) => char + char).join("")}`);
  return NAMED_COLORS.get(out) ?? out;
}

export const DRIFT = "drift";
export const MATCH = "match";
export const DESKTOP_UNDECLARED = "desktop-undeclared";

/**
 * Rows comparing a layer's claims against the desktop defaults.
 * `claims` comes from `extractLayerTokenClaims`; `defaults` from
 * `extractDefaultTokens` (or the committed fixture's flattened form).
 */
export function compareTokenClaims(claims, defaults, options = {}) {
  const { tokens = null } = options;
  const rows = [];
  for (const [token, claim] of [...claims.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (tokens && !tokens.includes(token)) continue;
    for (const mode of ["light", "dark"]) {
      const web = claim[mode];
      if (web === null || web === undefined) continue;
      const desktopEntry = defaults[token]?.[mode] ?? null;
      const desktop = typeof desktopEntry === "string" ? desktopEntry : desktopEntry?.value ?? null;
      const status = desktop === null ? DESKTOP_UNDECLARED
        : normalizeTokenValue(web) === normalizeTokenValue(desktop) ? MATCH
          : DRIFT;
      rows.push({
        token,
        mode,
        web,
        desktop,
        desktopSelector: typeof desktopEntry === "object" && desktopEntry ? desktopEntry.selector ?? null : null,
        desktopLine: typeof desktopEntry === "object" && desktopEntry ? desktopEntry.line ?? null : null,
        status,
      });
    }
  }
  return rows;
}

/** Flatten an extraction (or fixture) into `{ token: { light, dark } }` values. */
export function flattenDefaults(tokens) {
  const flat = {};
  for (const [token, entry] of Object.entries(tokens)) {
    flat[token] = {
      light: typeof entry?.light === "string" ? entry.light : entry?.light?.value ?? null,
      dark: typeof entry?.dark === "string" ? entry.dark : entry?.dark?.value ?? null,
    };
  }
  return flat;
}

export function summarizeRows(rows) {
  return rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, { [MATCH]: 0, [DRIFT]: 0, [DESKTOP_UNDECLARED]: 0 });
}

export const ALLOWLIST_CLASSES = [
  "notation", // same intent, different CSS notation/colour space
  "value-drift", // stale copy of a value desktop has since changed
  "structural", // needs a Web feature (e.g. accent configuration), not a value edit
  "web-invention", // no desktop counterpart at all
  "web-only", // not an Obsidian token; kept for Web/theme-compat reasons
];

/**
 * The base-token gate.
 *
 * Fails closed on three things, all of which are silent today:
 *   1. a divergence between the Web fallback layer and desktop Obsidian that is
 *      not in the allowlist;
 *   2. a fixture that no longer covers every token the fallback layer claims
 *      (i.e. a token was added to the Web layer without regenerating the
 *      baseline);
 *   3. a stale allowlist entry — one whose token now matches, whose modes
 *      changed, or whose recorded values are out of date. Without this a
 *      deviation can be fixed and the entry left behind, which is how an
 *      allowlist turns into a lie.
 */
export function evaluateBaseTokenGate({ claims, fixture, allowlist }) {
  const problems = [];
  const defaults = flattenDefaults(fixture.tokens ?? {});
  const rows = compareTokenClaims(claims, defaults);
  const summary = summarizeRows(rows);

  const missingTokens = [...claims.keys()].filter((token) => !(token in defaults)).sort();
  if (missingTokens.length) {
    problems.push(
      `fixture is missing ${missingTokens.length} token(s) the Web fallback claims: ${missingTokens.join(", ")} — regenerate with scripts/extract-obsidian-base-tokens.mjs`,
    );
  }

  const entries = new Map((allowlist.entries ?? []).map((entry) => [entry.token, entry]));
  for (const [token, entry] of entries) {
    if (!Array.isArray(entry.modes) || entry.modes.length === 0) {
      problems.push(`allowlist entry ${token} has no modes`);
    }
    if (!ALLOWLIST_CLASSES.includes(entry.class)) {
      problems.push(`allowlist entry ${token} has unknown class ${JSON.stringify(entry.class)}`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) {
      problems.push(`allowlist entry ${token} needs a substantive reason`);
    }
  }

  const divergent = rows.filter((row) => row.status !== MATCH);
  for (const row of divergent) {
    const entry = entries.get(row.token);
    if (!entry) {
      problems.push(
        `unallowlisted ${row.status}: ${row.token} [${row.mode}] web=${row.web} desktop=${row.desktop ?? "-"} — align it, or add an allowlist entry with a reason`,
      );
      continue;
    }
    if (!entry.modes.includes(row.mode)) {
      problems.push(`allowlist entry ${row.token} does not cover mode ${row.mode}`);
    }
  }

  const divergentKeys = new Set(divergent.map((row) => `${row.token}\u0000${row.mode}`));
  for (const [token, entry] of entries) {
    for (const mode of entry.modes) {
      if (!divergentKeys.has(`${token}\u0000${mode}`)) {
        const current = rows.find((row) => row.token === token && row.mode === mode);
        problems.push(
          current
            ? `stale allowlist entry ${token} [${mode}]: it now matches the desktop default (${current.desktop}) — delete the entry`
            : `stale allowlist entry ${token} [${mode}]: the Web fallback no longer declares this token`,
        );
      }
    }
  }

  return { ok: problems.length === 0, problems, rows, summary };
}
