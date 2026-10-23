import assert from "node:assert/strict";
import test from "node:test";
import { createAuthorAwareCallTool, normalizeAuthor, withAuthorMetadata } from "../src/author-client.js";

test("author client injects metadata only for mutations", () => {
  const author = normalizeAuthor({ agent: "codex", model: "gpt-5.6-sol" });
  const mutation = withAuthorMetadata({ name: "write_note", arguments: {}, _meta: { trace: "x" } }, author);
  assert.deepEqual(mutation._meta, { trace: "x", "obsidian/author": author });
  const read = { name: "get_note", arguments: {} };
  assert.equal(withAuthorMetadata(read, author), read);
});

test("author client resolves model at call time and supports switching", async () => {
  const calls = [];
  const callTool = createAuthorAwareCallTool(async (request) => { calls.push(request); return request; }, { agent: "codex", model: "gpt-5.6-sol" });
  await callTool({ name: "write_note", arguments: {} });
  callTool.setModel("gpt-5.6-terra");
  await callTool({ name: "git_commit", arguments: {} });
  assert.equal(calls[0]._meta["obsidian/author"].model, "gpt-5.6-sol");
  assert.equal(calls[1]._meta["obsidian/author"].model, "gpt-5.6-terra");
  assert.deepEqual(callTool.getAuthor(), { agent: "codex", model: "gpt-5.6-terra" });
});

test("author client rejects an unset model before sending a mutation", async () => {
  let called = false;
  const callTool = createAuthorAwareCallTool(async () => { called = true; }, { agent: "codex", model: () => "" });
  await callTool({ name: "get_note", arguments: {} });
  assert.throws(() => callTool({ name: "write_note", arguments: {} }), /author.model/);
  assert.equal(called, true);
});
