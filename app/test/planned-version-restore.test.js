import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-planned-version-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.GIT_ENABLED = "false";
process.env.VERSION_HISTORY_ENABLED = "true";

const { createRestoreVersionPlan, applyNotePlan } = await import("../src/mutation-plans.js");
const { withRequestContext } = await import("../src/request-context.js");
const { fileRevision } = await import("../src/vault.js");
const authored = (callback) => withRequestContext({ author: { agent: "version-test", model: "test" } }, callback);

test("version restore preview is read-only, revision-bound, and preserves UTF-8 bytes", async () => {
  const target = path.join(vault, "restore-me.md");
  const original = "# 原始内容\n中文与 emoji 😀\n";
  await fs.writeFile(target, "current content\n");
  const versionId = "restore-me.md/earlier.bak";
  await fs.mkdir(path.join(data, "history", "restore-me.md"), { recursive: true });
  await fs.writeFile(path.join(data, "history", versionId), original);
  const baseRevision = await fileRevision(target);
  const plan = await authored(() => createRestoreVersionPlan({ versionId, overwrite: true, ifMatch: baseRevision }));
  assert.equal(plan.changes[0].path, "restore-me.md");
  assert.equal(plan.changes[0].baseRevision, baseRevision);
  assert.match(plan.changes[0].diff, /原始内容/);
  assert.equal(await fs.readFile(target, "utf-8"), "current content\n");
  const result = await authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-version-key-0001"));
  assert.equal(result.changed[0].size, Buffer.byteLength(original));
  assert.equal(await fs.readFile(target, "utf-8"), original);
  assert.equal((await authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-version-key-0001"))).idempotentReplay, true);
});

test("restore refuses a changed destination and lossy version text", async () => {
  const target = path.join(vault, "conflicted.md");
  await fs.writeFile(target, "initial\n");
  const versionId = "conflicted.md/earlier.bak";
  await fs.mkdir(path.join(data, "history", "conflicted.md"), { recursive: true });
  await fs.writeFile(path.join(data, "history", versionId), "previous\n");
  const plan = await authored(() => createRestoreVersionPlan({ versionId, overwrite: true }));
  await fs.writeFile(target, "external edit\n");
  await assert.rejects(authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-version-key-0002")), /Revision conflict/i);
  assert.equal(await fs.readFile(target, "utf-8"), "external edit\n");
  await fs.writeFile(path.join(data, "history", versionId), Buffer.from([0xff, 0xfe]));
  await assert.rejects(authored(() => createRestoreVersionPlan({ versionId, overwrite: true })), /encoded data|valid/i);
});

test("planned restore preserves a UTF-8 BOM byte for byte", async () => {
  const versionId = "bom.md/earlier.bak";
  const original = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("# title\n")]);
  await fs.mkdir(path.join(data, "history", "bom.md"), { recursive: true });
  await fs.writeFile(path.join(data, "history", versionId), original);
  const plan = await authored(() => createRestoreVersionPlan({ versionId }));
  assert.equal(plan.changes[0].candidateRevision, `sha256:${createHash("sha256").update(original).digest("hex")}`);
  await authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-version-bom-key"));
  assert.deepEqual(await fs.readFile(path.join(vault, "bom.md")), original);
});

test("legacy restore_version applies through the journal", async () => {
  const handlers = new Map();
  const { registerLinkTools } = await import("../src/tools/links.js");
  registerLinkTools({ registerTool: (name, _definition, handler) => handlers.set(name, handler) });
  const versionId = "legacy-restore.md/earlier.bak";
  await fs.mkdir(path.join(data, "history", "legacy-restore.md"), { recursive: true });
  await fs.writeFile(path.join(data, "history", versionId), "legacy version\n");
  const response = await authored(() => handlers.get("restore_version")({ versionId, overwrite: false }));
  assert.deepEqual(response.structuredContent, {
    versionId, restoredPath: "legacy-restore.md",
    revision: response.structuredContent.revision, size: Buffer.byteLength("legacy version\n"),
  });
  assert.equal(await fs.readFile(path.join(vault, "legacy-restore.md"), "utf-8"), "legacy version\n");
});

test("legacy restore_version keeps byte-exact non-Markdown restore support", async () => {
  const handlers = new Map();
  const { registerLinkTools } = await import("../src/tools/links.js");
  registerLinkTools({ registerTool: (name, _definition, handler) => handlers.set(name, handler) });
  const versionId = "image.png/earlier.bak";
  const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]);
  await fs.mkdir(path.join(data, "history", "image.png"), { recursive: true });
  await fs.writeFile(path.join(data, "history", versionId), original);
  const response = await authored(() => handlers.get("restore_version")({ versionId }));
  assert.equal(response.structuredContent.restoredPath, "image.png");
  assert.deepEqual(await fs.readFile(path.join(vault, "image.png")), original);
});

test.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
