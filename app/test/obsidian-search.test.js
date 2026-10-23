import assert from "node:assert/strict";
import test from "node:test";
import { evaluateObsidianQuery } from "../src/search/evaluator.js";
import { parseObsidianQuery } from "../src/search/obsidian-query.js";

const record = {
  path: "Projects/Search Design.md",
  name: "Search Design.md",
  basename: "Search Design",
  tags: ["project/search", "status/active"],
  frontmatter: { Status: "active", aliases: ["查询设计"], owner: { name: "Ada" } },
  raw: "---\nStatus: active\n---\n# Search Design\nIntro exact phrase.\n\n## API\nThe same physical line has alpha and beta.\n\n## UI\nSemantic controls live here.",
  content: "# Search Design\nIntro exact phrase.\n\n## API\nThe same physical line has alpha and beta.\n\n## UI\nSemantic controls live here.",
};

function matches(query, options) {
  return evaluateObsidianQuery(record, parseObsidianQuery(query), options).matched;
}

test("parses implicit AND, OR, negation, and quoted phrases", () => {
  assert.equal(matches('"exact phrase" tag:project -file:Archive'), true);
  assert.equal(matches("file:Archive OR tag:status/active"), true);
  assert.equal(matches("tag:project file:Archive"), false);
  assert.equal(matches("-tag:project"), false);
});

test("supports Obsidian path, file, content, tag, line, and section operators", () => {
  assert.equal(matches('path:"Projects/Search"'), true);
  assert.equal(matches('file:"Search Design"'), true);
  assert.equal(matches("content:Semantic"), true);
  assert.equal(matches("tag:project"), true, "parent tag matches nested tags");
  assert.equal(matches('line:"alpha and beta"'), true);
  assert.equal(matches("line:(alpha beta)"), true);
  assert.equal(matches("line:(alpha Semantic)"), false);
  assert.equal(matches('line:"alpha UI"'), false);
  assert.equal(matches('section:"Semantic controls"'), true);
  assert.equal(matches('section:"API Semantic controls"'), false, "sibling sections stay separate");
  const preamble = { ...record, raw: "preamble alpha beta", content: "preamble alpha beta", frontmatter: {} };
  assert.equal(evaluateObsidianQuery(preamble, parseObsidianQuery("section:(alpha beta)")).matched, true);
});

test("supports property existence and property value filters case-insensitively", () => {
  assert.equal(matches("[status]"), true);
  assert.equal(matches("[STATUS:ACTIVE]"), true);
  assert.equal(matches("[owner:Ada]"), true);
  assert.equal(matches("[missing]"), false);
});

test("case-sensitive evaluation distinguishes Aa search mode", () => {
  assert.equal(matches("content:semantic"), true);
  assert.equal(matches("content:semantic", { caseSensitive: true }), false);
  assert.equal(matches("content:Semantic", { caseSensitive: true }), true);
  assert.equal(matches("file:search design", { caseSensitive: true }), false);
  assert.equal(matches("file:Search Design", { caseSensitive: true }), true);
});

test("semantic candidates retain structural filters and negative text clauses", () => {
  assert.equal(matches("tag:project related-concept", { semanticCandidate: true }), true);
  assert.equal(matches("tag:missing related-concept", { semanticCandidate: true }), false);
  assert.equal(matches("related-concept -Semantic", { semanticCandidate: true }), false);
});

test("rejects malformed queries with useful errors", () => {
  assert.throws(() => parseObsidianQuery('file:"broken'), /Unterminated quoted phrase/);
  assert.throws(() => parseObsidianQuery("tag:"), /requires a value/);
  assert.throws(() => parseObsidianQuery("OR tag:test"), /OR requires a term before/);
  assert.throws(() => parseObsidianQuery("tag:test OR"), /OR requires a term after/);
  assert.throws(() => parseObsidianQuery("line:(alpha beta"), /Unterminated grouped filter/);
});
