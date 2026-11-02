// Wave A / A2: canonical outbound-link projection tests.
//
// Contract: TODO - Web 显示 Bases 视图 §6.2 / §15.4 — the same canonical link
// extraction as the MCP vault-index; `file.hasLink` compares the raw target, so a
// second parser is forbidden. Code spans/fences and external schemes are excluded;
// duplicate targets do not change hasLink.
import assert from "node:assert/strict";
import test from "node:test";
import { catalogRecordFromRead, extractLinkTargets } from "../src/app/web-catalog/indexer.js";

test("link projection follows canonical wiki/alias/anchor/embed/markdown rules", () => {
  const content = [
    "[[Plain]]",
    "[[Aliased|shown]]",
    "[[Heading#Section]]",
    "[[Block^block-id]]",
    "![[Embedded.png]]",
    "[markdown](Folder/Note.md)",
    "![image](Assets/pic.png)",
  ].join("\n");
  assert.deepEqual(extractLinkTargets(content, "Notes/Source.md"), [
    "Plain",
    "Aliased",
    "Heading",
    "Block",
    "Embedded.png",
    "Folder/Note.md",
    "Assets/pic.png",
  ]);
});

test("link projection ignores code spans, fenced code and external schemes", () => {
  const content = [
    "inline `[[NotALink]]` span",
    "",
    "```",
    "[[FencedNotALink]]",
    "```",
    "",
    "[web](https://example.com/page)",
    "[[https://example.com/wiki]]",
    "[mail](mailto:a@b.c)",
  ].join("\n");
  assert.deepEqual(extractLinkTargets(content, "Notes/Source.md"), []);
});

test("link projection dedupes repeated targets without changing hasLink", () => {
  const targets = extractLinkTargets("[[A]] again [[A]] and [[A|alias]]", "Notes/Source.md");
  assert.deepEqual(targets, ["A"]);
});

test("catalogRecordFromRead carries link targets alongside the full frontmatter tree", () => {
  const record = catalogRecordFromRead({
    path: "Notes/Source.md",
    content: "[[Target]] and [x](Other.md)",
    frontmatter: { type: "note", link: "[[FromFrontmatter]]" },
    revision: "r1",
    stat: { size: 4, modified: "2026-01-01T00:00:00.000Z", created: "2025-01-01T00:00:00.000Z" },
  });
  assert.deepEqual(record.links, ["Target", "Other.md"]);
  assert.equal(record.frontmatterFault, null);
  assert.ok(record.frontmatterState);
});
