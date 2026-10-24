import assert from "node:assert/strict";
import test from "node:test";
import { documentMap, extractInlineTags, extractLinks, parseBlocks, parseHeadings } from "../src/obsidian.js";
import { updateFenceState } from "../src/markdown-lexicon.js";

// Windows/OneDrive/Syncthing 同步的笔记常是 CRLF，而 splitLines() 按 "\n" 切分不剥离 "\r"。
// 这些用例把「围栏内的标题 / 内联 tag / 链接不参与解析」这条规则固定到 LF / CRLF / 混合三种行尾上。
// 注意：`^block-id` 不在此列 —— parseBlocks() 不参考围栏状态（围栏内的 `^block` 仍会被抽取），
// 那是独立的既有行为，不属 issue #271，本文件只锁住它的 CRLF/LF 一致性。

const LF_BODY = [
  "# Title",
  "",
  "```bash",
  "echo hi",
  "# not-a-heading",
  "```",
  "",
  "## Next",
  "",
  "```",
  "^not-a-block",
  "```",
  "",
].join("\n");

const CRLF_BODY = LF_BODY.replace(/\n/g, "\r\n");

function titles(content) {
  return parseHeadings(content).map((heading) => `L${heading.level}:${heading.title}`);
}

test("parseHeadings: CRLF content behaves exactly like LF", () => {
  assert.deepEqual(titles(LF_BODY), ["L1:Title", "L2:Next"]);
  assert.deepEqual(titles(CRLF_BODY), titles(LF_BODY), "a `#` line inside a fence is not a heading");
});

test("parseHeadings: mixed line endings inside one fence stay inert", () => {
  const mixed = "# Title\n\n```bash\r\necho hi\r\n# not-a-heading\r\n```\n\n## Next\n";
  assert.deepEqual(titles(mixed), ["L1:Title", "L2:Next"]);
});

test("parseHeadings: a heading after a CRLF fence keeps its own nesting", () => {
  const content = "# Title\r\n\r\n```bash\r\n# not-a-heading\r\n```\r\n\r\n## Next\r\n\r\n### Deep\r\n";
  const headings = parseHeadings(content);
  assert.deepEqual(headings.map((heading) => heading.title), ["Title", "Next", "Deep"]);
  assert.equal(headings[1].path, "Title > Next");
  assert.equal(headings[2].path, "Title > Next > Deep");
});

test("parseBlocks: CRLF must not change block-id extraction (fence scoping is a separate issue)", () => {
  // parseBlocks 当前不参考围栏状态（围栏内的 ^block 也会被抽取），这是既有行为，
  // 不属 issue #271 的范围。这里只锁住「CRLF 与 LF 输出一致」，避免本次修复改变它。
  const content = "```\n^hidden\n```\n\ntext ^visible\n";
  const lf = parseBlocks(content).map((block) => block.id);
  const crlf = parseBlocks(content.replace(/\n/g, "\r\n")).map((block) => block.id);
  assert.deepEqual(lf, ["hidden", "visible"]);
  assert.deepEqual(crlf, lf);
});

test("extractInlineTags: CRLF fences hide tags just like LF", () => {
  const content = "before #real-tag\r\n```\r\n#code-tag\r\n```\r\nafter #another";
  assert.deepEqual(extractInlineTags(content).map((tag) => tag.tag), ["real-tag", "another"]);
});

test("extractLinks: CRLF fences hide wiki and markdown links just like LF", () => {
  const content = [
    "[[outside-wiki]] and [outside md](outside.md)",
    "",
    "```md",
    "[[inside-wiki]] and [inside md](inside.md)",
    "```",
    "",
    "[[after-wiki]] and [after md](after.md)",
  ].join("\n");
  const shape = (links) => links.map((link) => `${link.syntax}:${link.target}`);

  const lf = shape(extractLinks(content, "note.md"));
  assert.deepEqual(lf, ["wiki:outside-wiki", "markdown:outside.md", "wiki:after-wiki", "markdown:after.md"]);
  assert.deepEqual(
    shape(extractLinks(content.replace(/\n/g, "\r\n"), "note.md")),
    lf,
    "CRLF must not leak links out of a fenced block",
  );

  // 混合行尾（fence 起始行 LF、块内 CRLF）同样不能泄漏
  const mixed = "[[a]]\n\n```md\r\n[[inside]]\r\n```\n\n[[b]]\n";
  assert.deepEqual(shape(extractLinks(mixed, "note.md")), ["wiki:a", "wiki:b"]);
});

test("documentMap: CRLF note reports no headings from inside fences", () => {
  const map = documentMap({ path: "note.md", frontmatter: {}, content: CRLF_BODY });
  assert.deepEqual(map.headings.map((heading) => heading.title), ["Title", "Next"]);
});

test("updateFenceState: open and close markers tolerate a trailing CR", () => {
  const opened = updateFenceState("```bash\r", null);
  assert.deepEqual(opened, { marker: "`", length: 3 });
  assert.equal(updateFenceState("echo hi\r", opened), opened);
  assert.equal(updateFenceState("```\r", opened), null);

  const tilde = updateFenceState("~~~\r", null);
  assert.deepEqual(tilde, { marker: "~", length: 3 });
  assert.equal(updateFenceState("~~~\r", tilde), null);

  const indented = updateFenceState("  ```json\r", null);
  assert.deepEqual(indented, { marker: "`", length: 3 });
  assert.equal(updateFenceState("  ```\r", indented), null);

  // 关闭标记必须不短于开启标记，行尾 CR 不能让它误判
  const long = updateFenceState("````\r", null);
  assert.deepEqual(long, { marker: "`", length: 4 });
  assert.equal(updateFenceState("```\r", long), long, "a shorter close marker must not close a longer fence");
  assert.equal(updateFenceState("````\r", long), null);
});
