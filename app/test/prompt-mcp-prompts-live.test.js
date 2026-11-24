// P2 Task 4: prompts/list and prompts/get follow a publish inside one session, and
// the memory resource cannot disagree with agent_bootstrap.

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { adminLogin, connectMcp, prepareEnv, publishPack, shippedPack, startStack } from "./helpers/prompt-live.mjs";

const envRoot = await prepareEnv();
test.after(() => rm(envRoot, { recursive: true, force: true }));

test("prompts/list and prompts/get show the published copy", async (t) => {
  const stack = await startStack(t);
  const admin = await adminLogin(stack.origin);
  const mcp = await connectMcp(stack.origin);
  t.after(() => mcp.close());

  const before = await mcp.listPrompts();
  const beforePrompt = before.prompts.find((prompt) => prompt.name === "research_brief");
  assert.equal(beforePrompt.title, "Obsidian Research Brief");
  const beforeGet = await mcp.getPrompt({ name: "research_brief", arguments: { topic: "golden" } });
  assert.match(beforeGet.messages[0].content.text, /Search the Obsidian vault for "golden"/);

  const pack = await shippedPack();
  pack.files["mcp-prompts/research_brief/title.md"] = "Published Brief\n";
  pack.files["mcp-prompts/research_brief/description.md"] = "Published description\n";
  pack.files["mcp-prompts/research_brief/body.md"] = 'Read "{{topic}}" and brief it.\n';
  await publishPack(stack.origin, admin, pack, 0);

  const after = await mcp.listPrompts();
  const afterPrompt = after.prompts.find((prompt) => prompt.name === "research_brief");
  assert.equal(afterPrompt.title, "Published Brief");
  assert.equal(afterPrompt.description, "Published description");
  assert.deepEqual(afterPrompt.arguments, beforePrompt.arguments, "the argument schema is code-owned");

  const afterGet = await mcp.getPrompt({ name: "research_brief", arguments: { topic: "golden" } });
  assert.equal(afterGet.messages[0].content.text, 'Read "golden" and brief it.');
  assert.equal(afterGet.messages[0].role, "user", "the role is protocol, not copy");
});

test("a topic is text, never a template or an instruction", async (t) => {
  const stack = await startStack(t);
  const mcp = await connectMcp(stack.origin);
  t.after(() => mcp.close());

  const topic = '{{role}} and {{topic}} "quoted"';
  const got = await mcp.getPrompt({ name: "research_brief", arguments: { topic } });
  const text = got.messages[0].content.text;
  assert.ok(text.includes(topic));
  assert.equal(got.messages[0].role, "user");
  assert.equal(got.messages.length, 1);
});

test("the memory resource and agent_bootstrap agree after a publish", async (t) => {
  const stack = await startStack(t);
  const admin = await adminLogin(stack.origin);
  const mcp = await connectMcp(stack.origin);
  t.after(() => mcp.close());

  const pack = await shippedPack();
  pack.files["bootstrap/instructions.md"] = "Published initialize instructions.\n";
  await publishPack(stack.origin, admin, pack, 0);

  const bootstrap = JSON.parse((await mcp.callTool({ name: "agent_bootstrap", arguments: { client: "resource-test" } })).content[0].text);
  const resource = await mcp.readResource({ uri: "obsidian://agent/memory-policy" });
  const policy = JSON.parse(resource.contents[0].text);
  assert.equal(bootstrap.instructions, "Published initialize instructions.");
  assert.equal(policy.instructions, bootstrap.instructions);
});

test("a new session's initialize instructions use the active Base", async (t) => {
  const stack = await startStack(t);
  const admin = await adminLogin(stack.origin);
  const pack = await shippedPack();
  pack.files["bootstrap/instructions.md"] = "Instructions for sessions created after the publish.\n";
  await publishPack(stack.origin, admin, pack, 0);

  const fresh = await connectMcp(stack.origin, { client: "fresh" });
  t.after(() => fresh.close());
  assert.equal(fresh.getInstructions(), "Instructions for sessions created after the publish.");
});
