// WEB-ED-03 (PR-3): clean remote refresh must map the old -> new document as
// real, multi-hunk CodeMirror changes.
//
// These tests lock the invariants from the "Remote refresh" section of
// TODO - Web 编辑器交互正确性修复:
//   1. old -> new is a deterministic, ordered, non-overlapping ChangeSpec[];
//   2. unchanged islands between remote edits stay out of the change ranges;
//   3. selection is mapped by CodeMirror through those changes instead of being
//      restored from stale absolute offsets;
//   4. a remote patch is silent (no dirty callback) and is not an ordinary
//      local undo step.
//
// They exercise the pure diff plus EditorState/CodeMirror mapping. There is no
// runnable browser harness in this environment, so the create-editor wiring and
// the vault-events-controller call site are covered by focused source guards
// instead of a live EditorView.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { history, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import {
  applyTextChanges,
  computeTextChanges,
} from "../frontend/app/features/editor/text-changes.js";
import { readSourceTree } from "./helpers/source-tree.js";

function stateOf(doc, selection, extensions = []) {
  return EditorState.create({ doc, selection, extensions });
}

function applyRemote(state, newText) {
  const changes = computeTextChanges(state.doc.toString(), newText);
  return {
    changes,
    state: state.update({
      changes,
      annotations: Transaction.addToHistory.of(false),
    }).state,
  };
}

function assertOrderedNonOverlapping(changes, oldLength) {
  let previous = 0;
  for (const change of changes) {
    assert.ok(Number.isInteger(change.from), `from must be an integer: ${JSON.stringify(change)}`);
    assert.ok(Number.isInteger(change.to), `to must be an integer: ${JSON.stringify(change)}`);
    assert.ok(change.from >= previous, `changes must be ordered: ${JSON.stringify(changes)}`);
    assert.ok(change.to >= change.from, `to must not precede from: ${JSON.stringify(change)}`);
    assert.ok(change.to <= oldLength, `to must stay in range: ${JSON.stringify(change)}`);
    assert.equal(typeof change.insert, "string", "insert must be a string");
    previous = change.to;
  }
}

function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test("computeTextChanges returns no changes for identical text", () => {
  assert.deepEqual(computeTextChanges("", ""), []);
  assert.deepEqual(computeTextChanges("same\nbody\n", "same\nbody\n"), []);
});

test("computeTextChanges handles empty documents in both directions", () => {
  const inserted = computeTextChanges("", "line one\nline two\n");
  assert.equal(applyTextChanges("", inserted), "line one\nline two\n");
  const removed = computeTextChanges("line one\nline two\n", "");
  assert.equal(applyTextChanges("line one\nline two\n", removed), "");
});

test("computeTextChanges is deterministic for the same input", () => {
  const oldText = "one\ntwo\nthree\nfour\nfive\n";
  const newText = "one\nTWO\nthree\nfour\nFIVE\n";
  assert.deepEqual(computeTextChanges(oldText, newText), computeTextChanges(oldText, newText));
});

test("a multi-hunk remote edit keeps the unchanged island out of every change", () => {
  const oldText = "alpha\nbravo\ncharlie\ndelta\necho\n";
  const newText = "alpha\nBRAVO\ncharlie\ndelta\nECHO\n";

  const changes = computeTextChanges(oldText, newText);
  assert.ok(changes.length >= 2, `expected a multi-hunk diff, got ${JSON.stringify(changes)}`);
  assertOrderedNonOverlapping(changes, oldText.length);
  assert.equal(applyTextChanges(oldText, changes), newText);

  // The untouched "charlie\ndelta\n" block must not be swallowed by one big
  // common-prefix/common-suffix replacement.
  const islandStart = oldText.indexOf("charlie");
  const islandEnd = oldText.indexOf("echo");
  for (const change of changes) {
    const coversIsland = change.from < islandEnd && change.to > islandStart;
    assert.equal(coversIsland, false, `change swallowed the unchanged island: ${JSON.stringify(change)}`);
  }
});

test("a partially edited line is refined at the character level", () => {
  const oldText = "prefix MIDDLE suffix\n";
  const newText = "prefix changed suffix\n";
  const changes = computeTextChanges(oldText, newText);
  assertOrderedNonOverlapping(changes, oldText.length);
  assert.equal(applyTextChanges(oldText, changes), newText);
  // The common "prefix " and " suffix\n" must survive as islands: at least one
  // change stays strictly inside the line.
  assert.ok(changes.some((change) => change.from > 0 && change.to < oldText.length));
});

test("computeTextChanges round-trips on a property-based random corpus", () => {
  const random = mulberry32(0x5eed);
  const alphabet = ["a", "b", "c", " ", "\n", "\n", "#", "*", "é", "中", "\t", "|", "-", "~"];
  const randomText = (max) => {
    const length = Math.floor(random() * max);
    let text = "";
    for (let index = 0; index < length; index += 1) {
      text += alphabet[Math.floor(random() * alphabet.length)];
    }
    return text;
  };
  const mutate = (text) => {
    let result = text;
    const operations = Math.floor(random() * 5);
    for (let index = 0; index < operations; index += 1) {
      const position = Math.floor(random() * (result.length + 1));
      const roll = random();
      if (roll < 0.4) {
        result = result.slice(0, position) + randomText(12) + result.slice(position);
      } else if (roll < 0.75) {
        result = result.slice(0, position) + result.slice(position + Math.floor(random() * 8));
      } else {
        result = result.slice(0, position) + randomText(10)
          + result.slice(position + Math.floor(random() * 6));
      }
    }
    return result;
  };

  for (let iteration = 0; iteration < 3000; iteration += 1) {
    const oldText = randomText(60);
    const newText = mutate(oldText);
    const changes = computeTextChanges(oldText, newText);
    assertOrderedNonOverlapping(changes, oldText.length);
    assert.equal(
      applyTextChanges(oldText, changes),
      newText,
      `round-trip failed for ${JSON.stringify(oldText)} -> ${JSON.stringify(newText)}`,
    );
  }
});

test("remote insertion before the caret moves the caret with the unchanged suffix", () => {
  const oldText = "alpha\nbravo\n";
  const caret = oldText.indexOf("ravo");
  const newText = "alpha\nINSERTED\nbravo\n";
  const { state } = applyRemote(stateOf(oldText, EditorSelection.cursor(caret)), newText);
  assert.equal(state.doc.toString(), newText);
  assert.equal(state.selection.main.head, newText.indexOf("ravo"));
});

test("remote insertion after the caret leaves the caret in place", () => {
  const oldText = "alpha\nbravo\n";
  const newText = `${oldText}tail\n`;
  const { state } = applyRemote(stateOf(oldText, EditorSelection.cursor(0)), newText);
  assert.equal(state.selection.main.head, 0);
});

test("remote deletion before the caret moves the caret forward", () => {
  const oldText = "one\ntwo\nthree\n";
  const caret = oldText.indexOf("hree");
  const newText = "one\nthree\n";
  const { state } = applyRemote(stateOf(oldText, EditorSelection.cursor(caret)), newText);
  assert.equal(state.doc.toString(), newText);
  assert.equal(state.selection.main.head, newText.indexOf("hree"));
});

test("a caret between two remote hunks is shifted only by the preceding hunk", () => {
  const oldText = "A\nB\nC\nD\nE\n";
  const newText = "A\nB2\nC\nD\nE2\n";
  const { changes, state } = applyRemote(
    stateOf(oldText, EditorSelection.cursor(oldText.indexOf("C"))),
    newText,
  );
  assert.ok(changes.length >= 2);
  assert.equal(state.selection.main.head, newText.indexOf("C"));
});

test("a reverse selection keeps its anchor/head direction across a remote change", () => {
  const oldText = "0123456789\n";
  const selection = EditorSelection.range(10, 2);
  const newText = "0123XY456789\n";
  const { state } = applyRemote(stateOf(oldText, selection), newText);
  assert.equal(state.selection.main.empty, false);
  assert.ok(state.selection.main.anchor > state.selection.main.head);
  assert.equal(state.selection.main.anchor, 12);
  assert.equal(state.selection.main.head, 2);
  assert.equal(state.sliceDoc(state.selection.main.from, state.selection.main.to), "23XY456789");
});

test("multiple selections map through remote changes independently", () => {
  const oldText = "aaa\nbbb\nccc\n";
  const selection = EditorSelection.create([
    EditorSelection.cursor(1),
    EditorSelection.cursor(9),
  ]);
  const newText = "Zaaa\nbbb\nYccc\n";
  const { changes, state } = applyRemote(
    stateOf(oldText, selection, [EditorState.allowMultipleSelections.of(true)]),
    newText,
  );
  assert.equal(state.doc.toString(), newText);
  assert.equal(state.selection.ranges.length, 2);
  assertOrderedNonOverlapping(changes, oldText.length);
  // First cursor only sees the head insertion; the second sees both.
  assert.equal(state.selection.ranges[0].head, 2);
  assert.equal(state.selection.ranges[1].head, 11);
});

test("a remote transaction annotated addToHistory(false) is not an undo step", () => {
  let state = stateOf("alpha\nbravo\ncharlie\n", EditorSelection.cursor(0), [history()]);
  state = state.update({ changes: { from: 0, insert: "typed " } }).state;
  const afterLocalEdit = state.doc.toString();

  const newText = afterLocalEdit.replace("charlie", "charlie!");
  state = applyRemote(state, newText).state;
  assert.equal(state.doc.toString(), newText);

  const undone = undo({ state, dispatch: (transaction) => { state = transaction.state; } });
  assert.equal(undone, true);
  // The local edit is reverted, but the remote patch survives as mapped text.
  assert.equal(state.doc.toString(), newText.replace("typed ", ""));
  assert.equal(state.doc.toString().includes("charlie!"), true);

  // Nothing else is undoable: the remote patch is not treated as a local edit.
  assert.equal(undo({ state, dispatch: (transaction) => { state = transaction.state; } }), false);
});

test("without the annotation a remote transaction would be an undo step (contrast)", () => {
  let state = stateOf("alpha\nbravo\n", EditorSelection.cursor(0), [history()]);
  state = state.update({ changes: { from: 0, insert: "typed " } }).state;
  const remoteText = `${state.doc.toString()}tail\n`;
  state = state.update({ changes: computeTextChanges(state.doc.toString(), remoteText) }).state;
  undo({ state, dispatch: (transaction) => { state = transaction.state; } });
  assert.equal(state.doc.toString().includes("tail"), false);
});

test("create-editor applies external text with computed changes and no selection override", () => {
  const editorSource = readSourceTree(new URL("../frontend/app/features/editor/", import.meta.url));
  assert.match(editorSource, /import \{ computeTextChanges \} from "\.\/text-changes\.js";/);
  assert.match(editorSource, /applyExternalText\(value\) \{/);
  assert.match(editorSource, /computeTextChanges\(view\.state\.doc\.toString\(\), text\)/);
  assert.match(editorSource, /annotations: Transaction\.addToHistory\.of\(false\)/);

  const start = editorSource.indexOf("applyExternalText(value) {");
  const end = editorSource.indexOf("setMode(value) {", start);
  assert.ok(start >= 0 && end > start, "applyExternalText must precede setMode");
  const block = editorSource.slice(start, end);
  // Silent: the onChange listener is gated on suppressChange.
  assert.match(block, /suppressChange = true;/);
  assert.match(block, /suppressChange = false;/);
  // No stale numeric selection is pushed back into the new document.
  assert.doesNotMatch(block, /selection/);
  assert.doesNotMatch(block, /preserveSelection/);
  // No full-document replacement.
  assert.doesNotMatch(block, /from: 0, to: view\.state\.doc\.length/);
});

test("vault-events-controller uses applyExternalText for a clean remote refresh", () => {
  const controllerSource = fs.readFileSync(
    fileURLToPath(new URL("../frontend/app/features/sync/vault-events-controller.js", import.meta.url)),
    "utf8",
  );
  assert.match(controllerSource, /markdownEditor\.applyExternalText\(result\.content\)/);
  assert.doesNotMatch(controllerSource, /preserveSelection: true/);
  assert.doesNotMatch(controllerSource, /resetHistory: false, preserveSelection: true/);
});
