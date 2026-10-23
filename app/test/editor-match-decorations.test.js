import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { collectMatchRanges, decorated, excludedSyntaxRanges, highlightTrimEnd, highlightTrimStart, locateHighlightSpans } from "../frontend/app/features/editor/extensions/match-decorations.js";

const TAG = /(?<!\S)#[\p{L}\p{N}_/-]+/gu;
const HIGHLIGHT = /==[^=\n]+==/g;
const COMMENT = /%%[^%\n]+%%/g;

function stateOf(doc) {
  return EditorState.create({ doc, extensions: [markdown({ extensions: GFM })] });
}

function slices(state, pattern, from, to) {
  return collectMatchRanges(state, pattern, from, to).map((range) => state.sliceDoc(range.from, range.to));
}

function allSlices(state, pattern) {
  return slices(state, pattern, 0, state.doc.length);
}

test("WED-RX-01 body tags, highlights and comments are decorated", () => {
  const state = stateOf("body #tag ==mark== %%comment%%\n");
  assert.deepEqual(allSlices(state, TAG), ["#tag"]);
  assert.deepEqual(allSlices(state, HIGHLIGHT), ["==mark=="]);
  assert.deepEqual(allSlices(state, COMMENT), ["%%comment%%"]);
});

test("WED-RX-01b highlight paint can exclude Markdown source delimiters", () => {
  const state = stateOf("body ==mark== tail\n");
  const ranges = collectMatchRanges(
    state,
    HIGHLIGHT,
    0,
    state.doc.length,
    { trimStart: 2, trimEnd: 2 },
  );
  assert.deepEqual(ranges.map((range) => state.sliceDoc(range.from, range.to)), ["mark"]);
  assert.deepEqual(allSlices(state, HIGHLIGHT), ["==mark=="], "default regex contract remains unchanged");
});

test("WED-RX-01c trimStart and trimEnd accept functions", () => {
  const state = stateOf("body ==mark== tail\n");
  const ranges = collectMatchRanges(state, /==[^=\n]+==/g, 0, state.doc.length, {
    trimStart: () => 2,
    trimEnd: (text) => (text.endsWith("==") ? 2 : 0),
  });
  assert.deepEqual(ranges.map((range) => state.sliceDoc(range.from, range.to)), ["mark"]);
});

test("WED-RX-01d the shared highlight locator paints the same content the hide path leaves", () => {
  const state = stateOf("x ===a=== y ==a=b== z ==x====y== ====a====\n");
  const ranges = collectMatchRanges(state, locateHighlightSpans, 0, state.doc.length, {
    trimStart: highlightTrimStart,
    trimEnd: highlightTrimEnd,
  });
  // `====a====` is the same rule with no owner screenshot (推得项，待真值).
  assert.deepEqual(ranges.map((range) => state.sliceDoc(range.from, range.to)), ["a", "a=b", "x", "y", "a"]);
});

test("WED-RX-02 fenced code content is never decorated", () => {
  const state = stateOf(['```js', 'const tag = "#not-a-tag";', 'const mark = "==not highlight==";', 'const comment = "%%not comment%%";', '```', '', '#real', ''].join("\n"));
  assert.deepEqual(allSlices(state, TAG), ["#real"]);
  assert.deepEqual(allSlices(state, HIGHLIGHT), []);
  assert.deepEqual(allSlices(state, COMMENT), []);
});

test("WED-RX-03 indented code content is never decorated", () => {
  const state = stateOf("    indented #not-a-tag ==x== %%c%%\n\n#real\n");
  assert.deepEqual(allSlices(state, TAG), ["#real"]);
  assert.deepEqual(allSlices(state, HIGHLIGHT), []);
  assert.deepEqual(allSlices(state, COMMENT), []);
});

test("WED-RX-04 inline code is skipped while the rest of the line stays decorated", () => {
  const state = stateOf("`#incode ==x== %%c%%` plus #real ==hi== %%c%%\n");
  assert.deepEqual(allSlices(state, TAG), ["#real"]);
  assert.deepEqual(allSlices(state, HIGHLIGHT), ["==hi=="]);
  assert.deepEqual(allSlices(state, COMMENT), ["%%c%%"]);
});

test("WED-RX-05 YAML frontmatter strings are never decorated", () => {
  const state = stateOf("---\ntitle: #not-a-tag ==x== %%c%%\n---\n\n#real\n");
  assert.deepEqual(allSlices(state, TAG), ["#real"]);
  assert.deepEqual(allSlices(state, HIGHLIGHT), []);
  assert.deepEqual(allSlices(state, COMMENT), []);
  assert.deepEqual(
    excludedSyntaxRanges(state, 0, state.doc.length).map((range) => state.sliceDoc(range.from, range.to)),
    ["---\ntitle: #not-a-tag ==x== %%c%%\n---\n"],
  );
});

test("WED-RX-06 HTML blocks and comments are never decorated", () => {
  const state = stateOf(["<div>", "#not-a-tag ==x== %%c%%", "</div>", "", "<!-- #not-a-tag ==x== %%c%% -->", "", "#real", ""].join("\n"));
  assert.deepEqual(allSlices(state, TAG), ["#real"]);
  assert.deepEqual(allSlices(state, HIGHLIGHT), []);
  assert.deepEqual(allSlices(state, COMMENT), []);
});

test("WED-RX-07 inline HTML element text is skipped", () => {
  const state = stateOf("before <span>#nope ==x== %%c%%</span> after #real\n");
  assert.deepEqual(allSlices(state, TAG), ["#real"]);
  assert.deepEqual(allSlices(state, HIGHLIGHT), []);
  assert.deepEqual(allSlices(state, COMMENT), []);
});

test("WED-RX-08 window scan keeps line-start anchors and ignores the rest of the document", () => {
  const doc = "#start\n\n" + "padding #middle\n".repeat(4) + "tail #end\n";
  const state = stateOf(doc);
  assert.deepEqual(allSlices(state, TAG), ["#start", "#middle", "#middle", "#middle", "#middle", "#end"]);
  const middle = doc.indexOf("#middle");
  assert.deepEqual(slices(state, TAG, middle, middle + 1), ["#middle"]);
  assert.deepEqual(slices(state, TAG, doc.indexOf("#end"), doc.length), ["#end"]);
});

test("WED-RX-09 non-global candidate patterns are accepted", () => {
  const state = stateOf("body #tag\n");
  assert.deepEqual(collectMatchRanges(state, /#[\p{L}]+/u).map((range) => state.sliceDoc(range.from, range.to)), ["#tag"]);
});

test("WED-RX-10 a state without a markdown language still works", () => {
  const state = EditorState.create({ doc: "plain #tag\n" });
  assert.deepEqual(collectMatchRanges(state, TAG).map((range) => state.sliceDoc(range.from, range.to)), ["#tag"]);
});

test("WED-RX-11 decorated() no longer uses the context-blind matcher", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("../frontend/app/features/editor/extensions/match-decorations.js", import.meta.url)),
    "utf8",
  );
  assert.equal(source.includes("new MatchDecorator"), false);
  assert.equal(source.includes("syntaxTree"), true);
  assert.notEqual(decorated(TAG, "cm-obsidian-tag"), undefined);
});

test("WED-RX-12 visible range inside an inline HTML element stays undecorated", () => {
  // Opening tag sits on an earlier line, closing tag on a later line, so a
  // viewport that only covers the middle line must still resolve the pair.
  const doc = "para <span>keep\n#hidden ==x== %%c%%\nend</span> #real\n";
  const state = stateOf(doc);
  const middle = state.doc.line(2);

  assert.deepEqual(slices(state, TAG, middle.from, middle.to), []);
  assert.deepEqual(slices(state, HIGHLIGHT, middle.from, middle.to), []);
  assert.deepEqual(slices(state, COMMENT, middle.from, middle.to), []);

  // Outside the element the same patterns still decorate, and the full scan
  // agrees with the windowed result.
  assert.deepEqual(allSlices(state, TAG), ["#real"]);
  assert.deepEqual(allSlices(state, HIGHLIGHT), []);
  assert.deepEqual(allSlices(state, COMMENT), []);
});
