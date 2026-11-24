// #785 (2): a setext heading (`Title` + `===`) must offer the same fold control as ATX.
// The browser scenario in `scripts/web-regression/render-geometry-parity.mjs` proves the heading
// surface; this file pins the fold decisions off the real parser tree and the real fold service:
// where the indicator goes, and that the range it folds reaches the body.
import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import { codeFolding, foldEffect, foldable, foldedRanges, unfoldEffect } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { headingFoldDecorations } from "../frontend/app/features/editor/extensions/surface.js";

function stateOf(doc) {
  return EditorState.create({ doc, extensions: [markdown({ extensions: GFM }), codeFolding()] });
}

// `headingFoldDecorations` reads only `state` and `visibleRanges`, so the whole document stands in
// for a viewport without a DOM.
function indicators(state) {
  const found = [];
  headingFoldDecorations({ state, visibleRanges: [{ from: 0, to: state.doc.length }] })
    .between(0, state.doc.length, (from, to, value) => found.push({ from, widget: value.spec.widget }));
  return found;
}

function lineOf(state, number) {
  return state.doc.line(number);
}

test("#785 a setext heading carries one fold indicator, on its title line", () => {
  for (const [underline, level] of [["===", 1], ["---", 2]]) {
    const state = stateOf(`Setext title\n${underline}\n\nBody paragraph\n`);
    const found = indicators(state);
    assert.equal(found.length, 1, `setext h${level}: exactly one indicator`);
    assert.equal(found[0].from, 0, `setext h${level}: the indicator opens the title line`);
    assert.equal(found[0].widget.level, level, `setext h${level}: the indicator knows its level`);
    assert.equal(found[0].widget.open, true, `setext h${level}: an unfolded heading reports open`);
  }
});

test("#785 the setext indicator folds the underline and the body, and turns", () => {
  const doc = "Setext title\n===\n\nBody paragraph\n";
  const state = stateOf(doc);
  const title = lineOf(state, 1);
  const range = foldable(state, title.from, title.to);
  assert.notEqual(range, null, "the setext title line must be foldable");
  assert.ok(range.from >= title.to, "the fold starts at the end of the title line");
  assert.ok(
    doc.slice(range.from, range.to).includes("Body paragraph"),
    `the fold must reach the body, it covers ${JSON.stringify(doc.slice(range.from, range.to))}`,
  );
  assert.ok(doc.slice(range.from, range.to).includes("==="), "the fold hides the underline too");

  const folded = state.update({ effects: foldEffect.of(range) }).state;
  let covered = null;
  foldedRanges(folded).between(title.from, title.to, (from, to) => { covered = { from, to }; });
  assert.deepEqual(covered, range, "a folded setext heading is found from its title line");
  const shut = indicators(folded);
  assert.equal(shut.length, 1);
  assert.equal(shut[0].widget.open, false, "a folded setext heading reports collapsed");

  const back = folded.update({ effects: unfoldEffect.of(range) }).state;
  assert.equal(indicators(back)[0].widget.open, true, "unfolding restores the open indicator");
});

test("#785 a multi-line setext title gets its indicator on the first line only", () => {
  const state = stateOf("Multi line\ntitle\n===\n\nBody paragraph\n");
  const found = indicators(state);
  assert.equal(found.length, 1, "one indicator for the whole heading");
  assert.equal(found[0].from, lineOf(state, 1).from);
  const range = foldable(state, lineOf(state, 1).from, lineOf(state, 1).to);
  assert.ok(range && range.to >= lineOf(state, 5).from, "the fold reaches the body past the title");
});

test("#785 ATX keeps its own indicator and fold range", () => {
  const doc = "# ATX title\n\nAtx body\n";
  const state = stateOf(doc);
  const found = indicators(state);
  assert.equal(found.length, 1);
  assert.equal(found[0].from, 0);
  assert.equal(found[0].widget.level, 1);
  const title = lineOf(state, 1);
  const range = foldable(state, title.from, title.to);
  assert.ok(range && doc.slice(range.from, range.to).includes("Atx body"), "the ATX fold still reaches the body");
});

test("#785 a foldable non-heading block gets no heading indicator", () => {
  const state = stateOf("> quote one\n> quote two\n");
  assert.notEqual(foldable(state, 0, state.doc.line(1).to), null, "a blockquote is foldable");
  assert.deepEqual(indicators(state), [], "but it is not a heading and takes no heading indicator");
});

// Measured, not assumed: the parser starts the setext node after the quote marker (`node.from`
// 2 while the line starts at 0), so the "starts on this line" rule still lands the indicator.
test("#785 a setext heading inside a blockquote keeps one indicator on its title line", () => {
  const state = stateOf("> Quoted\n> =====\n>\n> Body\n");
  const found = indicators(state);
  assert.equal(found.length, 1);
  assert.equal(found[0].from, lineOf(state, 1).from);
  assert.equal(found[0].widget.level, 1);
});
