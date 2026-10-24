import { Decoration } from "@codemirror/view";

const NODE_CLASS = new Map([
  ["StrongEmphasis", "cm-strong"],
  ["Emphasis", "cm-em"],
  ["Strikethrough", "cm-strikethrough"],
  ["Link", "cm-link"],
]);

const SOURCE_CHROME = new Set([
  "EmphasisMark",
  "StrikethroughMark",
  "LinkMark",
  "URL",
]);

function pushMark(ranges, seen, className, from, to) {
  if (!(to > from)) return;
  const key = `${className}:${from}:${to}`;
  if (seen.has(key)) return;
  seen.add(key);
  ranges.push(Decoration.mark({ class: className }).range(from, to));
}

function visibleSemanticSpans(node) {
  const spans = [];
  let cursor = node.from;
  for (let child = node.node.firstChild; child; child = child.nextSibling) {
    if (!SOURCE_CHROME.has(child.name)) continue;
    if (child.from > cursor) spans.push({ from: cursor, to: child.from });
    cursor = Math.max(cursor, child.to);
  }
  if (cursor < node.to) spans.push({ from: cursor, to: node.to });
  return spans.filter((span) => span.to > span.from);
}

/**
 * Add Obsidian's semantic CodeMirror class surface without owning paint.
 * Marks cover only visible content, never hidden Markdown chrome, so the
 * semantic class survives the source-marker replacement decorations.
 */
export function addObsidianSemanticClass(ranges, node, seen) {
  const mapped = NODE_CLASS.get(node.name);
  if (mapped) {
    for (const span of visibleSemanticSpans(node)) {
      pushMark(ranges, seen, mapped, span.from, span.to);
    }
    return;
  }

  if (node.name === "HeaderMark") {
    const context = node.node.parent || node.node;
    const level = /^ATXHeading([1-6])$/.exec(context.name)?.[1];
    if (!level) return;
    pushMark(ranges, seen, `cm-header cm-header-${level}`, node.to, context.to);
    return;
  }

  if (node.name === "URL") {
    pushMark(ranges, seen, "cm-url", node.from, node.to);
  }
}
