// Selected-line gutter highlight.
//
// `highlightActiveLineGutter()` only marks the caret's line, so a multi-line selection
// left the numbers of every selected line unmarked — the desktop editor highlights them.
// This field maps the current selection ranges onto the line-number gutter through
// `gutterLineClass`; the marker only carries a class, so the number is highlighted
// without painting a filled cell across the line's wrapped rows.
import { RangeSetBuilder, StateField } from "@codemirror/state";
import { GutterMarker, gutterLineClass } from "@codemirror/view";

class SelectedLineMarker extends GutterMarker {
  elementClass = "cm-selectedLineGutter";
}

const selectedLineMarker = new SelectedLineMarker();

function selectedLineSet(state) {
  const builder = new RangeSetBuilder();
  for (const range of state.selection.ranges) {
    // A bare caret is the active line, which the active-line gutter already handles.
    if (range.empty) continue;
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let number = first; number <= last; number += 1) {
      const line = state.doc.line(number);
      builder.add(line.from, line.from, selectedLineMarker);
    }
  }
  return builder.finish();
}

export const selectedLineGutter = StateField.define({
  create: (state) => selectedLineSet(state),
  // Rebuilding is bounded by the selected line count, so every transaction simply
  // recomputes instead of guessing which selection changes need it.
  update: (_value, transaction) => selectedLineSet(transaction.state),
  provide: (field) => gutterLineClass.from(field),
});
