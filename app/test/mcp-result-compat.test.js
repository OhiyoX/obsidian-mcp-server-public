// O2: opt-in compact text encoding for MCP results. The default must stay
// byte-identical to the historical pretty-printed JSON, and
// `structuredContent` keeps carrying the same object.
import assert from "node:assert/strict";
import test from "node:test";
import { err, errStructured, ok } from "../src/result.js";

const NOTE = {
  path: "Project.md",
  frontmatter: { title: "Project", tags: ["a", "b"] },
  links: [{ source: "Project.md", raw: "[[Missing]]", status: "unresolved" }],
  truncated: false,
};

// Frozen output of the pre-O2 `ok()`: a golden string, not a computed one.
const NOTE_PRETTY = `{
  "path": "Project.md",
  "frontmatter": {
    "title": "Project",
    "tags": [
      "a",
      "b"
    ]
  },
  "links": [
    {
      "source": "Project.md",
      "raw": "[[Missing]]",
      "status": "unresolved"
    }
  ],
  "truncated": false
}`;

const BINARY_SUMMARY = { path: "Assets/diagram.png", mimeType: "image/png", size: 4096, sha256: "9f2c" };
const BINARY_PRETTY = `{
  "path": "Assets/diagram.png",
  "mimeType": "image/png",
  "size": 4096,
  "sha256": "9f2c"
}`;

const SHAPES = [
  ["nested object", NOTE],
  ["array", [{ path: "A.md", size: 1 }, { path: "B.md", size: 2 }]],
  ["string", "plain text"],
  ["number", 42],
  ["empty object", {}],
  ["empty array", []],
  ["empty string", ""],
  ["null", null],
  ["unicode", { path: "笔记/日本語.md", content: "héllo 🌍 — ok", emoji: "🧪" }],
  ["binary file metadata", BINARY_SUMMARY],
  ["structured error payload", { code: "invalid-format", message: "Expected YAML" }],
];

test("default encoding is byte-identical to the historical pretty JSON", () => {
  assert.equal(ok(NOTE).content[0].text, NOTE_PRETTY);
  assert.equal(ok(BINARY_SUMMARY).content[0].text, BINARY_PRETTY);
  assert.deepEqual(ok(NOTE).content, [{ type: "text", text: NOTE_PRETTY }]);
});

test("explicit pretty-json equals the default", () => {
  assert.deepEqual(ok(NOTE, { textEncoding: "pretty-json" }), ok(NOTE));
  assert.equal(ok(NOTE, {}).content[0].text, NOTE_PRETTY);
});

test("compact-json is smaller for a nested object and parses to the same value", () => {
  const result = ok(NOTE, { textEncoding: "compact-json" });
  assert.ok(result.content[0].text.length < NOTE_PRETTY.length);
  assert.equal(result.content[0].text.length, JSON.stringify(NOTE).length);
  assert.deepEqual(JSON.parse(result.content[0].text), NOTE);
});

test("compact-json keeps the text channel type and structuredContent", () => {
  const result = ok(NOTE, { textEncoding: "compact-json" });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.equal(result.structuredContent, NOTE);
  assert.equal(result.isError, undefined);
});

for (const [label, data] of SHAPES) {
  for (const textEncoding of ["pretty-json", "compact-json"]) {
    test(`${label} round-trips under ${textEncoding}`, () => {
      const result = ok(data, { textEncoding });
      assert.equal(result.structuredContent, data);
      assert.equal(result.content[0].type, "text");
      assert.equal(result.isError, undefined);
      assert.deepEqual(JSON.parse(result.content[0].text), data);
    });
  }
}

test("error results are unchanged in every path", () => {
  const plain = err(new Error("boom"));
  assert.deepEqual(plain, { content: [{ type: "text", text: "Error: boom" }], isError: true });

  const coded = errStructured(Object.assign(new Error("bad format"), { code: "invalid-format" }), "error");
  assert.deepEqual(coded, {
    content: [{ type: "text", text: "Error: bad format" }],
    structuredContent: { code: "invalid-format", message: "bad format" },
    isError: true,
  });
  assert.equal(errStructured(new Error("generic")).structuredContent.code, "error");
});

test("an unknown textEncoding fails loudly instead of guessing", () => {
  assert.throws(() => ok(NOTE, { textEncoding: "yaml" }), /textEncoding/);
});
