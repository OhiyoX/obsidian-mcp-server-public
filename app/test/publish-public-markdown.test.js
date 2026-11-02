import assert from "node:assert/strict";
import test from "node:test";
import { parseFrontmatter } from "../src/frontmatter.js";
import {
  publicPublishMarkdown,
  sanitizePublicMarkdownBody,
  selectPublicProperties,
} from "../src/app/publish-markdown.js";

test("Publish exposes only default-safe and explicitly opted-in properties", () => {
  const selected = selectPublicProperties({
    title: "Public title",
    description: "Public description",
    tags: ["public-tag"],
    aliases: ["Public alias"],
    type: "guide",
    status: "active",
    created: "2026-10-02",
    updated: "2026-10-03",
    date: "2026-10-04",
    count: 3,
    secret: "must-not-leak",
    mcp_author: { agent: "internal" },
    publish_properties: ["count"],
  });

  assert.deepEqual(selected, {
    title: "Public title",
    description: "Public description",
    tags: ["public-tag"],
    aliases: ["Public alias"],
    type: "guide",
    status: "active",
    created: "2026-10-02",
    updated: "2026-10-03",
    date: "2026-10-04",
    count: 3,
  });
});

test("Publish strips private frontmatter while preserving approved properties for Reader", () => {
  const source = [
    "---",
    "title: Public metadata title",
    "tags: [public-tag]",
    "secret: must-not-leak",
    "count: 7",
    "publish_properties: [count]",
    "---",
    "# Public body",
    "",
    "Hello [[Private Note]] ![[image.png]]",
  ].join("\n");

  const published = parseFrontmatter(publicPublishMarkdown(source));
  assert.equal(published.data.title, "Public metadata title");
  assert.deepEqual(published.data.tags, ["public-tag"]);
  assert.equal(published.data.count, 7);
  assert.equal("secret" in published.data, false);
  assert.equal("publish_properties" in published.data, false);
  assert.doesNotMatch(published.content, /\[\[Private Note]]/);
  assert.doesNotMatch(published.content, /image\.png/);
  assert.match(published.content, /Private Note/);
  assert.match(published.content, /附件未公开/);
});

test("Publish body sanitization keeps external Markdown untouched", () => {
  const source = "See [external](https://example.com) and [[Folder/Private#Heading|label]].";
  assert.equal(
    sanitizePublicMarkdownBody(source),
    "See [external](https://example.com) and label.",
  );
});
