import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { readSourceTree } from "./helpers/source-tree.js";
import { fileURLToPath } from "node:url";
import {
  coercePropertyInput,
  parseFrontmatterBlock,
  serializeFrontmatter,
} from "../frontend/app/features/editor/frontmatter.js";
import { buildBlockDecorations, liveBlockField, liveMetaField } from "../frontend/app/features/editor/live-preview.js";
import { interactionField } from "../frontend/app/features/editor/interaction.js";
import { EditorSelection, EditorState } from "@codemirror/state";
import { foldable } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";

const sample = `---
title: Original
tags:
  - alpha
published: false
---

# Body
`;

test("frontmatter parse/serialize round-trips mappings", () => {
  const parsed = parseFrontmatterBlock(sample);
  assert.equal(parsed.data.title, "Original");
  assert.deepEqual(parsed.data.tags, ["alpha"]);
  assert.equal(parsed.data.published, false);
  const next = serializeFrontmatter({ ...parsed.data, title: "Edited" });
  assert.match(next, /^---\n/);
  assert.match(next, /title: Edited/);
  assert.match(next, /published: false/);
  assert.deepEqual(coercePropertyInput("tags", "a, b", []), ["a", "b"]);
  assert.equal(coercePropertyInput("published", "true", false), true);
});

test("closed frontmatter stays a properties widget at the default doc-start caret", () => {
  const state = EditorState.create({
    doc: sample,
    selection: EditorSelection.cursor(0),
    extensions: [markdown({ extensions: GFM }), interactionField, liveMetaField, liveBlockField],
  });
  let widgets = 0;
  buildBlockDecorations(state).between(0, state.doc.length, (_from, _to, value) => {
    if (value.spec?.widget?.constructor?.name === "PropertiesWidget") widgets += 1;
  });
  assert.equal(widgets, 1);
});

test("closed frontmatter stays a properties widget even when the caret is inside YAML", () => {
  const inside = sample.indexOf("title:");
  const state = EditorState.create({
    doc: sample,
    selection: EditorSelection.cursor(inside),
    extensions: [markdown({ extensions: GFM }), interactionField, liveMetaField, liveBlockField],
  });
  let properties = 0;
  let yamlBars = 0;
  buildBlockDecorations(state).between(0, state.doc.length, (_from, _to, value) => {
    const name = value.spec?.widget?.constructor?.name;
    if (name === "PropertiesWidget") properties += 1;
    if (name === "YamlSourceBar") yamlBars += 1;
  });
  assert.equal(properties, 1);
  assert.equal(yamlBars, 0);
});

test("closed frontmatter does not unwrap to YAML source", () => {
  const inside = sample.indexOf("title:");
  const state = EditorState.create({
    doc: sample,
    selection: EditorSelection.cursor(inside),
    extensions: [markdown({ extensions: GFM }), interactionField, liveMetaField, liveBlockField],
  });
  let widgets = 0;
  buildBlockDecorations(state).between(0, state.doc.length, (_from, _to, value) => {
    if (value.spec?.widget?.constructor?.name === "PropertiesWidget") widgets += 1;
  });
  assert.equal(widgets, 1);
});

test("closed frontmatter stays a properties widget after selection enters YAML", () => {
  let state = EditorState.create({
    doc: sample,
    selection: EditorSelection.cursor(sample.length - 1),
    extensions: [markdown({ extensions: GFM }), interactionField, liveMetaField, liveBlockField],
  });
  let decorations = buildBlockDecorations(state);
  let widgets = 0;
  decorations.between(0, state.doc.length, (_from, _to, value) => {
    if (value.spec?.widget?.constructor?.name === "PropertiesWidget") widgets += 1;
  });
  assert.equal(widgets, 1);

  state = state.update({ selection: EditorSelection.cursor(sample.indexOf("tags:")) }).state;
  decorations = buildBlockDecorations(state);
  widgets = 0;
  decorations.between(0, state.doc.length, (_from, _to, value) => {
    if (value.spec?.widget?.constructor?.name === "PropertiesWidget") widgets += 1;
  });
  assert.equal(widgets, 1);
});

test("read-only surface keeps properties panel even with selection in YAML", () => {
  const state = EditorState.create({
    doc: sample,
    selection: EditorSelection.cursor(0),
    extensions: [
      markdown({ extensions: GFM }),
      interactionField,
      liveMetaField,
      liveBlockField,
      EditorState.readOnly.of(true),
    ],
  });
  let widgets = 0;
  buildBlockDecorations(state).between(0, state.doc.length, (_from, _to, value) => {
    if (value.spec?.widget?.constructor?.name === "PropertiesWidget") widgets += 1;
  });
  assert.equal(widgets, 1);
});

test("H1 immediately after YAML is still a foldable heading section", () => {
  const doc = `---
title: T
---
# Title after yaml

body under the heading
`;
  const state = EditorState.create({
    doc,
    extensions: [markdown({ extensions: GFM })],
  });
  const line = state.doc.lineAt(doc.indexOf("# Title"));
  const range = foldable(state, line.from, line.to);
  assert.equal(range != null, true);
  assert.equal(range.from > line.from, true);
  assert.equal(state.sliceDoc(range.from, range.to).includes("body under the heading"), true);
});

test("properties widget ends before an H1 that immediately follows YAML", () => {
  const doc = `---
title: T
---
# T
`;
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(doc.length - 1),
    extensions: [markdown({ extensions: GFM }), interactionField, liveMetaField, liveBlockField],
  });
  const headingFrom = doc.indexOf("# T");
  assert.equal(headingFrom > 0, true);
  let widgetTo = -1;
  buildBlockDecorations(state).between(0, state.doc.length, (from, to, value) => {
    if (value.spec?.widget?.constructor?.name === "PropertiesWidget") widgetTo = to;
  });
  assert.equal(widgetTo > 0, true);
  assert.equal(widgetTo <= headingFrom, true);
});

test("properties heading uses the live-preview toggle class, not a raw button chrome", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("../frontend/app/features/document/properties-panel.js", import.meta.url)),
    "utf8",
  );
  assert.equal(source.includes("cm-live-properties-toggle"), true);
  assert.equal(source.includes("cm-live-property-actions"), true);
  assert.equal(source.includes("cm-live-property-object-code"), true);
  assert.equal(source.includes("cm-live-tag-pill"), true);
  assert.equal(source.includes("cm-live-property-object-fields"), false);
  assert.equal(source.includes('icon("x"'), false);
});

test("properties widget keeps the CM caret out of the block and has no YAML source mode", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("../frontend/app/features/editor/properties-widget.js", import.meta.url)),
    "utf8",
  );
  assert.equal(source.includes("YamlSourceBar"), false);
  assert.equal(source.includes("onEditSource"), false);
  assert.equal(source.includes("退出 YAML"), false);
  assert.equal(source.includes('contenteditable", "false"'), true);
  assert.equal(source.includes("event.preventDefault()"), true);
  assert.equal(source.includes("from + nextSource.length"), false);
  const editor = readSourceTree(new URL("../frontend/app/features/editor/", import.meta.url));
  assert.equal(editor.includes("leavePropertiesWidget"), true);
  assert.equal(editor.includes("cursorAfterFrontmatter(text)"), true);
  const panel = fs.readFileSync(
    fileURLToPath(new URL("../frontend/app/features/document/properties-panel.js", import.meta.url)),
    "utf8",
  );
  assert.equal(panel.includes("编辑 YAML"), false);
  assert.equal(panel.includes("onEditSource"), false);
});

test("properties widget spacing uses padding so CM heightmap can see it", () => {
  const css = fs.readFileSync(
    fileURLToPath(new URL("../src/app/assets/app.css", import.meta.url)),
    "utf8",
  );
  assert.match(css, /\.cm-live-properties\s*\{[^}]*padding:\s*0 0 1\.4em/s);
  assert.equal(/\n\.cm-live-properties\s*\{[^}]*margin:\s*0 0 1\.4em/s.test(css), false);
  assert.match(css, /\.cm-live-property-actions\s*\{[^}]*align-items:\s*center/s);
  assert.equal(/\.cm-live-yaml-source-bar\s*\{/s.test(css), false);
  assert.match(css, /\.cm-live-properties\s*\{[^}]*caret-color:\s*transparent/s);
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\)[\s\S]*?\.cm-live-property-remove\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none[^}]*\}[\s\S]*?\.document-property-row:hover > \.cm-live-property-remove/s);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.cm-live-properties\.is-editable \.cm-live-property-remove\s*\{[^}]*position:\s*absolute[^}]*width:\s*44px[^}]*height:\s*44px[^}]*opacity:\s*\.42[^}]*pointer-events:\s*auto/s);
});
