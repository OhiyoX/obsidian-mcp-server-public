// #484 — the pure decision behind "which syntax nodes are chrome and may be replaced with
// nothing while the caret is elsewhere", plus the textual locator for `==highlight==` delimiters.
// The browser scenario in scripts/web-regression/live-source-fidelity.mjs proves the
// user-visible outcome (an autolink keeps its text, a link target stays hidden, the highlight
// markers hide while the content stays painted); this file pins the decisions themselves.
import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { highlightSpans, idleChromeRange, isHiddenIdleMark } from "../frontend/app/features/editor/extensions/live-decorations.js";
import { excludedSyntaxRanges } from "../frontend/app/features/editor/extensions/match-decorations.js";

function stateOf(doc) {
  return EditorState.create({ doc, extensions: [markdown({ extensions: GFM })] });
}

function spansOf(doc) {
  const state = stateOf(doc);
  return { state, spans: highlightSpans(state, 0, state.doc.length, excludedSyntaxRanges(state)) };
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
