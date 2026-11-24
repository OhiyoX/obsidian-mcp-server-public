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
export function addObsidianSemanticClass(ranges, node, seen, { headingApplies = true, state = null } = {}) {
  const mapped = NODE_CLASS.get(node.name);
  if (mapped) {
    for (const span of visibleSemanticSpans(node)) {
      pushMark(ranges, seen, mapped, span.from, span.to);
    }
    return;
  }

  if (node.name === "HeaderMark") {
    // `###` with nothing after it is not a heading yet: keep it the literal text typed.
    if (!headingApplies) return;
    const context = node.node.parent || node.node;
    const level = /^ATXHeading([1-6])$/.exec(context.name)?.[1];
    if (level) {
      pushMark(ranges, seen, `cm-header cm-header-${level}`, node.to, context.to);
      return;
    }
    // A setext `HeaderMark` is the underline itself, so `node.to === context.to` and the ATX
    // span is empty. The title is what carries the class then: `context.from` up to the
    // underline, minus the trailing line break / indent, so a theme that paints a
    // `.cm-header` background cannot colour the end of the title line.
    const setextLevel = /^SetextHeading([12])$/.exec(context.name)?.[1];
    if (!setextLevel) return;
    const titleEnd = state
      ? context.from + state.sliceDoc(context.from, node.from).replace(/\s+$/u, "").length
      : node.from;
    pushMark(ranges, seen, `cm-header cm-header-${setextLevel}`, context.from, titleEnd);
    return;
  }

  if (node.name === "URL") {
    pushMark(ranges, seen, "cm-url", node.from, node.to);
  }
}
