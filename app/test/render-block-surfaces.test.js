// §4 item 3 — Live Preview canonical surface of callout / embed / footnote
// (offline guards).
//
// The Reader half of this file was removed in BLOCK-R2. The Reader callout /
// footnote / embed surface is owned by U15 (`reader/callout-render.js`,
// `reader/footnote-rules.js`, `test/reader-callout-footnote-canonical.test.js`)
// and the BLOCK Reader module those cases pinned
// (`reader/block-surfaces.js`) was deleted by the U15 merge, so every Reader
// assertion here was stale by construction. What remains are the Live-side
// helpers: the callout source model + block scanner and the in-place embed
// chrome. The browser-level class / attribute / computed-paint proof lives in
// `scripts/render-parity-block-surfaces.mjs` (Live classes + paint) and
// `scripts/render-parity-phase1-theme.mjs` (both hosts, with mutation control).
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Text } from "@codemirror/state";
import { installDomShim } from "./dom-shim.mjs";

register("./css-stub-loader.mjs", import.meta.url);
installDomShim();

const { calloutSurfaceModel, scanCalloutBlocks } = await import(
  "../frontend/app/features/editor/extensions/block-callout.js"
);
const { embedSurfaceClasses, wikiLinkLabel, WikiEmbedWidget } = await import(
  "../frontend/app/features/editor/extensions/block-embed.js"
);

test("callout model splits type / fold / metadata / title / body", () => {
  const model = calloutSurfaceModel("> [!info]+ Custom title\n> body line\n> second line");
  assert.equal(model.type, "info");
  assert.equal(model.fold, "+");
  assert.equal(model.collapsible, true);
  assert.equal(model.collapsed, false);
  assert.equal(model.title, "Custom title");
  assert.equal(model.body, "body line\nsecond line");

  const collapsed = calloutSurfaceModel("> [!warning]-");
  assert.equal(collapsed.type, "warning");
  assert.equal(collapsed.fold, "-");
  assert.equal(collapsed.collapsed, true);
  // Desktop falls back to the capitalised type when the source has no title.
  assert.equal(collapsed.title, "Warning");

  const withMetadata = calloutSurfaceModel("> [!quote|revert] Title");
  assert.equal(withMetadata.type, "quote");
  assert.equal(withMetadata.metadata, "revert");
  assert.equal(withMetadata.title, "Title");
  assert.equal(withMetadata.collapsible, false);
});

test("callout scanner covers contiguous quote lines and skips fenced code", () => {
  const doc = Text.of([
    "intro",
    "> [!info] A",
    "> body",
    "> more",
    "",
    "```",
    "> [!info] not a callout",
    "```",
    "> [!tip] B",
    "",
    "tail",
  ]);
  const blocks = scanCalloutBlocks(doc);
  assert.equal(blocks.length, 2);
  assert.equal(doc.sliceString(blocks[0].from, blocks[0].to), "> [!info] A\n> body\n> more");
  assert.equal(doc.sliceString(blocks[1].from, blocks[1].to), "> [!tip] B");
});

test("Live embed widget keeps in-place wiki chrome with the canonical embed faces", () => {
  assert.equal(wikiLinkLabel("![[Folder/Note#Heading|Label]]"), "Label");
  assert.equal(wikiLinkLabel("![[pixel.svg]]"), "pixel.svg");

  // LP-08 freezes the in-place chrome: an embed is never an atomic image/media
  // widget, it stays a `.cm-live-wiki-link` label and only adds Desktop's
  // canonical embed container faces for the target kind.
  assert.deepEqual(embedSurfaceClasses("pixel.svg"), ["internal-embed", "image-embed"]);
  assert.deepEqual(embedSurfaceClasses("Folder/clip.mp4"), ["internal-embed", "file-embed"]);
  assert.deepEqual(embedSurfaceClasses("Folder/Note#Heading"), ["internal-embed", "markdown-embed", "inline-embed"]);

  const image = new WikiEmbedWidget("![[pixel.svg]]");
  const note = new WikiEmbedWidget("![[SomeNote|Label]]");
  assert.equal(image.eq(new WikiEmbedWidget("![[pixel.svg]]")), true);
  assert.equal(note.eq(image), false);
  for (const widget of [image, note]) {
    assert.equal(typeof widget.toDOM, "function");
  }
});
