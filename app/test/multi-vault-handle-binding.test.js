// W0-C — cross-call handle binding safety probes (MCP multi-vault).
//
// Contract: `_Workspace/40-Projects/obsidian_mcp_server/Architecture/DEVELOPMENT -
// MCP 多库（vault scope）与按库 Git 配置.md` §13 (P0 handle binding), §36
// (cross-call security tests), §44 (old-red items 6/7) and §25 W0-C.
//
// Wave 0 is characterization only: this file changes no production behavior and
// adds no production code. The four PENDING cases are real behavioral probes run
// against the production modules at module scope. Each is RED on the frozen BASE
// (see `scratch/multi-vault/W0C/red-evidence-*.log`) and becomes active
// automatically once the owning wave binds the handle (the probe recomputes on
// every run; nothing here returns early to fake a pass). The cross-validation
// cases prove the probes execute real code paths rather than stubs.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mv-handle-binding-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.GIT_ENABLED = "false";
process.env.VERSION_HISTORY_ENABLED = "true";

const { createNotePlan, getNotePlan } = await import("../src/mutation-plans.js");
const { startFileUpload, fileUploadStatus, cancelFileUpload } = await import("../src/file-transfer.js");
const { readAppliedRecord, saveAppliedRecord } = await import("../src/mutation-idempotency.js");
const { beginBatchJournal } = await import("../src/batch-journal.js");
const { withRequestContext } = await import("../src/request-context.js");
const { createVaultRuntime } = await import("../src/vault-runtime/runtime.js");
const { vaultDataPaths } = await import("../src/vault-runtime/paths.js");
const { vaultDataKey } = await import("../src/vault-runtime/descriptor.js");
const { decodeBaseCursor, encodeBaseCursor } = await import("../src/app/base-cursor.js");
const { decodeWebCatalogCursor, encodeWebCatalogCursor } = await import("../src/app/web-catalog/cursor.js");

after(() => fs.rm(root, { recursive: true, force: true }));

const AUTHOR = { agent: "mv-w0c-probe", model: "probe" };
const VAULT_A = "vault-a";
const VAULT_B = "vault-b";
const authored = (vaultId, callback) => withRequestContext({ author: AUTHOR, vaultId }, callback);

// Wave D / D-files: a *selected* Vault whose runtime is materialized now resolves its paths through
// `requestContext().vaultRuntime` (contract §10.1/§47); a selected Vault WITHOUT a materialized
// runtime fails closed as `vault_unavailable` instead of silently using primary storage. The probe
// below therefore supplies the owning runtime (so it still measures the real plan module), and
// asserts the refusal for the bare-`vaultId` shape that Wave C's registrar alone used to produce.
const VAULT_A_RUNTIME = createVaultRuntime({
  descriptor: { id: VAULT_A, name: VAULT_A, root: vault, primary: false, writable: true },
  paths: vaultDataPaths({ primary: false, dataRoot: data, dataKey: vaultDataKey(VAULT_A) }),
  deps: { requireRequestAuthor: () => AUTHOR },
});
const authoredFor = (callback) => withRequestContext({ author: AUTHOR, vaultId: VAULT_A, vaultRuntime: VAULT_A_RUNTIME }, callback);

const PENDING = {
  plan: "PENDING §13.1 / §36.1 / §44.6: on BASE `createNotePlan` returns no `vaultId` in its public result; activated by the plan-binding wave (B5) once plan.vaultId is emitted",
  upload: "PENDING §13.4 / §36.2 / §44.7: on BASE upload metadata and `startFileUpload` output carry no `vaultId`; activated by the upload-binding wave (B6)",
  idempotency: "PENDING §13.2 / §36.3: on BASE one global `DATA_PATH/mutation-idempotency` space serves every vault and the persisted record has no `vaultId`; activated once the idempotency key space is per-vault",
  journal: "PENDING §13.3 / §36.4: on BASE the mutation journal manifest is `schema: 1` with no `vaultId`; activated once the journal schema records its vault",
};

async function readJsonRecords(directory) {
  const records = [];
  async function visit(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.name.endsWith(".json")) records.push(JSON.parse(await fs.readFile(full, "utf8")));
    }
  }
  await visit(directory);
  return records;
}

// Probe 1 (§13.1): does the plan public result carry the creating vaultId?
const planResult = await authoredFor(() => createNotePlan([
  { path: "Probe/plan-note.md", operation: "write", content: "probe body", mustNotExist: true },
]));
const planBinding = { ready: Object.hasOwn(planResult, "vaultId"), observed: planResult.vaultId ?? null };

// Wave D / D-files negative control: a selected Vault with no materialized runtime must be refused
// structurally (never served by the primary runtime, contract §47).
const bareVaultRefusal = await authored(VAULT_A, () => createNotePlan([
  { path: "Probe/plan-note.md", operation: "write", content: "probe body", mustNotExist: true },
])).then(() => null, (error) => error);

// Probe 2 (§13.4): do the durable upload metadata and the start result carry vaultId?
const started = await authored(VAULT_A, () => startFileUpload({ vaultPath: "Probe/upload.bin", totalBytes: 4 }));
const uploadMetadata = JSON.parse(
  await fs.readFile(path.join(data, "transfers", "uploads", `${started.uploadId}.json`), "utf8"),
);
const uploadBinding = {
  ready: Object.hasOwn(started, "vaultId") || Object.hasOwn(uploadMetadata, "vaultId"),
  startObserved: started.vaultId ?? null,
  metadataObserved: uploadMetadata.vaultId ?? null,
};

// Probe 3 (§13.2): is the same idempotency key an independent space per vault?
// NOTE: this probe assumes §13.2's recommended per-vault storage root. If the
// binding wave instead scopes only the caller-computed digest, the A/B save below
// must be driven through the production caller; reconcile when B6 lands.
const DIGEST = "b".repeat(64);
const appliedRecord = (planId) => ({
  digest: DIGEST, planId, planHash: "sha256:probe", author: AUTHOR, unchanged: [],
  appliedAt: new Date().toISOString(), expiresAtMs: Date.now() + 3_600_000,
  result: { planId, applied: true },
});
const saveUnder = async (vaultId, planId) => {
  try {
    await authored(vaultId, () => saveAppliedRecord(appliedRecord(planId)));
    return true;
  } catch {
    return false;
  }
};
const savedUnderA = await saveUnder(VAULT_A, "probe-plan-a");
const savedUnderB = await saveUnder(VAULT_B, "probe-plan-b");
const persistedRecords = await readJsonRecords(path.join(data, "mutation-idempotency"));
const idempotencyBinding = {
  ready: persistedRecords.some((record) => Object.hasOwn(record, "vaultId"))
    || (savedUnderA && savedUnderB && persistedRecords.length >= 2),
  vaultIds: [...new Set(persistedRecords.map((record) => record.vaultId).filter(Boolean))].sort(),
  recordCount: persistedRecords.length,
};

// Probe 4 (§13.3): does the mutation journal manifest record its vault?
const journalEntry = {
  rel: "Probe/journal-note.md", existed: false, delete: false, original: null, trashRel: null,
  data: "journal candidate",
  tempPath: ".journal-note.md.obsidian-mcp-batch-00000000-0000-0000-0000-000000000000.tmp",
};
const journal = await authored(VAULT_A, () => beginBatchJournal([journalEntry], null));
const journalManifest = JSON.parse(await fs.readFile(path.join(journal.dir, "manifest.json"), "utf8"));
const journalBinding = { ready: Object.hasOwn(journalManifest, "vaultId"), schema: journalManifest.schema };
await fs.rm(journal.dir, { recursive: true, force: true });

// --- P0 old-red cases (explicit PENDING skip on BASE) -------------------------

test("plan public result is bound to the creating vault (§13.1)", {
  skip: planBinding.ready ? false : PENDING.plan,
}, () => {
  assert.equal(planResult.vaultId, VAULT_A,
    `§13.1: plan public result must carry the creating vaultId; observed ${JSON.stringify(planBinding.observed)}`);
});

test("upload metadata and start result are bound to the creating vault (§13.4)", {
  skip: uploadBinding.ready ? false : PENDING.upload,
}, () => {
  assert.equal(uploadMetadata.vaultId, VAULT_A, "§13.4: upload metadata must persist vaultId");
  assert.equal(started.vaultId, VAULT_A, "§13.4: start_file_upload must output vaultId");
});

test("mutation idempotency key space is per-vault (§13.2)", {
  skip: idempotencyBinding.ready ? false : PENDING.idempotency,
}, () => {
  assert.equal(savedUnderB, true,
    "§13.2 / §36.3: the same idempotency key under another vault must be an independent replay space");
  assert.deepEqual(idempotencyBinding.vaultIds, [VAULT_A, VAULT_B],
    "§13.2: every persisted applied record must carry its own vaultId");
  assert.ok(idempotencyBinding.recordCount >= 2, "§13.2: A and B must persist independent records");
});

test("mutation journal manifest records its vault (§13.3)", {
  skip: journalBinding.ready ? false : PENDING.journal,
}, () => {
  assert.equal(journalManifest.vaultId, VAULT_A, "§13.3: journal manifest must record the owning vaultId");
  assert.ok(journalManifest.schema >= 2, "§13.3: journal schema must be bumped for the vault binding");
});

// --- Cross-validation: the probes above execute the real production modules ---

test("plan probe executes the real plan module (§13.1 cross-validation)", async () => {
  assert.match(planResult.planId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.match(planResult.planHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(planResult.changes.length, 1);
  assert.equal(planResult.changes[0].path, "Probe/plan-note.md");
  const refetched = await authoredFor(() => getNotePlan(planResult.planId));
  assert.equal(refetched.planHash, planResult.planHash, "the probe plan must be retrievable from the production plan store");
});

test("a selected Vault without a materialized runtime is refused, never served by the primary (§47)", () => {
  assert.equal(bareVaultRefusal?.code, "vault_unavailable",
    "Wave D / D-files: a bare vaultId must fail closed instead of silently planning against the primary Vault");
});

test("upload probe executes the real transfer module (§13.4 cross-validation)", async () => {
  assert.equal(uploadMetadata.uploadId, started.uploadId);
  assert.equal(uploadMetadata.vaultPath, "Probe/upload.bin");
  assert.equal(uploadMetadata.totalBytes, 4);
  const status = await fileUploadStatus(started.uploadId);
  assert.equal(status.status, "uploading");
  assert.equal(status.path, "Probe/upload.bin");
  await cancelFileUpload(started.uploadId);
});

test("idempotency probe executes the real durable store (§13.2 cross-validation)", async () => {
  assert.equal(savedUnderA, true, "the first applied record must persist");
  const replay = await authored(VAULT_A, () => readAppliedRecord(DIGEST));
  assert.equal(replay?.planId, "probe-plan-a", "the durable store must replay the persisted applied record");
});

test("journal probe executes the real journal writer (§13.3 cross-validation)", () => {
  assert.equal(journalManifest.state, "prepared");
  assert.equal(journalManifest.entries.length, 1);
  assert.equal(journalManifest.entries[0].path, "Probe/journal-note.md");
  assert.equal(journalManifest.entries[0].after !== null, true);
});

// --- §13.5 cursors that are already vault-scoped on BASE ----------------------

test("Web-domain cursors already carry a per-vault catalog identity (§13.5 cross-validation)", () => {
  const catalogCursor = decodeWebCatalogCursor(encodeWebCatalogCursor(
    { parent: "", sort: "name", direction: "asc", catalogId: VAULT_A, g: 1, keys: ["a.md"] },
  ));
  assert.equal(catalogCursor.catalogId, VAULT_A);
  // children-query.js:45-47 compares catalogId independently, so a cursor minted
  // for another catalog fails closed as WEB_CATALOG_CURSOR_STALE.
  const baseCursor = decodeBaseCursor(encodeBaseCursor({
    catalogId: VAULT_A, generation: 1, path: "Notes/Probe.base", revision: "sha256:1",
    view: "table", orderContract: 1, offset: 0,
  }));
  assert.equal(baseCursor.catalogId, VAULT_A);
  // base-route.js:113-125 compares the same identity; a foreign catalog is stale.
});
