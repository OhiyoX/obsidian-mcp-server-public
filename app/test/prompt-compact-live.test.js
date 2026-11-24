// P2 Task 3: compact group copy follows the pack, and the fingerprint server_info
// reports is the fingerprint of what tools/list actually returned.

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { adminLogin, connectMcp, prepareEnv, publishPack, shippedPack, startStack } from "./helpers/prompt-live.mjs";

const envRoot = await prepareEnv();
test.after(() => rm(envRoot, { recursive: true, force: true }));

test("a published compact summary changes the group copy in an open session", async (t) => {
  const stack = await startStack(t, { profile: "compact" });
  const admin = await adminLogin(stack.origin);
  const mcp = await connectMcp(stack.origin);
  t.after(() => mcp.close());

  const before = (await mcp.listTools()).tools;
  const beforeGroup = before.find((tool) => tool.description?.includes("新建、保存、写入、修改、追加笔记"));
  assert.ok(beforeGroup, "the edit group carries its intent sentence");

  const pack = await shippedPack();
  pack.files["tools/compact/obsidian_edit.md"] = "published edit intent\n";
  await publishPack(stack.origin, admin, pack, 0);

  const after = (await mcp.listTools()).tools;
  const afterGroup = after.find((tool) => tool.name === beforeGroup.name);
  assert.match(afterGroup.description, /published edit intent/);
  assert.ok(!afterGroup.description.includes("新建、保存、写入、修改、追加笔记"));

  // Routing, schemas and the action list are code: only the sentence moved.
  assert.deepEqual(after.map((tool) => tool.name), before.map((tool) => tool.name));
  assert.deepEqual(afterGroup.inputSchema, beforeGroup.inputSchema);
  const actions = (description) => description.slice("Obsidian actions / 笔记操作: ".length).split(". ")[0];
  assert.equal(actions(afterGroup.description), actions(beforeGroup.description));
});

test("tool descriptions still cannot be bypassed by the compact face", async (t) => {
  const stack = await startStack(t, { profile: "compact" });
  const admin = await adminLogin(stack.origin);
  const readOnly = await connectMcp(stack.origin, { scopes: ["obsidian.read"], client: "read-only" });
  t.after(() => readOnly.close());

  const pack = await shippedPack();
  pack.files["tools/compact/obsidian_edit.md"] = "copy that names write_note and manage_publish\n";
  await publishPack(stack.origin, admin, pack, 0);

  const names = (await readOnly.listTools()).tools.map((tool) => tool.name);
  assert.ok(!names.includes("obsidian_edit"), "a read-only scope has no edit group");
  const editCall = await readOnly.callTool({ name: "obsidian_edit", arguments: { action: "write_note", params: {} } });
  assert.equal(editCall.isError, true, "the compact route stays closed");
});

test("server_info reports the fingerprint of the same scope's real list", async (t) => {
  const stack = await startStack(t, { profile: "compact" });
  const admin = await adminLogin(stack.origin);
  const mcp = await connectMcp(stack.origin);
  t.after(() => mcp.close());

  const pack = await shippedPack();
  pack.files["tools/compact/obsidian_edit.md"] = "published edit intent for the fingerprint test\n";
  await publishPack(stack.origin, admin, pack, 0);

  const listed = (await mcp.listTools()).tools;
  const info = await mcp.callTool({ name: "server_info", arguments: {} });
  const discovery = JSON.parse(info.content[0].text).discovery;
  const { compactDescriptorFingerprint } = await import("../src/compact-descriptor-integrity.js");
  assert.equal(discovery.compactSchemaFingerprint, compactDescriptorFingerprint(listed));
});

test("a summary beyond the byte budget is refused at publish", async (t) => {
  const stack = await startStack(t, { profile: "compact" });
  const admin = await adminLogin(stack.origin);
  const pack = await shippedPack();
  pack.files["tools/compact/obsidian_edit.md"] = `${"x".repeat(401)}\n`;
  await assert.rejects(publishPack(stack.origin, admin, pack, 0), /HTTP 422|publish 422/);
  assert.equal(stack.store.snapshot().revision, 0);
});
