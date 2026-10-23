import createDOMPurify from "dompurify";
import { inlineTitleFromSourcePath } from "../document/inline-title.js";
import { matchInlineTagAt } from "../document/inline-tag-lexicon.js";
import { formatDateValue, isoDateParts } from "../document/property-value.js";
import { iconHtml } from "../../ui/icons.js";
import { layoutRenderedTables } from "../document/table-layout.js";
import { attachCopyCodeButtons } from "./copy-code-button.js";
import { attachMermaidBlocks } from "./mermaid-lazy.js";
import { configureTaskSemantics } from "./task-semantics.js";
import { installReaderAssetDropGuard } from "./asset-drop-guard.js";
import { configureCallouts } from "./callout-render.js";
import { configureFootnotes } from "./footnote-rules.js";
import { configureHighlightColours } from "../document/highlight-colours.js";
import { highlightFencedCode } from "./code-highlight.js";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import mark from "markdown-it-mark";
import taskLists from "markdown-it-task-lists";
import texmath from "markdown-it-texmath";
import katex from "katex";
import yaml from "js-yaml";
import "katex/dist/katex.min.css";

const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
const AUDIO_EXTENSIONS = new Set(["flac", "m4a", "mp3", "oga", "ogg", "wav", "webm"]);
const VIDEO_EXTENSIONS = new Set(["m4v", "mov", "mp4", "ogv", "webm"]);

function escape(value) {
  return md.utils.escapeHtml(String(value ?? ""));
}

function displayTarget(target) {
  // Desktop (asar app.js `dd` via `fd`): no alias ⇒ the `#` segments joined by " > ".
  return target.split("#").filter(Boolean).join(" > ").trim();
}

function splitTarget(value) {
  // Markdown tables must escape the wikilink alias separator as \| to keep it
  // inside one GFM cell. Obsidian still treats that escaped pipe as the
  // target/label separator, so normalize it before splitting.
  const normalized = String(value).replace(/\\\|/gu, "|");
  const [targetPart, ...labelParts] = normalized.split("|");
  const target = targetPart.trim();
  return { target, label: labelParts.join("|").trim() || displayTarget(target) };
}

function extension(target) {
  return target.split("#", 1)[0].split(".").pop()?.toLowerCase() || "";
}

function canonicalPath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
}

function assetUrl(target, sourcePath = "", options = {}) {
  const query = new URLSearchParams({ path: target.split("#", 1)[0] });
  if (sourcePath) query.set("from", sourcePath);
  if (options.vaultId) query.set("vaultId", String(options.vaultId));
  const revisions = options.assetRevisions || {};
  const clean = canonicalPath(target.split("#", 1)[0]);
  const parts = clean.startsWith("/") ? [] : canonicalPath(sourcePath).split("/").slice(0, -1);
  for (const part of clean.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  const resolved = parts.join("/");
  const revision = revisions[`${options.vaultId || ""}::${resolved}`]
    || revisions[resolved]
    || options.revision;
  if (revision) query.set("rev", String(revision));
  return `/api/web/v1/asset?${query}`;
}

function embedDimensions(label) {
  const match = String(label || "").match(/^(\d{1,5})(?:x(\d{1,5}))?$/i);
  return match ? { width: match[1], height: match[2] || null } : null;
}

function resolvePurify() {
  try {
    if (typeof createDOMPurify !== "function") return null;
    // Browser/esbuild: default export is already a bound instance.
    if (typeof createDOMPurify.sanitize === "function") return createDOMPurify;
    // Node/factory form: bind to the current window when a usable DOM exists.
    if (typeof window !== "undefined" && window.document) {
      return createDOMPurify(window);
    }
  } catch {
    return null;
  }
  return null;
}

const purify = resolvePurify();

function obsidianLinks(parser) {
  parser.inline.ruler.before("link", "obsidian_link", (state, silent) => {
    const start = state.pos;
    const embedded = state.src.startsWith("![[", start);
    const linked = !embedded && state.src.startsWith("[[", start);
    if (!embedded && !linked) return false;
    const offset = embedded ? 3 : 2;
    const end = state.src.indexOf("]]", start + offset);
    if (end < 0) return false;
    if (!silent) {
      const token = state.push(embedded ? "obsidian_embed" : "obsidian_link", "", 0);
      token.meta = splitTarget(state.src.slice(start + offset, end));
    }
    state.pos = end + 2;
    return true;
  });

  parser.renderer.rules.obsidian_link = (tokens, index) => {
    const { target, label } = tokens[index].meta;
    const href = escape(target);
    return `<a href="${href}" class="internal-link" data-note="${escape(encodeURIComponent(target))}" data-internal-link="true">${escape(label)}</a>`;
  };
  parser.renderer.rules.obsidian_embed = (tokens, index, _options, env) => {
    const { target, label } = tokens[index].meta;
    const ext = extension(target);
    const src = escape(assetUrl(target, env?.sourcePath, env));
    const dimensions = embedDimensions(label);
    const displayLabel = dimensions ? target.split("/").pop() : label;
    const size = dimensions ? ` width="${dimensions.width}"${dimensions.height ? ` height="${dimensions.height}"` : ""}` : "";
    if (IMAGE_EXTENSIONS.has(ext)) return `<img class="internal-embed image-embed" src="${src}" alt="${escape(displayLabel)}" loading="lazy" decoding="async"${size}>`;
    if (AUDIO_EXTENSIONS.has(ext)) return `<audio class="internal-embed" src="${src}" controls preload="metadata"></audio>`;
    if (VIDEO_EXTENSIONS.has(ext)) return `<video class="internal-embed" src="${src}" controls preload="metadata"></video>`;
    if (ext === "pdf") return `<a class="internal-embed file-embed" href="${src}" target="_blank" rel="noopener">${escape(label)}</a>`;
    // Desktop turns a note embed into a real transclusion; the Web keeps the
    // navigable link but shows Desktop's own text face (the wikilink title),
    // never an invented prefix.
    return `<a href="${escape(target)}" class="internal-link internal-embed note-embed" data-note="${escape(encodeURIComponent(target))}" data-internal-link="true">${escape(label)}</a>`;
  };
}

/** `%%…%%` renders as Desktop Reading shows it: visible but faint, delimiters kept (owner 2026-10-10). */
export function obsidianComments(parser) {
  parser.inline.ruler.before("escape", "obsidian_comment", (state, silent) => {
    if (!state.src.startsWith("%%", state.pos)) return false;
    const end = state.src.indexOf("%%", state.pos + 2);
    if (end < 0) return false;
    if (!silent) state.push("obsidian_comment", "", 0).content = state.src.slice(state.pos, end + 2);
    // Intentionally keep state.pending so preceding text is flushed normally.
    state.pos = end + 2;
    return true;
  });
  parser.renderer.rules.obsidian_comment = (tokens, index) => `<span class="obsidian-comment">${escape(tokens[index].content)}</span>`;
}

function configureLinks(parser) {
  const defaultOpen = parser.renderer.rules.link_open || ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
  parser.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const hrefIndex = token.attrIndex("href");
    const href = hrefIndex >= 0 ? token.attrs[hrefIndex][1] : "";
    if (/^(?:https?:|mailto:|obsidian:)/i.test(href)) {
      token.attrSet("class", "external-link");
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noopener noreferrer");
    } else if (href && !href.startsWith("#")) {
      // Keep a real href for accessibility; navigation is handled by the host.
      token.attrSet("class", "internal-link");
      token.attrSet("data-note", encodeURIComponent(decodeURIComponent(href)));
      token.attrSet("data-internal-link", "true");
    }
    return defaultOpen(tokens, index, options, env, self);
  };
}

function configureImages(parser) {
  const defaultImage = parser.renderer.rules.image || ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
  parser.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const src = token.attrGet("src") || "";
    if (src && !/^(?:https?:|data:|blob:|\/\/)/i.test(src)) {
      token.attrSet("src", assetUrl(src, env?.sourcePath, env));
    }
    token.attrJoin("class", "internal-embed image-embed");
    token.attrSet("loading", "lazy");
    token.attrSet("decoding", "async");
    return defaultImage(tokens, index, options, env, self);
  };
}

function configureCodeTypography(parser) {
  parser.renderer.rules.code_inline = (tokens, index) => {
    const content = String(tokens[index].content || "");
    const parts = content.split(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)/gu);
    const rendered = parts.map((part) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(part)
      ? `<span class="code-cjk">${escape(part)}</span>`
      : escape(part)).join("");
    return `<code>${rendered}</code>`;
  };
}

// Issue #484: the tag lexeme lives in one shared module so Reading and Live Preview cannot
// drift apart again (Live used to require whitespace before `#`, so `(#paren)` was a pill here
// and plain text in the editor). markdown-it calls the rule at the start of each block's inline
// content, which is exactly `matchInlineTagAt`'s `index === 0` case.
export function obsidianTags(parser) {
  parser.inline.ruler.before("text", "obsidian_tag", (state, silent) => {
    const match = matchInlineTagAt(state.src, state.pos);
    if (!match) return false;
    if (!silent) {
      const token = state.push("obsidian_tag", "", 0);
      token.content = match.raw;
    }
    state.pos += match.length;
    return true;
  });
  parser.renderer.rules.obsidian_tag = (tokens, index) => {
    const tag = tokens[index].content;
    return `<a href="${escape(tag)}" class="tag" data-tag="${escape(tag.slice(1))}" data-internal-link="true">${escape(tag)}</a>`;
  };
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: false,
  // Fenced code carries the canonical `token <name>` face so a Vault theme
  // paints Reader and Live code blocks from the same `--code-*` tokens.
  highlight: highlightFencedCode,
})
  .use(footnote)
  .use(configureFootnotes)
  .use(mark)
  .use(taskLists, { enabled: false })
  .use(texmath, { engine: katex, delimiters: "dollars", katexOptions: { throwOnError: false, strict: "ignore" } });

obsidianLinks(md);
obsidianComments(md);
obsidianTags(md);
configureLinks(md);
configureImages(md);
configureCodeTypography(md);
configureTaskSemantics(md);
configureHighlightColours(md);
configureCallouts(md);

// Reading HTML has no physical source-line nodes. Preserve only the missing
// vertical geometry so Reader and editable surfaces keep the same blank-line rhythm.
export function preserveSourceBlankLines(parser) {
  parser.core.ruler.after("block", "obsidian_source_blank_lines", (state) => {
    if (!state.env?.preserveSourceBlankLines) return;
    const blocks = [];
    for (let index = 0; index < state.tokens.length; index += 1) {
      const token = state.tokens[index];
      if (token.level !== 0 || !Array.isArray(token.map) || token.nesting < 0) continue;
      blocks.push({ index, from: token.map[0], to: token.map[1] });
    }
    if (blocks.length < 2) return;

    const sourceLines = state.src.split(/\r?\n/);
    const inserts = [];
    for (let index = 1; index < blocks.length; index += 1) {
      const previous = blocks[index - 1];
      const current = blocks[index];
      let count = 0;
      for (let line = previous.to; line < current.from; line += 1) {
        if (/^\s*$/.test(sourceLines[line] || "")) count += 1;
      }
      if (count > 0) inserts.push({ index: current.index, count });
    }

    for (let index = inserts.length - 1; index >= 0; index -= 1) {
      const spacer = new state.Token("source_blank_lines", "div", 0);
      spacer.block = true;
      spacer.meta = { count: inserts[index].count };
      state.tokens.splice(inserts[index].index, 0, spacer);
    }
  });

  parser.renderer.rules.source_blank_lines = (tokens, index) => {
    const count = Math.max(1, Number(tokens[index].meta?.count) || 1);
    return `<div class="markdown-source-blank-lines" data-source-blank-lines="${count}" aria-hidden="true">${'<span class="markdown-source-blank-line"></span>'.repeat(count)}</div>\n`;
  };
}

preserveSourceBlankLines(md);

export function extractFrontmatter(raw) {
  const source = String(raw ?? "");
  const match = source.match(/^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/m);
  if (match?.index !== 0) return { body: source, properties: [], frontmatterEnd: 0 };
  if (!match) return { body: source, properties: [], frontmatterEnd: 0 };
  let properties = [];
  try {
    const parsed = yaml.load(match[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) properties = Object.entries(parsed);
    else if (parsed != null) properties = [["frontmatter", match[1]]];
  } catch {
    properties = [["frontmatter", match[1]]];
  }
  return { body: source.slice(match[0].length), properties, frontmatterEnd: match[0].length };
}

function semanticDefinitionKey(body) {
  const lines = [];
  for (const line of String(body || "").split(/\r?\n/)) {
    if (/^\s{0,3}\[[^\]]+\]:\s+\S/.test(line) || /^\s{0,3}\[\^[^\]]+\]:/.test(line)) {
      lines.push(line.trim());
    }
  }
  return lines.join("\n");
}

function envVersionOf(definitions, sourcePath, vaultId, assetRevisionStamp = "") {
  let hash = 2166136261;
  const value = `${vaultId || ""}\0${sourcePath || ""}\0${definitions}\0${assetRevisionStamp}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function assetRevisionStamp(revisions) {
  if (!revisions || typeof revisions !== "object") return "";
  return Object.keys(revisions).sort().map((key) => `${key}=${revisions[key]}`).join("&");
}

/**
 * Shared document parse environment for fragment / Live Preview widgets (LP-10).
 * Holds reference-link definitions collected from the full document body.
 * Footnote fragments intentionally stay on source fallback until fully supported.
 */
export function prepareObsidianDocumentContext(raw, context = {}) {
  const { body, properties, frontmatterEnd } = extractFrontmatter(raw);
  const env = {
    sourcePath: context.sourcePath || "",
    vaultId: context.vaultId != null ? String(context.vaultId) : "",
    assetRevisions: context.assetRevisions || {},
    references: Object.create(null),
    docId: context.docId || envVersionOf(semanticDefinitionKey(body), context.sourcePath, context.vaultId),
  };
  // Populate reference definitions without emitting HTML.
  if (/(?:^|\n) {0,3}\[/.test(body)) md.parse(body, env);
  // Drop mutated footnote state from the preparatory parse so later renders start clean.
  if (env.footnotes) delete env.footnotes;

  // Parsed references also capture continuation titles and definitions entering
  // or leaving fenced code; a line-only fingerprint misses both cases.
  const definitions = JSON.stringify(env.references);
  return {
    body,
    properties,
    frontmatterEnd,
    env,
    envVersion: envVersionOf(
      definitions,
      env.sourcePath,
      env.vaultId,
      assetRevisionStamp(env.assetRevisions),
    ),
  };
}

export function propertiesHtml(properties) {
  if (!properties.length) return "";
  // Desktop parity: a date value (a Date, or a string that is exactly an ISO date) shows
  // as the calendar glyph plus the locale short form, with the source date in datetime.
  const dateChip = (iso, text) => `<time class="metadata-property-date" datetime="${escape(iso)}" title="${escape(iso)}">${iconHtml("calendar", "svg-icon metadata-property-date-icon")}${escape(text)}</time>`;
  const dateChipFor = (value) => {
    const parsed = isoDateParts(value);
    const text = formatDateValue(value);
    // A value carrying a time keeps the full instant in `datetime` (Publish contract).
    return parsed && text ? dateChip(parsed.datetime ?? parsed.iso, text) : null;
  };
  const valueHtml = (key, value) => {
    if (Array.isArray(value) || /^(?:tags?|aliases|cssclasses)$/i.test(key)) {
      const values = Array.isArray(value) ? value : String(value || "").split(/\s*,\s*/).filter(Boolean);
      const taggable = /^tags?$/i.test(key);
      return values.map((item) => {
        const raw = typeof item === "object" ? JSON.stringify(item) : String(item);
        // Desktop strips one leading `#` before showing/searching a tag (asar app.js: the
        // multiselect option renderer slices it, then searches `tag:<value>`).
        const text = escape(taggable ? raw.replace(/^#/, "") : raw);
        // Only `tags` pills are tag searches: the preview click delegate routes [data-tag]
        // through the same search() the inline #tags use.
        return taggable
          ? `<a class="tag property-pill multi-select-pill" href="#${text}" data-tag="${text}" data-internal-link="true">${text}</a>`
          : `<span class="property-pill multi-select-pill">${text}</span>`;
      }).join(" ");
    }
    if (typeof value === "boolean") return `<span class="property-pill property-boolean">${value ? "true" : "false"}</span>`;
    if (value instanceof Date) {
      // js-yaml makes a date-only scalar UTC midnight, so the authored day is the UTC day
      // (`toLocaleDateString()` on the instant shifted it back a day in UTC-x zones).
      return dateChipFor(value) ?? escape(value.toISOString());
    }
    if (value && typeof value === "object") return `<code>${escape(JSON.stringify(value))}</code>`;
    if (value === null || value === undefined || value === "") return '<span class="metadata-empty">—</span>';
    return dateChipFor(value) ?? escape(String(value));
  };
  const propertyIcon = (key) => /^(?:tags?|aliases)$/i.test(key) ? "tag" : /^(?:created|updated|date|modified)$/i.test(key) ? "calendar" : /^mcp_author$/i.test(key) ? "circle-help" : "text";
  return `<details class="properties metadata-container" open><summary class="metadata-properties-heading">${iconHtml("chevron-right", "svg-icon properties-chevron")}${iconHtml("list-tree", "svg-icon properties-icon")}<span>笔记属性</span></summary><div class="metadata-content"><div class="metadata-properties">${properties.map(([key, value]) => `<div class="property metadata-property"><div class="metadata-property-key">${iconHtml(propertyIcon(key), "svg-icon metadata-property-icon")}<span>${escape(key)}</span></div><div class="metadata-property-value">${valueHtml(key, value)}</div></div>`).join("")}</div></div></details>`;
}

function hasFootnoteMarkup(source) {
  return /\[\^[^\]]+\]/.test(String(source || ""));
}

function sourceFallback(source) {
  return `<pre class="cm-live-source-fallback">${escape(source)}</pre>`;
}

/**
 * Independent render env: deep-copies references; never shares mutable footnotes.
 */
function cloneEnv(base, extras = {}) {
  const env = {
    sourcePath: extras.sourcePath ?? base?.sourcePath ?? "",
    vaultId: extras.vaultId ?? base?.vaultId ?? "",
    assetRevisions: { ...(extras.assetRevisions || base?.assetRevisions || {}) },
    references: { ...(base?.references || {}) },
    docId: base?.docId,
    preserveSourceBlankLines: Boolean(
      extras.preserveSourceBlankLines ?? base?.preserveSourceBlankLines
    ),
  };
  if (base?.docId && extras.blockId) {
    env.docId = `${base.docId}:${extras.blockId}`;
  } else if (extras.docId) {
    env.docId = extras.docId;
  }
  // Intentionally omit footnotes — each render owns a fresh footnote state.
  return env;
}

/**
 * Fail closed when DOMPurify is missing or unsupported.
 * Never return raw HTML (DOMPurify's unsupported path would).
 */
export function sanitizeRenderedHtml(rendered) {
  const html = String(rendered ?? "");
  // Require explicit support. DOMPurify's unsupported sanitize() returns dirty HTML.
  if (!purify || typeof purify.sanitize !== "function" || purify.isSupported !== true) {
    return escape(html);
  }
  return purify.sanitize(html, {
    ADD_TAGS: ["audio", "video", "source", "mark", "aside", "svg", "use"],
    ADD_ATTR: [
      "target",
      "rel",
      "data-note",
      "data-tag",
      "data-callout",
      "data-internal-link",
      "controls",
      "preload",
      "loading",
      "decoding",
      "width",
      "height",
      "checked",
      "disabled",
      "href",
    ],
    ALLOW_DATA_ATTR: true,
  });
}

function sanitize(rendered) {
  return sanitizeRenderedHtml(rendered);
}

export function renderObsidianMarkdown(raw, context = {}) {
  const source = String(raw ?? "");
  const isFragment = Boolean(context.fragment);
  const documentContext = context.documentContext || null;

  // Footnote fragments: editable SOURCE until rich multi-block footnotes are supported.
  if (isFragment && hasFootnoteMarkup(source)) {
    return sanitize(sourceFallback(source));
  }

  if (isFragment) {
    const env = cloneEnv(documentContext?.env, {
      sourcePath: context.sourcePath || documentContext?.env?.sourcePath || "",
      vaultId: context.vaultId != null ? String(context.vaultId) : documentContext?.env?.vaultId || "",
      assetRevisions: context.assetRevisions || documentContext?.env?.assetRevisions || {},
      blockId: context.blockId || "",
    });
    const rendered = md.render(source, env);
    return sanitize(rendered);
  }

  // Full document: single parse/render path. Avoid md.parse then md.render on a shared env
  // (that double-processes footnotes and can duplicate footnote sections).
  // The editor's fragment context may intentionally lag behind plain text edits.
  // Full reading always uses current source and a fresh reference environment.
  const { body, properties } = extractFrontmatter(source);
  const baseEnv = null;

  const title = context.title || inlineTitleFromSourcePath(context.sourcePath);
  const inlineTitle = title ? `<div class="inline-title" data-heading="${escape(title)}">${escape(title)}</div>` : "";
  const env = cloneEnv(baseEnv, {
    sourcePath: context.sourcePath || baseEnv?.sourcePath || "",
    vaultId: context.vaultId != null ? String(context.vaultId) : baseEnv?.vaultId || "",
    assetRevisions: context.assetRevisions || baseEnv?.assetRevisions || {},
    preserveSourceBlankLines: true,
  });
  const rendered = inlineTitle + propertiesHtml(properties) + md.render(body, env);
  return sanitize(rendered);
}
window.renderObsidianMarkdown = renderObsidianMarkdown;
window.prepareObsidianDocumentContext = prepareObsidianDocumentContext;
window.layoutObsidianTables = layoutRenderedTables;
// Reading-surface copy-code button (#482, second slice): the surfaces call this
// right after the table pass, once per render (the Reader re-renders on edits and
// on deferred content, and the pass is idempotent).
// Reading surfaces call `window.attachCopyCodeButtons` once per render (core/app.js,
// publish.js), so the lazy mermaid pass rides that call: a second call site in either surface
// would be a first-screen byte. A rendered diagram replaces its `<pre>` — copy button included.
const copyCodeButtons = attachCopyCodeButtons;
window.attachCopyCodeButtons = (root, options) => {
  const attached = copyCodeButtons(root, options);
  void attachMermaidBlocks(root, options);
  return attached;
};
window.attachMermaidBlocks = attachMermaidBlocks;
// U30 (A1): the reader surface intercepts file drags only — it never gains an upload entry.
installReaderAssetDropGuard();
