// P0 Task 5 gate (MCP prompts half): title, description and message body come from
// the Base pack; the argument schema and the `user` role stay code-owned.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const TEST_ROOT = await mkdtemp(path.join(os.tmpdir(), "obsidian-prompt-mcp-prompt-"));
process.env.VAULT_PATH = path.join(TEST_ROOT, "vault");
process.env.DATA_PATH = path.join(TEST_ROOT, "data");
process.env.OBSIDIAN_READ_ONLY = "true";
process.env.OAUTH_ENABLED = "false";
process.env.API_KEY = "";

const { registerPrompts, MCP_PROMPT_NAMES } = await import("../src/prompts.js");
const { bundledBasePack } = await import("../src/prompt-registry/bundled.js");

test.after(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

const BASELINE = JSON.parse(await readFile(new URL("./fixtures/prompt-base-baseline.json", import.meta.url), "utf8"));

async function withPromptClient(registry, run) {
  const server = new McpServer({ name: "prompt-mcp-prompt", version: "1" });
  registerPrompts(server, registry === undefined ? undefined : { registry });
  const client = new Client({ name: "prompt-client", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test("the pack carries the prompt copy and both servers expose research_brief", () => {
  const values = bundledBasePack().values;
  for (const name of MCP_PROMPT_NAMES) {
    for (const field of ["title", "description", "body"]) {
      assert.equal(typeof values[`prompts.${name}.${field}`], "string", `${name}.${field}`);
    }
  }
  assert.deepEqual([...MCP_PROMPT_NAMES], ["research_brief"]);
});

test("prompts/list and prompts/get reproduce the frozen copy", async () => {
  const result = await withPromptClient(undefined, async (client) => {
    const listed = await client.listPrompts();
    const got = await client.getPrompt({ name: "research_brief", arguments: { topic: "golden topic" } });
    return {
      list: JSON.parse(JSON.stringify(listed.prompts)),
      researchBrief: {
        title: listed.prompts.find((prompt) => prompt.name === "research_brief")?.title ?? null,
        description: listed.prompts.find((prompt) => prompt.name === "research_brief")?.description ?? null,
        body: got.messages[0]?.content?.text ?? null,
      },
      roles: got.messages.map((message) => message.role),
    };
  });
  assert.deepEqual(result.list, BASELINE.prompts.list);
  assert.deepEqual(result.researchBrief, BASELINE.prompts.researchBrief);
  assert.deepEqual(result.roles, ["user"]);
});

test("an edited snapshot changes the copy and still interpolates the topic safely", async () => {
  const values = { ...bundledBasePack().values };
  values["prompts.research_brief.title"] = "Edited Brief";
  values["prompts.research_brief.description"] = "Edited description";
  values["prompts.research_brief.body"] = 'Edited body for "{{topic}}".';
  const registry = { snapshot: () => ({ revision: 3, values }) };

  const topic = 'quotes " and backslash \\ stay literal';
  const result = await withPromptClient(registry, async (client) => {
    const listed = await client.listPrompts();
    const got = await client.getPrompt({ name: "research_brief", arguments: { topic } });
    return {
      prompt: listed.prompts.find((entry) => entry.name === "research_brief"),
      text: got.messages[0].content.text,
      role: got.messages[0].role,
    };
  });

  assert.equal(result.prompt.title, "Edited Brief");
  assert.equal(result.prompt.description, "Edited description");
  assert.equal(result.text, `Edited body for "${topic}".`);
  assert.equal(result.role, "user", "the role is protocol, not copy");
  // The argument schema is code-owned and still validates `topic`.
  assert.deepEqual(result.prompt.arguments?.[0]?.name, "topic");
});

test("a server without prompt support is left alone", () => {
  assert.doesNotThrow(() => registerPrompts({}));
});
