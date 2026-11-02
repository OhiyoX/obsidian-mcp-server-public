import assert from "node:assert/strict";
import test from "node:test";
import { createVaultLayout, normalizeWorkspaceRoot, workspacePathForLegacy } from "../src/vault-layout.js";

test("vault layout preserves legacy roots and maps the Workspace layout", () => {
  const legacy = createVaultLayout();
  assert.equal(legacy.projects, "40-Projects");
  assert.equal(legacy.home, "80-Maps/Home.md");
  assert.equal(legacy.aiGuide, "_AI.md");
  const next = createVaultLayout("_Workspace");
  assert.equal(next.system, "_Workspace/00-System");
  assert.equal(next.memory, "_Workspace/20-Memory");
  assert.equal(next.projects, "_Workspace/40-Projects");
  assert.equal(next.skills, "_Workspace/60-Skills");
  assert.equal(next.home, "_Workspace/80-Maps/Home.md");
  assert.equal(next.aiGuide, "_AI_README.md");
});

test("Workspace root rejects absolute, hidden and traversal paths", () => {
  for (const bad of ["/tmp", "C:/vault", "../outside", "nested/../outside", ".obsidian", "_Workspace//nested"]) {
    assert.throws(() => normalizeWorkspaceRoot(bad));
  }
  assert.equal(normalizeWorkspaceRoot("_Workspace/"), "_Workspace");
});

test("legacy private paths redirect only within the Workspace roots", () => {
  const layout = createVaultLayout("_Workspace");
  assert.equal(workspacePathForLegacy("40-Projects/example.md", layout), "_Workspace/40-Projects/example.md");
  assert.equal(workspacePathForLegacy("Notes/example.md", layout), null);
  assert.equal(workspacePathForLegacy("40-Projects-old/example.md", layout), null);
  assert.equal(workspacePathForLegacy("40-Projects/../Notes/example.md", layout), null);
  assert.equal(workspacePathForLegacy("40-Projects/example.md", createVaultLayout()), null);
});
