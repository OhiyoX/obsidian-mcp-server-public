// P2 Task 2: tools/list text follows the active Base within one session, and nothing
// else about a descriptor moves.

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { adminLogin, connectMcp, prepareEnv, publishPack, shippedPack, startStack } from "./helpers/prompt-live.mjs";

const envRoot = await prepareEnv();
test.after(() => rm(envRoot, { recursive: true, force: true }));

test("a published canonical description reaches an open session's next tools/list", async (t) => {
  const stack = await startStack(t);
  const admin = await adminLogin(stack.origin);
  const mcp = await connectMcp(stack.origin);
  t.after(() => mcp.close());

  const before = await mcp.listTools();
  const beforeTool = before.tools.find((tool) => tool.name === "get_note");
  assert.match(beforeTool.description, /Read a note as content/);

  const pack = await shippedPack();
  pack.files["tools/canonical/get_note.md"] = "Read a note. Published wording for this test.\n";
  await publishPack(stack.origin, admin, pack, 0);

  const after = await mcp.listTools();
  const afterTool = after.tools.find((tool) => tool.name === "get_note");
  const readHint = (await shippedPack()).files["memory/read-hint.md"].trimEnd();
  assert.equal(afterTool.description, `Read a note. Published wording for this test.${readHint}`);
  assert.notEqual(afterTool.description, beforeTool.description);

  // Everything except the description is the SDK's own descriptor.
  const strip = (tool) => ({ ...tool, description: undefined });
  assert.deepEqual(strip(afterTool), strip(beforeTool));

  // Re-listing does not accumulate a second guidance suffix.
  const again = (await mcp.listTools()).tools.find((tool) => tool.name === "get_note");
  assert.equal(again.description, afterTool.description);
});

test("the guidance suffix follows the pack and is never doubled", async (t) => {
  const stack = await startStack(t);
  const admin = await adminLogin(stack.origin);
  const mcp = await connectMcp(stack.origin);
  t.after(() => mcp.close());

  const pack = await shippedPack();
  pack.files["memory/read-hint.md"] = " Suffix from the pack.";
  await publishPack(stack.origin, admin, pack, 0);

  const tools = (await mcp.listTools()).tools;
  const read = tools.find((tool) => tool.name === "search_notes");
  const write = tools.find((tool) => tool.name === "write_note");
  assert.ok(read.description.endsWith(" Suffix from the pack."), read.description);
  assert.equal(read.description.split("Suffix from the pack.").length - 1, 1);
  assert.ok(!write.description.endsWith(" Suffix from the pack."), "the write hint is a different key");
});

test("tools hidden by the request scope never appear, whatever the copy says", async (t) => {
  const stack = await startStack(t);
  const admin = await adminLogin(stack.origin);
  const readOnly = await connectMcp(stack.origin, { scopes: ["obsidian.read"], client: "read-only" });
  t.after(() => readOnly.close());

  const names = (await readOnly.listTools()).tools.map((tool) => tool.name);
  assert.ok(!names.includes("write_note"));
  assert.ok(names.includes("get_note"));

  const pack = await shippedPack();
  pack.files["tools/canonical/get_note.md"] = "Copy that mentions write_note, delete_note and manage_publish.\n";
  await publishPack(stack.origin, admin, pack, 0);

  const after = await readOnly.listTools();
  const afterNames = after.tools.map((tool) => tool.name);
  assert.deepEqual(afterNames, names, "a copy edit cannot widen the visible set");
  assert.ok(!afterNames.includes("write_note"));
});
