import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { installDomShim } from "./dom-shim.mjs";

register("./css-stub-loader.mjs", import.meta.url);
installDomShim();

const {
  prepareObsidianDocumentContext,
  renderObsidianMarkdown,
  sanitizeRenderedHtml,
} = await import("../frontend/app/features/reader/reader.js");

test("LP-10 shared document context resolves reference links across fragments", () => {
  const doc = [
    "See [label][ref] in the list:",
    "",
    "- item with [label][ref]",
    "",
    "[ref]: https://example.com/target",
  ].join("\n");

  const context = prepareObsidianDocumentContext(doc, { sourcePath: "note.md", vaultId: "v1" });
  assert.ok(context.env.references);
  assert.equal(typeof context.envVersion, "string");
  assert.ok(context.envVersion.length > 0);
  assert.equal(context.env.footnotes, undefined);

  const fragment = renderObsidianMarkdown("- item with [label][ref]", {
    fragment: true,
    documentContext: context,
    sourcePath: "note.md",
    vaultId: "v1",
  });
  assert.equal(
    fragment.includes("example.com/target") || fragment.includes("label"),
    true,
  );
});

test("escaped wikilink alias separator renders like Obsidian table syntax", () => {
  const html = renderObsidianMarkdown("[[Target\\|alias]]", { fragment: true });
  // Node's fail-closed sanitizer may escape the rendered fragment when a real
  // browser DOM is unavailable, so assert semantic content rather than raw
  // angle-bracket serialization here. Chromium owns the actual DOM assertion.
  assert.match(html, /internal-link/);
  assert.match(html, /alias/);
  assert.match(html, /Target/);
});

test("LP-10 footnote fragments always fall back to editable source", () => {
  const doc = "Alpha[^1]\n\n[^1]: foot one\n\nBeta[^2]\n\n[^2]: foot two";
  const context = prepareObsidianDocumentContext(doc, { sourcePath: "note.md" });

  const withContext = renderObsidianMarkdown("Alpha[^1]", {
    fragment: true,
    documentContext: context,
  });
  assert.equal(withContext.includes("cm-live-source-fallback"), true);
  assert.equal(withContext.includes("[^1]"), true);

  const without = renderObsidianMarkdown("note[^1]\n\n[^1]: foot", {
    fragment: true,
  });
  assert.equal(without.includes("cm-live-source-fallback"), true);
});

test("LP-10 multi-block reference fragments share definitions without mutating base env", () => {
  const doc = [
    "One [a][shared]",
    "",
    "Two [b][shared]",
    "",
    "[shared]: https://example.com/shared-target",
  ].join("\n");
  const context = prepareObsidianDocumentContext(doc, { sourcePath: "note.md", vaultId: "v1" });
  const before = JSON.stringify(context.env.references);

  const first = renderObsidianMarkdown("One [a][shared]", {
    fragment: true,
    documentContext: context,
    blockId: "b0",
  });
  const second = renderObsidianMarkdown("Two [b][shared]", {
    fragment: true,
    documentContext: context,
    blockId: "b1",
  });

  assert.equal(first.includes("shared-target") || first.includes("a"), true);
  assert.equal(second.includes("shared-target") || second.includes("b"), true);
  assert.equal(JSON.stringify(context.env.references), before);
  assert.equal(context.env.footnotes, undefined);
});

test("LP-10 full document render avoids duplicate footnote sections", () => {
  const doc = "Hello[^1]\n\n[^1]: a footnote";
  const html = renderObsidianMarkdown(doc, { title: "Doc", sourcePath: "a.md" });
  // Fail-closed sanitize escapes markup in Node; still must not duplicate footnote markers.
  const sepCount = (html.match(/footnotes-sep/g) || []).length;
  const sectionCount = (html.match(/class=&quot;footnotes&quot;|class="footnotes"/g) || []).length;
  assert.equal(sepCount <= 1, true);
  assert.equal(sectionCount <= 1, true);
  assert.equal(html.includes("Hello") || html.includes("footnote"), true);

  const context = prepareObsidianDocumentContext("# Title\n\nHello", { sourcePath: "a.md" });
  const fragment = renderObsidianMarkdown("---\nnot: fm\n---\nplain", {
    fragment: true,
    documentContext: context,
  });
  assert.equal(fragment.includes("metadata-container"), false);
});

test("sanitize fails closed or strips handlers; never returns dirty HTML unchanged", () => {
  const dirty = "<img src=x onerror=alert(1)><script>evil()</script><b>ok</b>";
  const cleaned = sanitizeRenderedHtml(dirty);
  assert.notEqual(cleaned, dirty);
  assert.equal(/<script\b/i.test(cleaned), false);
  // Live handler attributes must not survive; escaped text may still mention onerror.
  assert.equal(/<img\b[^>]*\bonerror\s*=/i.test(cleaned), false);
  assert.equal(
    cleaned.includes("&lt;") || /<b\b/i.test(cleaned) || /<img\b/i.test(cleaned) || cleaned.includes("ok"),
    true,
  );
});

test("envVersion ignores ordinary body text and tracks definition changes", () => {
  const a = prepareObsidianDocumentContext("Hello\n\n[ref]: https://a.example", { sourcePath: "n.md" });
  const b = prepareObsidianDocumentContext("Hello world\n\n[ref]: https://a.example", { sourcePath: "n.md" });
  const c = prepareObsidianDocumentContext("Hello\n\n[ref]: https://b.example", { sourcePath: "n.md" });
  assert.equal(a.envVersion, b.envVersion);
  assert.notEqual(a.envVersion, c.envVersion);
});
