// Wave M — issue #605: a malformed percent escape in *any* cookie entry used to throw URIError out of
// `parseCookies`, which runs before any auth decision, so `Cookie: junk=%` turned login and every Admin
// page into a 500. The parser must degrade per entry and never let junk stand in for a session.
import assert from "node:assert/strict";
import test from "node:test";

import { parseCookies } from "../../src/admin/http.js";

const parse = (cookie) => parseCookies({ headers: cookie === undefined ? {} : { cookie } });

test("a valid percent-encoded value is decoded exactly once", () => {
  assert.deepEqual(parse("name=%E4%B8%AD%E6%96%87"), { name: "中文" });
  assert.deepEqual(parse("a=1; b=2"), { a: "1", b: "2" });
});

test("a malformed escape no longer throws — the raw value is kept for that entry only", () => {
  for (const junk of ["%", "%ZZ", "%E4%B", "%G0", "abc%", "%2"]) {
    assert.doesNotThrow(() => parse(`junk=${junk}`), `Cookie: junk=${junk} must not throw`);
    const parsed = parse(`junk=${junk}`);
    assert.equal(parsed.junk, junk, `the undecodable value stays raw, not dropped silently into the session`);
  }
});

test("one broken entry does not disturb the valid session cookie next to it", () => {
  const session = "obsidian_mcp_admin=session-value-123";
  const parsed = parse(`junk=%; ${session}; other=%ZZ`);
  assert.equal(parsed.obsidian_mcp_admin, "session-value-123");
  assert.equal(parsed.junk, "%");
  assert.equal(parsed.other, "%ZZ");
});

test("a broken value can never be mistaken for a session: the session key stays absent", () => {
  const parsed = parse("obsidian_mcp_admin=%");
  assert.equal(parsed.obsidian_mcp_admin, "%");
  assert.notEqual(parsed.obsidian_mcp_admin, "", "a raw `%` is not an empty/valid session value");
});

test("entries without '=' and duplicated keys keep their documented behaviour", () => {
  assert.deepEqual(parse("flag"), { flag: "" });
  assert.deepEqual(parse("a=1; a=2"), { a: "2" }, "the last duplicate wins, as before");
  assert.deepEqual(parse(""), {});
  assert.deepEqual(parse(undefined), {});
});

test("header-shaped edge cases do not throw", () => {
  for (const header of ["; ;", "a=; =b", "a==b", "  spaced = %E4%B8%AD  ", "\t tabbed=%  "]) {
    assert.doesNotThrow(() => parse(header), `Cookie: ${JSON.stringify(header)} must not throw`);
  }
  assert.deepEqual(parse("a==b"), { a: "=b" }, "only the first '=' splits the pair");
  assert.equal(parse("  spaced = %E4%B8%AD  ").spaced, undefined, "the key keeps its spaces, so it is a different key");
});
