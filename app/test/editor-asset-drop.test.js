// U30 contract A4/A5: DOM-free coverage for the editor drop helpers and the reader guard.
//
// Same pattern as the other `editor-*.test.js` files: import the front-end modules directly and
// drive them with plain objects — no browser, no CodeMirror view.
import assert from "node:assert/strict";
import test from "node:test";
import {
  WEB_ASSET_EXTENSIONS,
  assetEmbedText,
  assetExtension,
  assetFileNameHeader,
  cleanAssetName,
  createDragDepthCounter,
  expectedAssetMime,
  isAllowedAssetName,
  resolveDropPosition,
  shouldHandleAssetDrop,
} from "../frontend/app/features/editor/asset-drop.js";
import { installReaderAssetDropGuard } from "../frontend/app/features/reader/asset-drop-guard.js";

test("cleanAssetName mirrors the server naming matrix", () => {
  // Spaces and Unicode are preserved (Obsidian parity), the extension is lower-cased.
  assert.deepEqual(cleanAssetName("my photo.PNG"), { stem: "my photo", extension: ".png", name: "my photo.png" });
  assert.deepEqual(cleanAssetName("截图 2026-10-05 中文.jpeg"), { stem: "截图 2026-10-05 中文", extension: ".jpeg", name: "截图 2026-10-05 中文.jpeg" });
  assert.equal(cleanAssetName("café.webp").stem, "café");
  // Percent-encoded input is decoded exactly once.
  assert.equal(cleanAssetName("a%20b%2Bc.gif").name, "a b+c.gif");
  assert.equal(cleanAssetName("%E4%B8%AD%E6%96%87.png").name, "中文.png");

  // Illegal characters collapse to a single `-`, and `[ ] # ^` are included.
  assert.equal(cleanAssetName("a:b*c?d\"e<f>g|h[i]j#k^l.png").stem, "a-b-c-d-e-f-g-h-i-j-k-l");
  assert.equal(cleanAssetName("a///b.png"), null, "a slash is a traversal, not a character to clean");
  assert.equal(cleanAssetName("a\\\\b.png"), null);
  assert.equal(cleanAssetName("a//b.png"), null);

  // Traversal, absolute paths, NUL, dot-prefixed segments and bad extensions are refused.
  for (const bad of ["../x.png", "..%2Fx.png", "/etc/passwd.png", "C:\\temp\\x.png", "\\\\server\\share\\x.png", "x\u0000.png", ".hidden.png", "notes.pdf", "logo.svg", "photo.avif", "scan.bmp", "note.md", "photo", "", "   "]) {
    assert.equal(cleanAssetName(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
  // A malformed percent escape is refused instead of being kept literally.
  assert.equal(cleanAssetName("100%.png"), null);

  // Empty or all-dashes stems fall back to `image`; the stem caps at 120 characters.
  assert.equal(cleanAssetName("***.png").name, "image.png");
  assert.equal(cleanAssetName("   .png").name, "image.png");
  assert.equal(cleanAssetName("...png"), null, "a leading dot is not an extension");
  assert.equal(cleanAssetName(`${"n".repeat(200)}.png`).name, `${"n".repeat(120)}.png`);
  assert.equal(cleanAssetName(`${"n".repeat(119)}.${"x".repeat(10)}.png`).name, `${"n".repeat(119)}.png`, "a trailing dot exposed by truncation is trimmed");
  assert.equal(cleanAssetName(`${"x".repeat(200)} .png`).name.length, 120 + ".png".length);
});

test("the asset whitelist and MIME map stay aligned with the server", () => {
  assert.deepEqual([...WEB_ASSET_EXTENSIONS], [".png", ".jpg", ".jpeg", ".gif", ".webp"]);
  for (const name of ["a.png", "a.PNG", "a.jpg", "a.jpeg", "a.JPEG", "a.gif", "a.webp"]) {
    assert.equal(isAllowedAssetName(name), true, name);
    assert.ok(expectedAssetMime(name).startsWith("image/"), name);
  }
  assert.equal(expectedAssetMime("a.jpg"), "image/jpeg");
  assert.equal(expectedAssetMime("a.jpeg"), "image/jpeg");
  assert.equal(expectedAssetMime("a.png"), "image/png");
  for (const name of ["a.svg", "a.avif", "a.bmp", "a.pdf", "a.md", "a", "a.png.exe", "a.png ", "a.png\u0000"]) {
    assert.equal(isAllowedAssetName(name), false, name);
    assert.equal(expectedAssetMime(name), "", name);
  }
  // `isAllowedAssetName` only looks at the extension of a `File.name` (which never contains a
  // separator); path-shaped input is refused by the cleaner instead.
  assert.equal(isAllowedAssetName("dir/a.png"), true);
  assert.equal(cleanAssetName("dir/a.png"), null);
  // A leading dot is a hidden file, not an extension.
  assert.equal(assetExtension(".png"), "");
  assert.equal(assetExtension("photo.png"), ".png");
  assert.equal(assetExtension("photo"), "");
});

test("assetEmbedText emits a Vault-relative wikilink embed with `|` neutralised", () => {
  assert.equal(assetEmbedText("attachments/pixel-1.png"), "![[attachments/pixel-1.png]]");
  assert.equal(assetEmbedText("attachments/中文 图.png"), "![[attachments/中文 图.png]]");
  assert.equal(assetEmbedText("attachments/a|b.png"), "![[attachments/a-b.png]]", "an alias separator must not survive");
  assert.equal(assetEmbedText("attachments/a|b|c.png"), "![[attachments/a-b-c.png]]");
  assert.equal(assetEmbedText(undefined), "![[]]");
  // The embed is a wikilink, never a Markdown image or a raw API URL.
  assert.equal(assetEmbedText("attachments/x.png").startsWith("![["), true);
  assert.equal(assetEmbedText("attachments/x.png").includes("/api/web/v1/asset"), false);
});

test("resolveDropPosition falls back to the selection head when the point is unusable", () => {
  assert.equal(resolveDropPosition({ pos: 12, head: 3, docLength: 40 }), 12);
  assert.equal(resolveDropPosition({ pos: 0, head: 3, docLength: 40 }), 0);
  assert.equal(resolveDropPosition({ pos: 40, head: 3, docLength: 40 }), 40, "the document end is a legal position");
  // Out of range, missing or non-numeric coordinates fall back.
  assert.equal(resolveDropPosition({ pos: -1, head: 3, docLength: 40 }), 3);
  assert.equal(resolveDropPosition({ pos: 41, head: 3, docLength: 40 }), 3);
  assert.equal(resolveDropPosition({ pos: null, head: 3, docLength: 40 }), 3);
  assert.equal(resolveDropPosition({ pos: undefined, head: 3, docLength: 40 }), 3);
  assert.equal(resolveDropPosition({ pos: Number.NaN, head: 3, docLength: 40 }), 3);
  assert.equal(resolveDropPosition({ pos: "abc", head: 3, docLength: 40 }), 3);
  // Live Preview decorations that cannot hold a caret fall back even for an in-range point.
  assert.equal(resolveDropPosition({ pos: 12, head: 3, docLength: 40, atomic: true }), 3);
  // A stale selection head is clamped into the current document.
  assert.equal(resolveDropPosition({ pos: null, head: 999, docLength: 40 }), 40);
  assert.equal(resolveDropPosition({ pos: null, head: -5, docLength: 40 }), 0);
  assert.equal(resolveDropPosition({}), 0);
});

test("only a drag carrying files is intercepted", () => {
  assert.equal(shouldHandleAssetDrop(["Files"]), true);
  assert.equal(shouldHandleAssetDrop(["files"]), true);
  assert.equal(shouldHandleAssetDrop(["text/plain", "Files"]), true);
  assert.equal(shouldHandleAssetDrop(["text/plain"]), false, "an internal text/selection drag stays CodeMirror's");
  assert.equal(shouldHandleAssetDrop(["text/html", "text/plain"]), false);
  assert.equal(shouldHandleAssetDrop([]), false);
  assert.equal(shouldHandleAssetDrop(null), false);
  assert.equal(shouldHandleAssetDrop(undefined), false);
  // DataTransfer.types is array-like rather than a real Array in some engines.
  assert.equal(shouldHandleAssetDrop({ 0: "Files", length: 1 }), true);
  assert.equal(shouldHandleAssetDrop({ 0: "text/plain", length: 1 }), false);
});

test("the drag depth counter survives child-element bubbling", () => {
  const depth = createDragDepthCounter();
  assert.equal(depth.active, false);
  assert.equal(depth.enter(), 1);
  assert.equal(depth.active, true);
  // Entering a child line adds a level; the parent's leave must not clear the highlight.
  assert.equal(depth.enter(), 2);
  assert.equal(depth.leave(), 1);
  assert.equal(depth.active, true, "a child leave must not end the drag");
  assert.equal(depth.leave(), 0);
  assert.equal(depth.active, false);
  assert.equal(depth.leave(), 0, "leaves never go negative");
  depth.enter();
  depth.reset();
  assert.equal(depth.active, false, "a drop resets the depth regardless of unmatched leaves");
});

test("the x-file-name header is percent-encoded UTF-8", () => {
  assert.equal(assetFileNameHeader("pixel one.png"), "pixel%20one.png");
  assert.equal(assetFileNameHeader("中文.png"), "%E4%B8%AD%E6%96%87.png");
  assert.equal(assetFileNameHeader("a+b&c.png"), "a%2Bb%26c.png");
  assert.equal(assetFileNameHeader(undefined), "");
});

test("the reader guard cancels file drags on the rendered surface only", () => {
  const listeners = new Map();
  const root = {
    addEventListener: (type, handler) => listeners.set(`${type}:capture`, handler),
    removeEventListener: (type) => listeners.delete(`${type}:capture`),
  };
  const detach = installReaderAssetDropGuard(root);
  const readerTarget = { parentElement: { closest: (selector) => selector === ".markdown-preview-view" ? {} : null } };
  const editorTarget = { parentElement: { closest: () => null } };

  const fire = (type, target) => {
    const event = { target, prevented: 0, stopped: 0, preventDefault() { this.prevented += 1; }, stopPropagation() { this.stopped += 1; } };
    listeners.get(`${type}:capture`)?.(event);
    return event;
  };

  const readerDragOver = fire("dragover", readerTarget);
  assert.equal(readerDragOver.prevented, 1, "the default navigation must be cancelled on the reader");
  const readerDrop = fire("drop", readerTarget);
  assert.equal(readerDrop.prevented, 1);
  assert.equal(readerDrop.stopped, 1, "the reader drop must not reach any other handler");
  // The editor surface is untouched: the editor owns its own drop handling.
  assert.equal(fire("dragover", editorTarget).prevented, 0);
  assert.equal(fire("drop", editorTarget).prevented, 0);
  // A text node target resolves through its parent element.
  assert.equal(fire("drop", { parentElement: readerTarget.parentElement }).prevented, 1);

  detach();
  assert.equal(fire("drop", readerTarget).prevented, 0, "detach must remove both listeners");
  // Without a DOM (Node, unit tests) the guard is a no-op rather than a crash.
  assert.equal(typeof installReaderAssetDropGuard(null), "function");
});
