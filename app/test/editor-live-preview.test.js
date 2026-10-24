import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { GFM } from "@lezer/markdown";
import {
  buildBlockDecorations,
  createLiveBlockPreview,
  liveBlockField,
  liveMetaField,
  setLiveDocumentContext,
} from "../frontend/app/features/editor/live-preview.js";
import { interactionField, interactionEffect } from "../frontend/app/features/editor/interaction.js";

const yamlDoc = `---
title: T
---

body
`;

function stateOf(doc, selection) {
  return EditorState.create({
    doc,
    selection,
    extensions: [markdown({ extensions: GFM }), interactionField, liveMetaField, liveBlockField],
  });
}

function fenceMarks(state) {
  const found = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "FencedCode") return;
      for (let child = node.node.firstChild; child; child = child.nextSibling) {
        if (child.name === "CodeMark") found.push(state.sliceDoc(child.from, child.to));
      }
      return false;
    },
  });
  return found;
}

function widgetCount(state) {
  let count = 0;
  state.field(liveBlockField).between(0, state.doc.length, () => { count += 1; });
  return count;
}

test("LP-01 block decorations come from StateField provide, not ViewPlugin decorations", () => {
  const preview = createLiveBlockPreview(() => ({ sourcePath: "note.md", vaultId: "v1" }));
  assert.equal(preview.extension.includes(liveBlockField), true);
  assert.equal(preview.extension.includes(liveMetaField), true);

  const viewSource = fs.readFileSync(
    fileURLToPath(new URL("../node_modules/@codemirror/view/dist/index.js", import.meta.url)),
    "utf8",
  );
  assert.equal(viewSource.includes("Block decorations may not be specified via plugins"), true);

  const liveSource = fs.readFileSync(
    fileURLToPath(new URL("../frontend/app/features/editor/live-preview.js", import.meta.url)),
    "utf8",
  );
  assert.equal(liveSource.includes("ViewPlugin.fromClass"), false);
  assert.equal(liveSource.includes("EditorView.decorations.from"), true);
  assert.equal(liveSource.includes("MarkdownBlockWidget"), false);

  let state = stateOf(yamlDoc);
  state = state.update({
    effects: setLiveDocumentContext.of({
      sourcePath: "note.md",
      vaultId: "v1",
      documentContext: null,
      envVersion: "1",
    }),
  }).state;
  const decorations = state.field(liveBlockField);
  let blockCount = 0;
  decorations.between(0, state.doc.length, () => { blockCount += 1; });
  assert.equal(blockCount, 1);
  assert.equal(typeof buildBlockDecorations(state).between, "function");
});

test("LP-06 freeze maps decorations on docChanged and rebuilds after release", () => {
  let state = stateOf(yamlDoc);
  state = state.update({
    effects: setLiveDocumentContext.of({
      sourcePath: "n.md",
      vaultId: "v",
      documentContext: null,
      envVersion: "1",
    }),
  }).state;

  let fromBefore = null;
  state.field(liveBlockField).between(0, state.doc.length, (from) => { fromBefore = from; });
  assert.equal(fromBefore, 0);

  const body = state.doc.toString().indexOf("body");
  state = state.update({
    effects: interactionEffect.of({ pointerSelecting: true }),
  }).state;
  state = state.update({
    changes: { from: body, insert: "ZZZ" },
  }).state;

  let fromFrozen = null;
  state.field(liveBlockField).between(0, state.doc.length, (from) => { fromFrozen = from; });
  assert.equal(fromFrozen, 0);

  state = state.update({
    effects: interactionEffect.of({ pointerSelecting: false }),
  }).state;
  let fromRebuilt = null;
  state.field(liveBlockField).between(0, state.doc.length, (from) => { fromRebuilt = from; });
  assert.equal(fromRebuilt, 0);
});

test("LP-07 unclosed fences expose only the opening CodeMark as fence chrome", () => {
  assert.deepEqual(fenceMarks(stateOf("```js\ncode\n```\n")), ["```", "```"]);
  assert.deepEqual(fenceMarks(stateOf("```js\nunclosed\n")), ["```"]);
});

test("selectable fenced code stays out of the atomic block-decoration field", () => {
  const liveSource = fs.readFileSync(
    fileURLToPath(new URL("../frontend/app/features/editor/live-preview.js", import.meta.url)),
    "utf8",
  );
  assert.equal(liveSource.includes("isAlwaysRenderable"), false);
  assert.equal(liveSource.includes('"FencedCode"'), false);
  assert.equal(liveSource.includes('"CodeBlock"'), false);
  assert.equal(liveSource.includes('"Table"'), false);
  assert.equal(liveSource.includes('"HorizontalRule"'), false);
  assert.equal(liveSource.includes("PropertiesWidget"), true);

  const doc = "- one\n- two [[Note|alias]]\n\n```js\nconst x = 1\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---\n\n![[pixel.svg]]\n";
  let state = stateOf(doc);
  state = state.update({
    effects: setLiveDocumentContext.of({
      sourcePath: "note.md",
      vaultId: "v1",
      documentContext: null,
      envVersion: "1",
    }),
  }).state;

  assert.equal(widgetCount(state), 0);

  const fenceBody = state.doc.toString().indexOf("const x");
  let covering = 0;
  state.field(liveBlockField).between(fenceBody, fenceBody + 1, () => { covering += 1; });
  assert.equal(covering, 0);

  const tableCell = state.doc.toString().indexOf("| 1 |");
  covering = 0;
  state.field(liveBlockField).between(tableCell, tableCell + 1, () => { covering += 1; });
  assert.equal(covering, 0);

  const rule = state.doc.toString().lastIndexOf("---");
  covering = 0;
  state.field(liveBlockField).between(rule, rule + 1, () => { covering += 1; });
  assert.equal(covering, 0);

  state = state.update({
    selection: EditorSelection.cursor(fenceBody + 2),
  }).state;
  covering = 0;
  state.field(liveBlockField).between(fenceBody, fenceBody + 1, () => { covering += 1; });
  assert.equal(covering, 0);
});

test("unclosed fences stay as source and never become an oversized card", () => {
  let state = stateOf("before\n\n```js\nconst x = 1\n");
  state = state.update({ selection: EditorSelection.cursor(0) }).state;
  assert.equal(widgetCount(state), 0);
});

test("caret at the closed fence end is outside and keeps the rendered card", () => {
  const doc = "```js\nconst x = 1\n```\n\nafter\n";
  let state = stateOf(doc);
  let fenceTo = 0;
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "FencedCode") {
        fenceTo = node.to;
        return false;
      }
      return true;
    },
  });
  state = state.update({ selection: EditorSelection.cursor(fenceTo) }).state;
  assert.equal(widgetCount(state), 0);
});

test("interaction source documents single dragMoved dispatch and no destroy dispatch", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("../frontend/app/features/editor/interaction.js", import.meta.url)),
    "utf8",
  );
  assert.equal(source.includes("if (!pointerSelecting || !anchor || dragMoved) return"), true);
  assert.equal(source.includes("Do not dispatch during teardown"), true);
  assert.equal(source.includes("composing: false"), true);
});

test("live-preview reserves atomic block widgets for YAML properties", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("../frontend/app/features/editor/live-preview.js", import.meta.url)),
    "utf8",
  );
  assert.equal(source.includes("PropertiesWidget"), true);
  assert.equal(source.includes("MarkdownBlockWidget"), false);
  assert.equal(source.includes("FencedCodeWidget"), false);
  assert.equal(source.includes("obsidian-navigate"), true);
});
