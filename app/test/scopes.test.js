import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_NAMES } from "../src/config.js";
import {
  MCP_RESOURCE_SCOPE_REQUIREMENTS,
  MCP_SCOPES,
  MCP_TOOL_SCOPE_REQUIREMENTS,
  requiredScopesForTools,
} from "../src/scopes.js";

test("Scope registry covers every MCP tool and resource", () => {
  assert.deepEqual(Object.keys(MCP_TOOL_SCOPE_REQUIREMENTS).sort(), [...TOOL_NAMES].sort());
  for (const requirements of Object.values(MCP_TOOL_SCOPE_REQUIREMENTS)) {
    assert.ok(requirements.includes("obsidian.read"));
    assert.ok(requirements.every((scope) => MCP_SCOPES.includes(scope)));
  }
  assert.deepEqual(Object.values(MCP_RESOURCE_SCOPE_REQUIREMENTS), [
    ["obsidian.read"],
    ["obsidian.read"],
    ["obsidian.read"],
    ["obsidian.read"],
  ]);
});

test("Scope registry assigns read, write and file capabilities consistently", () => {
  assert.deepEqual(requiredScopesForTools(["get_note"]), ["obsidian.read"]);
  assert.deepEqual(requiredScopesForTools(["write_note"]), ["obsidian.read", "obsidian.write"]);
  assert.deepEqual(requiredScopesForTools(["daily_note"]), ["obsidian.read", "obsidian.write"]);
  assert.deepEqual(requiredScopesForTools(["get_file"]), ["obsidian.read", "obsidian.files"]);
  assert.deepEqual(requiredScopesForTools(["start_file_upload"]), ["obsidian.read", "obsidian.write", "obsidian.files"]);
  assert.deepEqual(requiredScopesForTools(["unknown_future_tool"]), MCP_SCOPES);
});
