// Wave D / D-plans — real dual-Vault matrix for the plans / recovery face.
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//   §29 Wave D — run a REAL two-Vault matrix per toolset instead of assuming the changed foundation
//       made every tool per-Vault; never invent a second Vault selector;
//   §3.4 a capability is a runtime fact (flip `plans` only with this face fully routed);
//   §10.1/§10.2 the request runtime + per-Vault mutation lock · §11 a per-Vault index instance
//       (an invalidation carries its runtime) · §13.1/§13.2/§13.3 per-Vault plan binding,
//       idempotency namespace and journal scope · §21 MV-I01/02/03/07 · §22.4 · §47 RETURN list.
//
// Driven here: the production tools (registered through `registerObsidianCapabilities` → C's
// vault-scope registrar → A4's context patch) over the real MCP SDK against a real primary +
// secondary Vault pair. Every assertion is an on-disk / in-process-index fact, not a self-report.
//
// NOT proven here: startup recovery of an interrupted *secondary* journal (lane HANDOFF risk 1 —
// `recoverUnlocked()` scans the legacy `DATA_ROOT/mutation-journal` tree while a routed secondary
// batch writes `<DATA_ROOT>/vaults/<dataKey>/mutation-journal`); `atomicWriteBatch` crash boundaries
// (covered by `batch-*`/`planned-*`); per-Vault retrieval/semantic/webCatalog/publish/events facts.
//
// Environment is assigned before the src modules are imported (`config.js` resolves at load).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mv-dplans-matrix-"));
const VAULTS_ROOT = path.join(ROOT, "vaults");
const PRIMARY_ROOT = path.join(VAULTS_ROOT, "primary");
const SECONDARY_ROOT = path.join(VAULTS_ROOT, "secondary");
const DATA_ROOT = path.join(ROOT, "data");
const SECONDARY = "secondary";
const SECONDARY_KEY = createHash("sha256").update(SECONDARY).digest("hex");
const PRIMARY_HISTORY = path.join(DATA_ROOT, "history");
const PRIMARY_TRASH = path.join(DATA_ROOT, "trash");
const PRIMARY_JOURNAL = path.join(DATA_ROOT, "mutation-journal");
const PRIMARY_IDEMPOTENCY = path.join(DATA_ROOT, "mutation-idempotency");
const SECONDARY_DATA_ROOT = path.join(DATA_ROOT, "vaults", SECONDARY_KEY);
const SECONDARY_HISTORY = path.join(SECONDARY_DATA_ROOT, "history");
const SECONDARY_TRASH = path.join(SECONDARY_DATA_ROOT, "trash");
const SECONDARY_JOURNAL = path.join(SECONDARY_DATA_ROOT, "mutation-journal");
const SECONDARY_IDEMPOTENCY = path.join(SECONDARY_DATA_ROOT, "mutation-idempotency");

process.env.VAULT_PATH = PRIMARY_ROOT;
process.env.WEB_VAULTS_ROOT = VAULTS_ROOT;
process.env.WEB_DEFAULT_VAULT = "primary";
process.env.DATA_PATH = DATA_ROOT;
process.env.HISTORY_PATH = PRIMARY_HISTORY;
process.env.TRASH_PATH = PRIMARY_TRASH;
process.env.RETRIEVAL_INDEX_PATH = path.join(DATA_ROOT, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";
process.env.VERSION_HISTORY_ENABLED = "true";
// The two legacy journal/idempotency roots exist from the start so the primary-root assertions
// below observe a real, empty tree (the first primary batch creates them in production).
for (const dir of [PRIMARY_ROOT, SECONDARY_ROOT, DATA_ROOT, PRIMARY_JOURNAL, PRIMARY_IDEMPOTENCY]) await fs.mkdir(dir, { recursive: true });

const { primaryRuntime } = await import("../src/vault.js");
const { primaryIndexRuntime } = await import("../src/vault-index.js");
const { DEFAULT_VAULT_ID } = await import("../src/oauth-provider.js");
const { createVaultRegistry } = await import("../src/vault-runtime/registry.js");
const { createVaultRuntimeMap } = await import("../src/vault-runtime/instances.js");
const { WIRED_CAPABILITY_KEYS } = await import("../src/vault-runtime/capabilities.js");
const { CAPABILITY_KEYS } = await import("../src/vault-runtime/descriptor.js");
const { currentLocalFs } = await import("../src/vault-runtime/request-vault.js");
const { createVaultScopeRegistrar, VAULT_SCOPE_DENY_CODES } = await import("../src/vault-scope-registrar.js");
const { withRequestContext, withRequestContextPatch } = await import("../src/request-context.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { VAULT_SCOPED_TOOLS } = await import("../src/vault-scope.js");
const { TOOL_NAMES } = await import("../src/config.js");
const { TOOLSET_TOOLS } = await import("../src/capability-catalog.js");
const { beginBatchJournal } = await import("../src/batch-journal.js");
const { idempotencyDigest } = await import("../src/mutation-idempotency.js");
const { searchRuntimeFor } = await import("../src/search-runtimes.js");

const AUTHOR = Object.freeze({ agent: "mv-dplans-matrix", model: "test" });
const testDir = new URL("..", import.meta.url);

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

const newMap = async () => {
  const map = createVaultRuntimeMap({
    registry: createVaultRegistry({ primaryRoot: PRIMARY_ROOT, primaryId: DEFAULT_VAULT_ID, vaultsRoot: VAULTS_ROOT, writable: true }),
    dataRoot: DATA_ROOT,
    primaryRuntime,
    deps: { requireRequestAuthor: () => AUTHOR },
  });
  await map.refresh();
  return map;
};
/** The exact pair server.js injects into C's registrar: one authority, no fork. */
const vaultScopeOf = (map) => ({ resolveVaultRuntime: (id) => map.get(id), vaultExists: (id) => map.has(id) });

const sha256File = async (absPath) => createHash("sha256").update(await fs.readFile(absPath)).digest("hex");
/** Recursive `path:size:sha256` listing; a missing root is an empty tree. */
async function treeSnapshot(root, prefix = "") {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const abs = path.join(root, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await treeSnapshot(abs, relative)));
    else out.push(`${relative}:${(await fs.stat(abs)).size}:${await sha256File(abs)}`);
  }
  return out;
}
const exists = (absPath) => fs.access(absPath).then(() => true, () => false);
const read = (absPath) => fs.readFile(absPath, "utf8");

/** A real MCP server: the production capability registration behind C's vault-scope registrar. */
async function toolClient(map) {
  const server = new McpServer({ name: "mv-dplans-matrix", version: "0.0.0" });
  registerObsidianCapabilities(server, { vaultScope: vaultScopeOf(map) });
  const client = new Client({ name: "mv-dplans-matrix", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const raw = (name, args = {}) => withRequestContextPatch({ author: AUTHOR }, () => client.callTool({ name, arguments: args }));
  return {
    raw,
    call: async (name, args = {}) => {
      const result = await raw(name, args);
      assert.notEqual(result.isError, true, `${name} failed: ${result.content?.[0]?.text}`);
      assert.ok(result.structuredContent, `${name} must return structuredContent`);
      return result.structuredContent;
    },
    close: async () => { await client.close(); await server.close(); },
  };
}

// ---------------------------------------------------------------------------------------
// 1. §29 plans lane — a plan's whole lifecycle lands only in the selected Vault
// ---------------------------------------------------------------------------------------

test("§29 plans lane: a vaultId=secondary plan writes, replays and records only inside the secondary Vault", async () => {
  const map = await newMap();
  assert.deepEqual([...map.ids()].sort(), [DEFAULT_VAULT_ID, SECONDARY]);

  const primaryBefore = await treeSnapshot(PRIMARY_ROOT);
  const primaryHistoryBefore = await treeSnapshot(PRIMARY_HISTORY);
  const primaryTrashBefore = await treeSnapshot(PRIMARY_TRASH);
  const primaryJournalBefore = await treeSnapshot(PRIMARY_JOURNAL);
  const primaryIdempotencyBefore = await treeSnapshot(PRIMARY_IDEMPOTENCY);

  const sessions = await toolClient(map);
  try {
    // create (side-effect free) → read → apply
    const plan = await sessions.call("plan_note_changes", {
      vaultId: SECONDARY,
      changes: [{ path: "plans/seed.md", operation: "write", content: "# seed\n\nv1\n", mustNotExist: true }],
    });
    assert.equal(plan.vaultId, SECONDARY, "the plan must carry the creating Vault (§13.1)");
    assert.equal(plan.changes[0].path, "plans/seed.md");
    assert.equal(await exists(path.join(SECONDARY_ROOT, "plans", "seed.md")), false, "planning must stay side-effect free");

    const refetched = await sessions.call("get_note_plan", { vaultId: SECONDARY, planId: plan.planId });
    assert.equal(refetched.vaultId, SECONDARY);
    assert.equal(refetched.planHash, plan.planHash);

    const key = "mv-dplans-secondary-key-0001";
    const applied = await sessions.call("apply_note_plan", { vaultId: SECONDARY, planId: plan.planId, planHash: plan.planHash, idempotencyKey: key });
    assert.equal(applied.applied, true);
    assert.equal(applied.idempotentReplay, false);
    assert.deepEqual(applied.changed.map((item) => item.path), ["plans/seed.md"]);
    // A plan write stamps its author frontmatter, so assert the body landed byte-for-byte under the
    // selected root rather than pinning the stamp.
    const written = await read(path.join(SECONDARY_ROOT, "plans", "seed.md"));
    assert.match(written, /^---\n[\s\S]*?---\n# seed\n\nv1\n$/, "the apply must land in the selected Vault, not the primary one");

    // the 24h idempotency record is namespaced per Vault (§13.2) …
    const record = path.join(SECONDARY_IDEMPOTENCY, `${idempotencyDigest(key)}.json`);
    assert.equal(await exists(record), true, "the committed mutation must persist its record under the secondary namespace");
    const stored = JSON.parse(await read(record));
    assert.equal(stored.schema, 2);
    assert.equal(stored.vaultId, SECONDARY);
    assert.equal(await exists(path.join(PRIMARY_IDEMPOTENCY, `${idempotencyDigest(key)}.json`)), false, "the primary namespace must stay untouched");

    // … and the replay of the same key is answered from that record, not by re-writing
    const replay = await sessions.call("apply_note_plan", { vaultId: SECONDARY, planId: plan.planId, planHash: plan.planHash, idempotencyKey: key });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(await read(path.join(SECONDARY_ROOT, "plans", "seed.md")), written, "a replay must not rewrite the committed bytes");
  } finally {
    await sessions.close();
  }

  assert.deepEqual(await treeSnapshot(PRIMARY_ROOT), primaryBefore, "the primary content root must be untouched");
  assert.deepEqual(await treeSnapshot(PRIMARY_HISTORY), primaryHistoryBefore, "primary history must be untouched");
  assert.deepEqual(await treeSnapshot(PRIMARY_TRASH), primaryTrashBefore, "primary trash must be untouched");
  assert.deepEqual(await treeSnapshot(PRIMARY_JOURNAL), primaryJournalBefore, "primary journals must be untouched");
  assert.deepEqual(await treeSnapshot(PRIMARY_IDEMPOTENCY), primaryIdempotencyBefore, "primary idempotency records must be untouched");
  assert.equal(await exists(path.join(PRIMARY_ROOT, "plans")), false);
});

// ---------------------------------------------------------------------------------------
// 2. §29 recovery face — move / delete / trash restore / version restore inside one Vault
// ---------------------------------------------------------------------------------------

test("§29 recovery face: move, delete, trash restore and version restore of plan tools stay inside the secondary Vault", async () => {
  const map = await newMap();
  const primaryBefore = await treeSnapshot(PRIMARY_ROOT);
  const primaryTrashBefore = await treeSnapshot(PRIMARY_TRASH);
  const primaryHistoryBefore = await treeSnapshot(PRIMARY_HISTORY);

  const sessions = await toolClient(map);
  try {
    await sessions.call("write_note", { vaultId: SECONDARY, path: "flow/seed.md", content: "# flow\n\nbody\n" });
    await sessions.call("write_note", { vaultId: SECONDARY, path: "flow/linker.md", content: "# linker\n\nsee [[flow/seed]]\n" });
    const linkerBefore = await read(path.join(SECONDARY_ROOT, "flow", "linker.md"));

    // move (+ link update): the plan, the batch and the rewritten link all stay in the secondary
    const movePlan = await sessions.call("plan_move_note", { vaultId: SECONDARY, from: "flow/seed.md", to: "archive/seed.md" });
    await sessions.call("apply_note_plan", { vaultId: SECONDARY, planId: movePlan.planId, planHash: movePlan.planHash, idempotencyKey: "mv-dplans-move-0001" });
    assert.equal(await exists(path.join(SECONDARY_ROOT, "flow", "seed.md")), false);
    assert.equal(await exists(path.join(SECONDARY_ROOT, "archive", "seed.md")), true, "the move must land in the selected Vault");
    const linkerAfter = await read(path.join(SECONDARY_ROOT, "flow", "linker.md"));
    assert.notEqual(linkerAfter, linkerBefore, "the move plan must rewrite the link inside the selected Vault");
    assert.match(linkerAfter, /archive\/seed/);

    // version history + `get_note_version` read the secondary snapshot the move produced. A batch
    // snapshots every *overwritten/deleted* path, so the pre-move revision is filed under the
    // pre-move path.
    const versions = await sessions.call("list_versions", { vaultId: SECONDARY, path: "flow/seed.md" });
    assert.ok(versions.versions.length >= 1, "the move must snapshot the pre-move revision into the secondary history root");
    const version = await sessions.call("get_note_version", { vaultId: SECONDARY, versionId: versions.versions[0].versionId });
    assert.match(version.content, /# flow/);

    // delete (+ trash backup) lands in the secondary trash root
    const deletePlan = await sessions.call("plan_delete_note", { vaultId: SECONDARY, path: "archive/seed.md", backup: true });
    const deleted = await sessions.call("apply_note_plan", { vaultId: SECONDARY, planId: deletePlan.planId, planHash: deletePlan.planHash, idempotencyKey: "mv-dplans-delete-0001" });
    assert.equal(deleted.changed[0].deleted, true);
    assert.equal(await exists(path.join(SECONDARY_ROOT, "archive", "seed.md")), false);
    assert.ok((await treeSnapshot(SECONDARY_TRASH)).length > 0, "the backup must live under the secondary trash root (§5.2)");
    const trash = await sessions.call("list_trash", { vaultId: SECONDARY, limit: 50 });
    assert.deepEqual(trash.entries.map((entry) => entry.originalPath), ["archive/seed.md"]);

    // trash restore from that secondary backup
    const restoreTrashPlan = await sessions.call("plan_restore_from_trash", { vaultId: SECONDARY, backupPath: trash.entries[0].backupPath, overwrite: false });
    await sessions.call("apply_note_plan", { vaultId: SECONDARY, planId: restoreTrashPlan.planId, planHash: restoreTrashPlan.planHash, idempotencyKey: "mv-dplans-trash-0001" });
    assert.equal(await exists(path.join(SECONDARY_ROOT, "archive", "seed.md")), true, "the trash restore must land in the selected Vault");

    // version restore + comparison of two sources
    const versionRestorePlan = await sessions.call("plan_restore_version", { vaultId: SECONDARY, versionId: version.versionId, destination: "archive/seed.md", overwrite: true });
    await sessions.call("apply_note_plan", { vaultId: SECONDARY, planId: versionRestorePlan.planId, planHash: versionRestorePlan.planHash, idempotencyKey: "mv-dplans-version-0001" });
    assert.equal(await read(path.join(SECONDARY_ROOT, "archive", "seed.md")), version.content, "the version restore must reproduce the secondary snapshot bytes");
    const comparison = await sessions.call("compare_note_versions", {
      vaultId: SECONDARY,
      left: { kind: "current", path: "archive/seed.md" },
      right: { kind: "version", versionId: version.versionId },
    });
    assert.equal(comparison.changed, false, "the restored note must compare equal to the version it came from");
    assert.ok(comparison.summary, "the comparison must carry its structural summary");
  } finally {
    await sessions.close();
  }

  assert.deepEqual(await treeSnapshot(PRIMARY_ROOT), primaryBefore, "the primary content root must be untouched");
  assert.deepEqual(await treeSnapshot(PRIMARY_TRASH), primaryTrashBefore, "primary trash must be untouched");
  assert.deepEqual(await treeSnapshot(PRIMARY_HISTORY), primaryHistoryBefore, "primary history must be untouched");
  assert.ok((await treeSnapshot(SECONDARY_HISTORY)).length > 0, "snapshots must live under the secondary's own history root (§5.2)");
});

// ---------------------------------------------------------------------------------------
// 3. §21 MV-I07 — no vaultId keeps the legacy primary semantics, and plans stay bound
// ---------------------------------------------------------------------------------------

test("§21 MV-I07: without vaultId the plan lifecycle stays on the primary Vault and is unreadable from the secondary", async () => {
  const map = await newMap();
  const secondaryBefore = await treeSnapshot(SECONDARY_ROOT);
  const sessions = await toolClient(map);
  try {
    const plan = await sessions.call("plan_note_changes", {
      changes: [{ path: "inbox/legacy-plan.md", operation: "write", content: "# legacy\n", mustNotExist: true }],
    });
    assert.equal(plan.vaultId, null, "a plan created without a Vault selection carries the legacy primary namespace");

    const applied = await sessions.call("apply_note_plan", { planId: plan.planId, planHash: plan.planHash, idempotencyKey: "mv-dplans-primary-0001" });
    assert.equal(applied.applied, true);
    assert.match(await read(path.join(PRIMARY_ROOT, "inbox", "legacy-plan.md")), /# legacy\n$/);
    assert.equal(await exists(path.join(PRIMARY_IDEMPOTENCY, `${idempotencyDigest("mv-dplans-primary-0001")}.json`)), true, "a legacy apply keeps the primary namespace");

    // the §13.1 gate: a still-live plan is not readable / appliable under another Vault
    const livePlan = await sessions.call("plan_note_changes", {
      changes: [{ path: "inbox/legacy-live.md", operation: "write", content: "# live\n", mustNotExist: true }],
    });
    const crossGet = await sessions.raw("get_note_plan", { vaultId: SECONDARY, planId: livePlan.planId });
    assert.equal(crossGet.isError, true);
    assert.match(crossGet.content[0].text, /VAULT_CONTEXT_MISMATCH/);
    const crossApply = await sessions.raw("apply_note_plan", { vaultId: SECONDARY, planId: livePlan.planId, planHash: livePlan.planHash, idempotencyKey: "mv-dplans-cross-0001" });
    assert.equal(crossApply.isError, true);
    assert.match(crossApply.content[0].text, /VAULT_CONTEXT_MISMATCH/);
    assert.equal(await exists(path.join(SECONDARY_ROOT, "inbox", "legacy-live.md")), false, "a refused cross-Vault apply must not write");
  } finally {
    await sessions.close();
  }
  assert.deepEqual(await treeSnapshot(SECONDARY_ROOT), secondaryBefore, "a primary plan lifecycle must not touch the secondary Vault");
});

// ---------------------------------------------------------------------------------------
// 4. §21 MV-I01/MV-I02 — per-Vault locks and no cross-Vault plan bleed
// ---------------------------------------------------------------------------------------

test("§21 MV-I01/MV-I02: routed plan mutations serialize inside a Vault, never block or bleed across Vaults", async () => {
  const map = await newMap();
  const secondaryRuntime = map.get(SECONDARY);
  const inVault = (vaultId, runtime, task) => withRequestContext({ author: AUTHOR, vaultId, vaultRuntime: runtime }, task);
  const routedLock = (vaultId, runtime, task) => inVault(vaultId, runtime, () => currentLocalFs().withMutationLock(task));

  // (a) a held secondary lock must not delay the primary Vault's routed lock (MV-I02)
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const held = routedLock(SECONDARY, secondaryRuntime, async () => { order.push("secondary:start"); await gate; order.push("secondary:end"); });
  await new Promise((resolve) => setImmediate(resolve));
  const startedAt = Date.now();
  await routedLock(DEFAULT_VAULT_ID, primaryRuntime, async () => { order.push("primary:ran-while-secondary-held"); });
  assert.deepEqual(order, ["secondary:start", "primary:ran-while-secondary-held"], "the primary lock must not wait behind a secondary lock");
  assert.ok(Date.now() - startedAt < 5_000, "the primary mutation must not block on another Vault's lock");
  release();
  await held;

  // (b) same-Vault routed locks stay strictly serial (MV-I01)
  const serial = [];
  await Promise.all([
    routedLock(SECONDARY, secondaryRuntime, async () => { serial.push("a:start"); await new Promise((resolve) => setTimeout(resolve, 20)); serial.push("a:end"); }),
    routedLock(SECONDARY, secondaryRuntime, async () => { serial.push("b:start"); serial.push("b:end"); }),
  ]);
  assert.deepEqual(serial, ["a:start", "a:end", "b:start", "b:end"], "same-Vault mutations stay serial (MV-I01)");

  // (c) concurrent real plan applies to two Vaults land only in their own root (MV-I02/MV-I03)
  const sessions = await toolClient(map);
  try {
    const secondaryPlan = await sessions.call("plan_note_changes", { vaultId: SECONDARY, changes: [{ path: "concurrent/secondary.md", operation: "write", content: "two\n", mustNotExist: true }] });
    const primaryPlan = await sessions.call("plan_note_changes", { changes: [{ path: "concurrent/primary.md", operation: "write", content: "one\n", mustNotExist: true }] });
    await Promise.all([
      sessions.call("apply_note_plan", { planId: primaryPlan.planId, planHash: primaryPlan.planHash, idempotencyKey: "mv-dplans-concurrent-primary" }),
      sessions.call("apply_note_plan", { vaultId: SECONDARY, planId: secondaryPlan.planId, planHash: secondaryPlan.planHash, idempotencyKey: "mv-dplans-concurrent-secondary" }),
    ]);
  } finally {
    await sessions.close();
  }
  assert.match(await read(path.join(PRIMARY_ROOT, "concurrent", "primary.md")), /one\n$/);
  assert.match(await read(path.join(SECONDARY_ROOT, "concurrent", "secondary.md")), /two\n$/);
  assert.equal(await exists(path.join(PRIMARY_ROOT, "concurrent", "secondary.md")), false, "no cross-Vault write");
  assert.equal(await exists(path.join(SECONDARY_ROOT, "concurrent", "primary.md")), false, "no cross-Vault write");
});

// ---------------------------------------------------------------------------------------
// 5. §1.4 — the journal namespace is per Vault
// ---------------------------------------------------------------------------------------

test("§1.4: a routed secondary batch journals under the secondary data layout, not the primary journal root", async () => {
  const map = await newMap();
  const secondaryRuntime = map.get(SECONDARY);
  const primaryJournalBefore = await treeSnapshot(PRIMARY_JOURNAL);

  const journal = await withRequestContext({ author: AUTHOR, vaultId: SECONDARY, vaultRuntime: secondaryRuntime }, () => beginBatchJournal([], null));
  try {
    assert.equal(journal.scope.vaultId, SECONDARY);
    assert.equal(journal.scope.journalRoot, SECONDARY_JOURNAL, "the routed scope must use the A7 per-Vault journal root");
    assert.equal(path.dirname(journal.dir), SECONDARY_JOURNAL, "the journal directory must be created under the secondary layout");
    const manifest = JSON.parse(await read(path.join(journal.dir, "manifest.json")));
    assert.equal(manifest.schema, 2);
    assert.equal(manifest.vaultId, SECONDARY, "the manifest must record its owning Vault (§13.3)");
    assert.deepEqual(manifest.entries, []);
  } finally {
    await fs.rm(journal.dir, { recursive: true, force: true });
  }

  assert.deepEqual(await treeSnapshot(PRIMARY_JOURNAL), primaryJournalBefore, "the primary journal root must not receive a secondary journal");
  assert.deepEqual((await fs.readdir(SECONDARY_JOURNAL)).filter((name) => !name.startsWith(".")), [], "the probe must clean up after itself");
});

// ---------------------------------------------------------------------------------------
// 6. §3.4 — the reported capability matches the routing this face delivers
// ---------------------------------------------------------------------------------------

test("§3.4: plans is available only with a routed plans face, and every other unwired key stays fail closed", async () => {
  const map = await newMap();
  const capabilities = map.get(SECONDARY).capabilities;
  // The exact Wave D wired set, extended (never loosened) by every lane that flips a key — the same
  // drift ratchet the D-files / workflows matrices carry, restated so this lane's own over-claim
  // control (`negctl-D-plans.mjs` NC-3) goes red without leaning on another lane's ratchet.
  // Wave D / D-plans landed after this lane and added `plans`; Wave F / F1 (§31) then converged
  // `retrieval`. Both remain exact-equality asserted (extended, never loosened).
  assert.deepEqual([...WIRED_CAPABILITY_KEYS].sort(), ["files", "git", "history", "memory", "notes", "plans", "publish", "retrieval", "skills", "trash"]);
  assert.ok(WIRED_CAPABILITY_KEYS.includes("plans"), "the plans key is flipped by this lane");
  assert.deepEqual(capabilities.plans, { available: true });
  for (const key of CAPABILITY_KEYS) {
    if (WIRED_CAPABILITY_KEYS.includes(key)) continue;
    assert.equal(capabilities[key].available, false, `${key} is not wired by any Wave D lane or Wave F / F1 and must stay fail closed (§3.4)`);
    assert.ok(capabilities[key].reason.length > 0, `${key} must carry a visible reason`);
  }
  for (const name of TOOLSET_TOOLS.plans) {
    assert.ok(TOOL_NAMES.includes(name), `${name} must be a canonical tool`);
    assert.ok(VAULT_SCOPED_TOOLS.includes(name), `${name} must be classified vault-scoped`);
  }

  // The flipped key must correspond to modules that really resolve per request — a key flipped
  // while the face still reads the primary facade is exactly the over-claim this guards.
  const source = (relative) => fs.readFile(new URL(relative, testDir), "utf8");
  const mutationPlans = await source("src/mutation-plans.js");
  const links = await source("src/tools/links.js");
  const planRuntimes = await source("src/plan-runtimes.js");
  assert.ok(mutationPlans.includes("vault-runtime/request-vault.js"), "mutation-plans.js must consume the request runtime");
  assert.ok(mutationPlans.includes("plan-runtimes.js"), "the plans post-commit invalidation must use this lane's seam");
  assert.doesNotMatch(mutationPlans, /(?<![.\w$])invalidateVaultIndex\s*\(/, "the plans face must not invalidate through the primary index facade");
  assert.ok(links.includes("plan-runtimes.js"), "the recovery face must invalidate through this lane's seam");
  assert.ok(links.includes("vault-runtime/request-vault.js"), "tools/links.js must consume the request runtime");
  assert.doesNotMatch(links, /(?<![.\w$])invalidateVaultIndex\s*\(/, "the recovery face must not invalidate through the primary index facade");
  assert.ok(planRuntimes.includes("searchRuntimeFor"), "the seam must resolve D-search's per-Vault index instance");
  assert.ok(planRuntimes.includes("currentVaultRuntime"), "the seam must resolve the request's VaultRuntime (fail closed §47)");
});

// ---------------------------------------------------------------------------------------
// 7. §11 / §21 MV-I03 — an apply moves only the selected Vault's index generation
// ---------------------------------------------------------------------------------------

test("§11: a secondary plan apply moves the secondary index generation and leaves the primary index untouched", async () => {
  const map = await newMap();
  const secondaryRuntime = map.get(SECONDARY);
  const secondaryIndex = searchRuntimeFor(secondaryRuntime).index;
  const sessions = await toolClient(map);
  try {
    await sessions.call("write_note", { vaultId: SECONDARY, path: "index/seed.md", content: "# seed\n\nbefore\n" });
    const built = await secondaryIndex.getVaultIndex();
    assert.ok(built.records.some((record) => record.path === "index/seed.md"), "the secondary index must see its own note");

    const secondaryGenerationBefore = secondaryIndex.generation;
    const primaryGenerationBefore = primaryIndexRuntime.generation;
    const primaryBuiltBefore = primaryIndexRuntime.indexBuilt;
    const revision = (await sessions.call("get_note", { vaultId: SECONDARY, path: "index/seed.md", format: "content" })).revision;

    const plan = await sessions.call("plan_note_changes", {
      vaultId: SECONDARY,
      changes: [{ path: "index/seed.md", operation: "write", content: "# seed\n\nafter\n", baseRevision: revision }],
    });
    await sessions.call("apply_note_plan", { vaultId: SECONDARY, planId: plan.planId, planHash: plan.planHash, idempotencyKey: "mv-dplans-index-0001" });

    assert.ok(secondaryIndex.generation > secondaryGenerationBefore, "the selected Vault's index generation must move");
    assert.equal(secondaryIndex.getCachedVaultIndex()?.records.some((record) => record.path === "index/seed.md"), false, "the changed record must leave the secondary cache");
    assert.equal(primaryIndexRuntime.generation, primaryGenerationBefore, "the primary index generation must not move (SEC-MV06)");
    assert.equal(primaryIndexRuntime.indexBuilt, primaryBuiltBefore, "the primary index must not be built or dropped by a secondary apply");
  } finally {
    await sessions.close();
  }
});

// ---------------------------------------------------------------------------------------
// 8. §47 — an unmaterialized Vault is refused before the plan handler runs
// ---------------------------------------------------------------------------------------

test("§47: a plan tool on a Vault without a materialized runtime is refused structurally and never runs", async () => {
  const map = await newMap();
  assert.equal(map.release(SECONDARY), true, "drop the secondary so the map no longer materializes it");
  assert.equal(map.get(SECONDARY), undefined, "an unmaterialized id must never resolve to the primary runtime");

  let handlerRuns = 0;
  const server = new McpServer({ name: "mv-dplans-refusal", version: "0.0.0" });
  createVaultScopeRegistrar(server, vaultScopeOf(map)).registerTool("plan_note_changes", {
    description: "Wave D / D-plans refusal probe on a canonical vault-scoped name.",
    inputSchema: { changes: z.array(z.object({ path: z.string() })) },
  }, () => { handlerRuns += 1; return { content: [{ type: "text", text: "{}" }], structuredContent: {} }; });
  const client = new Client({ name: "mv-dplans-refusal", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const probe = async (vaultId) => {
    const result = await withRequestContextPatch({ author: AUTHOR }, () => client.callTool({ name: "plan_note_changes", arguments: { vaultId, changes: [{ path: "plans/seed.md" }] } }));
    return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) };
  };
  try {
    const unmaterialized = await probe(SECONDARY);
    assert.equal(unmaterialized.isError, true);
    assert.equal(unmaterialized.payload.code, VAULT_SCOPE_DENY_CODES.UNAVAILABLE);
    assert.equal(handlerRuns, 0, "the handler must not run for an unmaterialized Vault (§47)");
    const unknown = await probe("no-such-vault");
    assert.equal(unknown.isError, true);
    assert.equal(unknown.payload.code, VAULT_SCOPE_DENY_CODES.UNAVAILABLE);
    assert.equal(handlerRuns, 0, "an unknown Vault must never reach the handler either");
    const primary = await probe(DEFAULT_VAULT_ID);
    assert.equal(primary.isError, false, "a materialized Vault must reach the handler");
    assert.equal(handlerRuns, 1, "exactly one handler run so far");
  } finally {
    await client.close();
    await server.close();
  }
});
