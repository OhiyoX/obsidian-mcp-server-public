import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { GFM } from "@lezer/markdown";
import {
  assetKey,
  assetRevisionKey,
  canonicalPath,
  collectAssetPaths,
  eventMatchesAssets,
  extractHeadings,
  frontmatterEndOffset,
  headingPlainText,
  selectionIsOnPropertiesWidget,
  cursorAfterFrontmatter,
  semanticDefinitionFingerprint,
  simpleHash,
} from "../frontend/app/features/editor/markdown-model.js";

function stateOf(doc) {
  return EditorState.create({ doc, extensions: [markdown({ extensions: GFM })] });
}

test("extractHeadings supports Setext, skips fenced code and frontmatter", () => {
  const doc = [
    "---",
    "title: ignore",
    "---",
    "",
    "# Alpha",
    "",
    "```js",
    "# fake",
    "```",
    "",
    "Setext Title",
    "===========",
    "",
    "## Dup",
    "",
    "## Dup",
  ].join("\n");

  const headings = extractHeadings(stateOf(doc));
  assert.deepEqual(
    headings.map((item) => ({ id: item.id, level: item.level, text: item.text })),
    [
      { id: "alpha", level: 1, text: "Alpha" },
      { id: "setext-title", level: 1, text: "Setext Title" },
      { id: "dup", level: 2, text: "Dup" },
      { id: "dup-2", level: 2, text: "Dup" },
    ],
  );
  assert.equal(headings.every((item) => Number.isInteger(item.from) && item.to > item.from), true);
  assert.equal(headings.some((item) => item.text === "fake"), false);
  assert.equal(frontmatterEndOffset(doc) > 0, true);
});

test("extractHeadings normalizes bold, links, quote prefixes, and multi-line Setext", () => {
  const doc = [
    "> # Quoted **Bold** and [link](https://example.com/x)",
    "",
    "Multi line",
    "setext heading",
    "---------------",
  ].join("\n");

  const state = stateOf(doc);
  const headings = extractHeadings(state);
  assert.equal(headings.length >= 2, true);
  assert.equal(headings[0].text.includes("**"), false);
  assert.equal(headings[0].text.includes("https://"), false);
  assert.equal(headings[0].text.includes("Bold"), true);
  assert.equal(headings[0].text.includes("link"), true);
  assert.equal(headings[0].text.startsWith(">"), false);
  const setext = headings.find((item) => /setext/i.test(item.text) || /multi/i.test(item.text));
  assert.ok(setext);
  assert.equal(setext.text.includes("Multi"), true);
  assert.equal(setext.text.includes("setext"), true);
  assert.equal(setext.text.includes("---"), false);
});

test("frontmatterEndOffset scans full docs without a silent 20k cutoff", () => {
  // Many short YAML lines (>20k) — avoid a single `---` underline false Setext parse.
  const pad = Array.from({ length: 2200 }, (_, index) => `k${index}: v${index}`).join("\n");
  const doc = `---\n${pad}\n---\n\n# After\n`;
  assert.equal(frontmatterEndOffset(doc) > 20000, true);
  const state = stateOf(doc);
  assert.equal(frontmatterEndOffset(state.doc) > 20000, true);
  const headings = extractHeadings(state);
  assert.equal(headings.length, 1);
  assert.equal(headings[0].text, "After");
});

test("Live caret after YAML is not treated as sitting on the properties widget", () => {
  const sample = "---\ntitle: A\n---\n\n# Body\n";
  const fmEnd = frontmatterEndOffset(sample);
  assert.equal(fmEnd > 0, true);
  assert.equal(cursorAfterFrontmatter(sample), fmEnd);
  assert.equal(cursorAfterFrontmatter("no yaml\n"), 0);
  assert.equal(selectionIsOnPropertiesWidget([{ from: 0, to: 0 }], sample), true);
  assert.equal(selectionIsOnPropertiesWidget([{ from: 0, to: fmEnd }], sample), true);
  assert.equal(selectionIsOnPropertiesWidget([{ from: fmEnd, to: fmEnd }], sample), false);
  assert.equal(selectionIsOnPropertiesWidget([{ from: sample.indexOf("title"), to: sample.indexOf("title") }], sample), true);
  assert.equal(selectionIsOnPropertiesWidget([{ from: 0, to: sample.length }], sample), false);
});

test("headingPlainText strips emphasis marks via syntax model", () => {
  const state = stateOf("# Hello **World**");
  let heading = null;
  syntaxTree(state).iterate({
    enter(node) {
      if (/^ATXHeading/.test(node.name)) heading = node;
    },
  });
  assert.ok(heading);
  assert.equal(headingPlainText(state, heading), "Hello World");
});

test("semanticDefinitionFingerprint ignores ordinary body edits", () => {
  const defs = "[ref]: https://example.com\n\n[^1]: note";
  assert.equal(
    semanticDefinitionFingerprint(`Hello\n\n${defs}`),
    semanticDefinitionFingerprint(`Hello world\n\n${defs}`),
  );
  assert.notEqual(
    semanticDefinitionFingerprint(`Hello\n\n${defs}`),
    semanticDefinitionFingerprint(`Hello\n\n[ref]: https://other.com\n\n[^1]: note`),
  );
  assert.equal(typeof simpleHash("a"), "string");
});

test("asset dependency matching uses canonical path and vault", () => {
  const paths = collectAssetPaths("![x](../images/pic.png)\n![[folder/a.png]]", "notes/demo.md");
  assert.deepEqual(paths.sort(), ["images/pic.png", "notes/folder/a.png"].sort());
  assert.equal(canonicalPath("notes\\\\a.png"), "notes/a.png");
  assert.equal(assetKey("vault-a", "notes/a.png"), "vault-a::notes/a.png");
  assert.equal(
    eventMatchesAssets(
      { vaultId: "vault-a", path: "images/pic.png", revision: "r2" },
      paths,
      "vault-a",
    ),
    true,
  );
  assert.equal(
    eventMatchesAssets(
      { vaultId: "other", path: "images/pic.png", revision: "r2" },
      paths,
      "vault-a",
    ),
    false,
  );
  const key1 = assetRevisionKey(paths, "vault-a", { [assetKey("vault-a", "images/pic.png")]: "1" });
  const key2 = assetRevisionKey(paths, "vault-a", { [assetKey("vault-a", "images/pic.png")]: "2" });
  assert.notEqual(key1, key2);
});
