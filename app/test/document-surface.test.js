import assert from "node:assert/strict";
import test from "node:test";
import { readSourceTree } from "./helpers/source-tree.js";
import {
  isEditableSurface,
  isLiveSurface,
  normalizeSurfaceMode,
  surfaceUsesEditor,
} from "../frontend/app/features/document/surface-mode.js";

test("surface modes distinguish editable live from read-only preview", () => {
  assert.equal(normalizeSurfaceMode("preview"), "preview");
  assert.equal(isLiveSurface("live"), true);
  assert.equal(isLiveSurface("preview"), false);
  assert.equal(isLiveSurface("raw"), false);
  assert.equal(isEditableSurface("live"), true);
  assert.equal(isEditableSurface("preview"), false);
  assert.equal(surfaceUsesEditor("preview"), false);
  assert.equal(surfaceUsesEditor("raw"), true);
});

test("reading view renders HTML preview instead of a CodeMirror caret", () => {
  const source = readSourceTree(new URL("../frontend/app/", import.meta.url));
  assert.equal(source.includes("renderObsidianMarkdown"), true);
  assert.equal(source.includes("bindPreviewNodes"), true);
  assert.equal(source.includes("leavePropertiesCaret"), true);
});
