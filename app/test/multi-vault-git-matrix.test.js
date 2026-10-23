// Wave D / D-git — real dual-Vault matrix for the git toolset (per-Vault GitRuntime parity lane).
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//   §29 Wave D git lane — a REAL two-Vault matrix against REAL git repositories instead of assuming
//       the shared foundation made the git tools per-Vault; never invent a second Vault selector;
//   §16/§16.1 a GitRuntime per Vault with `-C <its own root>`, §16.2 repo-presence state,
//   §16.3 timer reconcile, §16.4 a write goes to the *current* VaultRuntime's Git; §15.4 inheritance;
//   §3.4 capability is a runtime fact; §21 MV-I02/MV-I07; §42 SEC-MV06; §47 RETURN list.
//
// Driven here: the production git tools (registered through `registerObsidianCapabilities` -> C's
// vault-scope registrar -> A4's context patch) over the real MCP SDK, against a real primary + three
// secondary Vaults whose roots are real `git init` repositories. Every assertion is an
// on-disk/on-repo fact, not a handler self-report.
//
// NOT proven here (declared, not implied): a secondary's *plain localFs* write (e.g. `write_note`)
// does not yet feed that Vault's pending set — D0's runtime map injects `deps.requireRequestAuthor`
// only and `server.js` (498/500) is frozen this lane; the routed write paths
// (`tools/files.js#manage_folders`, `batch-journal.js`) and every git tool are per-Vault. Admin
// per-vault Git configuration/reload (Wave E) and the remaining Wave D toolsets belong to their own
// lanes. See `D-git.HANDOFF.md` §risks.
//
// Environment is assigned before the src modules are imported (`config.js` resolves at load).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

const execFileAsync = promisify(execFile);
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mv-dgit-matrix-"));
const VAULTS_ROOT = path.join(ROOT, "vaults");
const PRIMARY_ROOT = path.join(VAULTS_ROOT, "primary");
const SECONDARY_ROOT = path.join(VAULTS_ROOT, "secondary");
const DISABLED_ROOT = path.join(VAULTS_ROOT, "secondary-off");
const NO_REPO_ROOT = path.join(VAULTS_ROOT, "secondary-norepo");
const DATA_ROOT = path.join(ROOT, "data");
const SECONDARY = "secondary";
const DISABLED = "secondary-off";
// Git enabled by record, but the Vault root is not a repository (§16.2 "enabled + repository-missing").
const NO_REPO = "secondary-norepo";
const PRIMARY_BRANCH = "primary-branch";
const SECONDARY_BRANCH = "secondary-branch";

process.env.VAULT_PATH = PRIMARY_ROOT;
process.env.WEB_VAULTS_ROOT = VAULTS_ROOT;
process.env.WEB_DEFAULT_VAULT = "primary";
process.env.DATA_PATH = DATA_ROOT;
process.env.HISTORY_PATH = path.join(DATA_ROOT, "history");
process.env.TRASH_PATH = path.join(DATA_ROOT, "trash");
process.env.RETRIEVAL_INDEX_PATH = path.join(DATA_ROOT, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.VERSION_HISTORY_ENABLED = "true";
// The deployment baseline the *primary* Vault resolves to (a secondary has its own A5 record).
process.env.GIT_ENABLED = "true";
process.env.GIT_AUTO_COMMIT = "false";
process.env.GIT_AUTO_PUSH = "false";
process.env.GIT_AUTO_COMMIT_SWEEP = "false";
process.env.GIT_COMMIT_DEBOUNCE_SECONDS = "300";
process.env.GIT_COMMIT_MAX_DELAY_SECONDS = "900";
process.env.GIT_AUTHOR_NAME = "Obsidian MCP";
process.env.GIT_AUTHOR_EMAIL = "obsidian-mcp@local";

const AUTHOR = Object.freeze({ agent: "mv-dgit-matrix", model: "test" });
const MCP_COMMIT_MESSAGE = "chore(obsidian): save MCP changes";
const testDir = new URL("..", import.meta.url);

/** Real repositories: the primary, a git-enabled secondary, and a default-disabled secondary. */
async function gitIn(dir, ...args) {
  return execFileAsync("git", ["-C", dir, ...args], { encoding: "utf-8" });
}

async function seedRepo(dir, branch, file, subject) {
  await fs.mkdir(dir, { recursive: true });
  await gitIn(dir, "init", "-q", "-b", branch);
  await fs.writeFile(path.join(dir, file), `${subject}\n`);
  await gitIn(dir, "add", file);
  await gitIn(dir, "-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-q", "-m", subject);
}

for (const root of [VAULTS_ROOT, DATA_ROOT]) await fs.mkdir(root, { recursive: true });
after(() => fs.rm(ROOT, { recursive: true, force: true }));
await seedRepo(PRIMARY_ROOT, PRIMARY_BRANCH, "primary-seed.md", "primary seed commit");
await seedRepo(SECONDARY_ROOT, SECONDARY_BRANCH, "secondary-seed.md", "secondary seed commit");
await seedRepo(DISABLED_ROOT, "disabled-branch", "disabled-seed.md", "disabled seed commit");
await fs.mkdir(NO_REPO_ROOT, { recursive: true });
await fs.writeFile(path.join(NO_REPO_ROOT, "not-a-repo.md"), "plain folder\n");

// The A5 store: only the git-enabled secondary has a record. `secondary-off` has none, so §15.4
// default-disables it even though its root *is* a real repository.
await fs.writeFile(path.join(DATA_ROOT, "git-vaults.json"), `${JSON.stringify({
  schema: 1,
  revision: 1,
  vaults: {
    [SECONDARY]: {
      enabled: true,
      autoCommit: true,
      autoPush: false,
      autoCommitSweep: false,
      debounceSeconds: 5,
      maxDelaySeconds: 1,
      sweepIntervalSeconds: 900,
      remote: "origin",
      branch: "",
      updatedAt: "2026-10-07T00:00:00.000Z",
    },
    [NO_REPO]: {
      enabled: true,
      autoCommit: false,
      autoPush: false,
      autoCommitSweep: false,
      debounceSeconds: 300,
      maxDelaySeconds: 900,
      sweepIntervalSeconds: 900,
      remote: "origin",
      branch: "",
      updatedAt: "2026-10-07T00:00:00.000Z",
    },
  },
})}\n`);

const { gitConfigStoreInstance, primaryGitRuntime } = await import("../src/git.js");
const { primaryRuntime } = await import("../src/vault.js");
const { DEFAULT_VAULT_ID } = await import("../src/oauth-provider.js");
const { createVaultRegistry } = await import("../src/vault-runtime/registry.js");
const { createVaultRuntimeMap } = await import("../src/vault-runtime/instances.js");
const { WIRED_CAPABILITY_KEYS } = await import("../src/vault-runtime/capabilities.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { createVaultScopeRegistrar, VAULT_SCOPE_DENY_CODES } = await import("../src/vault-scope-registrar.js");
const { withRequestContextPatch } = await import("../src/request-context.js");
const { gitRuntimeFor } = await import("../src/git-runtimes.js");
const { VAULT_SCOPED_TOOLS } = await import("../src/vault-scope.js");
const { TOOL_NAMES } = await import("../src/config.js");

// The durable A5 load must have settled before a materialized secondary can read its record.
await gitConfigStoreInstance().ready;

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

const headOf = async (dir) => (await gitIn(dir, "rev-parse", "HEAD")).stdout.trim();
const porcelainOf = async (dir) => (await gitIn(dir, "status", "--porcelain=v1")).stdout.trim();
const exists = (absPath) => fs.access(absPath).then(() => true, () => false);
/** Recursive `path:size:sha256`-free content listing of the working tree (no `.git`). */
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
    if (prefix === "" && entry.name === ".git") continue;
    const abs = path.join(root, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await treeSnapshot(abs, relative)));
    else out.push(`${relative}:${(await fs.readFile(abs, "utf8")).trimEnd()}`);
  }
  return out;
}
async function waitFor(condition, { timeoutMs = 12_000, stepMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** A real MCP server: the production capability registration behind C's vault-scope registrar. */
async function toolClient(map) {
  const server = new McpServer({ name: "mv-dgit-matrix", version: "0.0.0" });
  registerObsidianCapabilities(server, { vaultScope: vaultScopeOf(map) });
  const client = new Client({ name: "mv-dgit-matrix", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  // `_meta["obsidian/author"]` is how a real host attributes a write (§7 tool contract); the
  // memory-guidance registrar derives it for mutating tools, so `git_commit` stamps this author.
  const raw = (name, args = {}) => withRequestContextPatch({ author: AUTHOR }, () => client.callTool({
    name,
    arguments: args,
    _meta: { "obsidian/author": AUTHOR },
  }));
  return {
    raw,
    call: async (name, args = {}) => {
      const result = await raw(name, args);
      assert.notEqual(result.isError, true, `${name} failed: ${result.content?.[0]?.text}`);
      assert.ok(result.structuredContent, `${name} must return structuredContent`);
      return result.structuredContent;
    },
    refusal: async (name, args = {}) => {
      const result = await raw(name, args);
      assert.equal(result.isError, true, `${name} was expected to fail closed`);
      return { payload: result.structuredContent ?? JSON.parse(result.content[0].text), text: result.content[0].text };
    },
    close: async () => { await client.close(); await server.close(); },
  };
}

// ---- 1. §29 git lane — reads describe the *selected* Vault's own repository

test("§29 git lane: git_status/git_log/git_diff describe the secondary repository only", async () => {
  // A commit that exists only in the secondary repository, made outside MCP (the other Vault's
  // history must stay invisible in either direction).
  await fs.writeFile(path.join(SECONDARY_ROOT, "secondary-only.md"), "secondary only\n");
  await gitIn(SECONDARY_ROOT, "add", "secondary-only.md");
  await gitIn(SECONDARY_ROOT, "-c", "user.name=External", "-c", "user.email=external@example.com", "commit", "-q", "-m", "secondary-only commit");
  await fs.writeFile(path.join(PRIMARY_ROOT, "primary-only.md"), "primary only\n");
  await gitIn(PRIMARY_ROOT, "add", "primary-only.md");
  await gitIn(PRIMARY_ROOT, "-c", "user.name=External", "-c", "user.email=external@example.com", "commit", "-q", "-m", "primary-only commit");

  const map = await newMap();
  const primaryHead = await headOf(PRIMARY_ROOT);
  const primaryPorcelain = await porcelainOf(PRIMARY_ROOT);
  const sessions = await toolClient(map);
  try {
    const secondaryStatus = await sessions.call("git_status", { vaultId: SECONDARY });
    assert.equal(secondaryStatus.branch, SECONDARY_BRANCH, "the selected Vault's branch, not the primary's");
    assert.equal(secondaryStatus.clean, true);
    assert.equal(secondaryStatus.configuration.enabled, true, "the secondary's own persisted record is in effect");
    assert.equal(secondaryStatus.configuration.autoCommit, true);

    const secondaryLog = (await sessions.call("git_log", { vaultId: SECONDARY, limit: 10 })).commits.map((entry) => entry.subject);
    assert.ok(secondaryLog.includes("secondary-only commit"), "the secondary's own commit is visible");
    assert.ok(!secondaryLog.includes("primary-only commit"), "the primary's commit must not be visible in the secondary");
    assert.ok(!secondaryLog.includes("primary seed commit"));

    const primaryLog = (await sessions.call("git_log", { limit: 10 })).commits.map((entry) => entry.subject);
    assert.ok(primaryLog.includes("primary-only commit"), "no vaultId still reads the primary repository (legacy)");
    assert.ok(!primaryLog.includes("secondary-only commit"), "the secondary's commit must not be visible in the primary");

    // A modification inside the secondary repository is reported with the secondary's own diff.
    await fs.appendFile(path.join(SECONDARY_ROOT, "secondary-only.md"), "more\n");
    const dirty = await sessions.call("git_status", { vaultId: SECONDARY });
    assert.equal(dirty.clean, false);
    assert.deepEqual(dirty.changes.map((change) => change.path), ["secondary-only.md"]);
    const diff = await sessions.call("git_diff", { vaultId: SECONDARY, path: "secondary-only.md" });
    assert.match(diff.diff, /\+more/);
    assert.equal(diff.path, "secondary-only.md");
    // Leave the shared fixture repository as this test found it.
    await gitIn(SECONDARY_ROOT, "checkout", "--", "secondary-only.md");

    // The primary is untouched by every one of those secondary-facing calls.
    assert.equal(await headOf(PRIMARY_ROOT), primaryHead);
    assert.equal(await porcelainOf(PRIMARY_ROOT), primaryPorcelain);
    assert.equal((await sessions.call("git_status")).clean, true, "the primary repository is still clean");
  } finally {
    await sessions.close();
  }
});

// ---- 2. §21 MV-I07 — no vaultId keeps the legacy primary semantics

test("§21 MV-I07: without vaultId every git tool stays on the primary Vault", async () => {
  const map = await newMap();
  const secondaryHead = await headOf(SECONDARY_ROOT);
  const sessions = await toolClient(map);
  try {
    const status = await sessions.call("git_status");
    assert.equal(status.branch, PRIMARY_BRANCH);
    assert.equal(status.configuration.enabled, true, "the primary resolves to the GIT_* deployment baseline");
    const explicitPrimary = await sessions.call("git_status", { vaultId: DEFAULT_VAULT_ID });
    assert.deepEqual(explicitPrimary, status, "an explicit primary vaultId is byte-identical to omitting it");
    assert.equal((await sessions.call("git_log", { limit: 5 })).commits[0].subject, "primary-only commit");
  } finally {
    await sessions.close();
  }
  assert.equal(await headOf(SECONDARY_ROOT), secondaryHead, "a primary request must not touch the secondary repository");
});

// ---- 3. git_commit writes only the selected Vault's repository

test("§16.1/§29: git_commit on the secondary commits only the secondary repository", async () => {
  const map = await newMap();
  const primaryHead = await headOf(PRIMARY_ROOT);
  const primaryPorcelain = await porcelainOf(PRIMARY_ROOT);
  const secondaryHead = await headOf(SECONDARY_ROOT);
  const sessions = await toolClient(map);
  try {
    await sessions.call("write_file", { vaultId: SECONDARY, path: "notes/commit-me.md", content: "commit me\n" });
    const committed = await sessions.call("git_commit", { vaultId: SECONDARY, message: "mcp secondary commit", paths: ["notes/commit-me.md"] });
    assert.equal(committed.committed, true);
    assert.equal(await headOf(SECONDARY_ROOT), committed.hash, "the secondary repository advanced");
    assert.notEqual(committed.hash, secondaryHead);
    assert.deepEqual(committed.author, AUTHOR);
    const log = (await sessions.call("git_log", { vaultId: SECONDARY, limit: 3 })).commits;
    assert.equal(log[0].subject, "mcp secondary commit");
    assert.ok(!(await sessions.call("git_status", { vaultId: SECONDARY })).changes.some((change) => change.path === "notes/commit-me.md"), "the committed path is clean");

    // Path containment is decided against the *selected* runtime's own root (SEC-MV01).
    const escaped = await sessions.refusal("git_commit", { vaultId: SECONDARY, message: "bad", paths: ["../outside.md"] });
    assert.equal(escaped.payload.code, "git_runtime_invalid_path");
  } finally {
    await sessions.close();
  }
  assert.equal(await headOf(PRIMARY_ROOT), primaryHead, "the primary repository must not advance");
  assert.equal(await porcelainOf(PRIMARY_ROOT), primaryPorcelain, "and must not be dirtied either");
  assert.equal((await gitIn(PRIMARY_ROOT, "log", "-1", "--format=%s")).stdout.trim(), "primary-only commit");
});

// ---- 4. §16.4 — a routed write feeds that Vault's auto-commit, never the primary's

test("§16.4: a secondary write path auto-commits inside the secondary repository only", async () => {
  const map = await newMap();
  const secondaryRuntime = map.get(SECONDARY);
  const primaryGit = primaryGitRuntime();
  assert.equal(map.unguarded(DEFAULT_VAULT_ID), primaryRuntime);
  // §16.1/SEC-MV06: the secondary owns a distinct GitRuntime rooted at its own path; the tool
  // handlers resolved exactly this instance for the requests above.
  const secondaryGit = gitRuntimeFor(secondaryRuntime);
  assert.notEqual(secondaryGit, primaryGit);
  assert.equal(secondaryGit.vaultId, SECONDARY);
  assert.equal(secondaryGit.root, SECONDARY_ROOT);
  assert.equal(gitRuntimeFor(secondaryRuntime), secondaryGit, "one GitRuntime per materialized VaultRuntime");

  const primaryHead = await headOf(PRIMARY_ROOT);
  const primaryPorcelain = await porcelainOf(PRIMARY_ROOT);
  const sessions = await toolClient(map);
  let before;
  try {
    // A tracked baseline *inside* the secondary repository (committed through the git tool).
    await sessions.call("write_file", { vaultId: SECONDARY, path: "Projects/draft.md", content: "draft\n" });
    const seeded = await sessions.call("git_commit", { vaultId: SECONDARY, message: "seed folder", paths: ["Projects/draft.md"] });
    assert.equal(seeded.committed, true);
    before = await headOf(SECONDARY_ROOT);

    // `manage_folders` calls `trackGitMutation` from `src/git.js`; the request selects the secondary,
    // so the mutation must land in the secondary's pending batch (§16.4).
    const deleted = await sessions.call("manage_folders", { vaultId: SECONDARY, folder: "Projects", action: "delete", recursiveDelete: true });
    assert.equal(deleted.deleted, "Projects");
    const secondaryPending = await sessions.call("git_status", { vaultId: SECONDARY });
    assert.deepEqual(secondaryPending.pendingAutoCommitPaths, ["Projects"], "the secondary batch owns the mutation");
    assert.deepEqual((await sessions.call("git_status")).pendingAutoCommitPaths, [], "the primary's pending batch must stay empty");

    // The secondary's own §16.3 timers then commit it (maxDelay 1 s, debounce floored to 5 s).
    const after = await waitFor(async () => {
      const head = await headOf(SECONDARY_ROOT);
      return head === before ? null : head;
    });
    assert.ok(after, "the secondary's auto-commit must land on its own schedule");
    const autoCommit = (await sessions.call("git_log", { vaultId: SECONDARY, limit: 1 })).commits[0];
    assert.equal(autoCommit.subject, MCP_COMMIT_MESSAGE);
    assert.equal(autoCommit.hash, after);
    assert.match((await gitIn(SECONDARY_ROOT, "show", "-s", "--format=%B", after)).stdout, /MCP-Agent: mv-dgit-matrix/);
    assert.deepEqual((await gitIn(SECONDARY_ROOT, "ls-files", "Projects")).stdout.trim(), "", "the deletion is committed");
    assert.deepEqual((await sessions.call("git_status", { vaultId: SECONDARY })).pendingAutoCommitPaths, []);

    // Isolation: the primary's repository never saw any of it.
    assert.equal(await headOf(PRIMARY_ROOT), primaryHead);
    assert.equal(await porcelainOf(PRIMARY_ROOT), primaryPorcelain);
    assert.ok(!(await gitIn(PRIMARY_ROOT, "log", "--format=%s")).stdout.includes(MCP_COMMIT_MESSAGE));
  } finally {
    await sessions.close();
  }
});

// ---- 5. §16.2/§47 — disabled / repository-missing / unmaterialized Vaults fail closed, zero side effects

test("§16.2/§47: a Git-disabled, repository-missing and unmaterialized Vault are refused, never the primary", async () => {
  const map = await newMap();
  const disabledHead = await headOf(DISABLED_ROOT);
  const disabledTree = await treeSnapshot(DISABLED_ROOT);
  const noRepoTtreeBefore = await treeSnapshot(NO_REPO_ROOT);
  const primaryHead = await headOf(PRIMARY_ROOT);
  const sessions = await toolClient(map);
  try {
    // (a) §15.4 default-disabled: no A5 record for this secondary, so its Git is disabled even
    //     though its root *is* a real repository. The refusal carries the A6 code.
    const refused = await sessions.refusal("git_status", { vaultId: DISABLED });
    assert.equal(refused.payload.code, "git_runtime_disabled");
    assert.equal(refused.payload.vaultId, DISABLED);
    const refusedCommit = await sessions.refusal("git_commit", { vaultId: DISABLED, message: "never", includeAll: true });
    assert.equal(refusedCommit.payload.code, "git_runtime_disabled");
    assert.equal(await headOf(DISABLED_ROOT), disabledHead, "no commit, no ref update");
    assert.deepEqual(await treeSnapshot(DISABLED_ROOT), disabledTree, "and no working-tree change");

    // (b) §16.2 "enabled + repository-missing": Git is enabled by record but the root is not a working
    //     tree. The state is distinguishable from "disabled" and the content tools keep working.
    const noRepo = await sessions.refusal("git_status", { vaultId: NO_REPO });
    assert.equal(noRepo.payload.code, "git_runtime_repository_missing");
    assert.equal(noRepo.payload.vaultId, NO_REPO);
    await sessions.call("write_file", { vaultId: NO_REPO, path: "still-writable.md", content: "content tools unaffected\n" });
    assert.equal(await exists(path.join(NO_REPO_ROOT, "still-writable.md")), true, "a missing Git repository does not disable the content tools (§16.2)");
    assert.deepEqual(await fs.readdir(NO_REPO_ROOT).then((entries) => entries.sort()), ["not-a-repo.md", "still-writable.md"]);
    assert.deepEqual(noRepoTtreeBefore.sort(), ["not-a-repo.md:plain folder"]);

    // (c) §47: an id the runtime map no longer materializes is denied before the handler runs.
    assert.equal(map.release(DISABLED), true);
    assert.equal(map.get(DISABLED), undefined);
    const unmaterialized = await sessions.refusal("git_status", { vaultId: DISABLED });
    assert.equal(unmaterialized.payload.code, VAULT_SCOPE_DENY_CODES.UNAVAILABLE);
    assert.equal(await headOf(DISABLED_ROOT), disabledHead);
    assert.deepEqual(await treeSnapshot(DISABLED_ROOT), disabledTree);
    assert.equal(await headOf(PRIMARY_ROOT), primaryHead, "and the refusal never falls back to the primary repository");
  } finally {
    await sessions.close();
  }
});

test("§47: the refusal happens before the handler, so no Vault I/O is attempted", async () => {
  const map = await newMap();
  assert.equal(map.release(DISABLED), true);
  let handlerRuns = 0;
  const server = new McpServer({ name: "mv-dgit-refusal", version: "0.0.0" });
  createVaultScopeRegistrar(server, vaultScopeOf(map)).registerTool("git_status", {
    description: "Wave D / D-git refusal probe on a canonical vault-scoped name.",
    inputSchema: {},
  }, () => { handlerRuns += 1; return { content: [{ type: "text", text: "{}" }], structuredContent: {} }; });
  const client = new Client({ name: "mv-dgit-refusal", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const probe = async (vaultId) => {
    const result = await withRequestContextPatch({ author: AUTHOR }, () => client.callTool({ name: "git_status", arguments: { vaultId } }));
    return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) };
  };
  try {
    const unmaterialized = await probe(DISABLED);
    assert.equal(unmaterialized.isError, true);
    assert.equal(unmaterialized.payload.code, VAULT_SCOPE_DENY_CODES.UNAVAILABLE);
    assert.equal(handlerRuns, 0, "the handler must not run for an unmaterialized Vault (§47)");
    const unknown = await probe("no-such-vault");
    assert.equal(unknown.isError, true);
    assert.equal(unknown.payload.code, VAULT_SCOPE_DENY_CODES.UNAVAILABLE);
    assert.equal(handlerRuns, 0, "an unknown Vault must never reach the handler either");
    await probe(DEFAULT_VAULT_ID);
    assert.equal(handlerRuns, 1, "the materialized primary Vault still serves the tool");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---- 6. §3.4 — the reported capability fact matches the wiring this lane delivered

// The canonical git tools whose per-Vault routing this lane delivers. Declared in the test so the
// assertion below ties the reported capability graph to the real canonical tool registry instead of
// mirroring a constant.
const WIRED_GIT_TOOLS = Object.freeze(["git_status", "git_diff", "git_log", "git_commit", "git_pull", "git_push"]);
const ROUTING_REQUIRED = Object.freeze([
  "../git-runtimes.js", "resolveGitRuntime", "runGitTool(",
  "gitStatusFor", "gitDiffFor", "gitLogFor", "commitGitFor", "pullGitFor", "pushGitFor",
]);
// The zero-arity facade names that are primary-bound on purpose: a handler using them would serve
// the primary repository for every Vault (the negative-control target NC-①).
const FACADE_NAMES = Object.freeze([/getGitStatus/, /getGitDiff/, /getGitLog/, /commitGit\(/, /pullGit\(/, /pushGit\(/]);

test("§3.4: the git capability is flipped only together with a fully routed toolset", async () => {
  const map = await newMap();
  assert.ok(WIRED_CAPABILITY_KEYS.includes("git"), "the git key is flipped by this lane");
  // Lane-scoped on purpose: each Wave D lane flips its own key(s) in the shared
  // `vault-runtime/capabilities.js` seam, so this assertion only pins THIS lane's key. The exact
  // global key set (and the tool->capability mapping) is owned by
  // `multi-vault-d-files-matrix.test.js` §3.4, which every lane keeps in sync.
  for (const key of ["git"]) assert.deepEqual(map.get(SECONDARY).capabilities[key], { available: true });
  for (const name of WIRED_GIT_TOOLS) {
    assert.ok(TOOL_NAMES.includes(name), `${name} must be a canonical tool`);
    assert.ok(VAULT_SCOPED_TOOLS.includes(name), `${name} must be classified vault-scoped`);
  }
  const source = await fs.readFile(new URL("src/tools/git.js", testDir), "utf8");
  for (const required of ROUTING_REQUIRED) assert.ok(source.includes(required), `src/tools/git.js must route through ${required}`);
  for (const facade of FACADE_NAMES) assert.doesNotMatch(source, facade, "the tool module must not use the primary-bound facade directly");
});
