import { redo, undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { freezePointerSelection, releasePointerSelection } from "../interaction.js";
import { renderTableCellEditing, renderTableCellIdle } from "./table-cell-render.js";
import { clampDocPos, handoffAnchorPosition, pointerLeftBlock } from "./table-drag-handoff.js";

function cellSelector(row, col) {
  return `.cm-table-cell[data-table-row="${row}"][data-table-col="${col}"]`;
}

function selectionOffsetWithin(element) {
  const selection = element.ownerDocument.getSelection?.();
  if (!selection?.rangeCount) return String(element.textContent || "").length;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) return String(element.textContent || "").length;
  const probe = element.ownerDocument.createRange();
  probe.selectNodeContents(element);
  probe.setEnd(range.startContainer, range.startOffset);
  return probe.toString().length;
}

function selectEditorContents(editor) {
  const selection = editor.ownerDocument.getSelection?.();
  if (!selection) return;
  const range = editor.ownerDocument.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
}

function textPointAtOffset(root, offset) {
  const target = Math.max(0, Number(offset) || 0);
  const showText = root.ownerDocument.defaultView?.NodeFilter?.SHOW_TEXT ?? 4;
  const walker = root.ownerDocument.createTreeWalker(root, showText);
  let remaining = target;
  let node = walker.nextNode();
  let last = null;
  while (node) {
    const length = String(node.nodeValue || "").length;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
    last = node;
    node = walker.nextNode();
  }
  if (last) return { node: last, offset: String(last.nodeValue || "").length };
  return { node: root, offset: root.childNodes.length };
}

function setDOMSelection(editor, offset) {
  const documentRef = editor.ownerDocument;
  const selection = documentRef.getSelection?.();
  if (!selection) return;
  const point = textPointAtOffset(editor, offset);
  const range = documentRef.createRange();
  range.setStart(point.node, point.offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function interactionHost(view) {
  return view.dom.closest(".markdown-source-view") || view.dom;
}

function markDOMEdit(view, active) {
  interactionHost(view).classList.toggle("cm-table-dom-edit-active", Boolean(active));
}

function markDOMSelection(view, active) {
  interactionHost(view).classList.toggle("cm-table-dom-selection-active", Boolean(active));
}

function restoreEditorAfterHistory(view, row, col, offset) {
  requestAnimationFrame(() => {
    const editor = view.contentDOM
      .querySelector(cellSelector(row, col))
      ?.querySelector(".cm-table-cell-editor");
    if (!editor) return;
    const source = editor.dataset.sourceValue ?? "";
    editor.contentEditable = "true";
    editor.classList.add("is-editing");
    markDOMSelection(view, false);
    markDOMEdit(view, true);
    renderTableCellEditing(editor, source);
    editor.focus({ preventScroll: true });
    setDOMSelection(editor, Math.min(offset, source.length));
  });
}

function setCaretFromPoint(element, x, y) {
  const documentRef = element.ownerDocument;
  if (typeof documentRef.caretPositionFromPoint === "function") {
    const point = documentRef.caretPositionFromPoint(x, y);
    if (point?.offsetNode && element.contains(point.offsetNode)) {
      const range = documentRef.createRange();
      range.setStart(point.offsetNode, point.offset);
      range.collapse(true);
      const selection = documentRef.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
  }
  if (typeof documentRef.caretRangeFromPoint === "function") {
    const range = documentRef.caretRangeFromPoint(x, y);
    if (range?.startContainer && element.contains(range.startContainer)) {
      const selection = documentRef.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
  }
  setDOMSelection(element, String(element.textContent || "").length);
}

function pointerDomPoint(root, x, y) {
  const documentRef = root.ownerDocument;
  if (typeof documentRef.caretPositionFromPoint === "function") {
    const point = documentRef.caretPositionFromPoint(x, y);
    if (point?.offsetNode && root.contains(point.offsetNode)) {
      return { node: point.offsetNode, offset: point.offset };
    }
  }
  if (typeof documentRef.caretRangeFromPoint === "function") {
    const range = documentRef.caretRangeFromPoint(x, y);
    if (range?.startContainer && root.contains(range.startContainer)) {
      return { node: range.startContainer, offset: range.startOffset };
    }
  }
  const editor = documentRef.elementFromPoint?.(x, y)?.closest?.(".cm-table-cell-editor");
  if (!editor || !root.contains(editor)) return null;
  const rect = editor.getBoundingClientRect();
  return {
    node: editor,
    offset: x < (rect.left + rect.right) / 2 ? 0 : editor.childNodes.length,
  };
}

function setNativeTableSelection(root, anchor, focus) {
  if (!anchor || !focus) return false;
  const selection = root.ownerDocument.getSelection?.();
  if (!selection) return false;
  try {
    if (typeof selection.setBaseAndExtent === "function") {
      selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    } else {
      const range = root.ownerDocument.createRange();
      range.setStart(anchor.node, anchor.offset);
      range.setEnd(focus.node, focus.offset);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return !selection.isCollapsed;
  } catch {
    return false;
  }
}

function beginPointerSelection(view, editor, event) {
  if (editor.contentEditable === "true" || event.button !== 0) return false;
  if ((event.ctrlKey || event.metaKey) && event.target?.closest?.("a")) return false;
  const root = editor.closest(".cm-table-widget");
  if (!root) return false;
  const anchor = pointerDomPoint(root, event.clientX, event.clientY);
  if (!anchor) return false;

  event.preventDefault();
  event.stopPropagation();

  const documentRef = editor.ownerDocument;
  const pointerId = event.pointerId;
  const startX = event.clientX;
  const startY = event.clientY;
  let dragged = false;
  let handedOff = false;
  let handoffAnchor = null;
  let handoffFocus = null;

  const stopListening = () => {
    documentRef.removeEventListener("pointermove", move, true);
    documentRef.removeEventListener("pointerup", finish, true);
    documentRef.removeEventListener("pointercancel", finish, true);
    window.removeEventListener("blur", abandon);
  };

  const abandon = () => {
    // Window blur: no pointerup will ever arrive; never leave the shared freeze latched.
    if (handedOff) {
      handedOff = false;
      releasePointerSelection(view);
    }
    stopListening();
  };

  // A handed-off gesture belongs to the root editor: keep moving the head while
  // the anchor stays at the position the drag started from.
  const extendHandoff = (point) => {
    if (handoffAnchor == null) return;
    const focus = clampDocPos(view.posAtCoords({ x: point.x, y: point.y }, false), view.state.doc.length);
    if (focus == null || focus === handoffFocus) return;
    handoffFocus = focus;
    view.dispatch({ selection: EditorSelection.create([EditorSelection.range(handoffAnchor, focus)], 0) });
  };

  const handOff = (point) => {
    handedOff = true;
    markDOMSelection(view, false);
    documentRef.getSelection?.()?.removeAllRanges();
    // The table widget's own source range is authoritative: `posAtCoords` maps
    // every point inside a block widget onto one of its boundaries.
    handoffAnchor = handoffAnchorPosition({
      blockFrom: Number(root.dataset.tableFrom),
      blockTo: Number(root.dataset.tableTo),
      pointerPos: view.posAtCoords({ x: point.x, y: point.y }, false),
    });
    if (handoffAnchor == null) return;
    // Share the drag freeze: the table plugin stopped the pointerdown before it
    // reached attachInteractionHandlers, so without this Live Preview block and
    // decoration plugins would rebuild under the pointer mid-drag.
    freezePointerSelection(view);
    view.focus();
    extendHandoff(point);
  };

  const move = (moveEvent) => {
    if (moveEvent.pointerId !== pointerId) return;
    if (!dragged && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) >= 3) {
      dragged = true;
      markDOMEdit(view, false);
    }
    if (!dragged) return;
    if (handedOff) {
      extendHandoff(moveEvent);
      return;
    }
    // Leaving the table block is a cross-block drag: hand the gesture to the
    // root editor instead of pinning the focus point inside the widget.
    if (pointerLeftBlock(root.getBoundingClientRect(), { x: moveEvent.clientX, y: moveEvent.clientY })) {
      handOff(moveEvent);
      return;
    }
    const focus = pointerDomPoint(root, moveEvent.clientX, moveEvent.clientY);
    if (!focus) return;
    // Do not expose the table-selection state until a real non-collapsed DOM
    // range exists. selectionchange may fire between pointer events; marking
    // active before the range exists creates a race where the transient
    // collapsed selection clears the class and later copy falls back to the
    // root CodeMirror handler.
    if (setNativeTableSelection(root, anchor, focus)) markDOMSelection(view, true);
    moveEvent.preventDefault();
    moveEvent.stopPropagation();
  };

  const finish = (upEvent) => {
    if (upEvent.pointerId !== pointerId) return;
    stopListening();
    if (handedOff) {
      handedOff = false;
      releasePointerSelection(view);
      return;
    }
    if (dragged) {
      const focus = pointerDomPoint(root, upEvent.clientX, upEvent.clientY);
      const selected = focus ? setNativeTableSelection(root, anchor, focus) : false;
      markDOMSelection(view, selected || Boolean(documentRef.getSelection?.()?.toString()));
      upEvent.preventDefault();
      upEvent.stopPropagation();
      return;
    }
    markDOMSelection(view, false);
    documentRef.getSelection?.()?.removeAllRanges();
    activateEditor(view, editor, upEvent);
    upEvent.preventDefault();
    upEvent.stopPropagation();
  };

  documentRef.addEventListener("pointermove", move, true);
  documentRef.addEventListener("pointerup", finish, true);
  documentRef.addEventListener("pointercancel", finish, true);
  window.addEventListener("blur", abandon);
  return true;
}

function normalizeCellSource(value) {
  const source = String(value ?? "").replace(/\r\n?|\n/gu, "<br>");
  let output = "";
  let backslashes = 0;
  for (const char of source) {
    if (char === "\\") {
      output += char;
      backslashes += 1;
      continue;
    }
    if (char === "|" && backslashes % 2 === 0) output += "\\";
    output += char;
    backslashes = 0;
  }
  return output;
}

function currentTableStart(view, editor) {
  const root = editor.closest(".cm-table-widget");
  if (!root) return null;
  try {
    const pos = view.posAtDOM(root, 0);
    if (Number.isInteger(pos)) return pos;
  } catch {
    // A detached widget can race a blur event during a document refresh.
  }
  const fallback = Number(root.dataset.tableFrom);
  return Number.isInteger(fallback) ? fallback : null;
}

function editorSourceRange(view, editor) {
  const tableFrom = currentTableStart(view, editor);
  const offsetFrom = Number(editor.dataset.sourceOffsetFrom);
  const offsetTo = Number(editor.dataset.sourceOffsetTo);
  if (!Number.isInteger(tableFrom)
    || !Number.isInteger(offsetFrom)
    || !Number.isInteger(offsetTo)
    || offsetFrom > offsetTo) return null;
  return { from: tableFrom + offsetFrom, to: tableFrom + offsetTo };
}

function commitEditor(view, editor, userEvent = "input.type") {
  const sourceRange = editorSourceRange(view, editor);
  const previous = editor.dataset.sourceValue ?? "";
  const domValue = String(editor.textContent ?? "").replace(/\u00a0/gu, " ");
  const next = normalizeCellSource(domValue);
  if (!sourceRange || next === previous) return false;
  const { from, to } = sourceRange;
  if (view.state.sliceDoc(from, to) !== previous) return false;
  view.dispatch({
    changes: { from, to, insert: next },
    userEvent,
  });
  editor.dataset.sourceValue = next;
  editor.dataset.sourceOffsetTo = String(Number(editor.dataset.sourceOffsetFrom) + next.length);
  return true;
}

function activateEditor(view, editor, event) {
  if (!editor || view.state.readOnly || editor.contentEditable === "true") return;
  markDOMSelection(view, false);
  markDOMEdit(view, true);
  editor.contentEditable = "true";
  editor.classList.add("is-editing");
  renderTableCellEditing(editor, editor.dataset.sourceValue ?? "");
  editor.focus({ preventScroll: true });
  setCaretFromPoint(editor, event.clientX, event.clientY);
}

function focusCell(view, row, col, atEnd = false) {
  requestAnimationFrame(() => {
    const editor = view.dom.querySelector(cellSelector(row, col))?.querySelector(".cm-table-cell-editor");
    if (!editor) return;
    const rect = editor.getBoundingClientRect();
    activateEditor(view, editor, {
      clientX: atEnd ? rect.right - 2 : rect.left + 2,
      clientY: (rect.top + rect.bottom) / 2,
    });
  });
}

function moveTarget(model, row, col, direction) {
  const flat = [];
  model.rows.forEach((entry, rowIndex) => {
    entry.cells.forEach((_cell, colIndex) => flat.push({ row: rowIndex, col: colIndex }));
  });
  const index = flat.findIndex((item) => item.row === row && item.col === col);
  if (index < 0) return null;
  const next = Math.max(0, Math.min(flat.length - 1, index + direction));
  return flat[next] || null;
}

function finishEditor(view, editor) {
  editor.contentEditable = "false";
  editor.classList.remove("is-editing");
  renderTableCellIdle(editor, editor.dataset.sourceValue ?? "");
  if (!view.contentDOM.querySelector(".cm-table-cell-editor.is-editing")) markDOMEdit(view, false);
}

export function bindTableCellEditor(view, cellElement, model, rowIndex, colIndex) {
  const editor = cellElement.querySelector(".cm-table-cell-editor");
  let composing = false;
  const scheduleCommit = () => {
    // Keep EditorState.doc as the synchronous source of truth. A delayed DOM-
    // only edit creates a window where a clean external refresh can overwrite
    // input before the document/session becomes dirty.
    if (!composing) commitEditor(view, editor);
  };

  editor.addEventListener("pointerdown", (event) => {
    beginPointerSelection(view, editor, event);
  });
  editor.addEventListener("input", scheduleCommit);
  editor.addEventListener("compositionstart", () => {
    composing = true;
  });
  editor.addEventListener("compositionend", () => {
    composing = false;
    commitEditor(view, editor, "input.type.compose");
  });
  editor.addEventListener("blur", () => {
    commitEditor(view, editor);
    finishEditor(view, editor);
  });
  editor.addEventListener("keydown", (event) => {
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (modifier && key === "a" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      selectEditorContents(editor);
      return;
    }
    if (modifier && (key === "z" || key === "y")) {
      event.preventDefault();
      event.stopPropagation();
      const offset = selectionOffsetWithin(editor);
      commitEditor(view, editor);
      if (key === "y" || (key === "z" && event.shiftKey)) redo(view);
      else undo(view);
      restoreEditorAfterHistory(view, rowIndex, colIndex, offset);
      return;
    }
    if (event.key !== "Tab" && event.key !== "Enter") return;
    event.preventDefault();
    commitEditor(view, editor);
    const direction = event.shiftKey ? -1 : 1;
    const target = moveTarget(model, rowIndex, colIndex, direction);
    if (target) focusCell(view, target.row, target.col, direction > 0);
  });
}
