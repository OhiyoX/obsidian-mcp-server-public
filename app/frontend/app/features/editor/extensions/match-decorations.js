import { syntaxTree } from "@codemirror/language";
import { Decoration, ViewPlugin } from "@codemirror/view";
import { readHighlightColour } from "../../document/highlight-colours.js";
import { frontmatterEndOffset } from "../markdown-model.js";

/**
 * Obsidian inline semantic decoration (`#tag`, `==highlight==`, `%%comment%%`)
 * is a text-level regex, but Obsidian only paints it in Markdown body text.
 * The same characters inside fenced/indented code, inline code, YAML
 * frontmatter, HTML blocks or inline HTML are literal and must stay undecorated.
 *
 * Lezer markdown node names that own such literal ranges. Names are taken from
 * the pinned `@lezer/markdown` / GFM syntax tree, not guessed.
 */
const EXCLUDED_NODE_NAMES = new Set([
  "FencedCode",
  "CodeBlock",
  "CodeText",
  "InlineCode",
  "HTMLBlock",
  "HTMLTag",
  "CommentBlock",
  "Comment",
]);

const VOID_HTML_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const HTML_TAG_RE = /^<\s*(\/?)\s*([a-zA-Z][\w-]*)/;
const HTML_SELF_CLOSING_RE = /\/\s*>\s*$/;

function normalized(ranges) {
  const sorted = ranges
    .filter((range) => range.to > range.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ from: range.from, to: range.to });
    }
  }
  return merged;
}

function rangeIsExcluded(excluded, from, to) {
  for (const range of excluded) {
    if (range.from < to && from < range.to) return true;
    if (range.from >= to) break;
  }
  return false;
}

/**
 * Inline HTML pairing needs both the opening and the closing tag, but the
 * syntax tree is only walked over the visible `[from, to]` window. An inline
 * element cannot cross a Markdown block (a blank line ends its paragraph), so
 * widening the walk to the full span of the top-level blocks that overlap the
 * window recovers tags above and below the viewport without scanning unrelated
 * blocks. Blocks are the top-level children of `Document`.
 */
function syntaxScanRange(state, from, to) {
  let start = from;
  let end = to;
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.node.parent?.name === "Document") {
        start = Math.min(start, node.from);
        end = Math.max(end, node.to);
      }
      return true;
    },
  });
  return { from: start, to: end };
}

/**
 * Sorted, merged ranges inside `[from, to]` that must not receive inline
 * semantic decoration: YAML frontmatter, fenced/indented/inline code, HTML
 * blocks/comments and the literal text owned by inline HTML elements.
 *
 * `extraNodeNames` adds caller-specific literal ranges 鈥?the Live tag
 * decoration passes the link/image destination nodes, because Reading's
 * markdown-it `link` rule consumes `[a](#sec)` before the tag rule can see it
 * (#484: the two hosts must not disagree on what is a tag).
 *
 * Pure and side-effect free so it can be unit tested against a real
 * `EditorState` without a browser.
 */
export function excludedSyntaxRanges(state, from = 0, to = state.doc.length, extraNodeNames = null) {
  const ranges = [];
  const fmEnd = frontmatterEndOffset(state.doc);
  if (fmEnd > 0 && from < fmEnd && 0 < to) ranges.push({ from: 0, to: fmEnd });

  const scan = syntaxScanRange(state, from, to);
  const htmlTags = [];
  syntaxTree(state).iterate({
    from: scan.from,
    to: scan.to,
    enter(node) {
      if (extraNodeNames && extraNodeNames.has(node.name)) {
        ranges.push({ from: node.from, to: node.to });
        return true;
      }
      if (!EXCLUDED_NODE_NAMES.has(node.name)) return true;
      if (node.name !== "HTMLTag") {
        ranges.push({ from: node.from, to: node.to });
        return true;
      }
      const text = state.sliceDoc(node.from, node.to);
      const match = HTML_TAG_RE.exec(text);
      if (!match) {
        ranges.push({ from: node.from, to: node.to });
        return true;
      }
      const name = match[2].toLowerCase();
      htmlTags.push({
        name,
        from: node.from,
        to: node.to,
        closing: match[1] === "/",
        selfClosing: HTML_SELF_CLOSING_RE.test(text) || VOID_HTML_TAGS.has(name),
      });
      return true;
    },
  });

  // Pair opening inline HTML tags with their matching closing tag so literal
  // text between them (`<span>#tag</span>`) is excluded with its element.
  const stack = [];
  for (const tag of htmlTags) {
    ranges.push({ from: tag.from, to: tag.to });
    if (tag.closing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].name === tag.name) {
          ranges.push({ from: stack[index].from, to: tag.to });
          stack.length = index;
          break;
        }
      }
    } else if (!tag.selfClosing) {
      stack.push(tag);
    }
  }

  return normalized(ranges);
}

function globalPattern(pattern) {
  return pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
}

function trimLength(trim, matchText) {
  const value = typeof trim === "function" ? Number(trim(matchText)) : Number(trim);
  return Math.max(0, value || 0);
}

/**
 * One highlight span's delimiter lengths. Both sides are the whole run of `=`
 * (two or more), so `===a===` trims 3 and 3 and leaves `a`.
 *
 * The opening side also swallows a leading colour emoji (`==🔴text==`): desktop
 * treats it as markup (it becomes `data-highlight` on the mark, not content), so
 * the paint and the hiding pass both start after it.
 */
export function highlightTrimStart(matchText) {
  const run = /^=+/.exec(matchText);
  if (!run) return 0;
  const { length } = readHighlightColour(matchText.slice(run[0].length));
  return run[0].length + length;
}

/** The colour of a whole highlight span's source text (`""` when uncoloured). */
export function highlightColourOf(matchText) {
  const run = /^=+/.exec(matchText);
  return readHighlightColour(run ? matchText.slice(run[0].length) : matchText).colour;
}

/**
 * The Live Preview class for a highlight span's source text (`==🔴x==`), i.e.
 * `cm-highlight-<colour>`, or `""` when the span is uncoloured. Desktop uses the
 * same class names, so a theme's `span.cm-highlight-red` rule lands unchanged.
 */
export function highlightedColourClass(matchText) {
  const colour = highlightColourOf(matchText);
  return colour ? `cm-highlight-${colour}` : "";
}

export function highlightTrimEnd(matchText) {
  const run = /=+$/.exec(matchText);
  return run ? run[0].length : 0;
}

/**
 * Highlight spans on a single line. A delimiter is a run of at least two `=`,
 * and the whole run on each side is the delimiter. A closing run of four or
 * more keeps only two when the remainder opens another span, so `==x====y==`
 * stays two highlights. `====` is empty and is not a span. `====a====` follows
 * this same rule (推得项，待真值: no owner screenshot for four equals).
 */
export function locateHighlightSpans(text) {
  const spans = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "=") {
      index += 1;
      continue;
    }
    const openFrom = index;
    while (index < text.length && text[index] === "=") index += 1;
    const openLen = index - openFrom;
    if (openLen < 2) continue;
    const contentFrom = index;
    let closeFrom = -1;
    while (index < text.length && text[index] !== "\n") {
      if (text[index] !== "=") {
        index += 1;
        continue;
      }
      const runFrom = index;
      while (index < text.length && text[index] === "=") index += 1;
      if (index - runFrom === 1) continue;
      closeFrom = runFrom;
      break;
    }
    if (closeFrom < 0) {
      index = contentFrom;
      continue;
    }
    let closeLen = index - closeFrom;
    if (closeLen >= 4 && locateHighlightSpans(text.slice(closeFrom + 2)).some((span) => span.from === 0)) {
      closeLen = 2;
      index = closeFrom + 2;
    }
    spans.push({ from: openFrom, to: closeFrom + closeLen, openLen, closeLen });
  }
  return spans;
}

/**
 * Per-line block-content starts for `nodeNames`, as `lineNumber -> local offset`.
 *
 * A block marker does not have to be followed by a space (`>#tag` is a
 * blockquote containing a tag), and markdown-it handles that by parsing each
 * block's *content* as inline text 鈥?its `state.pos === 0` is the content
 * start, not the line start. The Live scan is line based, so it needs the same
 * information from the Lezer tree: the end of the markers that own the prefix
 * (`QuoteMark`, `ListMark`) is where the block content begins.
 */
function blockContentStartsByLine(state, nodeNames, from, to) {
  const byLine = new Map();
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (!nodeNames.has(node.name)) return true;
      const line = state.doc.lineAt(Math.min(node.to, state.doc.length));
      const local = node.to - line.from;
      const previous = byLine.get(line.number);
      if (previous == null || local > previous) byLine.set(line.number, local);
      return true;
    },
  });
  return byLine;
}

/**
 * Regex candidate ranges for `[from, to]` that survive the syntax-context
 * filter. Scans whole lines inside the window so lookbehind anchors behave the
 * same as a document scan, and never walks the full document.
 *
 * `options.excludedNodes` widens the literal-range filter (see
 * `excludedSyntaxRanges`); `options.boundaryNodes` hands the `locateLine`
 * callback the line's block-content start as `{ boundaryOffsets }`, which is
 * how the shared tag lexer sees the same boundary markdown-it sees.
 */
export function collectMatchRanges(state, pattern, from = 0, to = state.doc.length, options = {}) {
  const excluded = excludedSyntaxRanges(state, from, to, options.excludedNodes || null);
  const locateLine = typeof pattern === "function" ? pattern : options.locateLine;
  const regexp = typeof locateLine === "function" ? null : globalPattern(pattern);
  const boundaryNodes = options.boundaryNodes ? new Set(options.boundaryNodes) : null;
  const blockStarts = boundaryNodes ? blockContentStartsByLine(state, boundaryNodes, from, to) : null;
  const found = [];
  const firstLine = state.doc.lineAt(Math.max(0, from));
  const lastLine = state.doc.lineAt(Math.min(state.doc.length, to));
  for (let number = firstLine.number; number <= lastLine.number; number += 1) {
    const line = state.doc.line(number);
    const context = blockStarts ? { boundaryOffsets: [blockStarts.get(number)].filter((value) => value > 0) } : undefined;
    const matches = typeof locateLine === "function"
      ? locateLine(line.text, context).map((span) => ({ index: span.from, text: line.text.slice(span.from, span.to) }))
      : [...line.text.matchAll(regexp)].map((match) => ({ index: match.index, text: match[0] }));
    for (const match of matches) {
      const matchFrom = line.from + match.index;
      const matchTo = matchFrom + match.text.length;
      if (matchTo <= from || matchFrom >= to) continue;
      if (rangeIsExcluded(excluded, matchFrom, matchTo)) continue;
      const trimStart = trimLength(options.trimStart, match.text);
      const trimEnd = trimLength(options.trimEnd, match.text);
      const decoratedFrom = Math.min(matchTo, matchFrom + trimStart);
      const decoratedTo = Math.max(decoratedFrom, matchTo - trimEnd);
      // The raw matched text travels with the range so a caller can derive
      // per-match presentation (the highlight colour) without re-reading the doc.
      if (decoratedTo > decoratedFrom) found.push({ from: decoratedFrom, to: decoratedTo, text: match.text });
    }
  }
  return found;
}

function decorationsFor(view, pattern, mark, options) {
  const ranges = [];
  // A per-match class hook (highlight colours) needs one mark per class; the
  // cache keeps the common case at a single mark object.
  const classMarks = new Map();
  const markFor = (text) => {
    if (typeof options.classFor !== "function") return mark;
    const extra = options.classFor(text ?? "") || "";
    if (!extra) return mark;
    let cached = classMarks.get(extra);
    if (!cached) {
      cached = Decoration.mark({ class: `${mark.spec.class ?? ""} ${extra}`.trim() });
      classMarks.set(extra, cached);
    }
    return cached;
  };
  for (const visible of view.visibleRanges) {
    for (const match of collectMatchRanges(view.state, pattern, visible.from, visible.to, options)) {
      ranges.push(markFor(match.text).range(match.from, match.to));
    }
  }
  return Decoration.set(ranges, true);
}

/**
 * Syntax-aware replacement for a bare `MatchDecorator`: the regex still finds
 * candidates, but they are filtered through the Lezer markdown syntax tree so
 * code, frontmatter and HTML keep their literal text undecorated. Decorations
 * are limited to visible ranges; the document is never scanned end to end.
 */
export function decorated(pattern, className, options = {}) {
  const mark = Decoration.mark({ class: className });
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = decorationsFor(view, pattern, mark, options);
      }

      update(update) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = decorationsFor(update.view, pattern, mark, options);
        }
      }
    },
    { decorations: (instance) => instance.decorations },
  );
}
