// DEP-339: semantics pinned for the in-repo front matter module that replaces
// gray-matter. These assertions mirror gray-matter@4.0.3 behaviour, verified
// byte-for-byte by scratch/web-bases/DEP-339/evidence/check-equivalence.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { parseFrontmatter, stringifyFrontmatter, stringifyMatter } from "../src/frontmatter.js";

test("parseFrontmatter: leading --- block, absent block, and empty block", () => {
  assert.deepEqual(parseFrontmatter("---\ntitle: Home\n---\nOther stuff"), { data: { title: "Home" }, content: "Other stuff" });
  assert.deepEqual(parseFrontmatter("hello world"), { data: {}, content: "hello world" });
  assert.deepEqual(parseFrontmatter("---\n---\nbody"), { data: {}, content: "body" });
  assert.deepEqual(parseFrontmatter("---\n# only a comment\n---\nbody"), { data: {}, content: "body" });
  assert.deepEqual(parseFrontmatter(" ---\ntitle: x\n---\nbody"), { data: {}, content: " ---\ntitle: x\n---\nbody" });
  assert.deepEqual(parseFrontmatter(""), { data: {}, content: "" });
});

test("parseFrontmatter: unclosed and ...-terminated headers keep gray-matter's degradation", () => {
  // No closing delimiter: the rest is parsed as the block and content is empty.
  assert.deepEqual(parseFrontmatter("---\ntitle: Home"), { data: { title: "Home" }, content: "" });
  // `...` at end of input is a YAML document end, so the block still parses.
  assert.deepEqual(parseFrontmatter("---\ntitle: x\n..."), { data: { title: "x" }, content: "" });
  // `...` followed by markdown is a second YAML document -> parse failure (callers degrade).
  assert.throws(() => parseFrontmatter("---\ntitle: x\n...\nbody"));
  assert.throws(() => parseFrontmatter("---\ntags: [a, b\n---\nbody"));
});

test("parseFrontmatter: BOM, CRLF and engine tags", () => {
  assert.deepEqual(parseFrontmatter("\uFEFF---\ntitle: x\n---\nbody"), { data: { title: "x" }, content: "body" });
  assert.deepEqual(parseFrontmatter("---\r\ntitle: x\r\n---\r\nbody"), { data: { title: "x" }, content: "body" });
  assert.deepEqual(parseFrontmatter("---yaml\ntitle: x\n---\nbody"), { data: { title: "x" }, content: "body" });
  assert.deepEqual(parseFrontmatter('---json\n{"a":1}\n---\nbody'), { data: { a: 1 }, content: "body" });
  assert.throws(() => parseFrontmatter("---toml\na = 1\n---\nbody"));
});

test("parseFrontmatter: scalar types and key order follow the YAML schema", () => {
  const parsed = parseFrontmatter("---\ntitle: 中文标题\ntags:\n  - a/b\n  - c\nn: 2\nd: 2026-10-06\nflag: true\n---\n正文\n");
  assert.deepEqual(Object.keys(parsed.data), ["title", "tags", "n", "d", "flag"]);
  assert.deepEqual(parsed.data.tags, ["a/b", "c"]);
  assert.equal(parsed.data.n, 2);
  assert.equal(parsed.data.flag, true);
  assert.equal(parsed.data.d instanceof Date, true);
  assert.equal(parsed.content, "正文\n");
});

test("stringifyMatter: byte shape (delimiters, quoting, indentation, trailing newline)", () => {
  assert.equal(stringifyMatter({ title: "x" }, "body"), "---\ntitle: x\n---\nbody\n");
  // js-yaml 3 quoted plain scalars containing `:` or flow indicators; js-yaml 4 does
  // not, so the module forces the older quoting via a dump-only schema.
  assert.equal(
    stringifyMatter({ url: "https://x/y", k: "with: colon", flow: "a,b", bracket: "a[0]" }, "body"),
    "---\nurl: 'https://x/y'\nk: 'with: colon'\nflow: 'a,b'\nbracket: 'a[0]'\n---\nbody\n",
  );
  assert.equal(stringifyMatter({ multiline: "a\nb" }, "body"), "---\nmultiline: |-\n  a\n  b\n---\nbody\n");
  assert.equal(stringifyMatter({ nested: { a: [1, 2] } }, "body"), "---\nnested:\n  a:\n    - 1\n    - 2\n---\nbody\n");
  // An empty dump emits no delimiters, but still normalizes the trailing newline.
  assert.equal(stringifyMatter({}, "body"), "body\n");
  assert.equal(stringifyMatter({}, ""), "\n");
  assert.equal(stringifyMatter({ title: "x" }, ""), "---\ntitle: x\n---\n\n");
  assert.equal(stringifyMatter({ title: "x" }, "body\n"), "---\ntitle: x\n---\nbody\n");
});

test("stringifyMatter: merges the content's own front matter first, like gray-matter", () => {
  assert.equal(stringifyMatter({ title: "x" }, "---\nold: 1\n---\nbody"), "---\nold: 1\ntitle: x\n---\nbody\n");
});

test("stringifyFrontmatter: no rewrite when there is no data to write", () => {
  assert.equal(stringifyFrontmatter({}, "body"), "body");
  assert.equal(stringifyFrontmatter({}, "---\ntitle: x\n---\nbody"), "---\ntitle: x\n---\nbody");
  assert.equal(stringifyFrontmatter({ title: "x" }, "body"), "---\ntitle: x\n---\nbody\n");
});

test("round trip: parse(serialize(data, body)) restores data and body", () => {
  const data = { title: "中文标题", tags: ["project/search", "status/active"], n: 3, flag: false };
  const serialized = stringifyMatter(data, "# Heading\n\nBody.\n");
  const parsed = parseFrontmatter(serialized);
  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.content, "# Heading\n\nBody.\n");
});
