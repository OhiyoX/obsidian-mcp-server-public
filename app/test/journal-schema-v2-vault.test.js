// B6 — mutation journal schema 2 + Vault-scoped recovery (§13.3, §36.4, §22.4, §49.4).
//
// Proves: a schema 2 manifest records its Vault; recovery of a secondary journal
// uses that Vault's registered runtime (never primary roots); an unregistered
// Vault fails closed and keeps the journal; legacy schema 1 is primary-only and a
// schema 1 manifest in a secondary namespace is refused.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mv-journal-vault-"));
const primaryVault = path.join(root, "primary-vault");
const data = path.join(root, "data");
await fs.mkdir(primaryVault, { recursive: true });
process.env.VAULT_PATH = primaryVault;
process.env.DATA_PATH = data;
process.env.GIT_ENABLED = "false";
process.env.VERSION_HISTORY_ENABLED = "true";

const {
  beginBatchJournal, recoverPendingBatches, setBatchJournalState,
} = await import("../src/batch-journal.js");
const { clearMutationVaultScopes, registerMutationVaultScope } = await import("../src/mutation-idempotency.js");
const { vaultDataKey } = await import("../src/vault-runtime/descriptor.js");
const { withRequestContext } = await import("../src/request-context.js");

after(() => fs.rm(root, { recursive: true, force: true }));

const AUTHOR = { agent: "b6-journal", model: "test" };
const VAULT_A = "vault-a";
const VAULT_B = "vault-b";
const as = (vaultId, callback) => withRequestContext({ author: AUTHOR, vaultId }, callback);
const sha = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const tempFor = (name) => `.${name}.obsidian-mcp-batch-00000000-0000-0000-0000-000000000000.tmp`;

const journalDataRoot = path.join(data, "mutation-journal");
const keyA = vaultDataKey(VAULT_A);
const keyB = vaultDataKey(VAULT_B);
const rootsA = {
  vaultRoot: path.join(root, "a", "vault"),
  trashRoot: path.join(root, "a", "trash"),
  historyRoot: path.join(root, "a", "history"),
  idempotencyRoot: path.join(data, "vaults", keyA, "mutation-idempotency"),
  journalRoot: path.join(journalDataRoot, keyA),
};

async function registerA() {
  await fs.mkdir(rootsA.vaultRoot, { recursive: true });
  await fs.mkdir(rootsA.trashRoot, { recursive: true });
  await fs.mkdir(rootsA.historyRoot, { recursive: true });
  return registerMutationVaultScope({ vaultId: VAULT_A, ...rootsA });
}

async function writeLegacyManifest(dir, manifest) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dir, "backup-0"), "before-legacy");
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
}

beforeEach(async () => {
  clearMutationVaultScopes();
  await fs.rm(journalDataRoot, { recursive: true, force: true });
  await fs.rm(path.join(data, "vaults"), { recursive: true, force: true });
  await fs.rm(primaryVault, { recursive: true, force: true });
  await fs.mkdir(primaryVault, { recursive: true });
});

test("schema 2 manifest records its Vault and recovery uses that Vault's roots (§13.3)", async () => {
  await registerA();
  const rel = "nested/note.md";
  const target = path.join(rootsA.vaultRoot, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "after-a");

  const journal = await as(VAULT_A, () => beginBatchJournal([{
    rel, existed: true, delete: false, original: "before-a", trashRel: null, data: "after-a",
    tempPath: tempFor("note.md"),
  }], null));
  const manifest = JSON.parse(await fs.readFile(path.join(journal.dir, "manifest.json"), "utf-8"));
  assert.equal(manifest.schema, 2);
  assert.equal(manifest.vaultId, VAULT_A);
  assert.equal(journal.dir.startsWith(`${path.join(journalDataRoot, keyA)}${path.sep}`), true);

  await recoverPendingBatches();
  assert.equal(await fs.readFile(target, "utf-8"), "before-a", "recovery must roll back inside Vault A's root");
  await assert.rejects(fs.access(journal.dir), "the recovered journal is removed");
  await assert.rejects(fs.access(path.join(primaryVault, rel)), "the primary Vault must not be touched");
});

test("a schema 2 journal for an unregistered Vault fails closed and is preserved (§13.3 / SEC-MV06)", async () => {
  const journal = await as(VAULT_B, () => beginBatchJournal([{
    rel: "b-note.md", existed: false, delete: false, original: null, trashRel: null, data: "b-body",
    tempPath: tempFor("b-note.md"),
  }], null));
  const manifest = JSON.parse(await fs.readFile(path.join(journal.dir, "manifest.json"), "utf-8"));
  assert.equal(manifest.vaultId, VAULT_B);

  await assert.rejects(recoverPendingBatches(), (error) => error?.code === "JOURNAL_VAULT_UNRESOLVED");
  // Journal preserved, no primary fallback, no primary write.
  assert.equal(JSON.parse(await fs.readFile(path.join(journal.dir, "manifest.json"), "utf-8")).vaultId, VAULT_B);
  await assert.rejects(fs.access(path.join(primaryVault, "b-note.md")));
  assert.equal((await fs.readdir(journalDataRoot)).includes(keyB), true);
});

test("legacy schema 1 recovery is primary-only (§22.4 / §49.4)", async () => {
  const target = path.join(primaryVault, "legacy.md");
  await fs.writeFile(target, "after-legacy");
  const dir = path.join(journalDataRoot, randomUUID());
  await writeLegacyManifest(dir, {
    schema: 1, state: "prepared", idempotency: null,
    entries: [{
      path: "legacy.md", existed: true, delete: false, trash: null, consumeTrash: null,
      before: sha("before-legacy"), after: sha("after-legacy"), backup: "backup-0",
      temp: tempFor("legacy.md"), history: false, historyName: "unused.bak",
    }],
  });

  await recoverPendingBatches();
  assert.equal(await fs.readFile(target, "utf-8"), "before-legacy");
  await assert.rejects(fs.access(dir));
});

test("a schema 1 manifest inside a secondary namespace is refused, not guessed (§13.3 / §22.4)", async () => {
  const dir = path.join(journalDataRoot, keyA, randomUUID());
  await writeLegacyManifest(dir, {
    schema: 1, state: "prepared", idempotency: null,
    entries: [{
      path: "legacy.md", existed: true, delete: false, trash: null, consumeTrash: null,
      before: sha("before-legacy"), after: sha("after-legacy"), backup: "backup-0",
      temp: tempFor("legacy.md"), history: false, historyName: "unused.bak",
    }],
  });

  await assert.rejects(recoverPendingBatches(), (error) => error?.code === "VAULT_CONTEXT_MISMATCH");
  assert.equal(await fs.readFile(path.join(dir, "manifest.json"), "utf-8").then(() => true), true);
  assert.equal((await fs.readdir(primaryVault)).length, 0, "primary Vault must stay untouched");
});

test("a committed schema 2 journal persists its idempotency record into the owning Vault (§13.2 / §13.3)", async () => {
  await registerA();
  const rel = "committed.md";
  const target = path.join(rootsA.vaultRoot, rel);
  await fs.writeFile(target, "after-c");
  const planId = "11111111-1111-4111-8111-111111111111";
  const planHash = `sha256:${"c".repeat(64)}`;
  const digest = createHash("sha256").update("journal-committed-key-0001").digest("hex");
  const appliedAt = new Date().toISOString();

  const journal = await as(VAULT_A, () => beginBatchJournal([{
    rel, existed: true, delete: false, original: "before-c", trashRel: null, data: "after-c",
    tempPath: tempFor("committed.md"),
  }], {
    digest, planId, planHash, author: AUTHOR, unchanged: [], appliedAt, expiresAtMs: Date.now() + 3_600_000,
  }));
  await setBatchJournalState(journal, "committed", {
    planId, planHash, applied: true, idempotentReplay: false, changed: [], unchanged: [], appliedAt,
  });

  await recoverPendingBatches();
  const saved = JSON.parse(await fs.readFile(path.join(rootsA.idempotencyRoot, `${digest}.json`), "utf-8"));
  assert.equal(saved.vaultId, VAULT_A);
  assert.equal(saved.planId, planId);
  assert.equal(saved.schema, 2);
  await assert.rejects(fs.access(path.join(data, "mutation-idempotency", `${digest}.json`)),
    "a secondary recovery must never write the primary idempotency root");
  // The committed history snapshot also landed in Vault A's history root.
  assert.equal((await fs.readdir(path.join(rootsA.historyRoot, rel))).some((name) => name.endsWith(".bak")), true);
});
