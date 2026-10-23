import assert from "node:assert/strict";
import test from "node:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { installDomShim } from "./dom-shim.mjs";

installDomShim();

const {
  codeBlockNewlineSpec,
  liveNewlineSpec,
  shouldCollapsePaddingNewline,
  snapHiddenChromeCaret,
  fenceLineInsertPos,
} = await import("../frontend/app/features/editor/editor.js");

function stateOf(doc, selection) {
  return EditorState.create({
    doc,
    selection,
    extensions: [markdown({ extensions: GFM }), EditorState.allowMultipleSelections.of(true), snapHiddenChromeCaret],
  });
}

test("caret on an opening fence stays there so the language can be typed", () => {
  const doc = "```js\nconst x = 1\n```\n";
  let state = stateOf(doc, EditorSelection.cursor(0));
  state = state.update({ selection: EditorSelection.cursor(3) }).state;
  assert.equal(state.selection.main.head, 3);
  assert.equal(fenceLineInsertPos(state, 3), 3);
});

test("caret on a closing fence stays there so the fence can be edited", () => {
  const doc = "```js\nconst x = 1\n```\n";
  const close = doc.lastIndexOf("```");
  let state = stateOf(doc, EditorSelection.cursor(close));
  state = state.update({ selection: EditorSelection.cursor(close) }).state;
  assert.equal(state.selection.main.head, close);
  assert.equal(fenceLineInsertPos(state, close), close);
});

test("Enter inside a fence body inserts a newline and keeps the caret in the body", () => {
  const doc = "```js\nconst x = 1\n```\n";
  const pos = doc.indexOf("x");
  const state = stateOf(doc, EditorSelection.cursor(pos));
  const spec = codeBlockNewlineSpec(state);
  assert.ok(spec);
  const next = state.update(spec).state;
  assert.equal(next.doc.toString(), "```js\nconst \nx = 1\n```\n");
  assert.equal(next.selection.main.head, pos + 1);
});

test("Enter at the last fence body line adds a blank line before the close fence", () => {
  const doc = "```js\nconst x = 1\n```\n";
  const pos = doc.indexOf("\n```");
  const state = stateOf(doc, EditorSelection.cursor(pos));
  const next = state.update(codeBlockNewlineSpec(state)).state;
  assert.equal(next.doc.toString(), "```js\nconst x = 1\n\n```\n");
  assert.equal(next.selection.main.head, pos + 1);
  assert.equal(next.doc.lineAt(next.selection.main.head).text, "");
});

test("Enter on an unclosed opening fence inserts a body line and closes the fence", () => {
  const doc = "intro\n```js";
  const state = stateOf(doc, EditorSelection.cursor(doc.length));
  const next = state.update(codeBlockNewlineSpec(state)).state;
  assert.equal(next.doc.toString(), "intro\n```js\n\n```");
  assert.equal(next.doc.lineAt(next.selection.main.head).text, "");
});

test("Enter on an unclosed opening fence with existing body opens a body line instead of a premature close", () => {
  const doc = "```js\nconst x = 1";
  const pos = doc.indexOf("\n");
  const state = stateOf(doc, EditorSelection.cursor(pos));
  const next = state.update(codeBlockNewlineSpec(state)).state;
  assert.equal(next.doc.toString(), "```js\n\nconst x = 1");
  assert.equal(next.selection.main.head, pos + 1);
  assert.equal(next.doc.lineAt(next.selection.main.head).text, "");
});

test("Enter on an unclosed tilde opening fence with existing body opens a body line", () => {
  const doc = "~~~\nbody";
  const pos = doc.indexOf("\n");
  const state = stateOf(doc, EditorSelection.cursor(pos));
  const next = state.update(codeBlockNewlineSpec(state)).state;
  assert.equal(next.doc.toString(), "~~~\n\nbody");
  assert.equal(next.selection.main.head, pos + 1);
});

test("snap does not pull the caret off an empty paragraph onto a following fence", () => {
  const doc = "hello\n\n```js\ncode\n```\n";
  const empty = doc.indexOf("\n\n") + 1;
  let state = stateOf(doc, EditorSelection.cursor(empty));
  state = state.update({ selection: EditorSelection.cursor(empty) }).state;
  assert.equal(state.selection.main.head, empty);
  assert.equal(state.update({
    changes: { from: empty, insert: "\n" },
    selection: EditorSelection.cursor(empty + 1),
  }).state.selection.main.head, empty + 1);
});

test("Enter with a newline selected inserts another line instead of a no-op", () => {
  const doc = "## Heading two\n\nBody\n";
  const pos = doc.indexOf("\n\n");
  const state = stateOf(doc, EditorSelection.range(pos, pos + 1));
  const spec = liveNewlineSpec(state);
  assert.ok(spec);
  const next = state.update(spec).state;
  assert.equal(next.doc.toString(), "## Heading two\n\n\nBody\n");
  assert.equal(next.doc.lineAt(next.selection.main.head).text, "");
});

test("Enter on a normal text selection is left to the default keymap", () => {
  const doc = "## Heading two\n\nBody\n";
  const start = doc.indexOf("Body");
  const state = stateOf(doc, EditorSelection.range(start, start + 2));
  assert.equal(liveNewlineSpec(state), null);
});

function paddingPointer(overrides = {}) {
  return { padding: true, button: 0, shiftKey: false, dragMoved: false, ...overrides };
}

const singleNewlineSelection = EditorSelection.create([EditorSelection.range(1, 2)]);

function paddingDecision(overrides = {}) {
  const pointer = !("pointer" in overrides)
    ? paddingPointer()
    : (overrides.pointer === null ? null : paddingPointer(overrides.pointer));
  return shouldCollapsePaddingNewline({
    pointer,
    selection: overrides.selection ?? singleNewlineSelection,
    selected: overrides.selected ?? "\n",
    composing: overrides.composing ?? false,
  });
}

test("the padding-click workaround only fires for a recorded padding pointer", () => {
  assert.equal(paddingDecision({ pointer: { padding: true } }), true);
  assert.equal(paddingDecision({ pointer: { padding: false } }), false);
  assert.equal(paddingDecision({ pointer: null }), false);
});

test("the padding-click workaround ignores keyboard and non-left pointer origins", () => {
  assert.equal(paddingDecision({ pointer: { shiftKey: true } }), false);
  assert.equal(paddingDecision({ pointer: { button: 2 } }), false);
  assert.equal(paddingDecision({ pointer: { dragMoved: true } }), false);
});

test("the padding-click workaround ignores composition and multi-range selections", () => {
  assert.equal(paddingDecision({ composing: true }), false);
  assert.equal(paddingDecision({
    selection: EditorSelection.create([
      EditorSelection.range(1, 2),
      EditorSelection.cursor(5),
    ]),
  }), false);
});

test("the padding-click workaround only collapses a plain one-newline selection", () => {
  assert.equal(paddingDecision({ selected: "\n\n" }), false);
  assert.equal(paddingDecision({ selected: "a" }), false);
  assert.equal(paddingDecision({
    selection: EditorSelection.create([EditorSelection.cursor(1)]),
    selected: "",
  }), false);
});

test("a selected newline is legitimate and is not collapsed by the live filter", () => {
  const doc = "## Heading two\n\nBody\n";
  const pos = doc.indexOf("\n\n");
  let state = stateOf(doc, EditorSelection.cursor(0));
  state = state.update({ selection: EditorSelection.range(pos, pos + 1) }).state;
  assert.equal(state.selection.main.empty, false);
  assert.equal(state.selection.main.from, pos);
  assert.equal(state.selection.main.to, pos + 1);
  assert.equal(state.sliceDoc(state.selection.main.from, state.selection.main.to), "\n");
});

test("a reverse newline selection keeps its anchor/head direction", () => {
  const doc = "## Heading two\n\nBody\n";
  const pos = doc.indexOf("\n\n");
  let state = stateOf(doc, EditorSelection.cursor(0));
  state = state.update({ selection: EditorSelection.range(pos + 1, pos) }).state;
  assert.equal(state.selection.main.empty, false);
  assert.equal(state.selection.main.anchor, pos + 1);
  assert.equal(state.selection.main.head, pos);
});

test("a multi-range selection that includes a newline is not collapsed", () => {
  const doc = "## Heading two\n\nBody\n";
  const pos = doc.indexOf("\n\n");
  let state = stateOf(doc, EditorSelection.cursor(0));
  state = state.update({
    selection: EditorSelection.create([
      EditorSelection.range(pos, pos + 1),
      EditorSelection.cursor(doc.indexOf("Body")),
    ]),
  }).state;
  assert.equal(state.selection.ranges.length, 2);
  assert.equal(state.selection.ranges[0].empty, false);
  assert.equal(state.sliceDoc(state.selection.ranges[0].from, state.selection.ranges[0].to), "\n");
});

test("a programmatic newline range survives the transaction filter", () => {
  const doc = "a\n\nb\n";
  const pos = doc.indexOf("\n\n");
  const state = stateOf(doc, EditorSelection.cursor(0));
  const next = state.update({ selection: EditorSelection.range(pos, pos + 1) }).state;
  assert.equal(next.selection.main.from, pos);
  assert.equal(next.selection.main.to, pos + 1);
});

