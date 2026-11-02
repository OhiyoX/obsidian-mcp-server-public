import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-planned-delete-"));
const vault = path.join(root, "vault");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = path.join(root, "data");
process.env.GIT_ENABLED = "false";
process.env.VERSION_HISTORY_ENABLED = "true";

const { createDeletePlan, applyNotePlan } = await import("../src/mutation-plans.js");
const { withRequestContext } = await import("../src/request-context.js");
const { restoreTrashEntry } = await import("../src/vault.js");
const authored = (callback) => withRequestContext({ author: { agent: "delete-test", model: "test" } }, callback);

test("delete preview is read-only; committed backup can be restored by its returned path", async () => {
  const target = path.join(vault, "delete-me.md");
  await fs.writeFile(target, "keep this text\n");
  const plan = await authored(() => createDeletePlan({ path: "delete-me.md", backup: true }));
  assert.equal(plan.changes[0].deleted, true);
  assert.equal(await fs.readFile(target, "utf-8"), "keep this text\n");
  const result = await authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-delete-key-0001"));
  const deleted = result.changed[0];
  assert.equal(deleted.path, "delete-me.md");
  assert.equal(deleted.previousSizeInBytes, Buffer.byteLength("keep this text\n"));
  assert.match(deleted.backup, /delete-me\.md$/);
  await assert.rejects(fs.access(target));
  const restored = await authored(() => restoreTrashEntry(deleted.backup));
  assert.equal(restored.restoredPath, "delete-me.md");
  assert.equal(await fs.readFile(target, "utf-8"), "keep this text\n");
  const replay = await authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-delete-key-0001"));
  assert.equal(replay.idempotentReplay, true);
});

test("legacy delete_note uses the journal and returns a usable Trash path", async () => {
  const handlers = new Map();
  const { registerLinkTools } = await import("../src/tools/links.js");
  registerLinkTools({ registerTool: (name, _definition, handler) => handlers.set(name, handler) });
  const target = path.join(vault, "legacy-delete.md");
  await fs.writeFile(target, "legacy\n");
  const response = await authored(() => handlers.get("delete_note")({ path: "legacy-delete.md", backup: true }));
  assert.equal(response.structuredContent.deleted, "legacy-delete.md");
  assert.equal(await fs.readFile(path.join(root, "data", "trash", response.structuredContent.backup), "utf-8"), "legacy\n");
  await assert.rejects(fs.access(target));
});

test.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
