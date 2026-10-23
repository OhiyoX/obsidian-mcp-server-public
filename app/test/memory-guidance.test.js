import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryGuidanceRegistrar } from "../src/memory-guidance.js";
import { requireRequestAuthor } from "../src/request-context.js";

function fixture() {
  const tools = new Map();
  const server = { registerTool: (name, config, handler) => tools.set(name, { config, handler }) };
  const registrar = createMemoryGuidanceRegistrar(server, { repeatAfterReads: 3 });
  const data = { path: "project.md", revision: "revision-1" };
  const original = { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, _meta: { existing: true } };
  for (const name of ["get_note", "search_notes", "agent_bootstrap", "write_note", "git_status", "pull_note_file"]) {
    registrar.registerTool(name, { description: name, annotations: { readOnlyHint: name !== "write_note" } }, async () => original);
  }
  return { registrar, tools, original };
}

test("first read adds guidance without changing original payload or annotations", async () => {
  const { tools, original } = fixture();
  const tool = tools.get("get_note");
  const result = await tool.handler();
  assert.equal(result.structuredContent, original.structuredContent);
  assert.equal(result.content[0], original.content[0]);
  assert.equal(original.content.length, 1);
  assert.equal(result._meta.existing, true);
  assert.equal(result._meta["obsidian/memoryReminder"].kind, "bootstrap");
  assert.equal(tool.config.annotations.readOnlyHint, true);
});

test("reminders are throttled and isolated per MCP session", async () => {
  const a = fixture(); const b = fixture();
  const read = a.tools.get("search_notes").handler;
  assert.equal((await read()).content.length, 2);
  assert.equal((await read()).content.length, 1);
  assert.equal((await read()).content.length, 1);
  assert.equal((await read())._meta["obsidian/memoryReminder"].kind, "checkpoint");
  assert.equal((await b.tools.get("get_note").handler())._meta["obsidian/memoryReminder"].kind, "bootstrap");
});

test("bootstrap suppresses introductions; successful writes suggest verification", async () => {
  const { tools } = fixture();
  assert.equal((await tools.get("agent_bootstrap").handler()).content.length, 1);
  assert.equal((await tools.get("get_note").handler()).content.length, 1);
  assert.equal((await tools.get("write_note").handler())._meta["obsidian/memoryReminder"].kind, "verify-write");
});

test("failed tools and unrelated/file-transfer tools are unchanged", async () => {
  const { tools, registrar, original } = fixture();
  const failure = { isError: true, content: [{ type: "text", text: "revision conflict" }] };
  registrar.registerTool("patch_note", {}, async () => failure);
  assert.equal(await tools.get("patch_note").handler(), failure);
  assert.equal(await tools.get("git_status").handler(), original);
  assert.equal(await tools.get("pull_note_file").handler(), original);
});

test("metadata get/list never claims a note was saved", async () => {
  const { tools, registrar, original } = fixture();
  registrar.registerTool("manage_frontmatter", {}, async () => original);
  registrar.registerTool("manage_tags", {}, async () => original);
  const result = await tools.get("manage_frontmatter").handler({ action: "get" });
  assert.equal(result._meta["obsidian/memoryReminder"].kind, "bootstrap");
  assert.equal(await tools.get("manage_tags").handler({ action: "list" }), original);
  assert.equal((await tools.get("manage_frontmatter").handler({ action: "set" }))._meta["obsidian/memoryReminder"].kind, "verify-write");
});

test("every plan tool receives the initialized MCP author context", async () => {
  const { registrar, tools } = fixture();
  for (const name of ["plan_note_changes", "plan_move_note", "plan_delete_note",
    "plan_restore_version", "plan_restore_from_trash", "get_note_plan"]) {
    registrar.registerTool(name, { annotations: { readOnlyHint: true } }, async () => ({
      structuredContent: requireRequestAuthor(), content: [],
    }));
    const result = await tools.get(name).handler({}, {
      _meta: { "obsidian/author": { agent: "release-verifier", model: "gpt-6" } },
    });
    assert.deepEqual(result.structuredContent, { agent: "release-verifier", model: "gpt-6" });
  }
});

test("daily_note write actions receive the initialized MCP author context", async () => {
  const { registrar, tools } = fixture();
  registrar.registerTool("daily_note", { annotations: { readOnlyHint: false } }, async (args, extra) => ({
    structuredContent: { ...requireRequestAuthor(), extraProvided: Boolean(extra) },
    content: [],
  }));
  const tool = tools.get("daily_note");
  const write = await tool.handler({ action: "create" }, {
    _meta: { "obsidian/author": { agent: "daily-writer", model: "gpt-6" } },
  });
  assert.deepEqual(write.structuredContent, { agent: "daily-writer", model: "gpt-6", extraProvided: true });
  assert.equal(write._meta["obsidian/memoryReminder"].kind, "verify-write");
});

test("daily_note read actions resolve the author but are not treated as mutations", async () => {
  const { registrar, tools } = fixture();
  registrar.registerTool("daily_note", { annotations: { readOnlyHint: false } }, async (args) => ({
    structuredContent: { args, author: requireRequestAuthor().agent },
    content: [],
  }));
  const tool = tools.get("daily_note");
  for (const action of ["path", "read"]) {
    const result = await tool.handler({ action }, {
      _meta: { "obsidian/author": { agent: "daily-reader", model: "gpt-6" } },
    });
    assert.equal(result.structuredContent.author, "daily-reader");
    assert.equal(result._meta?.["obsidian/memoryReminder"], undefined, `${action} must not emit a verify-write reminder`);
  }
});
