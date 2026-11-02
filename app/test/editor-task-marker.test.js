import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { Decoration, WidgetType } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import {
  taskAtomicRangesFromDecorations,
  taskCaretAfterToggle,
  taskLineState,
  TaskCheckboxWidget,
} from "../frontend/app/features/editor/extensions/live-decorations.js";

const fixture = "- [ ] task one\n- [x] task two\n\n- [ ] `code` tail\n";

function stateOf(doc) {
  return EditorState.create({ doc, extensions: [markdown({ extensions: GFM })] });
}

function taskMarkerRanges(state) {
  const found = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "TaskMarker") found.push({ from: node.from, to: node.to });
    },
  });
  return found;
}

function rangesOf(set, length) {
  const found = [];
  set.between(0, length, (from, to) => found.push({ from, to }));
  return found;
}

class OtherWidget extends WidgetType {
  toDOM() { return document.createElement("span"); }
}

test("WEB-ED-04 TaskMarker source ranges are collected for every task line", () => {
  const state = stateOf(fixture);
  const markers = taskMarkerRanges(state);
  assert.equal(markers.length, 3);
  assert.deepEqual(
    markers.map((range) => state.sliceDoc(range.from, range.to)),
    ["[ ]", "[x]", "[ ]"],
  );
  // Half-open source ranges, not the widget DOM.
  for (const range of markers) assert.ok(range.to - range.from === 3);
});

test("WEB-ED-04 completed Live task lines carry Obsidian's data-task + is-checked state", () => {
  // Obsidian Desktop sets both the data attribute and the is-checked class on a
  // completed Live line; is-checked is the same class Reader's completed `li`
  // carries, so a Vault theme can key on either shape. Unchecked lines keep
  // data-task=" " and must never carry is-checked.
  assert.deepEqual(taskLineState("[ ]"), {
    checked: false,
    className: "HyperMD-task-line",
    attributes: { "data-task": " " },
  });
  assert.deepEqual(taskLineState("[x]"), {
    checked: true,
    className: "HyperMD-task-line is-checked",
    attributes: { "data-task": "x" },
  });
  assert.deepEqual(taskLineState("[X]"), taskLineState("[x]"));
});

test("WEB-ED-04 atomic ranges are derived from the rendered task decorations", () => {
  const state = stateOf(fixture);
  const markers = taskMarkerRanges(state);
  // Mirror what buildLiveDecorations pushes: one replace widget per TaskMarker
  // plus unrelated replacements/marks that must never become atoms.
  const decorations = Decoration.set([
    Decoration.replace({ widget: new OtherWidget() }).range(markers[0].from - 2, markers[0].from),
    Decoration.replace({ widget: new TaskCheckboxWidget(markers[0].from, markers[0].to, false) })
      .range(markers[0].from, markers[0].to),
    Decoration.mark({ class: "cm-live-inline-code" }).range(markers[0].to, markers[1].from),
    Decoration.replace({ widget: new TaskCheckboxWidget(markers[1].from, markers[1].to, true) })
      .range(markers[1].from, markers[1].to),
    Decoration.replace({ widget: new TaskCheckboxWidget(markers[2].from, markers[2].to, false) })
      .range(markers[2].from, markers[2].to),
  ], true);

  const atomic = taskAtomicRangesFromDecorations(decorations, state.doc.length);
  assert.deepEqual(rangesOf(atomic, state.doc.length), markers);
});

test("WEB-ED-04 checkbox click keeps a caret outside the hidden marker", () => {
  const from = 2;
  const to = 5;
  // A caret strictly inside the replaced `[ ]` would be invisible.
  assert.equal(taskCaretAfterToggle(from + 1, from, to), to);
  // Boundaries and unrelated positions keep their place: clicking a checkbox
  // must not steal the caret from the rest of the document.
  assert.equal(taskCaretAfterToggle(from, from, to), from);
  assert.equal(taskCaretAfterToggle(to, from, to), to);
  assert.equal(taskCaretAfterToggle(40, from, to), 40);
});

test("WEB-ED-04 live decorations own task atomically without a transaction filter", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("../frontend/app/features/editor/extensions/live-decorations.js", import.meta.url)),
    "utf8",
  );
  const taskSource = fs.readFileSync(
    fileURLToPath(new URL("../frontend/app/features/editor/extensions/task-marker.js", import.meta.url)),
    "utf8",
  );
  assert.match(source, /EditorView\.atomicRanges\.of\(/);
  assert.match(source, /taskAtomicRangesFromDecorations\(decorations, view\.state\.doc\.length\)/);
  assert.match(taskSource, /value\.spec\?\.widget instanceof TaskCheckboxWidget/);
  // Cursor position must never be rewritten by a global transaction filter.
  assert.doesNotMatch(source, /transactionFilter/);
  assert.doesNotMatch(taskSource, /transactionFilter/);
});
