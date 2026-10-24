import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { interactionField } from "../interaction.js";

const FENCE_LINE_RE = /^\s*(`{3,}|~{3,})/;

function lineLooksLikeFence(text) {
  return FENCE_LINE_RE.test(text);
}

function codeBlockCovering(state, pos) {
  let found = null;
  const clamped = Math.min(Math.max(0, pos), state.doc.length);
  syntaxTree(state).iterate({
    from: clamped,
    to: clamped,
    enter(node) {
      if (node.name === "FencedCode" || node.name === "CodeBlock") {
        found = node.node;
        return false;
      }
    },
  });
  return found;
}

/**
 * Fence-specific position normalization for code-block insertion. It only keeps
 * the position inside the document; it deliberately carries no table-delimiter
 * or other hidden-chrome semantics. A GFM table delimiter is a legal caret
 * target and must never be snapped away from its own line (WEB-ED-02).
 */
export function fenceLineInsertPos(state, pos) {
  if (pos == null || pos < 0) return pos;
  return Math.min(pos, state.doc.length);
}


export const snapHiddenChromeCaret = EditorState.transactionFilter.of((tr) => {
  if (tr.startState.readOnly || !tr.selection) return tr;
  try {
    let changed = false;
    const ranges = tr.selection.ranges.map((range) => {
      // A non-empty selection is a document position the user chose. Hidden
      // chrome is a visual concern and must never rewrite it: selecting a
      // newline is legal editing behavior (WEB-ED-01).
      if (range.from !== range.to) return range;
      // Empty carets are left untouched. Visual chrome (a compressed table
      // divider) is not a reason to rewrite a legal document position, so the
      // delimiter can be reached by mouse and keyboard navigation alike.
      return range;
    });
    if (!changed) return tr;
    return [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex) }];
  } catch {
    return tr;
  }
});

/** Insert a raw newline inside fenced/indented code. Enter on an unclosed opening fence also closes it. */
export function codeBlockNewlineSpec(state) {
  if (state.readOnly) return null;
  const range = state.selection.main;
  if (!range.empty) return null;
  const pos = range.head;
  const fence = codeBlockCovering(state, pos);
  if (!fence) return null;
  const start = state.doc.lineAt(fence.from);
  const end = state.doc.lineAt(Math.max(fence.from, fence.to - 1));
  const line = state.doc.lineAt(pos);
  const closeMark = (start.text.match(/^\s*(`{3,}|~{3,})/) || [])[1] || "```";
  // An unclosed fence can still span body lines below the opening fence. Only
  // synthesize a closing fence when the opening fence is the whole node; with
  // body already present, Enter must open a body line, never inject a close
  // fence ahead of that body (WEB-ED fenced-code Enter boundary).
  const hasBody = start.number < end.number;
  const hasClose = hasBody && lineLooksLikeFence(end.text);
  if (lineLooksLikeFence(line.text) && line.number === start.number) {
    const insertAt = line.to;
    const insert = hasBody ? "\n" : `\n\n${closeMark}`;
    return {
      changes: { from: insertAt, insert },
      selection: EditorSelection.cursor(insertAt + 1),
    };
  }
  if (hasClose && lineLooksLikeFence(line.text) && line.number === end.number) {
    return {
      changes: { from: line.to, insert: "\n" },
      selection: EditorSelection.cursor(line.to + 1),
    };
  }
  const insertAt = fenceLineInsertPos(state, pos);
  return {
    changes: { from: insertAt, insert: "\n" },
    selection: EditorSelection.cursor(insertAt + 1),
  };
}

export function newlineInCodeBlock(view) {
  const spec = codeBlockNewlineSpec(view.state);
  if (!spec) return false;
  view.dispatch({ ...spec, scrollIntoView: true });
  return true;
}

/**
 * Live Enter command (not a selection filter). A click on heading/line padding
 * can select a single "\n" (full-width bar); default insertNewlineAndIndent
 * then replaces that newline with a newline, so Enter looks like a no-op. This
 * command keeps the blank line and inserts another. Any non-newline selection
 * is left alone for the default keymap. Collapsed caret inside a fence uses the
 * code path.
 */
export function liveNewlineSpec(state) {
  if (state.readOnly) return null;
  const range = state.selection.main;
  if (!range.empty) {
    const selected = state.sliceDoc(range.from, range.to);
    if (!/^\n+$/.test(selected)) return null;
    return {
      changes: { from: range.from, to: range.to, insert: `${selected}\n` },
      selection: EditorSelection.cursor(range.from + 1),
    };
  }
  return codeBlockNewlineSpec(state);
}

export function newlineInLive(view) {
  const spec = liveNewlineSpec(view.state);
  if (!spec) return false;
  view.dispatch({ ...spec, scrollIntoView: true });
  return true;
}

function normalizeLiveClickSelection(view, pointer) {
  if (!view || view.state.readOnly) return false;
  const selection = view.state.selection;
  const range = selection.main;
  const selected = range.empty ? "" : view.state.sliceDoc(range.from, range.to);
  const composing = Boolean(view.state.field(interactionField, false)?.composing);
  if (!shouldCollapsePaddingNewline({ pointer, selection, selected, composing })) return false;
  view.dispatch({ selection: EditorSelection.cursor(range.from) });
  return true;
}

/**
 * Padding-click workaround (WEB-ED-01).
 *
 * A left click on the empty padding beside a line can leave the browser with a
 * one-character "\n" DOM selection. The global transactionFilter collapse is
 * gone; this stays as a deliberately narrow pointer-source-specific fallback.
 *
 * It only fires for a recorded left-button pointerdown that landed outside the
 * rendered text of its line, with no Shift, no drag, no composition, no
 * multi-range and no keyboard-originated selection. A keydown or a non-left /
 * Shift pointerdown discards the record.
 *
 * Keep-or-delete: this remains until a real browser gate shows that the padding
 * click no longer produces the stray newline selection. See the Web editor
 * interaction TODO (PR-1).
 */
export function shouldCollapsePaddingNewline({ pointer, selection, selected, composing }) {
  if (!pointer || pointer.padding !== true) return false;
  if (pointer.button !== 0 || pointer.shiftKey === true || pointer.dragMoved === true) return false;
  if (composing === true) return false;
  if (!selection || selection.ranges.length !== 1) return false;
  if (selection.main.empty) return false;
  return selected === "\n";
}

const livePointerRecords = new WeakMap();

function pointerLandedOnLinePadding(view, event) {
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos == null) return false;
  const line = view.state.doc.lineAt(pos);
  const start = view.coordsAtPos(line.from, 1);
  const end = view.coordsAtPos(line.to, -1);
  if (!start || !end) return false;
  const left = Math.min(start.left, end.left);
  const right = Math.max(start.right, end.right);
  return event.clientX < left - 1 || event.clientX > right + 1;
}

export const collapseNewlineClick = EditorView.domEventHandlers({
  pointerdown(event, view) {
    if (event.button !== 0 || event.shiftKey) {
      livePointerRecords.delete(view);
      return false;
    }
    livePointerRecords.set(view, {
      button: event.button,
      shiftKey: false,
      padding: pointerLandedOnLinePadding(view, event),
      dragMoved: false,
    });
    return false;
  },
  keydown(_event, view) {
    livePointerRecords.delete(view);
    return false;
  },
  click(_event, view) {
    const pointer = livePointerRecords.get(view) || null;
    livePointerRecords.delete(view);
    if (!pointer) return false;
    const dragMoved = Boolean(view.state.field(interactionField, false)?.dragMoved);
    if (dragMoved) return false;
    requestAnimationFrame(() => normalizeLiveClickSelection(view, pointer));
    return false;
  },
});

