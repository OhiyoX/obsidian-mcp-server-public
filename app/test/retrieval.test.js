import assert from "node:assert/strict";
import test from "node:test";
import { chunkMarkdown, tokenize } from "../src/retrieval.js";
import { extractLinks } from "../src/obsidian.js";

test("retrieval tokenizer supports Chinese bigrams and Latin terms", () => {
  const tokens = tokenize("OpenWrt 网络故障");
  assert.ok(tokens.includes("openwrt"));
  assert.ok(tokens.includes("网络"));
  assert.ok(tokens.includes("故障"));
});

test("retrieval chunks preserve heading context", () => {
  const chunks = chunkMarkdown({ basename: "Test", frontmatter: { title: "测试" }, content: "# 测试\n\n简介\n\n## 排障\n\n处理步骤", path: "Test.md" }, { chunkSize: 400, overlap: 0 });
  assert.ok(chunks.some((chunk) => chunk.heading === "排障" && chunk.text.includes("处理步骤")));
});

test("link extraction ignores fenced and inline code examples", () => {
  const content = "[[Real]]\n```md\n[[Example]]\n```\n`[[Inline]]`";
  assert.deepEqual(extractLinks(content, "Source.md").map((link) => link.target), ["Real"]);
});
