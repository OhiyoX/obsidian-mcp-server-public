import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-planned-move-"));
const vault = path.join(root, "vault");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = path.join(root, "data");
process.env.GIT_ENABLED = "false";
process.env.VERSION_HISTORY_ENABLED = "true";

const { createMovePlan, applyNotePlan } = await import("../src/mutation-plans.js");
const { withRequestContext } = await import("../src/request-context.js");
const authored = (callback) => withRequestContext({ author: { agent: "move-test", model: "test" } }, callback);

test("move preview is read-only and apply moves content with backlinks in one batch", async () => {
  const source = path.join(vault, "source.md");
  const destination = path.join(vault, "destination.md");
  const linker = path.join(vault, "linker.md");
  await fs.writeFile(source, "# Source\nbody\n");
  await fs.writeFile(linker, "See [[source]].\n");
  const plan = await authored(() => createMovePlan({ from: "source.md", to: "destination.md" }));
  assert.equal(plan.changed, true);
  assert.equal(plan.changes.length, 3);
  assert.equal(await fs.readFile(source, "utf-8"), "# Source\nbody\n");
  assert.equal(await fs.readFile(linker, "utf-8"), "See [[source]].\n");
  await assert.rejects(fs.access(destination));
  const result = await authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-move-key-0001"));
  assert.equal(result.changed.length, 3);
  await assert.rejects(fs.access(source));
  assert.equal(await fs.readFile(destination, "utf-8"), "# Source\nbody\n");
  const updated = await fs.readFile(linker, "utf-8");
  assert.doesNotMatch(updated, /\[\[source\]\]/);
  assert.match(updated, /destination/);
  const replay = await authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-move-key-0001"));
  assert.equal(replay.idempotentReplay, true);
});

test("a changed backlink rejects the whole move before any file is replaced", async () => {
  const source = path.join(vault, "conflict-source.md");
  const linker = path.join(vault, "conflict-linker.md");
  await fs.writeFile(source, "original\n");
  await fs.writeFile(linker, "[[conflict-source]]\n");
  const plan = await authored(() => createMovePlan({ from: "conflict-source.md", to: "conflict-destination.md" }));
  await fs.writeFile(linker, "external edit [[conflict-source]]\n");
  await assert.rejects(authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-move-key-0002")), /Revision conflict/);
  assert.equal(await fs.readFile(source, "utf-8"), "original\n");
  await assert.rejects(fs.access(path.join(vault, "conflict-destination.md")));
});

test("legacy move_note routes through the recoverable plan adapter", async () => {
  const handlers = new Map();
  const { registerLinkTools } = await import("../src/tools/links.js");
  registerLinkTools({ registerTool: (name, _definition, handler) => handlers.set(name, handler) });
  const source = path.join(vault, "legacy-source.md");
  await fs.writeFile(source, "legacy content\n");
  const response = await authored(() => handlers.get("move_note")({
    from: "legacy-source.md", to: "legacy-destination.md", overwrite: false, updateLinks: false,
  }));
  assert.deepEqual(response.structuredContent.moved, { from: "legacy-source.md", to: "legacy-destination.md" });
  await assert.rejects(fs.access(source));
  assert.equal(await fs.readFile(path.join(vault, "legacy-destination.md"), "utf-8"), "legacy content\n");
});

test.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
