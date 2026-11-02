import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_NAMES } from "../src/config.js";
import { MCP_TOOL_SCOPE_REQUIREMENTS, requiredScopesForTools } from "../src/scopes.js";
import { COMPACT_GROUPS, compactToolView, projectCompactCall } from "../src/compact-tools.js";

const allNames = Object.values(COMPACT_GROUPS).flat();

test("interface v2 maps all 89 canonical tools exactly once", () => {
  assert.equal(Object.keys(COMPACT_GROUPS).length, 26);
  assert.equal(allNames.length, TOOL_NAMES.length);
  assert.equal(new Set(allNames).size, allNames.length);
  assert.deepEqual([...allNames].sort(), [...TOOL_NAMES].sort());
});

test("HTTP Scope and Vault projection uses native action, never the compact group", () => {
  const read = projectCompactCall("obsidian_read_read", { action: "get_note", params: { path: "x.md", vaultId: "vault" } });
  assert.equal(read.name, "get_note");
  assert.deepEqual(read.args, { path: "x.md", vaultId: "vault" });
  assert.deepEqual(requiredScopesForTools([read.name]), ["obsidian.read"]);

  const file = projectCompactCall("obsidian_file_upload", { action: "upload_file_chunk", params: { vaultId: "vault", uploadId: "x" } });
  assert.equal(file.name, "upload_file_chunk");
  assert.deepEqual(requiredScopesForTools([file.name]), ["obsidian.read", "obsidian.write", "obsidian.files"]);

  const unknown = projectCompactCall("obsidian_read_read", { action: "unknown_future_tool", params: {} });
  assert.equal(unknown.name, "obsidian_read_read");
  assert.deepEqual(requiredScopesForTools([unknown.name]), ["obsidian.read", "obsidian.write", "obsidian.files"]);

  const mismatched = projectCompactCall("obsidian_read_read", { action: "write_note", params: { vaultId: "vault" } });
  assert.equal(mismatched.name, "obsidian_read_read");
  assert.deepEqual(requiredScopesForTools([mismatched.name]), ["obsidian.read", "obsidian.write", "obsidian.files"]);
});

test("compact descriptors retain exact annotation and Scope classes and do not leak hidden names", () => {
  const descriptors = TOOL_NAMES.map((name) => ({
    name,
    title: name,
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    annotations: MCP_TOOL_SCOPE_REQUIREMENTS[name].includes("obsidian.write")
      ? { destructiveHint: true, readOnlyHint: false, openWorldHint: false }
      : { readOnlyHint: true, openWorldHint: false },
  }));
  const allowed = TOOL_NAMES.filter((name) => !MCP_TOOL_SCOPE_REQUIREMENTS[name].includes("obsidian.write"));
  const compact = compactToolView(descriptors, allowed);
  const actions = [...compact.routing.values()].flatMap((members) => [...members]);
  assert.deepEqual([...actions].sort(), [...allowed].sort());
  const allDescriptions = JSON.stringify(compact.tools);
  assert.equal(allDescriptions.includes('"write_note"'), false);
  assert.equal(allDescriptions.includes("upload_file_chunk"), false);
  const allScoped = compact.tools.filter((tool) => tool.name !== "agent_bootstrap" && tool.name !== "server_info");
  assert.ok(allScoped.every((tool) => tool.annotations.readOnlyHint === true));
  for (const tool of allScoped) {
    assert.equal(tool.inputSchema.oneOf.length, compact.routing.get(tool.name).size);
    assert.equal(tool.inputSchema.required.includes("action"), true);
    assert.equal(tool.inputSchema.required.includes("params"), true);
  }
});

test("mixing different risk annotations splits a domain instead of flattening safety hints", () => {
  const descriptors = TOOL_NAMES.map((name) => ({
    name,
    title: name,
    inputSchema: { type: "object", properties: {} },
    annotations: name === "get_note_context"
      ? { readOnlyHint: true, openWorldHint: true }
      : { readOnlyHint: true, openWorldHint: false },
  }));
  const compact = compactToolView(descriptors, TOOL_NAMES);
  const read = compact.tools.filter((tool) => tool.name.startsWith("obsidian_read"));
  assert.equal(read.length, 2);
  const groups = read.map((tool) => compact.routing.get(tool.name));
  assert.ok(groups.some((set) => set.has("get_note_context") && !set.has("get_note")));
  assert.ok(groups.some((set) => set.has("get_note") && !set.has("get_note_context")));
});
