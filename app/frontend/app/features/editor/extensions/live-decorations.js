import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { attachInteractionHandlers, interactionField, isInteractionFrozen } from "../interaction.js";
import { liveBlockField } from "../live-preview.js";
import { frontmatterEndOffset } from "../markdown-model.js";
import { addObsidianSemanticClass } from "./theme-semantics.js";
import { splitMarksAroundExclusive } from "./decoration-ranges.js";
import { readHighlightColour } from "../../document/highlight-colours.js";
import { excludedSyntaxRanges, locateHighlightSpans } from "./match-decorations.js";
import { TaskCheckboxWidget, taskAtomicRangesFromDecorations, taskCaretAfterToggle } from "./task-marker.js";
import { decorateFootnoteSurface } from "./block-footnote.js";
import { WikiEmbedWidget, isWikiEmbed, wikiLinkLabel } from "./block-embed.js";
import { CodeBlockFlairWidget, FLAIR_HOST_CLASS, codeBlockBody, codeBlockFlairLabel } from "./code-block-flair.js";
export { TaskCheckboxWidget, taskAtomicRangesFromDecorations, taskCaretAfterToggle } from "./task-marker.js";

function selectionReveals(state, from, to) {
  return state.selection.ranges.some((range) => {
    const lo = Math.min(range.from, range.to);
    const hi = Math.max(range.from, range.to);
    if (lo === hi) return lo >= from && lo <= to;
    return lo < to && hi > from;
  });
}

// Half-open semantic ranges keep the next element from activating the previous one.
function selectionActivatesContext(state, from, to) {
  return state.selection.ranges.some((range) => {
    const lo = Math.min(range.from, range.to);
    const hi = Math.max(range.from, range.to);
    if (lo === hi) return lo >= from && (lo < to || (to === state.doc.length && lo === to));
    return lo < to && hi > from;
  });
}

function listMarkerChars(mark) {
  return Math.max(1, String(mark || "").trim().length);
}

/**
 * Obsidian's completed-task state surface for one Live task line. Obsidian
 * Desktop sets both `data-task="x"` and the `is-checked` class on the line
 * element (the same class Reader's completed `li` carries), so a Vault theme can
 * key on either shape; unchecked lines keep `data-task=" "` and never carry
 * `is-checked`. The class is recomputed from the document on every decoration
 * rebuild, so toggling the checkbox adds or removes it immediately.
 */
export function taskLineState(marker) {
  const checked = /x/i.test(marker);
  return {
    checked,
    className: checked ? "HyperMD-task-line is-checked" : "HyperMD-task-line",
    attributes: { "data-task": checked ? "x" : " " },
  };
}

const HIDDEN_MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrongMark",
  "StrikethroughMark",
  "CodeMark",
  "CodeInfo",
  "LinkMark",
  "QuoteMark",
  "HighlightMark",
]);

// #484: a `URL` node is chrome only when it is a link or image *destination*. Obsidian's own
// grammar for this is "the target inside `[text](target)` / `![alt](src)`"; everywhere else a
// `URL` node IS user-visible text and hiding it deletes content:
//   - GFM literal autolinks (`see http://x.com/#frag`) hang the node off `Paragraph`,
//   - angle autolinks (`<https://x.com/#frag>`) off `Autolink`,
//   - the Lezer `URL` under `LinkTitle` never occurs (it is a sibling), so the rule is a positive
//     list rather than "everything except Autolink" 鈥?an unknown parent must fail towards
//     keeping the text.
const LINK_TARGET_PARENTS = new Set(["Link", "Image"]);

/**
 * #484: decide whether a syntax node is *chrome* 鈥?safe to replace with nothing while the
 * caret is elsewhere. `HIDDEN_MARKS` alone cannot answer this for `URL`: in `[text](target)`
 * the URL node is the link target (chrome), but inside an `<https://example.com>` autolink
 * the very same node name *is* the visible text, so hiding it deletes content the user typed.
 * Kept pure and exported so the decision is unit-testable next to the browser scenario.
 */
export function isHiddenIdleMark(nodeName, parentName) {
  if (nodeName === "URL") return LINK_TARGET_PARENTS.has(parentName);
  return HIDDEN_MARKS.has(nodeName);
}

// #484: the two node kinds whose chrome is only *part* of the node, so they need the node's first
// character to tell a backslash hard break from a two-space one.
const ESCAPE_LIKE = new Set(["Escape", "HardBreak"]);

/**
 * The exact source range idle Live Preview may replace with nothing for one syntax node,
 * or `null` when the node is not chrome.
 *
 * Two chrome kinds hide only part of their node, because the rest of it is content:
 *   - `Escape` (`\#`, `\*`) covers the backslash *and* the escaped character; hiding the
 *     whole node would delete the character the user typed, so only the backslash goes.
 *   - `HardBreak` covers the backslash plus the newline, and the two-space spelling
 *     (`"  \n"`) covers two spaces plus the newline. Hiding the newline would destroy the line
 *     structure, and only the backslash spelling has a visible marker at all, so `firstChar`
 *     decides: nothing is hidden for a two-space break.
 * Both are `local`: they reveal from their own range (and the line holding them), not from the
 * whole directive/paragraph context the other marks use.
 */
export function idleChromeRange(nodeName, nodeFrom, nodeTo, parentName, firstChar = "") {
  if (ESCAPE_LIKE.has(nodeName)) {
    if (firstChar !== "\\") return null;
    return { from: nodeFrom, to: Math.min(nodeTo, nodeFrom + 1), local: true };
  }
  if (!isHiddenIdleMark(nodeName, parentName)) return null;
  return { from: nodeFrom, to: nodeTo, local: false };
}

// `==highlight==` is the one piece of source chrome the syntax tree does not model at all, so
// its delimiters are located textually (the same `locateHighlightSpans` rule the paint path
// trims with) and filtered against the same exclusions (frontmatter, code, HTML).
/**
 * Ranges of highlight spans that are real source chrome, each with the whole `=`
 * run on both sides (two or more) that idle Live Preview may hide.
 */
export function highlightSpans(state, from = 0, to = state.doc.length, excluded = []) {
  const spans = [];
  const start = Math.max(0, from);
  const endLimit = Math.min(state.doc.length, Math.max(from, to));
  const firstLine = state.doc.lineAt(start);
  const lastLine = state.doc.lineAt(endLimit);
  for (let number = firstLine.number; number <= lastLine.number; number += 1) {
    const line = state.doc.line(number);
    for (const span of locateHighlightSpans(line.text)) {
      const spanFrom = line.from + span.from;
      const spanTo = line.from + span.to;
      if (spanTo <= from || spanFrom >= to) continue;
      if (excluded.some((range) => range.from < spanTo && range.to > spanFrom)) continue;
      const contentFrom = spanFrom + span.openLen;
      const contentEnd = spanTo - span.closeLen;
      // Line-relative content bounds: `openLen`/`closeLen` are lengths, `span.from`
      // is where the `=` run starts, so the emoji (if any) sits right after it.
      const { length: emojiLength } = readHighlightColour(line.text.slice(span.from + span.openLen, span.to - span.closeLen));
      spans.push({
        from: spanFrom,
        to: spanTo,
        open: { from: spanFrom, to: spanFrom + span.openLen },
        close: { from: spanTo - span.closeLen, to: spanTo },
        // 1.14 colours: a leading emoji is markup, not content, so it hides with
        // the delimiters (and the paint path starts after it).
        emoji: emojiLength ? { from: contentFrom, to: Math.min(contentEnd, contentFrom + emojiLength) } : null,
      });
    }
  }
  return spans;
}

function collectReplacedRanges(state) {
  const ranges = [];
  const blocks = state.field(liveBlockField, false);
  if (!blocks) return ranges;
  blocks.between(0, state.doc.length, (from, to) => {
    ranges.push({ from, to });
  });
  return ranges;
}

function overlapsReplaced(replaced, from, to) {
  // Block ranges are ordered and disjoint. Avoid N source nodes 脳 M blocks.
  let low = 0, high = replaced.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (replaced[mid].to <= from) low = mid + 1;
    else high = mid;
  }
  return low < replaced.length && replaced[low].from < to;
}

function isExclusiveDecoration(range) {
  const spec = range.value.spec || {};
  return Boolean(spec.widget || spec.block || (!spec.class && !spec.attributes && spec.line == null));
}

function safeDecorationSet(ranges) {
  const points = [];
  const exclusive = [];
  const marks = [];
  for (const range of ranges) {
    if (range.from === range.to) points.push(range);
    else if (isExclusiveDecoration(range)) exclusive.push(range);
    else marks.push(range);
  }
  // Replacements/widgets own their source ranges and remain mutually
  // exclusive. Semantic marks are deliberately allowed to overlap each
  // other (for example inline code inside a table cell, or strong inside a
  // quote); CodeMirror splits/nests mark ranges correctly.
  exclusive.sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from));
  const keptExclusive = [];
  for (const range of exclusive) {
    if (keptExclusive.some((prev) => range.from < prev.to && range.to > prev.from)) continue;
    keptExclusive.push(range);
  }
  const keptMarks = splitMarksAroundExclusive(marks, keptExclusive);
  const all = [...points, ...keptExclusive, ...keptMarks];
  all.sort((a, b) => a.from - b.from || (a.value.startSide - b.value.startSide));
  return Decoration.set(all, true);
}

function decorateLines(view, from, to, className, ranges, attributes = undefined) {
  const end = Math.max(from, to - (to > from ? 1 : 0));
  let pos = from;
  while (pos <= end) {
    const line = view.state.doc.lineAt(pos);
    ranges.push(Decoration.line({ class: className, attributes }).range(line.from));
    if (line.to >= end) break;
    pos = line.to + 1;
  }
}

function collectFenceMarks(state, node) {
  const marks = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeMark") marks.push({ from: child.from, to: child.to });
  }
  return marks;
}

class ListMarkWidget extends WidgetType {
  constructor(mark) {
    super();
    this.mark = mark;
  }
  eq(other) { return other.mark === this.mark; }
  toDOM() {
    const el = document.createElement("span");
    const bullet = !/^\d/.test(this.mark);
    el.className = bullet
      ? "cm-formatting-list cm-formatting-list-ul cm-live-list-mark cm-live-list-bullet"
      : "cm-formatting-list cm-formatting-list-ol cm-live-list-mark";
    el.style.setProperty("--list-marker-chars", String(listMarkerChars(this.mark)));
    // Keep the original source marker in layout so idle and source-revealed
    // states have exactly the same advance width. The unordered bullet is
    // painted by CSS on top of this transparent source glyph.
    el.textContent = this.mark;
    return el;
  }
  ignoreEvent() { return false; }
}

class WikiLinkWidget extends WidgetType {
  constructor(raw) {
    super();
    this.raw = raw;
    this.label = wikiLinkLabel(raw);
  }
  eq(other) { return other.raw === this.raw; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-hmd-internal-link cm-obsidian-link cm-live-wiki-link";
    el.textContent = this.label;
    return el;
  }
  ignoreEvent() { return false; }
}

function decorateWikiLinks(view, ranges, replaced, fmEnd) {
  const from = Math.max(view.viewport.from, fmEnd);
  const to = view.viewport.to;
  if (from >= to) return;
  const text = view.state.doc.sliceString(from, to);
  const pattern = /!?\[\[[^\]\n]+\]\]/g;
  let match;
  while ((match = pattern.exec(text))) {
    const start = from + match.index;
    const end = start + match[0].length;
    if (overlapsReplaced(replaced, start, end)) continue;
    if (!view.state.readOnly && selectionReveals(view.state, start, end)) {
      ranges.push(Decoration.mark({
        class: "cm-hmd-internal-link cm-obsidian-link cm-live-wiki-link",
      }).range(start, end));
      continue;
    }
    // `![[鈥]` is an embed, not a link: it keeps the in-place wiki chrome
    // (LP-08) while adding Desktop's canonical embed container faces.
    if (isWikiEmbed(match[0])) {
      ranges.push(Decoration.replace({ widget: new WikiEmbedWidget(match[0]) }).range(start, end));
      continue;
    }
    ranges.push(Decoration.replace({ widget: new WikiLinkWidget(match[0]) }).range(start, end));
  }
}

function buildLiveDecorations(view) {
  const ranges = [];
  const semanticThemeRanges = new Set();
  // Ranges whose text must keep its source form (fences / indented code); the
  // footnote surface skips them so a `[^x]:` example inside code stays source.
  const codeRanges = [];
  const replaced = collectReplacedRanges(view.state);
  const fmEnd = frontmatterEndOffset(view.state.doc)
    || (view.state.doc.line(1).text === "---" ? view.state.doc.length : 0);
  if (view.viewport.from < fmEnd) decorateLines(view, view.viewport.from, Math.min(fmEnd, view.viewport.to), "cm-live-frontmatter", ranges);

  syntaxTree(view.state).iterate({
    // Only inline/line chrome is viewport scoped; block replacements stay in
    // the direct StateField over the complete syntax tree.
    from: view.viewport.from,
    to: view.viewport.to,
    enter(node) {
      if (node.name !== "Document" && node.from < fmEnd) return false;
      if (overlapsReplaced(replaced, node.from, node.to) && node.name !== "Document") {
        if (node.from >= fmEnd) return false;
      }
      // Table Surface v2 owns the complete GFM Table range as a block widget.
      // Never apply line/mark decorations inside it: source chrome must not
      // participate in the table's visual layout.
      if (node.name === "Table") return false;
      addObsidianSemanticClass(ranges, node, semanticThemeRanges);

      const heading = /^ATXHeading([1-6])$/.exec(node.name);
      if (heading) {
        ranges.push(Decoration.line({ class: `cm-live-heading cm-live-h${heading[1]} HyperMD-header HyperMD-header-${heading[1]}` }).range(view.state.doc.lineAt(node.from).from));
      }
      if (node.name === "Blockquote") {
        decorateLines(view, node.from, node.to, "cm-live-quote HyperMD-quote", ranges);
      }
      if (node.name === "FencedCode") {
        codeRanges.push({ from: node.from, to: node.to });
        const fenceMarks = collectFenceMarks(view.state, node.node);
        const blockActive = !view.state.readOnly && selectionReveals(view.state, node.from, node.to);
        const startLine = view.state.doc.lineAt(node.from).number;
        const endLine = view.state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
        const fenceLineNumbers = new Set(
          fenceMarks.map((mark) => view.state.doc.lineAt(mark.from).number),
        );
        const hasCloseFence = fenceMarks.length >= 2;
        // #482 third slice: the language label lives in the top-right corner of an
        // idle fence (Desktop creates its flair widget only when the block is not
        // being edited). The label is "" for languages Web does not know, and that
        // is meaningful — Desktop paints the copy icon for those fences.
        const flairLabel = codeBlockFlairLabel(view.state, node.node);
        const flairCode = blockActive ? "" : codeBlockBody(view.state, node.node);

        for (let number = startLine; number <= endLine; number += 1) {
          const line = view.state.doc.line(number);
          const isFenceLine = fenceLineNumbers.has(number);
          if (isFenceLine) {
            const isOpenFence = number === startLine;
            if (isOpenFence) {
              ranges.push(Decoration.line({
                class: `cm-live-code-lang-line HyperMD-codeblock HyperMD-codeblock-begin${blockActive ? "" : ` ${FLAIR_HOST_CLASS}`}`,
              }).range(line.from));
              if (!blockActive) {
                ranges.push(Decoration.widget({
                  widget: new CodeBlockFlairWidget(flairLabel, flairCode),
                  side: 1,
                }).range(line.to));
              }
            } else {
              ranges.push(Decoration.line({ class: "cm-live-code-fence-line HyperMD-codeblock HyperMD-codeblock-end" }).range(line.from));
            }
            if (!blockActive && line.to > line.from) {
              ranges.push(Decoration.replace({}).range(line.from, line.to));
            }
            continue;
          }
          if (startLine === endLine) {
            ranges.push(Decoration.line({ class: "cm-live-code cm-live-code-start cm-live-code-end" }).range(line.from));
            continue;
          }
          const parts = ["cm-live-code", "cm-live-code-body", "HyperMD-codeblock"];
          const bodyStart = startLine + (fenceLineNumbers.has(startLine) ? 1 : 0);
          const bodyEnd = hasCloseFence ? endLine - 1 : endLine;
          if (number === bodyStart) {
            parts.push("cm-live-code-start");
            if (fenceLineNumbers.has(startLine)) parts.push("cm-live-code-below-lang");
          }
          if (number === bodyEnd) {
            parts.push("cm-live-code-end");
            if (hasCloseFence) parts.push("cm-live-code-above-fence");
          }
          ranges.push(Decoration.line({ class: parts.join(" ") }).range(line.from));
        }
        return false;
      }
      if (node.name === "CodeBlock") {
        codeRanges.push({ from: node.from, to: node.to });
        const startLine = view.state.doc.lineAt(node.from).number;
        const endLine = view.state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
        for (let number = startLine; number <= endLine; number += 1) {
          const line = view.state.doc.line(number);
          const parts = ["cm-live-code", "cm-live-code-indented", "HyperMD-codeblock"];
          if (number === startLine) parts.push("cm-live-code-start");
          if (number === endLine) parts.push("cm-live-code-end");
          if (number !== startLine && number !== endLine) parts.push("cm-live-code-body");
          ranges.push(Decoration.line({ class: parts.join(" ") }).range(line.from));
        }
        return false;
      }
      if (node.name === "HorizontalRule") {
        const line = view.state.doc.lineAt(node.from);
        const onRule = !view.state.readOnly && selectionReveals(view.state, line.from, line.to);
        ranges.push(Decoration.line({
          class: onRule ? "cm-live-hr cm-live-hr-active HyperMD-hr" : "cm-live-hr HyperMD-hr",
        }).range(line.from));
        return false;
      }
      if (node.name === "ListItem") {
        decorateLines(view, node.from, node.to, "HyperMD-list-line", ranges);
      }
      if (node.name === "TaskMarker") {
        const marker = view.state.sliceDoc(node.from, node.to);
        const taskLine = view.state.doc.lineAt(node.from);
        const taskState = taskLineState(marker);
        ranges.push(Decoration.line({
          class: taskState.className, attributes: taskState.attributes,
        }).range(taskLine.from));
        ranges.push(Decoration.replace({
          widget: new TaskCheckboxWidget(node.from, node.to, taskState.checked),
        }).range(node.from, node.to));
        return false;
      }
      if (node.name === "ListMark") {
        if (overlapsReplaced(replaced, node.from, node.to)) return;
        const mark = view.state.sliceDoc(node.from, node.to);
        const context = node.node.parent || node.node;
        // Reveal list source only when the selection is on the marker or its
        // single following source-space. Editing elsewhere in the list item
        // keeps the semantic bullet stable instead of flashing raw Markdown.
        const active = !view.state.readOnly
          && selectionReveals(view.state, node.from, Math.min(context.to, node.to + 1));
        if (!active) {
          ranges.push(Decoration.replace({
            widget: new ListMarkWidget(mark),
          }).range(node.from, node.to));
        } else {
          // Reveal the editable source marker without dropping its semantic
          // typography/width. Active state adds chrome; it does not reset style.
          ranges.push(Decoration.mark({
            class: `cm-formatting-list ${/^\d/.test(mark) ? "cm-formatting-list-ol" : "cm-formatting-list-ul"} cm-live-list-mark cm-live-list-source`,
            attributes: { style: `--list-marker-chars:${listMarkerChars(mark)}` },
          }).range(node.from, node.to));
        }
        return;
      }
      if (node.name === "InlineCode") {
        let innerFrom = node.from;
        let innerTo = node.to;
        for (let child = node.node.firstChild; child; child = child.nextSibling) {
          if (child.name !== "CodeMark") continue;
          if (child.from === node.from) innerFrom = child.to;
          if (child.to === node.to) innerTo = child.from;
        }
        if (innerTo > innerFrom) {
          const insideTableCell = node.node.parent?.name === "TableCell";
          // In a table cell, the InlineCode and TableCell ranges can coincide.
          // Marking the full source range would let CodeMirror coalesce the two
          // decorations, making the inline-code background fill the whole fixed
          // cell box. Limit the chip paint to the visible code content there.
          // Outside tables, keep the historical full-range chip so hidden
          // backticks continue to reserve stable width during editing.
          ranges.push(Decoration.mark({
            class: "cm-inline-code cm-live-inline-code-content cm-live-inline-code",
          }).range(insideTableCell ? innerFrom : node.from, insideTableCell ? innerTo : node.to));
        }
      }
      const context = node.node.parent || node.node;
      const chrome = idleChromeRange(
        node.name,
        node.from,
        node.to,
        context.name,
        ESCAPE_LIKE.has(node.name) ? view.state.sliceDoc(node.from, node.from + 1) : "",
      );
      if (!chrome) return;
      if (overlapsReplaced(replaced, context.from, context.to)) return;
      // An escape or a hard break reveals from its own line: Desktop shows the `\` again as soon
      // as the caret is on that line, and never hides it while the caret is on it.
      const localLine = chrome.local ? view.state.doc.lineAt(chrome.from) : null;
      const active = !view.state.readOnly && (localLine
        ? selectionReveals(view.state, localLine.from, localLine.to)
        : selectionActivatesContext(view.state, context.from, context.to));
      if (!active) {
        if (node.name === "CodeMark" && context.name === "InlineCode") {
          ranges.push(Decoration.mark({ class: "cm-live-source-mark-hidden" }).range(chrome.from, chrome.to));
        } else {
          ranges.push(Decoration.replace({}).range(chrome.from, chrome.to));
        }
      }
    },
  });
  // #484: `==highlight==` delimiters are chrome, but they are not syntax nodes in this parser
  // (there is no `HighlightMark`), so `HIDDEN_MARKS` never sees them and idles as literal text.
  // Hide the whole `=` run on each side 鈥?the same characters the highlight paint trims 鈥?and
  // bring them back when the caret is inside the span, like every other source mark.
  //
  // The `excluded` ranges are viewport-derived, which raises an obvious question: a fenced block
  // that starts above the viewport could be cropped, and a `==` inside it would then be hidden 鈥?  // exactly the class of content loss this issue is about. It is safe because
  // `excludedSyntaxRanges()` -> `syntaxScanRange()` widens the scan to the top-level nodes that
  // *intersect* the viewport, so a fence opened above the viewport is still covered whole.
  // (Verified by the cross-site check on 2026-10-10; keep that widening if this code changes.)
  //
  // A span that wraps across lines is left alone (`\n` ends the scan), because a hidden
  // multi-line delimiter would be indistinguishable from lost text. A single `=` inside
  // the content stays (`==a=b==`). A closing run of four or more splits into two spans
  // when the remainder opens another one (`==x====y==`). `====a====` uses the same
  // whole-run rule (鎺ㄥ緱椤癸紝寰呯湡鍊? no owner screenshot).
  const excludedRanges = excludedSyntaxRanges(view.state, view.viewport.from, view.viewport.to);
  for (const span of highlightSpans(view.state, view.viewport.from, view.viewport.to, excludedRanges)) {
    if (overlapsReplaced(replaced, span.from, span.to)) continue;
    if (selectionReveals(view.state, span.from, span.to)) continue;
    ranges.push(Decoration.replace({}).range(span.open.from, span.open.to));
    ranges.push(Decoration.replace({}).range(span.close.from, span.close.to));
    if (span.emoji) ranges.push(Decoration.replace({}).range(span.emoji.from, span.emoji.to));
  }
  decorateFootnoteSurface(view.state, ranges, codeRanges, view.viewport);
  decorateWikiLinks(view, ranges, replaced, fmEnd);
  const decorations = safeDecorationSet(ranges);
  // Derive atomicRanges from the rendered decoration set.
  return {
    decorations,
    atomicRanges: taskAtomicRangesFromDecorations(decorations, view.state.doc.length),
  };
}

export const livePreview = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.setDecorations(buildLiveDecorations(view));
    this.detachInteraction = attachInteractionHandlers(view);
  }

  setDecorations(built) {
    this.decorations = built.decorations;
    this.atomicRanges = built.atomicRanges;
  }

  update(update) {
    this.view = update.view;
    const frozen = isInteractionFrozen(update.state);
    if (frozen) {
      if (update.docChanged) {
        this.decorations = this.decorations.map(update.changes);
        this.atomicRanges = this.atomicRanges.map(update.changes);
      }
      return;
    }
    const interactionTouched = update.startState.field(interactionField, false) !== update.state.field(interactionField, false);
    const treeChanged = syntaxTree(update.state) !== syntaxTree(update.startState);
    if (update.docChanged || update.selectionSet || update.viewportChanged || interactionTouched || treeChanged) {
      this.setDecorations(buildLiveDecorations(update.view));
    }
  }

  destroy() {
    this.detachInteraction?.();
  }
}, {
  decorations: (instance) => instance.decorations,
  provide: (plugin) => EditorView.atomicRanges.of(
    (view) => view.plugin(plugin)?.atomicRanges ?? Decoration.none,
  ),
});
