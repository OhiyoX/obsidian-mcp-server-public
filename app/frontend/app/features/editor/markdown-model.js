import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";

/** Normalize vault-relative paths for dependency matching. */
export function canonicalPath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
}

export function assetKey(vaultId, path) {
  return `${String(vaultId || "")}::${canonicalPath(path)}`;
}

/**
 * End offset of YAML frontmatter when present.
 * Scans the full document (no silent length cutoff).
 */
export function frontmatterEndOffset(doc) {
  if (typeof doc === "string") {
    const match = String(doc).match(/^---\r?\n[\s\S]*?^---(?:\r?\n|$)/m);
    return match?.index === 0 ? match[0].length : 0;
  }
  if (!doc || doc.lines < 2) return 0;
  if (doc.line(1).text !== "---") return 0;
  for (let number = 2; number <= doc.lines; number += 1) {
    const line = doc.line(number);
    if (line.text === "---") {
      return number < doc.lines ? line.to + 1 : line.to;
    }
  }
  return 0;
}

/** First body offset after closed YAML. Used so Live never parks the caret on the properties widget. */
export function cursorAfterFrontmatter(doc) {
  const length = typeof doc === "string" ? doc.length : doc.length;
  const fmEnd = frontmatterEndOffset(doc);
  return Math.min(length, Math.max(0, fmEnd));
}

/**
 * True when Live should move the caret off the properties widget.
 * Any collapsed caret inside YAML, or a range that is exactly the YAML span.
 * Select-all and ranges that continue into the body are left alone.
 */
export function selectionIsOnPropertiesWidget(ranges, doc) {
  const fmEnd = frontmatterEndOffset(doc);
  if (!(fmEnd > 0) || !Array.isArray(ranges) || !ranges.length) return false;
  return ranges.every((range) => {
    const lo = Math.min(range.from, range.to);
    const hi = Math.max(range.from, range.to);
    if (lo === hi) return lo < fmEnd;
    return lo === 0 && hi <= fmEnd && hi >= fmEnd - 1;
  });
}

function slugify(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "heading";
}

const HEADING_SKIP = new Set([
  "HeaderMark",
  "SetextMark",
  "EmphasisMark",
  "StrongMark",
  "StrikethroughMark",
  "CodeMark",
  "CodeInfo",
  "LinkMark",
  "URL",
  "QuoteMark",
  "HighlightMark",
]);

function linkPlainText(state, treeNode) {
  const parts = [];
  let pos = treeNode.from;
  for (let child = treeNode.firstChild; child; child = child.nextSibling) {
    if (child.from > pos && child.name !== "URL") {
      parts.push(state.sliceDoc(pos, child.from));
    }
    if (HEADING_SKIP.has(child.name) || child.name === "URL") {
      pos = child.to;
      continue;
    }
    if (child.firstChild) parts.push(headingPlainText(state, child));
    else parts.push(state.sliceDoc(child.from, child.to));
    pos = child.to;
  }
  if (pos < treeNode.to) parts.push(state.sliceDoc(pos, treeNode.to));
  return parts.join("");
}

/**
 * Plain heading text from the syntax tree (no marks, link URLs, or quote prefixes).
 * Collects Lezer gaps between children — plain text is often not a separate node.
 */
export function headingPlainText(state, node) {
  const treeNode = node.node || node;
  const parts = [];
  let pos = treeNode.from;

  for (let child = treeNode.firstChild; child; child = child.nextSibling) {
    if (child.from > pos) parts.push(state.sliceDoc(pos, child.from));

    if (HEADING_SKIP.has(child.name)) {
      pos = child.to;
      continue;
    }

    if (child.name === "Link" || child.name === "Image" || child.name === "Autolink") {
      parts.push(linkPlainText(state, child));
      pos = child.to;
      continue;
    }

    if (child.firstChild) parts.push(headingPlainText(state, child));
    else parts.push(state.sliceDoc(child.from, child.to));
    pos = child.to;
  }

  if (pos < treeNode.to) parts.push(state.sliceDoc(pos, treeNode.to));
  return parts.join("").replace(/\s+/g, " ").trim();
}

/**
 * Source-mapped headings for outline / navigation.
 * Supports ATX + multi-line Setext; excludes fenced/indented code and YAML frontmatter.
 * @returns {{id:string,level:number,text:string,from:number,to:number}[]}
 */
export function extractHeadings(state) {
  const fmEnd = frontmatterEndOffset(state.doc);
  const used = new Map();
  const headings = [];
  const tree = ensureSyntaxTree(state, state.doc.length, 5000) || syntaxTree(state);

  tree.iterate({
    enter(node) {
      if (node.name === "FencedCode" || node.name === "CodeBlock") return false;
      // Skip nodes wholly inside frontmatter; do not abort Document/ancestors.
      if (node.to <= fmEnd) return false;

      const atx = /^ATXHeading([1-6])$/.exec(node.name);
      const setext = /^SetextHeading([1-6])$/.exec(node.name);
      if (!atx && !setext) return;
      if (node.from < fmEnd) return;

      const level = Number((atx || setext)[1]);
      const text = headingPlainText(state, node);
      if (!text) return;

      const base = slugify(text);
      const count = (used.get(base) || 0) + 1;
      used.set(base, count);
      headings.push({
        id: count === 1 ? base : `${base}-${count}`,
        level,
        text,
        from: node.from,
        to: node.to,
      });
    },
  });

  return headings;
}

export function simpleHash(text) {
  let hash = 2166136261;
  const value = String(text ?? "");
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Fingerprint of reference-link and footnote definitions only.
 * Used so ordinary body edits do not bump envVersion / rebuild every widget.
 */
export function semanticDefinitionFingerprint(source) {
  const lines = [];
  for (const line of String(source ?? "").split(/\r?\n/)) {
    if (/^\s{0,3}\[[^\]]+\]:\s+\S/.test(line) || /^\s{0,3}\[\^[^\]]+\]:/.test(line)) {
      lines.push(line.trim());
    }
  }
  return lines.join("\n");
}

const ASSET_PATTERNS = [
  /!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g,
  /!\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?]]/g,
];

export function resolveRelative(fromPath, target) {
  const clean = canonicalPath(target.split("#", 1)[0]);
  if (!clean || /^(?:https?:|data:|blob:|\/\/)/i.test(clean)) return null;
  if (clean.startsWith("/")) return clean.replace(/^\//, "");
  const base = canonicalPath(fromPath).split("/").slice(0, -1);
  for (const part of clean.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  return base.join("/");
}

/** Collect canonical asset paths referenced by a markdown fragment. */
export function collectAssetPaths(source, sourcePath = "") {
  const found = new Set();
  const text = String(source ?? "");
  for (const pattern of ASSET_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      const resolved = resolveRelative(sourcePath, match[1].trim());
      if (resolved) found.add(resolved);
    }
  }
  return [...found];
}

export function assetRevisionKey(paths, vaultId, revisions) {
  if (!paths.length) return "";
  const map = revisions || {};
  return paths
    .map((path) => `${canonicalPath(path)}@${map[assetKey(vaultId, path)] || map[canonicalPath(path)] || ""}`)
    .sort()
    .join("|");
}

export function eventMatchesAssets(event, dependencies, sourceVaultId) {
  if (!event || !dependencies?.length) return false;
  const eventVault = event.vaultId != null ? String(event.vaultId) : "";
  if (sourceVaultId != null && eventVault && String(sourceVaultId) !== eventVault) return false;
  const eventPath = canonicalPath(event.path);
  if (!eventPath) return false;
  // The authenticated server also resolves root-relative and nearest-name
  // attachments. Until it exposes canonical resolutions, conservatively refresh
  // same-name candidates within this vault; URLs still keep their own from/path.
  const basename = eventPath.split("/").at(-1).toLowerCase();
  return dependencies.some((path) => canonicalPath(path) === eventPath
    || canonicalPath(path).split("/").at(-1).toLowerCase() === basename);
}
