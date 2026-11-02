import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  TABLE_DRAG_HANDOFF_TOLERANCE_PX,
  clampDocPos,
  handoffAnchorPosition,
  pointerLeftBlock,
} from "../frontend/app/features/editor/extensions/table-drag-handoff.js";

const editorRoot = new URL("../frontend/app/features/editor/", import.meta.url);
const readEditor = (relative) => fs.readFileSync(fileURLToPath(new URL(relative, editorRoot)), "utf8");
const tableCellEditor = readEditor("extensions/table-cell-editor.js");
const interaction = readEditor("interaction.js");

const block = { left: 100, right: 400, top: 50, bottom: 200 };

test("H1-DRAG-01 a focus point inside the table block keeps the in-table gesture", () => {
  assert.equal(pointerLeftBlock(block, { x: 120, y: 80 }), false);
  assert.equal(pointerLeftBlock(block, { x: 100, y: 50 }), false);
  // Within tolerance of the border is still inside: the widget border and the
  // pointer coordinate differ by sub-pixel rounding.
  assert.equal(pointerLeftBlock(block, { x: 99, y: 80 }), false);
  assert.equal(pointerLeftBlock(block, { x: 401, y: 80 }), false);
});

test("H1-DRAG-02 a focus point outside the table block must hand off to the root editor", () => {
  assert.equal(pointerLeftBlock(block, { x: 40, y: 80 }), true);
  assert.equal(pointerLeftBlock(block, { x: 460, y: 80 }), true);
  assert.equal(pointerLeftBlock(block, { x: 120, y: 20 }), true);
  assert.equal(pointerLeftBlock(block, { x: 120, y: 260 }), true);
  // Beyond tolerance only: a one-pixel excursion stays in the table.
  assert.equal(pointerLeftBlock(block, { x: 100 - TABLE_DRAG_HANDOFF_TOLERANCE_PX - 0.5, y: 80 }), true);
  // Missing geometry never hands off (no invented rectangle).
  assert.equal(pointerLeftBlock(null, { x: 0, y: 0 }), false);
  assert.equal(pointerLeftBlock(block, null), false);
  assert.equal(pointerLeftBlock(block, { x: Number.NaN, y: 0 }), false);
});

test("H1-DRAG-03 handoff positions are clamped into the document", () => {
  assert.equal(clampDocPos(0, 10), 0);
  assert.equal(clampDocPos(9.6, 10), 10);
  assert.equal(clampDocPos(42, 10), 10);
  assert.equal(clampDocPos(-5, 10), 0);
  assert.equal(clampDocPos(Number.NaN, 10), null);
  assert.equal(clampDocPos(null, 10), null);
});

test("H1-DRAG-03b a leaving drag anchors at the far edge of the block it left", () => {
  // Drag started inside the table and continued below it: include the block.
  assert.equal(handoffAnchorPosition({ blockFrom: 46, blockTo: 132, pointerPos: 140 }), 46);
  // Drag continued above it: include the block from its end.
  assert.equal(handoffAnchorPosition({ blockFrom: 46, blockTo: 132, pointerPos: 20 }), 132);
  // A degenerate/absent block range or pointer position never invents an anchor.
  assert.equal(handoffAnchorPosition({ blockFrom: null, blockTo: null, pointerPos: 140 }), 140);
  assert.equal(handoffAnchorPosition({ blockFrom: 46, blockTo: 132, pointerPos: null }), null);
  assert.equal(handoffAnchorPosition(), null);
  // Reversed block bounds still resolve to a consistent edge.
  assert.equal(handoffAnchorPosition({ blockFrom: 132, blockTo: 46, pointerPos: 140 }), 46);
});

test("H1-DRAG-04 table-cell-editor hands a leaving drag to the shared freeze", () => {
  assert.match(tableCellEditor, /from "\.\/table-drag-handoff\.js"/);
  assert.match(tableCellEditor, /pointerLeftBlock\(/);
  assert.match(tableCellEditor, /freezePointerSelection\(/);
  assert.match(tableCellEditor, /releasePointerSelection\(/);
  // The handoff must hand the gesture to the root editor selection, not keep
  // pinning the focus point inside the widget.
  assert.match(tableCellEditor, /EditorSelection\.range\(/);
  assert.match(tableCellEditor, /posAtCoords\(/);
});

test("H1-DRAG-05 interaction.js owns a shared, releasable pointer freeze", () => {
  assert.match(interaction, /export function freezePointerSelection\(/);
  assert.match(interaction, /export function releasePointerSelection\(/);
  // A nested surface (the table block) stops the pointerdown before it reaches
  // attachInteractionHandlers; the window pointerup must therefore also clear a
  // freeze it did not set itself, or the editor stays frozen after the drag.
  assert.match(interaction, /const endPointer = \(\) => \{[\s\S]*?releasePointerSelection\(view\)/);
});

test("H1-DRAG-06 the in-table native selection path is preserved", () => {
  // These are the exact behaviours app/scripts/web-regression.mjs pins for a
  // drag that stays inside the table.
  assert.match(tableCellEditor, /function beginPointerSelection/);
  assert.match(tableCellEditor, /addEventListener\("pointerdown"/);
  assert.match(tableCellEditor, /selection\.setBaseAndExtent/);
  assert.match(tableCellEditor, /Math\.hypot/);
  assert.match(tableCellEditor, /markDOMSelection\(view, true\)/);
  assert.match(tableCellEditor, /markDOMEdit\(view, false\)/);
});
