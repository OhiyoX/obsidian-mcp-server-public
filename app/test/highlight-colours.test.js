// Obsidian 1.14 coloured highlights (`==🔴text==`), both hosts.
//
// Reading: the emoji is stripped from the mark and becomes `data-highlight`.
// Live Preview: the same table drives `highlightTrimStart` (so the paint and the
// chrome-hiding pass start after the emoji) and `classFor` (so the mark carries
// `cm-highlight-<colour>`), and `highlightSpans` reports the emoji as chrome.
//
// The table itself is transcribed from the 1.14.4 bundle, so these cases pin the
// whole observable contract: which characters are colours, what happens to an
// unknown emoji, and what an emoji that is not first does.

import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import MarkdownIt from "markdown-it";
import mark from "markdown-it-mark";

import {
  HIGHLIGHT_COLOR_EMOJI,
  configureHighlightColours,

  highlightColourName,
  readHighlightColour,
} from "../frontend/app/features/document/highlight-colours.js";

import { highlightColourOf, highlightedColourClass, highlightTrimStart } from "../frontend/app/features/editor/extensions/match-decorations.js";
import { highlightSpans } from "../frontend/app/features/editor/extensions/live-decorations.js";

const COLOURS = ["red", "orange", "yellow", "green", "blue", "purple"];

const md = new MarkdownIt({ html: false }).use(mark);
configureHighlightColours(md);

const render = (source) => md.render(source).trim();

// --- the table itself -----------------------------------------------------------------

test("the colour table is exactly the twelve desktop emoji, in six colours", () => {
  assert.equal(HIGHLIGHT_COLOR_EMOJI.size, 12);
  const byColour = new Map();
  for (const colour of HIGHLIGHT_COLOR_EMOJI.values()) byColour.set(colour, (byColour.get(colour) ?? 0) + 1);
  assert.deepEqual([...byColour.keys()].sort(), [...COLOURS].sort());
  for (const [, count] of byColour) assert.equal(count, 2, "each colour has a circle and a square emoji");
});

test("readHighlightColour reads one leading code point only", () => {
  assert.deepEqual(readHighlightColour("🔴red"), { colour: "red", length: 2 });
  assert.deepEqual(readHighlightColour("🟪purple"), { colour: "purple", length: 2 });
  assert.deepEqual(readHighlightColour("plain"), { colour: "", length: 0 });
  assert.deepEqual(readHighlightColour(""), { colour: "", length: 0 });
  assert.deepEqual(readHighlightColour(undefined), { colour: "", length: 0 });
  // Not first ⇒ not a colour; the emoji stays content.
  assert.deepEqual(readHighlightColour("a🔴"), { colour: "", length: 0 });
  // An emoji outside the table is not a colour.
  assert.deepEqual(readHighlightColour("⚫black"), { colour: "", length: 0 });
  assert.equal(highlightColourName("🟢ok"), "green");
});

// --- Reading --------------------------------------------------------------------------

test("Reading: every colour emoji becomes data-highlight and leaves the content", () => {
  for (const [emoji, colour] of HIGHLIGHT_COLOR_EMOJI) {
    const html = render(`==${emoji}text==`);
    assert.equal(html, `<p><mark data-highlight="${colour}">text</mark></p>`, `${emoji} must paint ${colour} and drop the emoji`);
  }
});

test("Reading: uncoloured, unknown and non-leading emoji stay plain", () => {
  assert.equal(render("==plain=="), "<p><mark>plain</mark></p>");
  assert.equal(render("==⚫text=="), "<p><mark>⚫text</mark></p>", "an emoji outside the table is content");
  assert.equal(render("==a🔴b=="), "<p><mark>a🔴b</mark></p>", "only a leading emoji is markup");
  // markdown-it-mark refuses a span whose content starts with a space, which is
  // desktop's own guard too (`!/\s/.test(src.charAt(2))`) — nothing to colour.
  assert.equal(render("== 🔴text=="), "<p>== 🔴text==</p>");
});

test("Reading: coloured and plain highlights coexist in one paragraph", () => {
  const html = render("==🔵blue== mid ==plain== and ==🟨yellow==");
  assert.equal(
    html,
    '<p><mark data-highlight="blue">blue</mark> mid <mark>plain</mark> and <mark data-highlight="yellow">yellow</mark></p>',
  );
});

test("Reading: the emoji is markup only inside a highlight", () => {
  assert.equal(render("🔴 outside"), "<p>🔴 outside</p>");
  assert.equal(render("`==🔴code==`"), "<p><code>==🔴code==</code></p>", "code spans keep their literal text");
});

// --- Live Preview ---------------------------------------------------------------------

test("Live: the paint and the hiding pass both start after the colour emoji", () => {
  assert.equal(highlightTrimStart("==🔴text=="), 2 + 2);
  assert.equal(highlightTrimStart("===🟥text==="), 3 + 2);
  assert.equal(highlightTrimStart("==text=="), 2, "no emoji keeps the historical trim");
  assert.equal(highlightTrimStart("== 🔴text=="), 2, "an emoji after whitespace is content");
  assert.equal(highlightColourOf("==🟪text=="), "purple");
  assert.equal(highlightColourOf("==text=="), "");
});

test("Live: the decoration class carries the colour", () => {
  assert.equal(highlightedColourClass("==🔴text=="), "cm-highlight-red");
  assert.equal(highlightedColourClass("==text=="), "");
  assert.equal(highlightedColourClass("==⚫text=="), "");
});

test("Live: highlightSpans reports the emoji as its own chrome range", () => {
  const state = EditorState.create({ doc: "==🔴red== and ==plain==\n" });
  const spans = highlightSpans(state, 0, state.doc.length, []);
  assert.equal(spans.length, 2);
  assert.deepEqual(spans[0].open, { from: 0, to: 2 });
  assert.deepEqual(spans[0].emoji, { from: 2, to: 4 }, "the emoji hides with the delimiters");
  assert.deepEqual(spans[0].close, { from: 7, to: 9 });
  assert.equal(state.sliceDoc(spans[0].emoji.from, spans[0].emoji.to), "🔴");
  assert.equal(spans[1].emoji, null, "an uncoloured span has no emoji chrome");
});

test("Live: an emoji-only highlight keeps a non-empty content range", () => {
  const state = EditorState.create({ doc: "==🔴==\n" });
  const spans = highlightSpans(state, 0, state.doc.length, []);
  // `==🔴==` is a 2-unit emoji between delimiters; the emoji range must not
  // swallow the closing run even if a caller passes a stale content end.
  for (const span of spans) {
    if (!span.emoji) continue;
    assert.ok(span.emoji.from >= span.open.to);
    assert.ok(span.emoji.to <= span.close.from);
  }
});
