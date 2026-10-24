import assert from "node:assert/strict";
import test from "node:test";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import { configureTaskSemantics } from "../frontend/app/features/reader/task-semantics.js";

function parser() {
  const md = new MarkdownIt({ html: false })
    .use(taskLists, { enabled: false });
  configureTaskSemantics(md);
  return md;
}

test("Reader task semantics preserve rich inline tokens without labelAfter duplication", () => {
  const html = parser().render([
    "- [x] prefix `code` **strong** suffix",
    "- [ ] open task",
  ].join("\n"));

  assert.match(html, /<li class="task-list-item is-checked" data-task="x">/);
  assert.match(html, /<input data-task="x" class="task-list-item-checkbox" checked="" disabled="" type="checkbox">/);
  assert.match(html, /<li class="task-list-item" data-task=" ">/);
  assert.match(html, /<input data-task=" " class="task-list-item-checkbox" disabled="" type="checkbox">/);

  assert.equal((html.match(/prefix/g) || []).length, 1);
  assert.equal((html.match(/suffix/g) || []).length, 1);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<strong>strong<\/strong>/);
  assert.equal(html.includes("`code`"), false);
  assert.equal(html.includes("**strong**"), false);
  assert.equal(html.includes("task-list-item-label"), false);
  assert.equal(html.includes("task-item-"), false);
});
