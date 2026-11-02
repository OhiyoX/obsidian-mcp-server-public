// H1 P0-2: RAW <-> Live mode switching is a surface *reconfigure*, never a
// document/state rebuild.
//
// TODO invariant §2.4.6: "navigation to another note resets history; RAW <-> Live
// switching of the same note keeps history". §2.1: a legal EditorSelection must
// not be rewritten just because visual chrome changes. `create-editor.js`
// `setMode()` therefore only reconfigures the surface compartment; these tests
// pin both the mechanism and its observable effect on a real EditorState.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { history, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { GFM } from "@lezer/markdown";
import { createLiveBlockPreview } from "../frontend/app/features/editor/live-preview.js";
import { surfaceModeExtensions } from "../frontend/app/features/editor/extensions/surface.js";

const DOC = "alpha bravo charlie delta\n";
const modeCompartment = new Compartment();
const blockPreview = createLiveBlockPreview(() => ({ sourcePath: "note.md", vaultId: "v1" }));

function stateFor(mode, selection) {
  return EditorState.create({
    doc: DOC,
    selection,
    extensions: [
      markdown({ extensions: GFM }),
      history(),
      modeCompartment.of(surfaceModeExtensions(mode, blockPreview)),
    ],
  });
}

test("H1-SEL-01 RAW <-> Live reconfigure keeps selection and undo history", () => {
  let state = stateFor("live", EditorSelection.range(6, 11));
  state = state.update({ changes: { from: 0, insert: "typed " }, userEvent: "input.type" }).state;
  const typed = state.doc.toString();
  assert.equal(typed, `typed ${DOC}`);
  state = state.update({ selection: EditorSelection.range(12, 17) }).state;
  const before = { anchor: state.selection.main.anchor, head: state.selection.main.head, text: state.sliceDoc(12, 17) };
  assert.equal(before.text, "bravo");

  for (const mode of ["raw", "live", "preview", "live", "raw"]) {
    state = state.update({ effects: modeCompartment.reconfigure(surfaceModeExtensions(mode, blockPreview)) }).state;
    assert.equal(state.selection.main.anchor, before.anchor, `anchor after ${mode}`);
    assert.equal(state.selection.main.head, before.head, `head after ${mode}`);
    assert.equal(state.selection.main.empty, false, `selection survived ${mode}`);
    assert.equal(state.sliceDoc(state.selection.main.from, state.selection.main.to), "bravo", `slice after ${mode}`);
    assert.equal(state.doc.toString(), typed, `document untouched by ${mode}`);
  }

  // The typing step is still the only undo step after five surface switches.
  let undone = state;
  assert.equal(undo({ state: undone, dispatch: (transaction) => { undone = transaction.state; } }), true);
  assert.equal(undone.doc.toString(), DOC);
});

test("H1-SEL-01b contrast: rebuilding the state would drop the typed undo step", () => {
  let state = stateFor("live", EditorSelection.range(6, 11));
  state = state.update({ changes: { from: 0, insert: "typed " }, userEvent: "input.type" }).state;
  // Same document, same selection, but a fresh EditorState (the anti-pattern
  // setMode must not use): history is gone, so H1-SEL-01 is not vacuous.
  const rebuilt = EditorState.create({
    doc: state.doc.toString(),
    selection: state.selection,
    extensions: [
      markdown({ extensions: GFM }),
      history(),
      modeCompartment.of(surfaceModeExtensions("raw", blockPreview)),
    ],
  });
  let next = rebuilt;
  assert.equal(undo({ state: next, dispatch: (transaction) => { next = transaction.state; } }), false);
  assert.equal(next.doc.toString(), `typed ${DOC}`);
});

test("H1-SEL-02 reverse selections keep their direction across mode switches", () => {
  let state = stateFor("raw", EditorSelection.range(17, 12));
  const before = { anchor: state.selection.main.anchor, head: state.selection.main.head };
  assert.ok(before.anchor > before.head);
  for (const mode of ["live", "raw", "preview", "live"]) {
    state = state.update({ effects: modeCompartment.reconfigure(surfaceModeExtensions(mode, blockPreview)) }).state;
    assert.equal(state.selection.main.anchor, before.anchor, `anchor after ${mode}`);
    assert.equal(state.selection.main.head, before.head, `head after ${mode}`);
  }
});

test("H1-SEL-03 setMode only reconfigures the surface compartment", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("../frontend/app/features/editor/create-editor.js", import.meta.url)),
    "utf8",
  );
  const start = source.indexOf("setMode(value) {");
  const end = source.indexOf("setSourcePath(path, nextVaultId) {", start);
  assert.ok(start >= 0 && end > start, "setMode must precede setSourcePath");
  const block = source.slice(start, end);
  assert.match(block, /mode\.reconfigure\(surfaceModeExtensions\(/);
  // A mode switch must never rebuild the state (that would drop history) and
  // must never push a numeric selection back into the document.
  assert.doesNotMatch(block, /setState\(/);
  assert.doesNotMatch(block, /historyComp\.of\(/);
  assert.doesNotMatch(block, /selection:/);
  assert.doesNotMatch(block, /setValue\(/);
});

test("H1-SEL-04 every surface exposes the shared interaction freeze field", () => {
  const surface = fs.readFileSync(
    fileURLToPath(new URL("../frontend/app/features/editor/extensions/surface.js", import.meta.url)),
    "utf8",
  );
  // Live Preview must keep the shared pointer/composition freeze so block and
  // decoration plugins map instead of rebuild during a drag (H1 P0-1).
  assert.match(surface, /interactionField/);
  assert.match(surface, /isInteractionFrozen|interactionField/);
});
