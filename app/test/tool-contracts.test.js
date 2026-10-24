import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOL_NAMES } from "../src/config.js";
import { completeToolDescriptor, hasDeclaredToolContract, outputSchemaForTool } from "../src/tool-contracts.js";

test("graph_health validates detailed issues as structured items", () => {
  const base = { notes: 2, links: 1, counts: { resolved: 0, ambiguous: 0, unresolved: 1, attachment: 0 }, orphans: { count: 1 }, deadends: { count: 1 }, truncated: false };
  const schema = outputSchemaForTool("graph_health");
  assert.equal(schema.safeParse(base).success, true);
  assert.equal(schema.safeParse({ ...base, issues: [] }).success, true);
  assert.equal(schema.safeParse({ ...base, issues: [{ source: "A.md", raw: "[[Missing]]", status: "unresolved", candidates: [] }] }).success, true);
  assert.equal(schema.safeParse({ ...base, issues: "Missing" }).success, false);
});

test("get_note validates heading section metadata", () => {
  const schema = outputSchemaForTool("get_note");
  assert.equal(schema.safeParse({ path: "Project.md", section: "Status", heading: { title: "Status", level: 2, index: 4 }, content: "Current" }).success, true);
  assert.equal(schema.safeParse({ path: "Project.md", section: "Status", heading: "Status", content: "Current" }).success, false);
});

test("every Obsidian tool advertises an output contract and explicit safety annotations", async () => {
  assert.deepEqual(TOOL_NAMES.filter((name) => !hasDeclaredToolContract(name)), []);
  const server = new McpServer({ name: "tool-contract-test", version: "1" });
  for (const name of TOOL_NAMES) {
    const readOnlyHint = name.startsWith("get_") || name.startsWith("list_");
    server.registerTool(name, completeToolDescriptor(name, {
      title: name,
      description: `Contract test for ${name}`,
      inputSchema: {},
      annotations: { readOnlyHint, destructiveHint: !readOnlyHint, openWorldHint: false },
    }), async () => ({ content: [{ type: "text", text: "{}" }], structuredContent: {} }));
  }
  const client = new Client({ name: "tool-contract-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, TOOL_NAMES.length);
    for (const tool of tools) {
      assert.equal(tool.outputSchema?.type, "object", `${tool.name} is missing outputSchema`);
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} is missing readOnlyHint`);
      assert.equal(typeof tool.annotations?.destructiveHint, "boolean", `${tool.name} is missing destructiveHint`);
      assert.equal(typeof tool.annotations?.idempotentHint, "boolean", `${tool.name} is missing idempotentHint`);
      assert.equal(typeof tool.annotations?.openWorldHint, "boolean", `${tool.name} is missing openWorldHint`);
      assert.ok(tool._meta?.["openai/toolInvocation/invoking"]?.length <= 64);
      assert.ok(tool._meta?.["openai/toolInvocation/invoked"]?.length <= 64);
    }
    const append = tools.find((tool) => tool.name === "append_to_note");
    assert.deepEqual(append.outputSchema.required, ["path", "created", "previousSizeInBytes", "currentSizeInBytes", "revision", "preWriteVersionId"]);
    assert.equal(append.outputSchema.properties.created.type, "boolean");
    assert.equal(append.outputSchema.properties.currentSizeInBytes.type, "number");
    for (const name of ["recall", "memory_recall"]) {
      const recall = tools.find((tool) => tool.name === name);
      assert.equal(recall.outputSchema.properties.totalCandidates.type, "number", `${name}.totalCandidates must match the numeric handler result`);
    }
    const skillImport = tools.find((tool) => tool.name === "skill_import");
    assert.equal(skillImport.outputSchema.properties.imported.type, "number", "skill_import.imported must match the numeric handler result");
    const managePublish = tools.find((tool) => tool.name === "manage_publish");
    assert.equal(managePublish.outputSchema.properties.changed.type, "boolean", "manage_publish.changed must match the boolean handler result");
  } finally {
    await client.close();
    await server.close();
  }
});
