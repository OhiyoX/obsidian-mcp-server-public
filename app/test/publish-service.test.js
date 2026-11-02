import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-publish-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
delete process.env.WEB_VAULTS_ROOT;

const { PublishService, decodeDocumentRoute, encodeDocumentRoute } = await import("../src/publish/service.js");

test.after(async () => fs.rm(root, { recursive: true, force: true }));

test("document routes round trip without granting access by themselves", () => {
  const encoded = encodeDocumentRoute("default", "Folder/Note.md");
  assert.deepEqual(decodeDocumentRoute(encoded), { vaultId: "default", path: "Folder/Note.md" });
  assert.throws(() => decodeDocumentRoute(`${encoded}!`), /Invalid document route/);
});

test("publish records are opaque, persistent, concurrent-idempotent, and fail closed when the note disappears", async () => {
  await fs.mkdir(path.join(vault, "Folder"), { recursive: true });
  await fs.writeFile(path.join(vault, "Folder", "Note.md"), "---\nsecret: hidden\n---\n# Public\n\nHello", "utf8");
  const file = path.join(data, "publish", "test-state.json");
  const service = new PublishService({ file });
  await service.ready;

  const results = await Promise.all(Array.from({ length: 8 }, () => service.publish("default", "Folder/Note.md", { actor: "test" })));
  assert.equal(new Set(results.map((item) => item.id)).size, 1);
  assert.match(results[0].id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await service.list()).length, 1);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).records.length, 1);

  const restored = new PublishService({ file });
  await restored.ready;
  const published = await restored.resolve(results[0].id);
  assert.equal(published.record.path, "Folder/Note.md");
  assert.match(published.note.content, /secret: hidden/);

  const revoked = await restored.revoke("default", "Folder/Note.md");
  assert.equal(revoked.revoked, true);
  assert.equal(await restored.resolve(results[0].id), null);

  const republished = await restored.publish("default", "Folder/Note.md", { actor: "test" });
  await fs.rm(path.join(vault, "Folder", "Note.md"));
  assert.equal(await restored.resolve(republished.id), null);
});

test("corrupt publish state is rejected instead of silently resetting publications", async () => {
  const file = path.join(data, "publish", "corrupt.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "{not json", "utf8");
  const service = new PublishService({ file });
  await assert.rejects(service.ready, /Cannot load publish state/);
});
