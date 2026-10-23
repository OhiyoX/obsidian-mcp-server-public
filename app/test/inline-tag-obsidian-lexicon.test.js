import assert from "node:assert/strict";
import test from "node:test";
import { extractInlineTags, inlineTags, removeInlineTags, appendInlineTags, parseHeadings } from "../src/obsidian.js";

function tagNames(content) {
  return extractInlineTags(content).map((t) => t.tag);
}

test("extractInlineTags: accepts valid Obsidian tags", () => {
  assert.deepEqual(tagNames("#hello"), ["hello"]);
  assert.deepEqual(tagNames("#nested/tag"), ["nested/tag"]);
  assert.deepEqual(tagNames("#tag_with_underscore"), ["tag_with_underscore"]);
  assert.deepEqual(tagNames("#tag-with-hyphen"), ["tag-with-hyphen"]);
  assert.deepEqual(tagNames("text #alpha and #beta"), ["alpha", "beta"]);
  assert.deepEqual(tagNames("#中文标签"), ["中文标签"]);
  assert.deepEqual(tagNames("#プロジェクト/進行中"), ["プロジェクト/進行中"]);
});

test("extractInlineTags: rejects URL fragments in markdown links", () => {
  assert.deepEqual(tagNames("[section](note.md#section)"), []);
  assert.deepEqual(tagNames("[link](https://example.com/page#anchor)"), []);
  assert.deepEqual(tagNames("see [the docs](reference.md#heading-2) for details"), []);
  assert.deepEqual(tagNames("[alias](note#fragment) and #real-tag"), ["real-tag"]);
  assert.deepEqual(tagNames("[heading](#section)"), [], "# right after ( must not match");
  assert.deepEqual(tagNames("(see #fragment)"), ["fragment"], "tag after space inside parens is valid in Obsidian");
});

test("extractInlineTags: rejects wiki link heading fragments", () => {
  assert.deepEqual(tagNames("[[note#heading]]"), []);
  assert.deepEqual(tagNames("[[note#^block-id]]"), []);
  assert.deepEqual(tagNames("[[display|note#section]]"), []);
  assert.deepEqual(tagNames("[[#heading-only]]"), []);
});

test("extractInlineTags: skips tags inside inline code spans", () => {
  assert.deepEqual(tagNames("use `#not-a-tag` here"), []);
  assert.deepEqual(tagNames("`#code` and #real"), ["real"]);
  assert.deepEqual(tagNames("multiple `#one` and `#two` but #three"), ["three"]);
  assert.deepEqual(tagNames("see `code #fragment` here"), [], "space before # inside inline code must not match");
  assert.deepEqual(tagNames("`#a` text `#b` #c"), ["c"], "only tags outside code spans should match");
});

test("extractInlineTags: skips tags inside fenced code blocks", () => {
  const content = "before #real-tag\n```\n#code-tag\n```\nafter #another";
  assert.deepEqual(tagNames(content), ["real-tag", "another"]);
});

test("extractInlineTags: rejects pure numeric tags", () => {
  assert.deepEqual(tagNames("#123"), []);
  assert.deepEqual(tagNames("#456 and #valid"), ["valid"]);
});

test("extractInlineTags: strips trailing punctuation", () => {
  assert.deepEqual(tagNames("#tag."), ["tag"]);
  assert.deepEqual(tagNames("#tag,"), ["tag"]);
  assert.deepEqual(tagNames("#tag!"), ["tag"]);
  assert.deepEqual(tagNames("#tag?"), ["tag"]);
  assert.deepEqual(tagNames("#tag)"), ["tag"]);
});

test("extractInlineTags: does not match tags glued to non-whitespace prefix", () => {
  assert.deepEqual(tagNames("prefix#notag"), []);
  assert.deepEqual(tagNames("word#still-notag"), []);
});

test("extractInlineTags: matches tags after blockquote marker", () => {
  assert.deepEqual(tagNames("> #quoted-tag"), ["quoted-tag"]);
  assert.deepEqual(tagNames("> text #inner"), ["inner"]);
});

test("inlineTags: deduplicates repeated tags", () => {
  assert.deepEqual(inlineTags("#alpha and #alpha again"), ["alpha"]);
  assert.deepEqual(inlineTags("#a #b #a #c #b"), ["a", "b", "c"]);
});

test("removeInlineTags: removes only specified tags with consistent regex", () => {
  assert.equal(removeInlineTags("text #remove me #keep", ["remove"]), "text me #keep");
  assert.equal(removeInlineTags("#only-tag", ["only-tag"]), "");
  assert.equal(removeInlineTags("no tags here", ["nothing"]), "no tags here");
});

test("removeInlineTags: does not touch URL fragments", () => {
  const content = "[link](note.md#section) and #real";
  const result = removeInlineTags(content, ["section"]);
  assert.equal(result, content, "URL fragment must not be treated as a removable tag");
});

test("removeInlineTags: does not touch inline code spans", () => {
  const content = "`#protected` and #removable";
  const result = removeInlineTags(content, ["protected"]);
  assert.equal(result, content, "tag inside inline code must not be removed");
});

test("appendInlineTags: appends missing tags", () => {
  const result = appendInlineTags("some text", ["new-tag"]);
  assert.ok(result.includes("#new-tag"));
});

test("appendInlineTags: does not duplicate existing tags", () => {
  const result = appendInlineTags("text #existing", ["existing"]);
  assert.equal(result, "text #existing");
});

test("parseHeadings: returns headings with correct levels and paths", () => {
  const content = "# Title\n## Sub\n### Deep\n## Another";
  const headings = parseHeadings(content);
  assert.equal(headings.length, 4);
  assert.equal(headings[0].level, 1);
  assert.equal(headings[0].title, "Title");
  assert.equal(headings[0].path, "Title");
  assert.equal(headings[2].path, "Title > Sub > Deep");
  assert.equal(headings[3].path, "Title > Another");
});

test("parseHeadings: ignores headings inside fenced code blocks", () => {
  const content = "# Real\n```\n## Not a heading\n```\n## Also real";
  const headings = parseHeadings(content);
  assert.equal(headings.length, 2);
  assert.equal(headings[0].title, "Real");
  assert.equal(headings[1].title, "Also real");
});

test("parseHeadings: ignores headings inside tilde-fenced code blocks", () => {
  const content = "# Real\n~~~\n## Not a heading\n~~~\n## Also real";
  const headings = parseHeadings(content);
  assert.equal(headings.length, 2);
});

test("parseHeadings: handles nested fences correctly", () => {
  const content = "```\n# inside fence 1\n```\n# between\n```\n# inside fence 2\n```\n# after";
  const headings = parseHeadings(content);
  assert.equal(headings.length, 2);
  assert.equal(headings[0].title, "between");
  assert.equal(headings[1].title, "after");
});

test("parseHeadings: does not close backtick fence with tildes", () => {
  const content = "````\n# inside backtick fence\n~~~\n# still inside\n````\n# after fence";
  const headings = parseHeadings(content);
  assert.equal(headings.length, 1);
  assert.equal(headings[0].title, "after fence");
});

test("parseHeadings: does not close fence with shorter run of same marker", () => {
  const content = "``````\n# inside 6-backtick fence\n```\n# still inside\n``````\n# after fence";
  const headings = parseHeadings(content);
  assert.equal(headings.length, 1);
  assert.equal(headings[0].title, "after fence");
});

test("extractInlineTags: skips multi-backtick code spans", () => {
  assert.deepEqual(tagNames("`` #fake-tag ` code ``"), [], "double-backtick span must be masked");
  assert.deepEqual(tagNames("``text #inside`` #outside"), ["outside"]);
  assert.deepEqual(tagNames("``` #still-code ``` #real"), ["real"], "triple-backtick inline span");
});

test("extractInlineTags: frozen fixtures from issue #212", () => {
  assert.deepEqual(tagNames("#112评估已部署，gate"), ["112评估已部署"]);
  assert.deepEqual(tagNames("#55、p2-b"), [], "pure numeric #55 is rejected");
  assert.deepEqual(tagNames("#97–#112"), [], "en-dash splits into two pure-numeric fragments");
  assert.deepEqual(tagNames("#63/.12"), [], "trailing slash segment is rejected");
  assert.deepEqual(tagNames("`#444`。chrome"), [], "tag inside inline code is masked");
  assert.deepEqual(tagNames('"## 标题"'), [], "quoted heading is not a tag");
  assert.deepEqual(tagNames("https://x/y#frag"), [], "URL fragment has no whitespace prefix");
  assert.deepEqual(tagNames("#v2026.10.01"), ["v2026"], "dot terminates tag body");
});

test("extractInlineTags: rejects empty slash segments", () => {
  assert.deepEqual(tagNames("#foo/"), [], "trailing slash");
  assert.deepEqual(tagNames("#/foo"), [], "leading slash");
  assert.deepEqual(tagNames("#foo//bar"), [], "double slash");
  assert.deepEqual(tagNames("#foo//"), [], "trailing double slash");
  assert.deepEqual(tagNames("#/123/foo"), [], "leading slash before numeric");
});

test("extractInlineTags: position and original are precise", () => {
  const content = "text #alpha/beta more";
  const tags = extractInlineTags(content);
  assert.equal(tags.length, 1);
  assert.equal(tags[0].tag, "alpha/beta");
  assert.equal(tags[0].original, "#alpha/beta");
  assert.equal(tags[0].position.start.line, 0);
  assert.equal(tags[0].position.start.col, 5);
  assert.equal(tags[0].position.end.col, 16);
});

test("extractInlineTags: multiline position tracking", () => {
  const content = "line one\n#second-line-tag";
  const tags = extractInlineTags(content);
  assert.equal(tags.length, 1);
  assert.equal(tags[0].position.start.line, 1);
  assert.equal(tags[0].position.start.col, 0);
});

test("extractInlineTags: UTF-16 position is correct after emoji in code span", () => {
  const content = "`😀` #real";
  const tags = extractInlineTags(content);
  assert.equal(tags.length, 1);
  assert.equal(tags[0].tag, "real");
  assert.equal(tags[0].original, "#real");
  assert.equal(tags[0].position.start.col, 5, "emoji is 2 UTF-16 units so # starts at col 5");
});

test("removeInlineTags: UTF-16 offset stays aligned after emoji in code span", () => {
  assert.equal(removeInlineTags("`😀` #real", ["real"]), "`😀`");
  assert.equal(removeInlineTags("before `🎉🎉` #tag after", ["tag"]), "before `🎉🎉` after");
});

test("extractInlineTags: nested tag with numeric segment is valid", () => {
  assert.deepEqual(tagNames("#foo/123"), ["foo/123"], "per-segment numeric is allowed");
  assert.deepEqual(tagNames("#project/2026/archive"), ["project/2026/archive"]);
  assert.deepEqual(tagNames("#123"), [], "whole-tag pure numeric is still rejected");
});
