#!/usr/bin/env node
// Community-theme subset extractor for the render-parity Phase 1-C gate.
//
// A real community theme (Things / Minimal / AnuPpuccin) is 60-350 KB and is NOT
// vendored here. This dev tool derives a small, reviewable subset: the rules whose
// selectors can reach the 24 canonical Markdown kinds the gate asserts, plus the
// transitive chain of custom-property ("token") definitions they reference. The
// committed fixture carries a provenance manifest (source path + sha256 +
// extraction time + tool version) in its header, so the subset and the real theme
// stay connected and the fixture cannot drift silently.
//
// Usage: node scripts/extract-theme-subset.mjs <theme.css> --out <fixture.css>
//        [--name <Theme>] [--license MIT] [--license-source "..."] [--excluded "a|b"]
//
// Everything here is DOM-free and process-free so the gate and the offline tests
// can share it. Nothing in this module touches the source theme. The extracted
// rules are the source theme's CSS: the subset header carries the source theme's
// own license notice, so a subset is distributed under the source theme's license,
// not this repository's MIT.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { TOKEN_PROP, collectTokenDefs, parseDeclarations, splitTopLevel } from "./theme-token-defs.mjs";

export const TOOL_VERSION = "1.0.0";
export const SUBSET_MARKER = "RENDER-PARITY-THEME-SUBSET v1";
export const MANIFEST_BEGIN = "MANIFEST-JSON-BEGIN";
export const MANIFEST_END = "MANIFEST-JSON-END";

// Selector vocabulary: the canonical Obsidian / CodeMirror faces that own the 24
// kinds. A rule whose subject (rightmost compound) mentions any of these can
// reach the note surface; everything else is chrome, a plugin, or print media.
const CANONICAL_SUBSTRINGS = [
  ".cm-", ".HyperMD-", ".markdown-", ".preview", ".token", ".internal-", ".external-", ".callout",
  ".footnote", ".task-", ".embed", ".tag", ".CodeMirror", ".multi-select", ".metadata-",
  ".frontmatter", ".mod-cm6", ".is-live-preview",
];
const CANONICAL_ELEMENTS = [
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "strong", "em", "i", "b", "s", "del", "mark", "code",
  "pre", "blockquote", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "hr", "img", "a",
  "sup", "sub", "kbd", "figure", "figcaption", "caption",
];
const ELEMENT_PATTERN = new RegExp(`(^|[\\s,>+~])(?:${CANONICAL_ELEMENTS.join("|")})(?![\\w-])`);
const BASE_CONTEXT = /^\s*(?::root|html|body|\.theme-light|\.theme-dark)(?![\w-])/;
const NON_SCREEN_CONTEXT = /print|speech/i;

// Declaration keep-set: the properties the gate asserts for the 24 kinds, the
// shorthands that can set them, and every custom property (the token bridge).
export const ASSERTED_PROPS = [
  "color", "background-color", "font-size", "font-weight", "border-top-color",
  "border-right-color", "border-top-left-radius", "border-top-width", "text-decoration-line",
];
const RELEVANT_PROPS = new Set([
  ...ASSERTED_PROPS, "background", "font", "border", "border-color", "border-top", "border-right",
  "border-width", "border-radius", "text-decoration", "border-left-color", "border-bottom-color",
  "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius",
  "border-left-width", "border-right-width", "border-bottom-width",
]);

// Classes the Web host can actually put on the note container chain. A rule whose
// selector requires any other class (a theme's optional colour scheme or plugin
// toggle: `.minimal-atom-light`, `.ctp-latte`, `.rainbow-tags`) can never match in
// this host, so keeping it would only inflate the subset. The gate re-checks every
// dropped selector against the live DOM and fails when a dropped rule does match,
// so this vocabulary cannot rot silently.
const HOST_CLASSES = [
  "theme-light", "theme-dark", "is-live-preview", "is-mobile", "is-phone", "is-tablet",
  "markdown-rendered", "markdown-preview-view", "markdown-preview-sizer", "markdown-preview-section",
  "markdown-preview-pusher", "markdown-reading-view", "markdown-source-view", "markdown-embed",
  "markdown-embed-content", "cm-s-obsidian", "mod-cm6", "show-properties", "hide-properties",
  "is-focus-mode", "mod-root", "workspace-leaf-content", "view-content", "internal-embed",
  "image-embed", "mod-ui",
  // Measured on the live app's kind-element chains (see the slice HANDOFF):
  // classes the Web host really puts on the note surface and its ancestors.
  "is-checked", "is-desktop", "is-readable-line-width", "horizontal-main-container",
  "mode-preview", "shell", "workspace", "workspace-split", "mod-vertical", "table-scroll",
  "document", "editor", "language-js", "comment", "keyword", "number", "string",
];
const CANONICAL_CLASS_PREFIXES = [
  "cm-", "HyperMD-", "markdown-", "callout", "token", "internal-", "external-", "task-", "footnote",
  "embed", "tag", "preview", "multi-select", "metadata-", "frontmatter", "CodeMirror",
];

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const normalize = (text) => String(text).replace(/\r\n/g, "\n");

/** Bounded CSS reader: flat rules with their enclosing at-rule context preserved. */
export function parseCss(source) {
  const text = normalize(source).replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length));
  const comments = [...normalize(source).matchAll(/\/\*[\s\S]*?\*\//g)].map((match) => match[0]);
  const rules = [];
  const statements = [];
  const stack = [];
  let buffer = "";
  let order = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "{") { stack.push({ prelude: buffer.trim() }); buffer = ""; continue; }
    if (char === "}") {
      const frame = stack.pop();
      if (!frame) continue;
      const body = buffer;
      buffer = "";
      if (frame.prelude.startsWith("@") || !frame.prelude) continue;
      const context = stack.filter((entry) => entry.prelude.startsWith("@")).map((entry) => entry.prelude).join(" && ") || null;
      rules.push({ selector: frame.prelude, decls: parseDeclarations(body), context, order: order++ });
      continue;
    }
    if (char === ";" && stack.length === 0) {
      const statement = buffer.trim();
      buffer = "";
      if (statement) statements.push(statement);
      continue;
    }
    buffer += char;
  }
  return { rules, statements, comments, text: normalize(source) };
}

/** Rightmost compound of a selector: the element the rule actually styles. */
export function subjectOf(selector) {
  const text = String(selector);
  let depth = 0;
  let quote = null;
  let cut = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (char === ">" || char === "+" || char === "~" || char === " ")) cut = i + 1;
  }
  return text.slice(cut).trim();
}

export function isBaseContext(selector) {
  // The SUBJECT must be the base context: `body:not(.default-font-color) strong`
  // is a `strong` rule that merely starts with `body`, not a token block.
  return BASE_CONTEXT.test(subjectOf(selector));
}

export function specificity(selector) {
  let text = String(selector).replace(/:where\([^)]*\)/g, " ");
  let match;
  while ((match = /:is\(([^)]*)\)/.exec(text))) {
    const options = splitTopLevel(match[1], ",").map((option) => option.trim()).filter(Boolean);
    let best = "";
    let bestScore = -1;
    for (const option of options) {
      const score = specificity(option).score;
      if (score > bestScore) { bestScore = score; best = option; }
    }
    text = text.replace(match[0], ` ${best} `);
  }
  const ids = (text.match(/#[\w-]+/g) || []).length;
  const classes = (text.match(/\.[\w-]+/g) || []).length
    + (text.match(/\[[^\]]*\]/g) || []).length
    + (text.match(/:(?!:)[\w-]+(\([^)]*\))?/g) || []).length;
  const types = (text.replace(/[#.][\w-]+|\[[^\]]*\]|::?[\w-]+(\([^)]*\))?/g, " ").match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
  return { score: ids * 10000 + classes * 100 + types, ids, classes, types };
}

/** True when the selector needs a class this host never renders. */
export function isReachableSelector(selector) {
  // `:not(...)` is excluded: a theme keying on `body:not(.default-font-color)` is
  // reachable precisely because the host does NOT set that class.
  const text = String(selector).replace(/:not\([^)]*\)/g, "");
  return [...text.matchAll(/\.([A-Za-z0-9_-]+)/g)].every((match) => HOST_CLASSES.includes(match[1]) || CANONICAL_CLASS_PREFIXES.some((prefix) => match[1].includes(prefix)));
}

export function isCanonicalSelector(selector) {
  const value = String(selector);
  if (!isReachableSelector(value)) return false;
  if (isBaseContext(value)) return true;
  const subject = subjectOf(value);
  if (subject === "*") return true;
  if (CANONICAL_SUBSTRINGS.some((token) => subject.includes(token))) return true;
  return ELEMENT_PATTERN.test(subject);
}

/** True when every selector of the rule is `.theme-dark`-scoped (light gate cannot use it). */
export function isDarkOnlyRule(rule) {
  if (/\B\.theme-dark\b/.test(rule.context || "")) return true;
  const selectors = splitTopLevel(rule.selector, ",").map((entry) => entry.trim()).filter(Boolean);
  return !selectors.length || selectors.every((selector) => /\B\.theme-dark\b/.test(selector));
}

function keepDecl(decl, reason, referenced) {
  if (TOKEN_PROP.test(decl.prop)) return reason !== "token-closure" || referenced.has(decl.prop);
  if (reason === "base-tokens") return false;
  return RELEVANT_PROPS.has(decl.prop);
}

/**
 * Selects in-scope rules and closes over the token definitions they use. A kept
 * rule may read a token the theme defines in an out-of-scope rule; without that
 * definition the subset would resolve the token to nothing and the paint would
 * silently fall back. Only declarations that survive `keepDecl` contribute
 * references, so the closure cannot snowball through unused tokens.
 */
export function selectRules(parsed) {
  const kept = new Map();
  const reasons = new Map();
  const dropped = [];
  const add = (rule, reason) => {
    if (kept.has(rule.order)) return;
    kept.set(rule.order, rule);
    reasons.set(rule.order, reason);
  };
  for (const rule of parsed.rules) {
    if (NON_SCREEN_CONTEXT.test(rule.context || "") || isDarkOnlyRule(rule)) { dropped.push(rule); continue; }
    const selectors = splitTopLevel(rule.selector, ",").map((entry) => entry.trim()).filter(Boolean);
    if (!selectors.some(isCanonicalSelector)) { dropped.push(rule); continue; }
    add(rule, selectors.every(isBaseContext) ? "base-tokens" : "canonical");
  }
  let referenced = new Set();
  for (let pass = 0; pass < 16; pass += 1) {
    const rules = [...kept.values()].sort((a, b) => a.order - b.order);
    const nextReferenced = new Set();
    for (const rule of rules) {
      const reason = reasons.get(rule.order);
      for (const decl of rule.decls) {
        if (!keepDecl(decl, reason, referenced)) continue;
        for (const match of decl.value.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) nextReferenced.add(match[1]);
      }
    }
    let changed = false;
    for (const rule of parsed.rules) {
      if (kept.has(rule.order) || NON_SCREEN_CONTEXT.test(rule.context || "") || isDarkOnlyRule(rule)) continue;
      const selectors = splitTopLevel(rule.selector, ",").map((entry) => entry.trim()).filter(Boolean);
      if (!selectors.some(isReachableSelector)) continue;
      if (!rule.decls.some((decl) => TOKEN_PROP.test(decl.prop) && nextReferenced.has(decl.prop))) continue;
      add(rule, "token-closure");
      changed = true;
    }
    const same = referenced.size === nextReferenced.size && [...nextReferenced].every((name) => referenced.has(name));
    referenced = nextReferenced;
    if (!changed && same) break;
  }
  return {
    kept: [...kept.values()].sort((a, b) => a.order - b.order).map((rule) => ({ rule, reason: reasons.get(rule.order) })),
    dropped,
    referenced,
  };
}

function serializeRule({ rule, reason }, referenced) {
  const selectors = splitTopLevel(rule.selector, ",").map((entry) => entry.trim())
    // Light mode only: a selector that requires `.theme-dark` can never match.
    .filter((entry) => entry && !/\.theme-dark\b/.test(entry.replace(/:not\([^)]*\)/g, "")))
    .filter((entry) => isCanonicalSelector(entry) || (reason === "token-closure" && isReachableSelector(entry)));
  const decls = rule.decls.filter((decl) => keepDecl(decl, reason, referenced));
  if (!selectors.length || !decls.length) return null;
  const body = `${selectors.join(",\n")} {\n${decls.map((decl) => `  ${decl.prop}: ${decl.value}${decl.important ? " !important" : ""};`).join("\n")}\n}`;
  if (!rule.context) return body;
  return `${rule.context} {\n${body.split("\n").map((line) => `  ${line}`).join("\n")}\n}`;
}

// The gate re-checks these against the live DOM: a dropped rule that still
// matches the note surface would be a silent hole in the subset, so the extractor
// records the most suspicious ones (relevant properties or tokens, fewest exotic
// classes first) inside the pinned manifest.
export function droppedSample(dropped, limit = 60) {
  const relevant = (rule) => rule.decls.filter((decl) => TOKEN_PROP.test(decl.prop) || RELEVANT_PROPS.has(decl.prop));
  const score = (rule) => (subjectOf(rule.selector).match(/\.[A-Za-z0-9_-]+/g) || []).length;
  // A rule whose every subject is a pseudo-element (`::-webkit-scrollbar-thumb`)
  // cannot move an asserted element property, so it cannot be a hole in the
  // subset: the gate measures elements, never pseudo-elements.
  const pseudoOnly = (rule) => splitTopLevel(rule.selector, ",").map((entry) => subjectOf(entry.trim())).every((subject) => subject.includes("::"));
  const entries = dropped
    // Rules dropped because the gate is screen-only can never match it.
    .filter((rule) => !NON_SCREEN_CONTEXT.test(rule.context || ""))
    .filter((rule) => !pseudoOnly(rule))
    .filter((rule) => relevant(rule).length)
    .sort((a, b) => score(a) - score(b) || a.order - b.order)
    .map((rule) => ({
      selector: rule.selector.length > 240 ? `${rule.selector.slice(0, 240)}…` : rule.selector,
      props: relevant(rule).map((decl) => decl.prop),
    }));
  return entries.slice(0, limit);
}

/**
 * Selector-level drops: a kept rule may still lose individual selectors to the
 * reachability filter (`li.task-list-item.is-checked` when the host class was
 * not in the vocabulary). Those are recorded too, so the gate re-checks them
 * against the live kind elements instead of trusting the vocabulary.
 */
export function droppedSelectorSample(kept, limit = 40) {
  const entries = [];
  for (const { rule, reason } of kept) {
    const props = rule.decls.filter((decl) => TOKEN_PROP.test(decl.prop) || RELEVANT_PROPS.has(decl.prop)).map((decl) => decl.prop);
    if (!props.length) continue;
    for (const entry of splitTopLevel(rule.selector, ",").map((value) => value.trim())) {
      if (!entry || subjectOf(entry).includes("::")) continue;
      if (isCanonicalSelector(entry) || (reason === "token-closure" && isReachableSelector(entry))) continue;
      entries.push({ selector: entry.length > 240 ? `${entry.slice(0, 240)}…` : entry, props });
    }
  }
  return entries.slice(0, limit);
}

/**
 * Token table: every custom property the selected rules define, as compact
 * `[selector, value, important]` definitions in source order. Dark-scoped
 * definitions are dropped (the gate runs light mode) and the winner is resolved
 * at gate time against the live DOM -- statically picking a winner here would
 * wrongly prefer a theme's optional colour-scheme block that this host never
 * renders.
 */
/**
 * Token definitions from a rule list, keyed by property and ordered by source.
 *
 * `includeDark` defaults to FALSE on purpose: the subset extractor derives a
 * LIGHT-mode-only fixture, so a `.theme-dark`-scoped declaration can never match
 * there and keeping it would only inflate the committed subset. A caller that
 * samples the dark side (issue #360) must pass `{ includeDark: true }`, otherwise
 * the table would be missing the very declarations the dark cascade uses and the
 * gate would compare the computed value against the light fallback of the theme.
 */
export { TOKEN_PROP, collectTokenDefs, splitTopLevel } from "./theme-token-defs.mjs";

export function buildManifest({ parsed, kept, dropped, source, extractedAt, subsetCss, droppedSelectors = [] }) {
  // Counts and pinned sentinels come from the committed body itself, so the
  // manifest can never disagree with the CSS the gate installs.
  const tokens = collectTokenDefs(parseCss(subsetCss).rules);
  const names = Object.keys(tokens);
  return {
    tool: "app/scripts/extract-theme-subset.mjs",
    toolVersion: TOOL_VERSION,
    extractedAt,
    source: {
      path: source.path,
      sha256: source.sha256,
      bytes: source.bytes,
      name: source.name,
      version: source.version ?? null,
      author: source.author ?? null,
      license: source.license ?? "unknown",
      licenseSource: source.licenseSource ?? "unverified",
      licenseNotice: (source.licenseNotice || "").trim(),
    },
    subset: {
      sha256: sha256(subsetCss),
      bytes: Buffer.byteLength(subsetCss, "utf8"),
      rules: kept.length,
      sourceRules: parsed.rules.length,
      droppedRules: dropped.length,
      tokens: names.length,
      rootTokens: names.filter((name) => tokens[name].some(([selector]) => isBaseContext(selector))).length,
      tokenDefinitions: names.reduce((total, name) => total + tokens[name].length, 0),
      byReason: kept.reduce((acc, entry) => ({ ...acc, [entry.reason]: (acc[entry.reason] || 0) + 1 }), {}),
    },
    // A few pinned token declarations so the offline test can prove the committed
    // body still carries this theme's own values. The full token truth is
    // re-derived from the body by the gate, never from the app.
    sentinel: Object.fromEntries(names.slice(0, 6).map((name) => [name, tokens[name][0][1]])),
    droppedSample: [...droppedSample(dropped), ...droppedSelectorSample(kept).concat(droppedSelectors).slice(0, 40)],
    // Out-of-scope markers: strings that are all over the source theme but must
    // never reach a subset. The offline test asserts their absence.
    excludedMarkers: source.excludedMarkers || [],
  };
}

export function formatSubset(manifest, body = "") {
  const { source, subset } = manifest;
  const human = [
    ` * Community theme subset for render-parity Phase 1-C: ${source.name}`,
    ` * Source: ${source.path}`,
    ` * Source sha256: ${source.sha256} (${source.bytes} bytes, ${subset.sourceRules} rules)`,
    ` * Source theme: ${source.name} ${source.version ?? "?"} by ${source.author ?? "?"} -- license ${source.license}`,
    ` * Extracted ${manifest.extractedAt} by ${manifest.tool} v${manifest.toolVersion}`,
    ...(source.licenseNotice ? source.licenseNotice.split("\n").map((line) => ` * ${line}`) : []),
    " *",
    ` * Kept ${subset.rules} of ${subset.sourceRules} rules: the canonical selector surface for the 24 Markdown`,
    " * kinds the render-parity gate asserts, plus the transitive chain of custom-property",
    ` * definitions they reference (${subset.tokens} tokens, ${subset.tokenDefinitions} definitions). Light mode only:`,
    " * `.theme-dark`-scoped rules and selectors needing a class this host never renders are",
    " * excluded, so this is NOT the complete theme. Re-extract with:",
    " *   node scripts/extract-theme-subset.mjs <theme.css> --out <this file>",
    " * The manifest pins provenance + the body hash: the gate fails when this body, the",
    " * manifest and the app's computed paint disagree.",
  ];
  const json = JSON.stringify(manifest, null, 1).split("\n").map((line) => ` * ${line}`).join("\n");
  return `/* ${SUBSET_MARKER}\n${human.join("\n")}\n * ${MANIFEST_BEGIN}\n${json}\n * ${MANIFEST_END}\n */\n\n${body}`;
}

/** Splits a committed subset fixture into its pinned manifest and CSS body. */
export function parseSubset(text) {
  const normalized = normalize(text);
  const start = normalized.indexOf(SUBSET_MARKER);
  const begin = normalized.indexOf(MANIFEST_BEGIN, start);
  const end = normalized.indexOf(MANIFEST_END, begin);
  if (start === -1 || begin === -1 || end === -1) throw new Error(`not a ${SUBSET_MARKER} fixture`);
  const json = normalized.slice(begin + MANIFEST_BEGIN.length, end)
    .split("\n").map((line) => line.replace(/^\s*\*?\s?/, "")).join("\n").trim();
  const body = normalized.slice(normalized.indexOf("*/", end) + 2).replace(/^\n+/, "");
  return { manifest: JSON.parse(json), body, bodySha256: sha256(body) };
}

export function extractSubset(source, options = {}) {
  const parsed = parseCss(source);
  const { kept, dropped, referenced } = selectRules(parsed);
  const body = `${kept.map((entry) => serializeRule(entry, referenced)).filter(Boolean).join("\n\n")}\n`;
  const manifest = buildManifest({
    parsed, kept, dropped, subsetCss: body, extractedAt: options.extractedAt,
    source: { path: options.path, sha256: sha256(normalize(source)), bytes: Buffer.byteLength(normalize(source), "utf8"), ...options.meta },
  });
  return { manifest, body, css: formatSubset(manifest, body), kept, dropped };
}

function flag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? true;
}

async function main() {
  const args = process.argv.slice(2);
  const out = flag(args, "--out");
  const sourcePath = args.find((arg) => !arg.startsWith("--") && arg !== out && arg !== flag(args, "--name"));
  if (!sourcePath) {
    console.error("usage: node scripts/extract-theme-subset.mjs <theme.css> --out <fixture.css> [--name X] [--license MIT]");
    process.exitCode = 2;
    return;
  }
  const source = await fs.readFile(sourcePath, "utf8");
  const meta = { name: flag(args, "--name") || path.basename(path.dirname(sourcePath)) };
  try {
    const themeManifest = JSON.parse(await fs.readFile(sourcePath.replace(/theme\.css$/, "manifest.json"), "utf8"));
    meta.version = themeManifest.version ?? null;
    meta.author = themeManifest.author ?? null;
  } catch { /* theme without a manifest.json */ }
  const notice = normalize(source).match(/(MIT License|GNU GENERAL PUBLIC LICENSE|AGPLv3 License|GPL-3\.0)/i);
  meta.license = flag(args, "--license") || (notice ? notice[1] : "unknown");
  meta.licenseSource = flag(args, "--license-source") || (notice ? "source theme.css notice" : "unverified");
  meta.excludedMarkers = String(flag(args, "--excluded") || "").split("|").filter(Boolean);
  meta.licenseNotice = (parseCss(source).comments[0] || "").replace(/\/\*|\*\//g, "").trim();
  const result = extractSubset(source, { path: sourcePath.replaceAll("\\", "/"), meta, extractedAt: new Date().toISOString() });
  const { subset, source: from } = result.manifest;
  if (out && out !== true) await fs.writeFile(out, result.css);
  console.log(JSON.stringify({
    theme: from.name, sourceBytes: from.bytes, sourceRules: subset.sourceRules, keptRules: subset.rules,
    keptBytes: subset.bytes, tokens: subset.tokens, rootTokens: subset.rootTokens,
    tokenDefinitions: subset.tokenDefinitions, droppedRules: subset.droppedRules,
    droppedSample: result.manifest.droppedSample.length, byReason: subset.byReason,
    sourceSha256: from.sha256, subsetSha256: subset.sha256, out: out && out !== true ? out.replaceAll("\\", "/") : null,
  }, null, 1));
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
