// Issue #484 — one tag lexer for both hosts.
//
// The defect: Reading's `obsidianTags` (markdown-it) accepted a tag preceded by `(`, `[` or `{`,
// while Live Preview's own pattern required whitespace, so `(#paren)` was a tag pill in Reading
// and plain text in the editor. The fix moved the lexeme into
// `frontend/app/features/document/inline-tag-lexicon.js`, which both hosts call.
//
// This file has to fail if that ever drifts apart again, so it proves three separate things:
//   1. the lexeme itself (boundaries, body class, numeric-tag rule, termination);
//   2. BOTH HOSTS AGREE: the Reading host's rendered `data-tag` values and the Live host's scan
//      — the *shipped* one, options included — produce the same tags for one matrix;
//   3. the private copies are gone: neither host file contains a hand-written tag pattern.
// A behavioural test alone would not catch (3), and the source assertion alone would not catch a
// host wiring a different lexer, so both are required.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { register } from "node:module";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { createDomHarness } from "./helpers/base-dom.mjs";
import {
  findInlineTags,
  isInlineTagBoundary,
  matchInlineTagAt,
} from "../frontend/app/features/document/inline-tag-lexicon.js";
import { collectMatchRanges } from "../frontend/app/features/editor/extensions/match-decorations.js";

register("./css-stub-loader.mjs", import.meta.url);
const dom = createDomHarness();
dom.install();

const MarkdownIt = (await import("markdown-it")).default;
const { extractFrontmatter, obsidianTags } = await import("../frontend/app/features/reader/reader.js");
// The Live host's own decoration options; importing them keeps this test on the shipped wiring.
const { LIVE_TAG_DECORATION } = await import("../frontend/app/features/editor/create-editor.js");

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
obsidianTags(md);

/**
 * Tags the Reading host renders, as `#tag` (its `data-tag` value plus the leading `#`).
 *
 * The frontmatter step mirrors `renderObsidianMarkdown`: the shipped full-document path renders
 * `extractFrontmatter(source).body`, so the inline lexer never sees the YAML block. `sanitize()`
 * is left out on purpose — it only removes whole unsafe elements and attributes and never
 * rewrites a `#tag` into a different tag, and it needs a browser-grade DOM this file does not
 * have (`renderObsidianMarkdown` fail-closes to escaped source under this harness).
 */
function readerTags(doc) {
  const { body } = extractFrontmatter(doc);
  return [...md.render(body).matchAll(/data-tag="([^"]*)"/g)].map((match) => `#${match[1]}`);
}

/** Tags the Live host decorates, through the same `collectMatchRanges` + lexer the editor uses. */
function liveTags(doc) {
  const state = EditorState.create({ doc, extensions: [markdown({ extensions: GFM })] });
  return collectMatchRanges(state, findInlineTags, 0, state.doc.length, LIVE_TAG_DECORATION)
    .map((range) => state.sliceDoc(range.from, range.to));
}

// Every source here is run through both hosts; the two lists must be identical.
const SHARED_MATRIX = [
  "body #tag\n",
  "(#paren)\n",
  "[#bracket] bracket\n",
  "{#curly}\n",
  "word#notag a#b\n",
  "#7 #123 #v2026.10.01 #55、p2-b\n",
  "#nested/tag and #hyphen-ated and #日本語标签\n",
  "#tag#other\n",
  "text #tag) and #tag, and #tag.\n",
  "\\#escaped and #real\n",
  "`#code` #real\n",
  "`` #fake ` code `` #real\n",
  "```\n#fence\n```\n#after\n",
  "---\ntitle: #not-a-tag\ntags:\n  - fixture\n---\n\n#real #inline\n",
  "<div>#html</div>\n\n#after-html\n",
  "[heading](#section)\n",
  "[#in-label](url)\n",
  "[a](https://x.com/#frag) and https://x.com/#frag\n",
  "> #quoted\n",
  ">#glued\n",
  ">>#double\n",
  "> a\n> #inside\n",
  "- #list-tag\n",
  "- [ ] #task #open\n",
  "## heading #in-heading\n",
  "# \\#in-heading-escaped\n",
  "| a | b |\n| - | - |\n| #cell | x |\n",
  "    indented code #nope\n\n#after-code\n",
  "#tag with **strong** #other\n",
  "x\n#lazy-continuation\n",
];

test("#484 the Reading and Live hosts produce the same tags for the shared matrix", () => {
  const disagreements = [];
  for (const doc of SHARED_MATRIX) {
    const reader = readerTags(doc);
    const live = liveTags(doc);
    if (JSON.stringify(reader) !== JSON.stringify(live)) {
      disagreements.push({ doc, reader, live });
    }
  }
  assert.deepEqual(disagreements, [], "both hosts must call the same lexer with the same context");
});

test("#484 the matrix actually exercises tags, so a green run cannot come from two empty lists", () => {
  const withTags = SHARED_MATRIX.filter((doc) => readerTags(doc).length > 0);
  assert.ok(withTags.length >= 15, `expected most matrix rows to render a tag, got ${withTags.length}`);
  // Negative rows must stay negative on both sides.
  for (const doc of ["word#notag a#b\n", "[heading](#section)\n", "`#code` #real\n"]) {
    assert.equal(readerTags(doc).includes("#notag"), false, `Reading must not tag in ${JSON.stringify(doc)}`);
  }
  assert.deepEqual(liveTags("(#paren)\n"), ["#paren"], "the reported input of #484 is a Live tag");
  assert.deepEqual(readerTags("(#paren)\n"), ["#paren"], "and the same tag in Reading");
});

test("#484 the shared matrix keeps the frontmatter out of the Reading inline lexer", () => {
  // The one matrix row that needs this: the YAML block is handed to the properties panel, and the
  // shipped full-document path renders `extractFrontmatter(source).body`, so `#not-a-tag` in YAML
  // never reaches `md.render`. Pinned first-hand instead of assumed.
  const doc = "---\ntitle: #not-a-tag\ntags:\n  - fixture\n---\n\n#real #inline\n";
  const { body } = extractFrontmatter(doc);
  assert.equal(body.includes("#not-a-tag"), false, "the YAML tag is not part of the rendered body");
  assert.deepEqual(readerTags(doc), ["#real", "#inline"]);
  assert.deepEqual(liveTags(doc), ["#real", "#inline"]);
});

test("#484 the lexeme accepts Obsidian's tag boundaries and nothing else", () => {
  for (const previous of ["", " ", "\t", "\n", "(", "[", "{"]) {
    assert.equal(isInlineTagBoundary(previous), true, `${JSON.stringify(previous)} is a boundary`);
    assert.ok(matchInlineTagAt(`${previous}#tag`, previous.length), `#tag after ${JSON.stringify(previous)}`);
  }
  for (const previous of ["a", "9", ">", "-", "/", "\\", "#", ".", ")", "]", "}"]) {
    assert.equal(isInlineTagBoundary(previous), false, `${JSON.stringify(previous)} is not a boundary`);
    assert.equal(matchInlineTagAt(`${previous}#tag`, previous.length), null, `no tag after ${JSON.stringify(previous)}`);
  }
});

test("#484 the lexeme keeps Obsidian's body class, numeric rule and termination", () => {
  const at = (source) => matchInlineTagAt(source, 0);
  assert.deepEqual(at("#tag"), { raw: "#tag", tag: "tag", length: 4 });
  assert.equal(at("#123"), null, "a purely numeric tag is not a tag");
  assert.equal(at("#"), null);
  assert.equal(at("##tag"), null);
  assert.equal(at("# tag"), null);
  assert.equal(matchInlineTagAt("#v2026.10.01", 0).raw, "#v2026", "the body class ends at `.`");
  assert.equal(matchInlineTagAt("x #tag、p2", 2).raw, "#tag", "the body class ends at a CJK comma");
  // Measured, pre-existing Reading behaviour this slice must NOT change (the lexeme is shared
  // verbatim): markdown-it's rule accepts an empty slash segment (`#/foo`, `#foo/`), while the
  // server-side `src/obsidian.js` `extractInlineTags` rejects it. That divergence is older than
  // #484 and lives outside its scope; it is pinned here so a future unification is a deliberate
  // act rather than a silent drift.
  assert.deepEqual(at("#/foo"), { raw: "#/foo", tag: "/foo", length: 5 });
  assert.deepEqual(at("#foo/"), { raw: "#foo/", tag: "foo/", length: 5 });
});

test("#484 findInlineTags reports to/from inside the scanned text, not document offsets", () => {
  assert.deepEqual(findInlineTags("see #alpha and #beta/x here"), [
    { from: 4, to: 10, tag: "alpha", raw: "#alpha" },
    { from: 15, to: 22, tag: "beta/x", raw: "#beta/x" },
  ]);
  // A block-content start only *adds* a boundary; it never removes one.
  assert.deepEqual(findInlineTags(">#glued", { boundaryOffsets: [1] }).map((tag) => tag.tag), ["glued"]);
  assert.deepEqual(findInlineTags(">#glued"), [], "without the block-content start there is no boundary");
  assert.deepEqual(findInlineTags("a #kept", { boundaryOffsets: [2] }).map((tag) => tag.tag), ["kept"]);
  assert.deepEqual(findInlineTags("a#glued", { boundaryOffsets: [0] }), [], "offset 0 is already a start");
});

test("#484 neither host keeps a private tag pattern", () => {
  const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
  const readerSource = read("../frontend/app/features/reader/reader.js");
  const editorSource = read("../frontend/app/features/editor/create-editor.js");
  const tableSource = read("../frontend/app/features/editor/extensions/table-cell-render.js");

  assert.match(readerSource, /matchInlineTagAt\(/, "Reading must call the shared lexer");
  assert.equal(
    readerSource.includes("(?=[\\p{L}\\p{N}_/-]*[\\p{L}_/-])"),
    false,
    "Reading must not keep the old inline copy of the pattern",
  );
  for (const [name, source] of [["create-editor.js", editorSource], ["table-cell-render.js", tableSource]]) {
    assert.match(source, /findInlineTags/, `${name} must call the shared scan`);
    assert.equal(
      source.includes("(?<!\\S)#"),
      false,
      `${name} must not keep the old whitespace-only tag pattern`,
    );
  }
  assert.match(readerSource, /inline-tag-lexicon\.js/, "Reading imports the shared module");
  assert.match(editorSource, /inline-tag-lexicon\.js/, "Live imports the shared module");
});
