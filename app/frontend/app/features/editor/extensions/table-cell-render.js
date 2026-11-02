import { findInlineTags } from "../../document/inline-tag-lexicon.js";

function appendRenderedFragment(element, source) {
  const renderer = globalThis.window?.renderObsidianMarkdown;
  if (typeof renderer !== "function") {
    element.textContent = source;
    return;
  }
  try {
    const template = element.ownerDocument.createElement("template");
    template.innerHTML = renderer(source, { fragment: true });
    const children = [...template.content.childNodes];
    if (children.length === 1 && children[0]?.nodeType === 1 && children[0].tagName === "P") {
      element.replaceChildren(...children[0].childNodes);
    } else {
      element.replaceChildren(template.content);
    }
  } catch {
    element.textContent = source;
  }
}

export function renderTableCellIdle(element, value) {
  appendRenderedFragment(element, String(value ?? ""));
}

function overlaps(aFrom, aTo, bFrom, bTo) {
  return aFrom < bTo && aTo > bFrom;
}

function sourceSemanticRanges(source) {
  const ranges = [];
  const codeRanges = [];

  const add = (from, to, className, { allowInsideCode = false } = {}) => {
    const start = Math.max(0, Number(from) || 0);
    const end = Math.min(source.length, Number(to) || 0);
    if (!(end > start)) return;
    if (!allowInsideCode && codeRanges.some((range) => overlaps(start, end, range.from, range.to))) return;
    ranges.push({ from: start, to: end, className });
  };

  // Inline code is one semantic chip even while its source backticks are
  // revealed. This mirrors ordinary Live Preview: source chrome becomes
  // editable without dropping the code paint.
  for (const match of source.matchAll(/(`+)([^\n]*?)\1/gu)) {
    if (match.index == null || !match[0]) continue;
    const from = match.index;
    const to = from + match[0].length;
    codeRanges.push({ from, to });
    add(from, to, "cm-inline-code cm-live-inline-code-content cm-live-inline-code", { allowInsideCode: true });
  }

  const paired = [
    { pattern: /(\*\*|__)(.+?)\1/gu, className: "cm-strong" },
    { pattern: /~~(.+?)~~/gu, className: "cm-strikethrough", fixedChrome: 2 },
    { pattern: /==(.+?)==/gu, className: "cm-obsidian-highlight cm-highlight", fixedChrome: 2 },
  ];
  for (const spec of paired) {
    for (const match of source.matchAll(spec.pattern)) {
      if (match.index == null || !match[0]) continue;
      const chrome = spec.fixedChrome ?? String(match[1] || "").length;
      add(match.index + chrome, match.index + match[0].length - chrome, spec.className);
    }
  }

  // Single emphasis runs. Strong markers are excluded by the neighbour guards.
  for (const match of source.matchAll(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gu)) {
    if (match.index == null) continue;
    add(match.index + 1, match.index + match[0].length - 1, "cm-em");
  }
  for (const match of source.matchAll(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/gu)) {
    if (match.index == null) continue;
    add(match.index + 1, match.index + match[0].length - 1, "cm-em");
  }

  for (const match of source.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/gu)) {
    if (match.index == null) continue;
    const label = match[1] || "";
    const url = match[2] || "";
    const labelFrom = match.index + 1;
    const urlFrom = labelFrom + label.length + 2;
    add(labelFrom, labelFrom + label.length, "cm-link");
    add(urlFrom, urlFrom + url.length, "cm-url");
  }

  for (const match of source.matchAll(/!?\[\[([^\]\n]+)\]\]/gu)) {
    if (match.index == null) continue;
    const embedChrome = match[0].startsWith("!") ? 3 : 2;
    add(
      match.index + embedChrome,
      match.index + match[0].length - 2,
      "cm-hmd-internal-link cm-obsidian-link",
    );
  }

  for (const tag of findInlineTags(source)) {
    add(tag.from, tag.to, "cm-obsidian-tag cm-hashtag cm-meta");
  }

  for (const match of source.matchAll(/%%([^%\n]+)%%/gu)) {
    if (match.index == null) continue;
    add(match.index + 2, match.index + match[0].length - 2, "cm-obsidian-comment cm-comment");
  }

  return ranges;
}

/**
 * Render editable Markdown source without flattening semantic paint.
 *
 * textContent remains byte-for-byte the cell source (subject only to normal
 * browser text-node representation), while spans carry the same canonical Live
 * classes used outside tables. Community theme.css therefore keeps ownership
 * of paint during source editing.
 */
export function renderTableCellEditing(element, value) {
  const source = String(value ?? "");
  const ranges = sourceSemanticRanges(source);
  if (!ranges.length) {
    element.textContent = source;
    return;
  }

  const boundaries = new Set([0, source.length]);
  for (const range of ranges) {
    boundaries.add(range.from);
    boundaries.add(range.to);
  }
  const points = [...boundaries].sort((a, b) => a - b);
  const fragment = element.ownerDocument.createDocumentFragment();

  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (!(to > from)) continue;
    const text = source.slice(from, to);
    const classes = [...new Set(
      ranges
        .filter((range) => range.from <= from && range.to >= to)
        .flatMap((range) => range.className.split(/\s+/u).filter(Boolean)),
    )];
    if (!classes.length) {
      fragment.append(element.ownerDocument.createTextNode(text));
      continue;
    }
    const span = element.ownerDocument.createElement("span");
    span.className = classes.join(" ");
    span.textContent = text;
    fragment.append(span);
  }

  element.replaceChildren(fragment);
}
