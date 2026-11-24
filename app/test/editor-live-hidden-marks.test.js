// #484 — the pure decision behind "which syntax nodes are chrome and may be replaced with
// nothing while the caret is elsewhere", plus the textual locator for `==highlight==` delimiters.
// The browser scenario in scripts/web-regression/live-source-fidelity.mjs proves the
// user-visible outcome (an autolink keeps its text, a link target stays hidden, the highlight
// markers hide while the content stays painted); this file pins the decisions themselves.
import assert from "node:assert/strict";
import test from "node:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { GFM } from "@lezer/markdown";
import {
  blockMarkApplies,
  headingGateChar,
  headingLines,
  headingRevealEnd,
  highlightSpans,
  idleChromeRange,
  isHiddenIdleMark,
  selectionActivatesContext,
  setextUnderlineRow,
} from "../frontend/app/features/editor/extensions/live-decorations.js";
import { excludedSyntaxRanges } from "../frontend/app/features/editor/extensions/match-decorations.js";
import { addObsidianSemanticClass } from "../frontend/app/features/editor/extensions/theme-semantics.js";

function stateOf(doc) {
  return EditorState.create({ doc, extensions: [markdown({ extensions: GFM })] });
}

function spansOf(doc) {
  const state = stateOf(doc);
  return { state, spans: highlightSpans(state, 0, state.doc.length, excludedSyntaxRanges(state)) };
}

// #780: the heading surface plus the setext underline, read off the real parser tree.
function headingsOf(state, name) {
  const found = [];
  syntaxTree(state).iterate({ enter(node) { if (node.name === name) found.push(node.node); } });
  return found;
}

test("#484 an autolink's URL node is content, never chrome", () => {
  assert.equal(isHiddenIdleMark("URL", "Autolink"), false);
});

test("#484 a bare literal URL is content and must never be hidden", () => {
  // The reported input of #484 was `http://x.com/#frag` 鈥?a GFM literal autolink, whose `URL`
  // node hangs off `Paragraph` (lezer tree, measured), not off `Autolink`. Treating "URL is
  // chrome unless the parent is Autolink" therefore still deleted the very text the issue is
  // about; only a link/image destination may be hidden.
  assert.equal(isHiddenIdleMark("URL", "Paragraph"), false);
  assert.equal(isHiddenIdleMark("URL", "TableCell"), false);
  assert.equal(isHiddenIdleMark("URL", "Document"), false);
});

test("#484 a markdown link target is chrome and stays hideable", () => {
  assert.equal(isHiddenIdleMark("URL", "Link"), true);
  assert.equal(isHiddenIdleMark("URL", "Image"), true);
  // The `LinkMark` pair (`[`,`]`,`(`,`)`) and the surrounding chrome keep hiding.
  assert.equal(isHiddenIdleMark("LinkMark", "Link"), true);
  assert.equal(isHiddenIdleMark("LinkMark", "Autolink"), true);
});

test("#484 the other marks keep their existing behaviour", () => {
  assert.equal(isHiddenIdleMark("QuoteMark", "Blockquote"), true);
  assert.equal(isHiddenIdleMark("HeaderMark", "ATXHeading1"), true);
  assert.equal(isHiddenIdleMark("EmphasisMark", "Emphasis"), true);
  assert.equal(isHiddenIdleMark("StrikethroughMark", "Strikethrough"), true);
  assert.equal(isHiddenIdleMark("CodeMark", "InlineCode"), true);
});

test("#484 unknown nodes are never hidden (fail closed, no accidental deletion)", () => {
  assert.equal(isHiddenIdleMark("Paragraph", "Document"), false);
  assert.equal(isHiddenIdleMark("SomeFutureMark", "SomeFutureWrapper"), false);
  // Reverse control for the URL rule: it is a positive list of destination parents, so an
  // unknown parent keeps the text. `URL` under `LinkTitle` cannot occur (the tree has it as a
  // sibling inside `Link`); the assertion is kept as the fail-closed direction, replacing the
  // earlier `true` expectation that belonged to the "hide URL unless Autolink" rule #505 shipped
  // and #484 measured as still deleting bare URLs.
  assert.equal(isHiddenIdleMark("URL", "LinkTitle"), false);
  // ...and the URL rule must not leak into the other marks either way.
  assert.equal(isHiddenIdleMark("LinkMark", "Paragraph"), true);
});

test("#484 an escape hides only its backslash and keeps the escaped character", () => {
  // `\#escaped`: the node covers `\#`, the hidden range covers `\` alone, so `#escaped` stays.
  assert.deepEqual(idleChromeRange("Escape", 0, 2, "Paragraph", "\\"), { from: 0, to: 1, local: true });
  // `\*` before a letter is not an escape in CommonMark and produces no node; the pair that
  // does occur (`\*`, `\\`, `\_`, ...) always hides exactly one character.
  assert.deepEqual(idleChromeRange("Escape", 12, 14, "Paragraph", "\\"), { from: 12, to: 13, local: true });
  // Without the character the decision fails closed: nothing is hidden.
  assert.equal(idleChromeRange("Escape", 0, 2, "Paragraph"), null);
});

test("#484 a hard break hides only its backslash and keeps the line break", () => {
  // `line one\` + newline + `line two`: the node is `\` + `\n`; only the backslash is chrome,
  // the newline is document structure and must stay.
  assert.deepEqual(idleChromeRange("HardBreak", 8, 10, "Paragraph", "\\"), { from: 8, to: 9, local: true });
  // Never wider than the node it came from (a node without a newline cannot over-hide).
  assert.deepEqual(idleChromeRange("HardBreak", 8, 9, "Paragraph", "\\"), { from: 8, to: 9, local: true });
  // The two-space spelling (`"  \n"`, measured in the lezer tree) has no visible marker, so its
  // trailing spaces are not chrome and nothing is hidden 鈥?a hidden space would be a pointless
  // (if invisible) edit of content the user typed.
  assert.equal(idleChromeRange("HardBreak", 1, 4, "Paragraph", " "), null);
});

test("#484 the chrome decision keeps the old answer for every node that is not URL/Escape/HardBreak", () => {
  // Loop over the historical set so a future edit to `HIDDEN_MARKS` cannot silently drop one of
  // them, and assert the full-node range is used (only Escape/HardBreak hide partially).
  const names = ["HeaderMark", "EmphasisMark", "StrongMark", "StrikethroughMark", "CodeMark", "CodeInfo", "LinkMark", "QuoteMark", "HighlightMark"];
  for (const name of names) {
    assert.deepEqual(
      idleChromeRange(name, 5, 9, "Paragraph"),
      { from: 5, to: 9, local: false },
      `${name} must hide its whole node range`,
    );
  }
  assert.equal(idleChromeRange("Paragraph", 0, 5, "Document"), null);
  assert.equal(idleChromeRange("URL", 0, 5, "Paragraph"), null);
});

test("#484 highlight spans expose exactly the two == delimiter pairs", () => {
  const { state, spans } = spansOf("a ==hi== b\n");
  assert.equal(spans.length, 1);
  assert.equal(state.sliceDoc(spans[0].open.from, spans[0].open.to), "==");
  assert.equal(state.sliceDoc(spans[0].close.from, spans[0].close.to), "==");
  assert.equal(state.sliceDoc(spans[0].from, spans[0].to), "==hi==");
  // The content between the delimiters is never part of a hidden range.
  assert.equal(state.sliceDoc(spans[0].open.to, spans[0].close.from), "hi");
});

test("#484 highlight spans never cover code or frontmatter", () => {
  assert.equal(spansOf("`==hi==`\n").spans.length, 0, "inline code keeps its literal == characters");
  assert.equal(spansOf("```\n==hi==\n```\n").spans.length, 0, "a fenced block keeps its literal == characters");
  assert.equal(spansOf("---\n==hi==\n---\n\nbody\n").spans.length, 0, "frontmatter is not body chrome");
  assert.equal(spansOf("---\nt: 1\n---\n\nbody ==hi==\n").spans.length, 1, "the body span after frontmatter is still chrome");
});

test("#484 highlight spans keep working when the content contains a single =", () => {
  // Desktop Live Preview (owner screenshot, 2026-10-10) renders `==a=b==` as a highlight with the
  // markers hidden, so the span locator must accept a `=` inside the content.
  const { state, spans } = spansOf("x ==a=b== y\n");
  assert.equal(spans.length, 1);
  assert.equal(state.sliceDoc(spans[0].from, spans[0].to), "==a=b==");
  assert.equal(state.sliceDoc(spans[0].open.to, spans[0].close.from), "a=b");
});

test("#484 the widened span pattern does not invent spans", () => {
  assert.equal(spansOf("a ==== b\n").spans.length, 0, "an empty span stays literal");
  assert.equal(spansOf("a ===== b\n").spans.length, 0, "three pairs in a row are not one span");
  const adjacent = spansOf("a ==x====y== b\n");
  assert.deepEqual(
    adjacent.spans.map((span) => adjacent.state.sliceDoc(span.from, span.to)),
    ["==x==", "==y=="],
    "two adjacent spans are two highlights, not one merged span",
  );
  assert.equal(spansOf("a ==x==\nb ==y==\n").spans.length, 2, "spans never cross a line break");
  assert.equal(spansOf("a ==x\n==y== b\n").spans.length, 1, "a delimiter pair split by a newline is not a span");
});

test("#484 three or more adjacent = signs are delimiter runs on both sides", () => {
  // Owner truth (2026-10-10 screenshot): idle `===a===` shows only `a`. The whole run on
  // each side is chrome, in the hide path and in the paint path.
  const { state, spans } = spansOf("x ===a=== y\n");
  assert.equal(spans.length, 1);
  assert.equal(state.sliceDoc(spans[0].from, spans[0].to), "===a===");
  assert.equal(state.sliceDoc(spans[0].open.from, spans[0].open.to), "===");
  assert.equal(state.sliceDoc(spans[0].close.from, spans[0].close.to), "===");
  assert.equal(state.sliceDoc(spans[0].open.to, spans[0].close.from), "a");
});

test("#484 ====a==== follows the same variable-length rule (推得项，待真值)", () => {
  // No owner screenshot for four equals. The same rule as `===a===` hides both
  // runs and leaves `a`. This is inferred, not claimed as Desktop-verified.
  const { state, spans } = spansOf("x ====a==== y\n");
  assert.equal(spans.length, 1);
  assert.equal(state.sliceDoc(spans[0].from, spans[0].to), "====a====");
  assert.equal(state.sliceDoc(spans[0].open.from, spans[0].open.to), "====");
  assert.equal(state.sliceDoc(spans[0].close.from, spans[0].close.to), "====");
  assert.equal(state.sliceDoc(spans[0].open.to, spans[0].close.from), "a");
});

test("#484 only closed, non-empty spans count (no half-scanned delimiters)", () => {
  assert.equal(spansOf("a ==hi b\n").spans.length, 0, "an unclosed pair is plain text");
  assert.equal(spansOf("a ==== b\n").spans.length, 0, "an empty span is not a highlight");
  assert.equal(spansOf("a ==a== ==b== c\n").spans.length, 2);
});

test("an empty block mark stays the literal text typed until its construct applies", () => {
  // `###` with nothing after it is still being typed. The parser emits a HeaderMark for the
  // empty heading, so the mark's own line decides, and the marker stays visible text.
  assert.equal(blockMarkApplies("HeaderMark", ""), false);
  assert.equal(blockMarkApplies("HeaderMark", "\n"), false);
  assert.equal(blockMarkApplies("HeaderMark", " "), true);
  assert.equal(blockMarkApplies("HeaderMark", "\t"), true);
  // The same rule covers the other line marks that can be empty: `>` alone and `-` alone.
  assert.equal(blockMarkApplies("QuoteMark", ""), false);
  assert.equal(blockMarkApplies("ListMark", ""), false);
  // A mark with content keeps the parser's verdict: `>x` is a quote in the Reader too, and
  // Reader/Live parity outranks this rule.
  assert.equal(blockMarkApplies("QuoteMark", "x"), true);
  assert.equal(blockMarkApplies("ListMark", " "), true);
  // Marks this rule does not own are untouched.
  assert.equal(blockMarkApplies("EmphasisMark", ""), true);
  assert.equal(blockMarkApplies("StrongMark", ""), true);

  // Idle chrome follows the same answer, so `###` never disappears when the caret leaves.
  assert.equal(idleChromeRange("HeaderMark", 0, 3, "ATXHeading3", "", ""), null);
  assert.deepEqual(idleChromeRange("HeaderMark", 0, 3, "ATXHeading3", "", " "), { from: 0, to: 3, local: false });
  assert.equal(idleChromeRange("QuoteMark", 0, 1, "Blockquote", "", ""), null);
  assert.equal(idleChromeRange("ListMark", 0, 1, "ListItem", "", ""), null);
});

// #780: `Title` + `===` is a heading in the Reader, so Live Preview must give it the same
// heading surface as ATX. The parser makes this the awkward case: a setext `HeaderMark` is the
// UNDERLINE (not an opening marker), and the heading node covers the title lines plus that
// underline. Measured tree for "Title line\nsecond title line\n===\n\nNext\n":
// Document(0-39) > SetextHeading1(0-32) > HeaderMark(29-32), Paragraph(34-38).
test("#780 a setext heading paints its title lines and never the underline", () => {
  const state = stateOf("Title line\nsecond title line\n===\n\nNext\n");
  const [h1] = headingsOf(state, "SetextHeading1");
  assert.ok(h1, "the parser must produce a SetextHeading1");
  const lines = headingLines(state, h1);
  assert.deepEqual(lines.map((line) => line.from), [0, 11], "every title line, in source order");
  for (const line of lines) {
    assert.equal(line.className, "cm-live-heading cm-live-h1 HyperMD-header HyperMD-header-1");
  }
  const underlineFrom = state.doc.line(3).from;
  assert.ok(!lines.some((line) => line.from === underlineFrom), "the `===` line is chrome, not a title line");

  const [h2] = headingsOf(stateOf("Level two\n---\n\nNext\n"), "SetextHeading2");
  assert.deepEqual(headingLines(stateOf("Level two\n---\n\nNext\n"), h2), [
    { from: 0, className: "cm-live-heading cm-live-h2 HyperMD-header HyperMD-header-2" },
  ]);
});

test("#780 an ATX heading keeps its one line and its class surface", () => {
  const state = stateOf("# A ##\n");
  const [h1] = headingsOf(state, "ATXHeading1");
  assert.deepEqual(headingLines(state, h1), [
    { from: 0, className: "cm-live-heading cm-live-h1 HyperMD-header HyperMD-header-1" },
  ]);
  assert.deepEqual(headingLines(stateOf("plain paragraph\n"), { name: "Paragraph", from: 0, to: 15 }), []);
});

test("#780 a setext underline hides while idle and comes back at the caret", () => {
  const doc = "Title\n===\n\nNext\n";
  const state = stateOf(doc);
  const [heading] = headingsOf(state, "SetextHeading1");
  const [mark] = headingsOf(state, "HeaderMark");
  assert.equal(state.sliceDoc(mark.from, mark.to), "===", "the mark is the underline itself");
  // The underline ends at a line break, so its own next character must not read as "still being
  // typed"; the title's first character answers instead.
  assert.equal(headingGateChar(state, mark), "T");
  assert.deepEqual(
    idleChromeRange("HeaderMark", mark.from, mark.to, "SetextHeading1", "", headingGateChar(state, mark)),
    { from: mark.from, to: mark.to, local: false },
    "idle Live Preview hides the whole `===`",
  );

  // Reveal: the loop keeps the mark as soon as the caret is inside the heading it belongs to.
  const caret = EditorState.create({
    doc,
    selection: EditorSelection.cursor(2),
    extensions: [markdown({ extensions: GFM })],
  });
  assert.equal(selectionActivatesContext(caret, heading.from, heading.to), true);
  const away = EditorState.create({
    doc,
    selection: EditorSelection.cursor(doc.length),
    extensions: [markdown({ extensions: GFM })],
  });
  assert.equal(selectionActivatesContext(away, heading.from, heading.to), false, "caret after the heading keeps it hidden");

  // Control: the ATX opening mark keeps its own gate (`#` + space applies; `#tag` does not).
  const atx = stateOf("# A\n");
  assert.equal(headingGateChar(atx, headingsOf(atx, "HeaderMark")[0]), " ");
  const hashtag = stateOf("#tag\n");
  assert.equal(headingsOf(hashtag, "HeaderMark").length, 0, "#tag is not a heading at all");
});

// #785 (1): a hidden setext underline must not cost a row either. `setextUnderlineRow` is the
// row-half of the reveal the `HeaderMark` loop already answers for the characters, so the `===`
// and its row can never disagree. Style lives in `app.css`; this pins the decision.
test("#785 a setext underline row collapses while idle and returns at the caret", () => {
  const doc = "Title\n===\n\nNext\n";
  const underlined = doc.indexOf("===");
  const stateAt = (pos, { readOnly = false } = {}) => EditorState.create({
    doc,
    selection: EditorSelection.cursor(pos),
    extensions: [markdown({ extensions: GFM }), ...(readOnly ? [EditorState.readOnly.of(true)] : [])],
  });
  const headingOf = (state) => headingsOf(state, "SetextHeading1")[0];
  const rowOf = (state) => setextUnderlineRow(state, headingOf(state));
  const collapsed = { from: underlined, className: "cm-live-setext-underline-hidden" };

  // Idle: the caret is away, so the `===` is hidden and its line is the row that goes with it.
  assert.deepEqual(rowOf(stateAt(doc.length)), collapsed, "the idle underline line carries the class");
  // Caret in the heading (title, or the underline itself): the characters come back, so the row does.
  assert.equal(rowOf(stateAt(0)), null, "the caret at the heading start keeps the row");
  assert.equal(rowOf(stateAt(3)), null, "the caret in the title keeps the row");
  assert.equal(rowOf(stateAt(underlined)), null, "the caret on the underline keeps the row");
  // The underline's own end is INSIDE the heading. The half-open context end would report "away"
  // there, which parked the caret on a collapsed row with a 0px caret; `headingRevealEnd` widens
  // the setext range by that one position and the characters follow the same range.
  assert.equal(rowOf(stateAt(underlined + 3)), null, "the caret at the underline's end keeps the row");
  assert.equal(
    selectionActivatesContext(stateAt(underlined + 3), 0, headingRevealEnd(stateAt(0), headingOf(stateAt(0)))),
    true,
    "the same widened range reveals the `===`, so the row and the characters cannot disagree",
  );
  // Caret on the following blank line is outside the heading again.
  assert.deepEqual(rowOf(stateAt(underlined + 4)), collapsed, "the blank line after the heading is idle");
  // Read-only hides every mark, so it collapses too.
  assert.deepEqual(rowOf(stateAt(3, { readOnly: true })), collapsed, "a read-only view collapses the row");
  // ATX keeps its half-open end: a caret at `# A`'s line end still hides the `#`.
  const atx = stateOf("# A\n\nNext\n");
  const [atxHeading] = headingsOf(atx, "ATXHeading1");
  assert.equal(headingRevealEnd(atx, atxHeading), 3, "ATX is not widened");
  assert.equal(setextUnderlineRow(atx, atxHeading), null, "ATX has no underline line to collapse");
  assert.equal(setextUnderlineRow(stateOf("plain paragraph\n"), { name: "Paragraph", from: 0, to: 15 }), null);

  // A multi-line setext title collapses the UNDERLINE line, never a title line.
  const multiDoc = "Title line\nsecond title line\n===\n\nNext\n";
  const multi = EditorState.create({
    doc: multiDoc,
    selection: EditorSelection.cursor(multiDoc.length),
    extensions: [markdown({ extensions: GFM })],
  });
  assert.deepEqual(
    setextUnderlineRow(multi, headingOf(multi)),
    { from: multi.doc.line(3).from, className: "cm-live-setext-underline-hidden" },
  );
});

// #785 (3): the semantic `cm-header cm-header-N` surface. ATX has it; a setext heading did not,
// because its `HeaderMark` IS the underline (`node.to === context.to`), so the ATX span is empty.
function semanticMarksOf(doc) {
  const state = stateOf(doc);
  const ranges = [];
  const seen = new Set();
  syntaxTree(state).iterate({
    enter(node) { addObsidianSemanticClass(ranges, node, seen, { state }); },
  });
  return {
    state,
    marks: ranges.map((range) => ({
      from: range.from,
      to: range.to,
      text: state.sliceDoc(range.from, range.to),
      className: range.value.spec.class,
    })),
  };
}

const headersOf = (marks) => marks.filter((mark) => mark.className.startsWith("cm-header"));

test("#785 a setext title carries the semantic header class and the underline does not", () => {
  const h1 = semanticMarksOf("Title\n===\n\nNext\n");
  // Exactly the title text: never the `===` and never the line break before it.
  assert.deepEqual(headersOf(h1.marks), [
    { from: 0, to: 5, text: "Title", className: "cm-header cm-header-1" },
  ]);
  assert.equal(h1.state.sliceDoc(5, 9), "\n===", "the underline and its break stay outside");

  const h2 = semanticMarksOf("Level two\n---\n\nNext\n");
  assert.deepEqual(headersOf(h2.marks), [
    { from: 0, to: 9, text: "Level two", className: "cm-header cm-header-2" },
  ]);
  assert.equal(h2.state.sliceDoc(9, 13), "\n---", "the underline and its break stay outside");
});

test("#785 a multi-line setext title gets one span that stops at the last title character", () => {
  const { state, marks } = semanticMarksOf("Title line\nsecond title line\n===\n\nNext\n");
  assert.deepEqual(headersOf(marks), [{
    from: 0,
    to: 28,
    text: "Title line\nsecond title line",
    className: "cm-header cm-header-1",
  }]);
  assert.equal(state.sliceDoc(28, 32), "\n===", "the underline keeps no header class");
  assert.doesNotMatch(headersOf(marks)[0].text, /\s$/, "no trailing break or indent inside the span");

  // Trailing spaces (a hard break) and a tab are title-line end, not title text.
  for (const doc of ["Title  \n===\n", "Title\t\n===\n"]) {
    assert.deepEqual(headersOf(semanticMarksOf(doc).marks).map((mark) => mark.text), ["Title"], doc);
  }
});

test("#785 the ATX header span is unchanged", () => {
  const { marks } = semanticMarksOf("# A\nbody\n");
  // From the end of the `#` mark to the end of the heading: the old behaviour, byte for byte.
  assert.deepEqual(headersOf(marks), [
    { from: 1, to: 3, text: " A", className: "cm-header cm-header-1" },
  ]);
  assert.deepEqual(headersOf(semanticMarksOf("### Three ###\n").marks).map((mark) => mark.className), [
    "cm-header cm-header-3",
  ]);
});

test("#785 a heading that does not apply yet gets no header class either way", () => {
  const ranges = [];
  const state = stateOf("Title\n===\n");
  syntaxTree(state).iterate({
    enter(node) { addObsidianSemanticClass(ranges, node, new Set(), { headingApplies: false, state }); },
  });
  assert.equal(ranges.filter((range) => range.value.spec.class.startsWith("cm-header")).length, 0);
});
