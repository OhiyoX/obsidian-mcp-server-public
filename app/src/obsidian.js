import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import { requireRequestAuthor, stampFrontmatter } from "./request-context.js";
// Wave D / D-files: note reads/writes follow the request's VaultRuntime instead of the primary
// facade (contract §10.1); callers without a Vault selection keep the legacy primary behaviour.
// An in-process owner of a *fixed* runtime (the primary VaultIndex facade) passes `localFs`
// explicitly so its projection never follows the ambient Vault selection (§11/§43-12).
import {
  assertWritable,
  currentLocalFs,
  decodeLinkTarget,
  hasExtension,
  hasNumericExtension,
  normalizeVaultInput,
  resolveVaultPath,
  stripMarkdownExtension,
  toVaultPath,
} from "./vault-runtime/request-vault.js";
import { maskCodeSpans, normalizeTag, updateFenceState, isValidInlineTagBody } from "./markdown-lexicon.js";

export { normalizeTag };

export { parseFrontmatter, stringifyFrontmatter };

export async function readNote(absPath, options = {}) {
  const localFs = options.localFs ?? currentLocalFs();
  const raw = await localFs.readLimitedText(absPath);
  const stat = await fs.stat(absPath);
  let parsed;
  try {
    parsed = parseFrontmatter(raw);
  } catch (error) {
    if (!options.tolerateMalformedFrontmatter) throw error;
    // Index/search callers may degrade one malformed YAML header to plain
    // Markdown. The catch is deliberately scoped to parsing only: read/stat/
    // revision failures still propagate and cannot be mistaken for bad YAML.
    parsed = { data: {}, content: raw };
  }
  return {
    path: localFs.toVaultPath(absPath),
    raw,
    content: parsed.content,
    frontmatter: parsed.data,
    revision: await localFs.fileRevision(absPath),
    stat: { size: stat.size, created: stat.birthtime.toISOString(), modified: stat.mtime.toISOString() },
  };
}

// Exact bytes writeNoteFile persists for a note. Exported so callers can
// measure the on-disk size of a prospective write (issue #251 write guard)
// without duplicating the frontmatter stamping/serialization rules.
export function serializeNoteFile(frontmatter, content) {
  return stringifyFrontmatter(stampFrontmatter(frontmatter, requireRequestAuthor()), content);
}

export async function writeNoteFile(absPath, frontmatter, content, options = {}) {
  assertWritable();
  const localFs = options.localFs ?? currentLocalFs();
  return localFs.atomicWriteFile(absPath, serializeNoteFile(frontmatter, content), { encoding: "utf-8", ifMatch: options.ifMatch });
}

export function splitLines(content) {
  const trailing = content.endsWith("\n");
  const lines = content.split("\n");
  if (trailing) lines.pop();
  return { lines, trailing };
}

function joinLines(lines, trailing = false) {
  return `${lines.join("\n")}${trailing ? "\n" : ""}`;
}

function lineStarts(content) {
  const starts = [0];
  for (let i = 0; i < content.length; i += 1) if (content[i] === "\n") starts.push(i + 1);
  return starts;
}

function locAtOffset(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (starts[mid] <= offset && (mid === starts.length - 1 || starts[mid + 1] > offset)) {
      return { line: mid, col: offset - starts[mid], offset };
    }
    if (starts[mid] > offset) high = mid - 1;
    else low = mid + 1;
  }
  return { line: 0, col: offset, offset };
}

function positionForRange(content, start, end) {
  const starts = lineStarts(content);
  return { start: locAtOffset(starts, start), end: locAtOffset(starts, end) };
}

function positionForLine(content, lineIndex) {
  const starts = lineStarts(content);
  const start = starts[lineIndex] ?? 0;
  const end = lineIndex + 1 < starts.length ? Math.max(start, starts[lineIndex + 1] - 1) : content.length;
  return { start: locAtOffset(starts, start), end: locAtOffset(starts, end) };
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function normalizeTagList(tags = []) {
  const values = Array.isArray(tags) ? tags : [tags];
  return unique(values.map(normalizeTag));
}

export function frontmatterTags(data) {
  const raw = data.tags ?? data.tag ?? [];
  if (Array.isArray(raw)) return normalizeTagList(raw);
  if (typeof raw === "string") return normalizeTagList(raw.split(/[,\s]+/));
  return [];
}

// Front matter keys are LITERAL keys on every read path (`get_note` with
// sectionType=frontmatter and `manage_frontmatter` action=get both index
// `frontmatter[key]` directly), so a dotted key means "a key that contains a dot",
// not a path. Callers assume otherwise often enough that a silent literal write
// leaves junk (`probe.nested: x`) inside a real note, so writes fail closed and name
// the supported way to set a nested field: replace the parent mapping instead.
//
// Scope of the rule (owner ruling 2026-10-12, issue #538; pinned by
// `app/test/frontmatter-key-guard.test.js` and `…-map-faces.test.js` — tightening the
// whole-map side is a behaviour change and must update those suites):
//   * KEY-SHAPED parameters go through this guard: `manage_frontmatter` `key`,
//     `patch_note` / plan `target`, and `rename_property` `to`
//     (`assertRenameDestinationIsWritable` wraps this function for the rename wording).
//   * WHOLE-MAP parameters stay literal **on purpose**: an `updates` record
//     (`manage_frontmatter action=set|replace`, plan `frontmatter action=set|replace`) and a
//     whole `frontmatter` map (`write_note`, plan `operation=write`) are maps the caller
//     authored, so a dotted key inside them is an explicit literal key. That is the
//     documented escape hatch for a key that must contain a dot — do not guard it here.
//   * Deleting an EXISTING literal dotted key stays allowed (`removing`) — the only cleanup path.
export function assertFrontmatterKeyIsLiteral(key, { existing = {}, removing = false } = {}) {
  if (!key.includes(".")) return;
  // Removing an existing literal dotted key stays allowed: it is the only way to clean
  // up keys written before this guard existed. A missing one is rejected as well, so a
  // nested delete can never no-op silently.
  if (removing && Object.hasOwn(existing, key)) return;
  const how = "dots are literal characters in a front matter key, not path separators; to set a nested field, "
    + "replace the parent mapping instead (manage_frontmatter action=set key=\"<parent>\" value=<object>, "
    + "or a plan `frontmatter` set with `updates`)";
  throw new Error(`front matter key "${key}" contains ".": ${how}`);
}

export function extractInlineTags(content) {
  const tags = [];
  const starts = lineStarts(content);
  const lines = content.split("\n");
  let fence = null;
  const tagRegex = /(^|[\s>])#([\p{L}\p{M}\p{N}_\-/]+)/gu;

  lines.forEach((line, lineIndex) => {
    const prevFence = fence;
    fence = updateFenceState(line, fence);
    if (prevFence !== null || fence !== null) return;
    const masked = maskCodeSpans(line);
    let match;
    while ((match = tagRegex.exec(masked)) !== null) {
      const rawTag = match[2].replace(/[.,;:!?()[\]{}"'`]+$/g, "");
      if (!isValidInlineTagBody(rawTag)) continue;
      const normalized = normalizeTag(rawTag);
      const start = starts[lineIndex] + match.index + match[1].length;
      const end = start + rawTag.length + 1;
      tags.push({ tag: normalized, original: `#${rawTag}`, position: positionForRange(content, start, end) });
    }
  });
  return tags;
}

export function inlineTags(content) {
  return unique(extractInlineTags(content).map((item) => item.tag));
}

export function allTagsForNote(note) {
  return unique([...frontmatterTags(note.frontmatter), ...inlineTags(note.content)]);
}

export function parseHeadings(content) {
  const { lines } = splitLines(content);
  const stack = [];
  const headings = [];
  let fence = null;
  lines.forEach((line, index) => {
    const prevFence = fence;
    fence = updateFenceState(line, fence);
    if (prevFence !== null || fence !== null) return;
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) return;
    const level = match[1].length;
    const title = match[2].trim();
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title });
    headings.push({ level, title, path: stack.map((item) => item.title).join(" > "), line: index + 1, index });
  });
  return headings;
}

export function parseBlocks(content) {
  const { lines } = splitLines(content);
  const blocks = [];
  lines.forEach((line, index) => {
    const match = line.match(/\^([A-Za-z0-9-]+)\s*$/);
    if (match) blocks.push({ id: match[1], line: index + 1, index, text: line });
  });
  return blocks;
}

export function resolveLinkPath(target, sourcePath) {
  if (!target) return "";
  const clean = normalizeVaultInput(decodeLinkTarget(target).split(/[\\#^]/)[0]);
  if (!clean) return "";
  const withExtension = !hasExtension(clean) || hasNumericExtension(clean) ? `${clean}.md` : clean;
  if (clean.includes("/")) return path.posix.normalize(withExtension);
  const sourceDir = path.posix.dirname(sourcePath);
  return sourceDir === "." ? withExtension : path.posix.normalize(path.posix.join(sourceDir, withExtension));
}

export function extractLinks(content, sourcePath) {
  const links = [];
  const wikiRegex = /(!)?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  const markdownRegex = /(!)?\[([^\]]*)]\(([^)]+)\)/g;
  let match;
  const scanContent = maskMarkdownCode(content);

  while ((match = wikiRegex.exec(scanContent)) !== null) {
    const link = match[2].trim();
    const target = link.split(/[\\#^]/)[0].trim();
    links.push({
      type: match[1] ? "embed" : "wiki",
      syntax: "wiki",
      raw: match[0],
      link,
      target,
      anchor: link.slice(target.length) || "",
      alias: match[3] || "",
      start: match.index,
      end: match.index + match[0].length,
      resolvedPath: resolveLinkPath(target, sourcePath),
    });
  }

  while ((match = markdownRegex.exec(scanContent)) !== null) {
    const target = decodeLinkTarget(match[3].trim());
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
    links.push({
      type: match[1] ? "embed" : "markdown",
      syntax: "markdown",
      raw: match[0],
      link: target,
      target,
      alias: match[2] || "",
      start: match.index,
      end: match.index + match[0].length,
      resolvedPath: resolveLinkPath(target, sourcePath),
    });
  }

  return links.sort((a, b) => a.start - b.start);
}

function maskMarkdownCode(content) {
  const lines = content.split("\n");
  let fence = null;
  return lines.map((line) => {
    const prevFence = fence;
    fence = updateFenceState(line, fence);
    if (prevFence !== null || fence !== null) return " ".repeat(line.length);
    return maskCodeSpans(line);
  }).join("\n");
}

export function documentMap(note) {
  return {
    path: note.path,
    frontmatterFields: Object.keys(note.frontmatter),
    headings: parseHeadings(note.content),
    blocks: parseBlocks(note.content),
    tags: allTagsForNote(note),
    outgoingLinks: extractLinks(note.content, note.path),
  };
}

function referenceCache(link, content) {
  const cache = { link: link.link || link.target, original: link.raw, position: positionForRange(content, link.start ?? 0, link.end ?? 0) };
  if (link.alias) cache.displayText = link.alias;
  return cache;
}

function frontmatterLinkCaches(frontmatter) {
  const caches = [];
  function visit(value, keyPath) {
    if (typeof value === "string") {
      const wikiRegex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
      let match;
      while ((match = wikiRegex.exec(value)) !== null) {
        const cache = { key: keyPath, link: match[1], original: match[0] };
        if (match[2]) cache.displayText = match[2];
        caches.push(cache);
      }
      return;
    }
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${keyPath}.${index}`));
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, child]) => visit(child, keyPath ? `${keyPath}.${key}` : key));
  }
  Object.entries(frontmatter || {}).forEach(([key, value]) => visit(value, key));
  return caches;
}

function frontmatterPosition(raw) {
  if (!raw.startsWith("---")) return undefined;
  const endMatch = raw.slice(3).match(/\n---\s*(\n|$)/);
  if (!endMatch) return undefined;
  const end = 3 + endMatch.index + endMatch[0].length;
  return positionForRange(raw, 0, end);
}

export function buildCachedMetadata(note) {
  const links = extractLinks(note.content, note.path);
  const headings = parseHeadings(note.content).map((heading) => ({
    heading: heading.title,
    level: heading.level,
    position: positionForLine(note.content, heading.index),
  }));
  const blocks = Object.fromEntries(parseBlocks(note.content).map((block) => [block.id, { id: block.id, position: positionForLine(note.content, block.index) }]));
  return {
    links: links.filter((link) => link.type !== "embed").map((link) => referenceCache(link, note.content)),
    embeds: links.filter((link) => link.type === "embed").map((link) => referenceCache(link, note.content)),
    tags: [
      ...extractInlineTags(note.content).map((tag) => ({ tag: `#${tag.tag}`, position: tag.position })),
      ...frontmatterTags(note.frontmatter).map((tag) => ({ tag: `#${tag}` })),
    ],
    headings,
    sections: headings.map((heading) => ({ type: "heading", position: heading.position })),
    frontmatter: note.frontmatter,
    frontmatterPosition: frontmatterPosition(note.raw),
    frontmatterLinks: frontmatterLinkCaches(note.frontmatter),
    blocks,
  };
}

export function findHeadingSection(content, target) {
  const { lines } = splitLines(content);
  const headings = parseHeadings(content);
  const match = headings.find((heading) => heading.title === target || heading.path === target);
  if (!match) return null;
  let end = lines.length;
  for (const heading of headings) {
    if (heading.index > match.index && heading.level <= match.level) {
      end = heading.index;
      break;
    }
  }
  return { heading: match, bodyStart: match.index + 1, end };
}

export function patchBodySection(content, targetType, target, operation, patchContent, createTargetIfMissing) {
  const split = splitLines(content);
  const { lines } = split;
  const patchLines = splitLines(patchContent).lines;
  if (targetType === "heading") {
    const section = findHeadingSection(content, target);
    if (!section) {
      if (!createTargetIfMissing) throw new Error(`Heading not found: ${target}`);
      if (lines.length && lines[lines.length - 1].trim()) lines.push("");
      lines.push(`## ${target}`, ...patchLines);
      return joinLines(lines, true);
    }
    if (operation === "append") lines.splice(section.end, 0, ...patchLines);
    else if (operation === "prepend") lines.splice(section.bodyStart, 0, ...patchLines);
    else lines.splice(section.bodyStart, section.end - section.bodyStart, ...patchLines);
    return joinLines(lines, split.trailing);
  }
  if (targetType === "block") {
    const blockId = target.replace(/^\^/, "");
    const block = parseBlocks(content).find((item) => item.id === blockId);
    if (!block) throw new Error(`Block reference not found: ${target}`);
    if (operation === "append") lines.splice(block.index + 1, 0, ...patchLines);
    else if (operation === "prepend") lines.splice(block.index, 0, ...patchLines);
    else lines.splice(block.index, 1, ...patchLines);
    return joinLines(lines, split.trailing);
  }
  throw new Error(`Unsupported targetType for body patch: ${targetType}`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildSearchRegex(query, options = {}) {
  let pattern = options.useRegex ? query : escapeRegExp(query);
  if (!options.useRegex && options.flexibleWhitespace) pattern = pattern.replace(/\s+/g, "\\s+");
  if (options.wholeWord) pattern = `\\b${pattern}\\b`;
  return new RegExp(pattern, `${options.caseSensitive ? "" : "i"}g`);
}

export function searchSnippets(text, regex, contextLength, maxMatches) {
  const snippets = [];
  let match;
  regex.lastIndex = 0;
  while ((match = regex.exec(text)) !== null && snippets.length < maxMatches) {
    const start = Math.max(0, match.index - contextLength);
    const end = Math.min(text.length, match.index + match[0].length + contextLength);
    snippets.push({ line: text.slice(0, match.index).split("\n").length, match: match[0], context: text.slice(start, end) });
    if (match[0] === "") regex.lastIndex += 1;
  }
  return snippets;
}

export function matchesFrontmatterFilters(frontmatter, filters = {}) {
  return Object.entries(filters).every(([key, expected]) => {
    const actual = frontmatter[key];
    if (Array.isArray(actual)) return actual.map(String).some((value) => value.toLowerCase().includes(String(expected).toLowerCase()));
    if (typeof actual === "object" && actual !== null) return JSON.stringify(actual) === JSON.stringify(expected);
    return String(actual ?? "").toLowerCase().includes(String(expected).toLowerCase());
  });
}

export function applyStringReplacement(content, replacements) {
  let output = content;
  const details = [];
  for (const replacement of replacements) {
    const regex = buildSearchRegex(replacement.search, replacement);
    const flags = regex.flags.includes("g") && replacement.replaceAll !== false ? regex.flags : regex.flags.replace("g", "");
    const finalRegex = new RegExp(regex.source, flags);
    let count = 0;
    output = output.replace(finalRegex, () => {
      count += 1;
      return replacement.replace;
    });
    details.push({ search: replacement.search, replacements: count });
  }
  return { output, details };
}

export function removeInlineTags(content, tags) {
  const normalized = normalizeTagList(tags);
  if (!normalized.length) return content;
  const lines = content.split("\n");
  let fence = null;
  return lines.map((line) => {
    const prevFence = fence;
    fence = updateFenceState(line, fence);
    if (prevFence !== null || fence !== null) return line;
    const masked = maskCodeSpans(line);
    const tagRegex = /(^|[\s>])#([\p{L}\p{M}\p{N}_\-/]+)/gu;
    let result = "";
    let lastEnd = 0;
    let match;
    while ((match = tagRegex.exec(masked)) !== null) {
      const rawTag = match[2].replace(/[.,;:!?()[\]{}"'`]+$/g, "");
      if (!isValidInlineTagBody(rawTag)) continue;
      if (normalized.includes(normalizeTag(rawTag))) {
        result += line.slice(lastEnd, match.index) + match[1].trimEnd();
        lastEnd = match.index + match[0].length;
      }
    }
    if (lastEnd === 0) return line;
    result += line.slice(lastEnd);
    return result;
  }).join("\n");
}

export function appendInlineTags(content, tags) {
  const normalized = normalizeTagList(tags);
  if (!normalized.length) return content;
  const existing = inlineTags(content);
  const missing = normalized.filter((tag) => !existing.includes(tag));
  if (!missing.length) return content;
  const suffix = missing.map((tag) => `#${tag}`).join(" ");
  return content.trimEnd() ? `${content.trimEnd()}\n\n${suffix}\n` : `${suffix}\n`;
}

export function linkMatchesNote(link, notePath) {
  const target = normalizeVaultInput(link.target || link.resolvedPath);
  const note = normalizeVaultInput(notePath);
  const noteNoExt = stripMarkdownExtension(note);
  const basename = stripMarkdownExtension(path.posix.basename(note));
  return target === note || target === noteNoExt || target === basename || link.resolvedPath === note;
}

function replaceWikiLinks(content, fromPath, toPath, sourcePath) {
  const from = normalizeVaultInput(fromPath);
  const to = stripMarkdownExtension(normalizeVaultInput(toPath));
  return content.replace(/(!)?\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, (full, embed = "", targetWithAnchor, alias = "") => {
    const target = targetWithAnchor.trim();
    const targetNote = target.split(/[\\#^]/)[0].trim();
    const suffix = target.slice(targetNote.length);
    const link = { target: targetNote, resolvedPath: resolveLinkPath(targetNote, sourcePath) };
    if (!linkMatchesNote(link, from)) return full;
    return `${embed}[[${to}${suffix}${alias}]]`;
  });
}

function replaceMarkdownLinks(content, fromPath, toPath, sourcePath) {
  const from = normalizeVaultInput(fromPath);
  const to = normalizeVaultInput(toPath);
  return content.replace(/(!?\[[^\]]*]\()([^)]+)(\))/g, (full, prefix, target, suffix) => {
    const trimmed = decodeLinkTarget(target.trim());
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("#")) return full;
    const targetNote = trimmed.split("#")[0].trim();
    const anchor = trimmed.slice(targetNote.length);
    const link = { target: targetNote, resolvedPath: resolveLinkPath(targetNote, sourcePath) };
    if (!linkMatchesNote(link, from)) return full;
    return `${prefix}${encodeURI(to)}${anchor}${suffix}`;
  });
}

export function replaceVaultLinks(content, fromPath, toPath, sourcePath) {
  return replaceMarkdownLinks(replaceWikiLinks(content, fromPath, toPath, sourcePath), fromPath, toPath, sourcePath);
}
